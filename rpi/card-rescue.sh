#!/usr/bin/env bash
#
# Reach a Pi you cannot reach, by writing to its SD card from your own machine.
#
# A board with no keyboard and no screen is only as reachable as its network lets it be, and that
# is not always up to you. A guest network, an access point with client isolation, a hotel, the
# club's wifi: the Pi boots, joins, works, and is invisible from the machine next to it. Rewriting
# the card means losing everything on it. This edits the settings the Imager left behind instead.
#
#   ./rpi/card-rescue.sh show              what the card says now
#   ./rpi/card-rescue.sh wifi "SSID"       teach it another wifi network
#   ./rpi/card-rescue.sh tailscale         put it in your Tailscale network at the next boot
#
# Put the card in this Mac first. Both changes take effect at the next boot of the Pi.
#
# The thing that is easy to get wrong: cloud-init does its first-boot work once per instance, and
# it decides what "once" means by the instance-id in meta-data. Add a command without touching that
# id and nothing whatsoever happens at the next boot. So both changes bump it, which makes
# cloud-init treat the card as a fresh instance and do the work again.
#
# The Python below sits at the left margin on purpose. An indented heredoc strips every leading tab,
# Python's own indentation included, and the result is a syntax error at the worst possible moment.

set -euo pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[1mStopped:\033[0m %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null || die "python3 not found; it is what edits the settings files."

# AWB_BOOT points somewhere other than a real card. Only needed to test this script itself, because
# it writes to the one card you have and a mistake in it is a Pi that will not boot.
BOOT="${AWB_BOOT:-}"
if [[ -z "${BOOT}" ]]; then
	for candidate in /Volumes/bootfs /Volumes/boot; do
		[[ -d "${candidate}" ]] && BOOT="${candidate}" && break
	done
fi
[[ -n "${BOOT}" ]] || die "No boot partition mounted. Put the card in this Mac (the Imager ejects it after writing)."
[[ -f "${BOOT}/user-data" ]] || die "This card has no cloud-init settings on it. It was written by an Imager older than 2.0, or without customisation."

# ---------------------------------------------------------------- showing

show_card() {
	say "What is on ${BOOT}"
	python3 - "${BOOT}" <<'PYTHON'
import pathlib, re, sys
boot = pathlib.Path(sys.argv[1])
user = (boot / 'user-data').read_text()
net = (boot / 'network-config').read_text() if (boot / 'network-config').exists() else ''
meta = (boot / 'meta-data').read_text() if (boot / 'meta-data').exists() else ''

def one(text, key):
    m = re.search(r'^\s*%s:\s*"?([^"\n]*)"?\s*$' % key, text, re.M)
    return m.group(1) if m else None

nets = re.findall(r'^ {8}"?([^"\n:]+?)"?:\s*$', net, re.M)
print('  hostname      :', one(user, 'hostname'))
print('  user          :', one(user, 'name'))
print('  ssh key       :', 'yes' if 'ssh_authorized_keys' in user else 'no')
print('  ssh password  :', 'no' if re.search(r'ssh_pwauth:\s*false', user) else 'yes')
print('  wifi          :', ', '.join(nets) if nets else 'none')
print('  tailscale     :', 'yes, at the next boot' if 'awb-tailscale' in user else 'no')
print('  instance-id   :', one(meta, 'instance-id'))
PYTHON
}

# ---------------------------------------------------------------- tailscale

add_tailscale() {
	say "Tailscale at the next boot"
	note "Make a key at https://login.tailscale.com/admin/settings/keys"
	note "Single use, and an hour is plenty: it is traded for the machine's own identity at the"
	note "first login and is worthless after that. Which matters, because until the Pi has booted"
	note "once the key sits on this card in plain text."
	echo
	local key
	# -s, and never as an argument: everything on a command line is visible to every process on the
	# machine, and lands in the shell history besides.
	read -r -s -p "  Auth key (tskey-...): " key </dev/tty
	echo
	[[ -n "${key}" ]] || die "No key given."
	[[ "${key}" == tskey-* ]] || die "That does not look like a Tailscale auth key; they start with tskey-."

	TS_KEY="${key}" python3 - "${BOOT}" <<'PYTHON'
import os, pathlib, re, sys, time
boot = pathlib.Path(sys.argv[1])
key = os.environ['TS_KEY']
user_data = boot / 'user-data'
text = user_data.read_text()

installer = '''#!/bin/bash
# Written onto the card by rpi/card-rescue.sh. Runs at the first boot after that.
set -euo pipefail
exec >>/var/log/awb-tailscale.log 2>&1
echo "== $(date -Is) putting this board in the tailnet =="
. /etc/os-release
# Their apt repository, so Tailscale is updated along with everything else on the machine. That
# path is keyed on the Debian codename, and a fresh Raspberry Pi OS can be out before it exists;
# their own install script works out what the machine is, so it is the honest fallback.
if curl -fsSL "https://pkgs.tailscale.com/stable/raspbian/${VERSION_CODENAME}.noarmor.gpg" \\
        > /usr/share/keyrings/tailscale-archive-keyring.gpg \\
    && curl -fsSL "https://pkgs.tailscale.com/stable/raspbian/${VERSION_CODENAME}.tailscale-keyring.list" \\
        > /etc/apt/sources.list.d/tailscale.list \\
    && apt-get update && apt-get install -y tailscale; then
    echo "installed from the apt repository"
else
    echo "no apt repository for ${VERSION_CODENAME}; using the install script"
    rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL https://tailscale.com/install.sh | sh
fi
# --ssh so you get in over Tailscale even when the network underneath blocks everything else.
if [ -r /run/awb-tskey ]; then
    tailscale up --authkey "$(cat /run/awb-tskey)" --hostname "$(hostname)" --ssh
    rm -f /run/awb-tskey
    echo "up as $(hostname)"
else
    echo "no key on this boot; sign in from a browser with: sudo tailscale up"
fi
'''

def indent(body, spaces):
    pad = ' ' * spaces
    return '\n'.join(pad + line if line.strip() else '' for line in body.split('\n'))

# anything an earlier round wrote goes first, so running this twice is harmless
text = re.sub(r'\n# awb-rescue begin.*?# awb-rescue end\n', '\n', text, flags=re.S)
text = re.sub(r'\n *- \[ /usr/local/sbin/awb-tailscale\.sh \]', '', text)

block = ('\n# awb-rescue begin\n'
         'write_files:\n'
         '  - path: /run/awb-tskey\n'
         "    permissions: '0600'\n"
         '    content: %s\n'
         '  - path: /usr/local/sbin/awb-tailscale.sh\n'
         "    permissions: '0700'\n"
         '    content: |\n'
         '%s\n'
         '# awb-rescue end\n') % (key, indent(installer.strip('\n'), 6))

if re.search(r'^runcmd:', text, re.M):
    text = re.sub(r'^(runcmd:\n(?:[ \t]+- .*\n)*)',
                  r'\g<1>  - [ /usr/local/sbin/awb-tailscale.sh ]\n', text, count=1, flags=re.M)
else:
    text += '\nruncmd:\n  - [ /usr/local/sbin/awb-tailscale.sh ]\n'
text = text.rstrip('\n') + '\n' + block
user_data.write_text(text)

# And the instance-id, or cloud-init skips the whole first-boot round and none of this happens.
meta = boot / 'meta-data'
stamp = 'awb-rescue-%d' % int(time.time())
if meta.exists() and re.search(r'^instance-id:', meta.read_text(), re.M):
    meta.write_text(re.sub(r'^instance-id:.*$', 'instance-id: ' + stamp,
                           meta.read_text(), count=1, flags=re.M))
else:
    meta.write_text('instance-id: %s\n' % stamp)
print('  Written. instance-id is now %s' % stamp)
PYTHON

	say "Done"
	note "Eject the card, put it back in the Pi and power it up."
	note "It installs Tailscale and signs in by itself; give it a few minutes on a slow line."
	note "Then it appears in your tailnet and you reach it by name, whatever wifi it is on."
}

# ---------------------------------------------------------------- wifi

add_wifi() {
	local ssid="$1"
	[[ -f "${BOOT}/network-config" ]] || die "This card has no network-config on it."
	say "Another wifi network: ${ssid}"
	local password
	read -r -s -p "  Password (empty for an open network): " password </dev/tty
	echo

	SSID="${ssid}" PSK="${password}" python3 - "${BOOT}" <<'PYTHON'
import os, pathlib, re, sys, time
boot = pathlib.Path(sys.argv[1])
net = boot / 'network-config'
text = net.read_text()
ssid, psk = os.environ['SSID'], os.environ['PSK']

# already there? then replace it rather than have the same network twice with two passwords
if '"%s":' % ssid in text:
    print('  That network was already on the card; replacing it.')
    text = re.sub(r'\n {8}"%s":\n(?: {10}.*\n)*' % re.escape(ssid), '\n', text)

entry = '        "%s":\n' % ssid
entry += ('          password: "%s"\n' % psk) if psk else '          auth:\n            key-management: none\n'

if 'access-points:' in text:
    text = re.sub(r'^( +)access-points:\n', r'\g<1>access-points:\n' + entry, text, count=1, flags=re.M)
else:
    text += ('  wifis:\n    wlan0:\n      dhcp4: true\n      optional: true\n'
             '      access-points:\n' + entry)
net.write_text(text)

# same story as with tailscale: without a new id cloud-init does nothing at the next boot
meta = boot / 'meta-data'
stamp = 'awb-rescue-%d' % int(time.time())
meta.write_text('instance-id: %s\n' % stamp)
print('  Added. instance-id is now %s' % stamp)
PYTHON
	say "Done"
	note "It joins whichever of its networks it finds, so this one is a fallback and not a move."
}

# ---------------------------------------------------------------- main

case "${1:-}" in
	show) show_card ;;
	wifi) [[ -n "${2:-}" ]] || die "Which network? ./rpi/card-rescue.sh wifi \"SSID\""; add_wifi "$2" ;;
	tailscale) add_tailscale ;;
	*) awk 'NR > 2 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"; exit 1 ;;
esac
