#!/usr/bin/env bash
#
# Reach a Pi you cannot reach, by writing to its SD card from your own machine.
#
# A board with no keyboard and no screen is only as reachable as its network lets it be, and that is
# not always up to you. A guest network, an access point with client isolation, a hotel, the club's
# wifi: the Pi boots, joins, works, and is invisible from the machine next to it. Rewriting the card
# loses everything on it. This edits the settings the Imager left behind instead.
#
#   ./rpi/card-rescue.sh show              what the card says now, and any logs it brought back
#   ./rpi/card-rescue.sh tailscale         put it in your Tailscale network at the next boot
#   ./rpi/card-rescue.sh wifi "SSID"       teach it another wifi network
#   ./rpi/card-rescue.sh debug             have the next boot leave its logs on this card
#   ./rpi/card-rescue.sh bump              do the first-boot work again, changing nothing else
#
# Put the card in this Mac first. Everything takes effect at the next boot of the Pi.
#
# Three things here were learned the hard way, and each of them looks exactly like "it just did not
# work", with no error and no trace anywhere:
#
#   - Raspberry Pi Imager 2.0 writes cloud-init (user-data, network-config, meta-data), not the
#     custom.toml that older versions wrote.
#   - cloud-init does its first-boot work once per instance, and the id it goes by sits in two
#     places: meta-data, and ds=nocloud;i=<id> on the kernel command line in cmdline.txt. The
#     command line wins. Change only meta-data and the next boot does nothing whatsoever.
#   - user-data is one YAML document, so it can hold only one write_files: and one runcmd:. Adding a
#     second one silently replaces the first, taking whatever it held with it.
#
# The Python below sits at the left margin on purpose. An indented heredoc strips every leading tab,
# Python's own indentation included, and the result is a syntax error at the worst possible moment.

set -euo pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[1mStopped:\033[0m %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null || die "python3 not found; it is what edits the settings files."

# Ask for a secret without it ending up anywhere it should not be: not on a command line, not in the
# shell history, not on the screen. A terminal is the usual way, but there is not always one - run
# from an editor or a wrapper and /dev/tty does not exist - so fall back to stdin.
ask_secret() {
	local prompt="$1" value=""
	if [[ -r /dev/tty ]]; then
		read -r -s -p "  ${prompt}: " value </dev/tty 2>/dev/null || value=""
		echo >&2
	fi
	if [[ -z "${value}" ]]; then
		read -r -s value || true
	fi
	printf '%s' "${value}"
}

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

# ---------------------------------------------------------------- the shared edit

# Merge one script and one command into the single write_files: and runcmd: that user-data may have,
# replacing whatever an earlier run of this script left there. Reads AWB_NAME, AWB_BODY and the
# optional AWB_EXTRA ("path\npermissions\ncontent") from the environment.
edit_user_data() {
	python3 - "${BOOT}" <<'PYTHON'
import os, pathlib, re, sys

boot = pathlib.Path(sys.argv[1])
name = os.environ['AWB_NAME']
body = os.environ['AWB_BODY']
extra = os.environ.get('AWB_EXTRA', '')
path = '/usr/local/sbin/awb-%s.sh' % name
user_data = boot / 'user-data'
text = user_data.read_text()


def indent(block, spaces):
    pad = ' ' * spaces
    return '\n'.join(pad + line if line.strip() else '' for line in block.split('\n'))


def add_files(text, entries):
    m = re.search(r'^write_files:[ \t]*\n', text, re.M)
    if m:
        return text[:m.end()] + entries + text[m.end():]
    return text.rstrip('\n') + '\n\nwrite_files:\n' + entries


def add_command(text, entry):
    m = re.search(r'^runcmd:\n(?:[ \t]+- .*\n)*', text, re.M)
    if m:
        return text[:m.end()] + entry + text[m.end():]
    return text.rstrip('\n') + '\n\nruncmd:\n' + entry


# Out with whatever an earlier run wrote, so running this twice changes nothing. Between two
# markers, because working out where one write_files entry ends by its indentation alone is the
# kind of guess that leaves half an entry behind.
text = re.sub(r'\n  # awb-%s begin\n.*?  # awb-%s end\n' % (name, name), '\n', text, flags=re.S)
text = re.sub(r'\n[ \t]*- \[[^\]]*awb-%s\.sh[^\]]*\]' % name, '', text)

entries = '  # awb-%s begin\n' % name
if extra:
    extra_path, extra_perm, extra_content = extra.split('\n', 2)
    entries += ('  - path: %s\n    permissions: %s\n    content: %s\n'
                % (extra_path, extra_perm, extra_content))
entries += ('  - path: %s\n    permissions: \'0700\'\n    content: |\n%s\n'
            % (path, indent(body.strip('\n'), 6)))
entries += '  # awb-%s end\n' % name

text = add_files(text, entries)
# || true, because cloud-init runs the runcmd entries as one script, and a failure here must not
# take the rest of the boot with it - least of all the step that saves the logs.
text = add_command(text, '  - [ /bin/sh, -c, "%s || true" ]\n' % path)
user_data.write_text(text)
print('  Written to user-data.')
PYTHON
}

# ---------------------------------------------------------------- the instance id

bump_instance_id() {
	python3 - "${BOOT}" <<'PYTHON'
import pathlib, re, sys, time
boot = pathlib.Path(sys.argv[1])
stamp = 'awb-rescue-%d' % int(time.time())

meta = boot / 'meta-data'
if meta.exists() and re.search(r'^instance-id:', meta.read_text(), re.M):
    meta.write_text(re.sub(r'^instance-id:.*$', 'instance-id: ' + stamp, meta.read_text(),
                           count=1, flags=re.M))
else:
    meta.write_text('instance-id: %s\n' % stamp)

cmdline = boot / 'cmdline.txt'
if cmdline.exists():
    text = cmdline.read_text()
    fixed = re.sub(r'(ds=nocloud[^\s]*?;i=)[^\s;]+', lambda m: m.group(1) + stamp, text)
    if fixed == text and 'ds=nocloud' in text:
        fixed = re.sub(r'(ds=nocloud[^\s]*)', lambda m: m.group(1) + ';i=' + stamp, text, count=1)
    if fixed != text:
        # one line, always: a second line in here and the Pi does not boot at all
        assert fixed.strip().count('\n') == 0, 'cmdline.txt must stay a single line'
        cmdline.write_text(fixed)
        print('  instance-id is now %s, in meta-data and on the kernel command line' % stamp)
    else:
        print('  instance-id is now %s (meta-data only; no ds=nocloud on the command line)' % stamp)
else:
    print('  instance-id is now %s' % stamp)
PYTHON
}

# ---------------------------------------------------------------- showing

show_card() {
	say "What is on ${BOOT}"
	python3 - "${BOOT}" <<'PYTHON'
import pathlib, re, sys
boot = pathlib.Path(sys.argv[1])
user = (boot / 'user-data').read_text()
net = (boot / 'network-config').read_text() if (boot / 'network-config').exists() else ''
meta = (boot / 'meta-data').read_text() if (boot / 'meta-data').exists() else ''
cmd = (boot / 'cmdline.txt').read_text() if (boot / 'cmdline.txt').exists() else ''


def one(text, key):
    m = re.search(r'^\s*%s:\s*"?([^"\n]*)"?\s*$' % key, text, re.M)
    return m.group(1) if m else None


nets = re.findall(r'^ {8}"?([^"\n:]+?)"?:\s*$', net, re.M)
runs = sorted(set(re.findall(r'awb-(\w+)\.sh', user)))
m = re.search(r'ds=nocloud[^\s]*?;i=([^\s;]+)', cmd)
print('  hostname      :', one(user, 'hostname'))
print('  user          :', one(user, 'name'))
print('  ssh key       :', 'yes' if 'ssh_authorized_keys' in user else 'no')
print('  ssh password  :', 'no' if re.search(r'ssh_pwauth:\s*false', user) else 'yes')
print('  wifi          :', ', '.join(nets) if nets else 'none')
print('  at next boot  :', ', '.join(runs) if runs else 'nothing extra')
print('  instance-id   :', one(meta, 'instance-id'), '(meta-data)')
print('                 ', m.group(1) if m else '-', '(kernel command line; this is the one that counts)')
PYTHON
	if [[ -d "${BOOT}/awb-debug" ]]; then
		say "What the Pi left behind"
		sed -n '1,60p' "${BOOT}/awb-debug/summary.txt" 2>/dev/null || true
		echo
		note "Everything: ${BOOT}/awb-debug/"
	fi
}

# ---------------------------------------------------------------- tailscale

add_tailscale() {
	say "Tailscale at the next boot"
	note "Make a key at https://login.tailscale.com/admin/settings/keys"
	note "Single use, and an hour is plenty: it is traded for the machine's own identity at the"
	note "first login and is worthless after that. Which matters, because until the Pi has booted"
	note "once, the key sits on this card in plain text."
	echo
	# Never as an argument: everything on a command line is visible to every process on the machine,
	# and lands in the shell history besides.
	local key
	key="$(ask_secret "Auth key (tskey-...)")"
	[[ -n "${key}" ]] || die "No key given."
	[[ "${key}" == tskey-* ]] || die "That does not look like a Tailscale auth key; they start with tskey-."

	AWB_NAME=tailscale \
	AWB_EXTRA="/run/awb-tskey
'0600'
${key}" \
	AWB_BODY='#!/bin/bash
# Written onto the card by rpi/card-rescue.sh. Runs at the first boot after that.
set -uo pipefail
exec >>/var/log/awb-tailscale.log 2>&1
echo "== $(date -Is) putting this board in the tailnet =="
# Wait for the network rather than assume it. cloud-init starts this early - a minute after power
# on, seen on a real board - and wifi association plus DHCP can easily take longer than that. No
# network is a reason to wait; three minutes without one is a reason to stop and say so.
for attempt in $(seq 1 36); do
    getent hosts pkgs.tailscale.com >/dev/null 2>&1 && break
    [ "$attempt" = 36 ] && echo "no name resolution after three minutes; giving up" && exit 1
    sleep 5
done
echo "network is up after about $((attempt * 5)) seconds"
. /etc/os-release
# Their apt repository, so Tailscale is updated along with everything else on the machine. That
# path is keyed on the Debian codename, and a fresh Raspberry Pi OS can be out before it exists;
# their own install script works out what the machine is, so it is the honest fallback.
if curl -fsSL "https://pkgs.tailscale.com/stable/raspbian/${VERSION_CODENAME}.noarmor.gpg" \
        > /usr/share/keyrings/tailscale-archive-keyring.gpg \
    && curl -fsSL "https://pkgs.tailscale.com/stable/raspbian/${VERSION_CODENAME}.tailscale-keyring.list" \
        > /etc/apt/sources.list.d/tailscale.list \
    && apt-get update && apt-get install -y tailscale; then
    echo "installed from the apt repository"
else
    echo "no apt repository for ${VERSION_CODENAME}; using the install script"
    rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled
# --ssh so you get in over Tailscale even when the network underneath blocks everything else.
if [ -r /run/awb-tskey ]; then
    tailscale up --authkey "$(cat /run/awb-tskey)" --hostname "$(hostname)" --ssh
    echo "tailscale up exited $?"
    rm -f /run/awb-tskey
    tailscale status | head -3
else
    echo "no key on this boot; sign in from a browser with: sudo tailscale up"
fi' \
		edit_user_data
	bump_instance_id
	say "Done"
	note "Eject the card, put it back in the Pi and power it up."
	note "It installs Tailscale and signs in by itself; give it a few minutes on a slow line."
	note "Then it appears in your tailnet and you reach it by name, whatever wifi it is on."
}

# ---------------------------------------------------------------- debug

add_debug() {
	say "Leave the logs on the card at the next boot"
	note "Everything that says what went wrong lives on the Linux partition, which a Mac cannot"
	note "read. This has the Pi copy it onto the boot partition, which is plain FAT."
	AWB_NAME=debug \
	AWB_BODY='#!/bin/bash
# Written onto the card by rpi/card-rescue.sh. Copies what happened onto the boot partition.
OUT=/boot/firmware/awb-debug
[ -d /boot/firmware ] || OUT=/boot/awb-debug
mkdir -p "$OUT"
{
  echo "== $(date -Is) =="
  echo "-- who am i"; hostname; head -2 /etc/os-release; uptime
  echo "-- network"; ip -br addr; ip route
  echo "-- wifi"; nmcli -t -f ACTIVE,SSID,SIGNAL device wifi list --rescan no 2>&1 | head -20
  echo "-- name resolution"; getent hosts pkgs.tailscale.com
  echo "-- reaching the internet"; curl -sS -o /dev/null -w "%{http_code}\n" --max-time 20 https://pkgs.tailscale.com/
  echo "-- tailscale"; command -v tailscale >/dev/null && tailscale status 2>&1 | head -5 || echo "not installed"
  echo "-- cloud-init"; cloud-init status --long 2>&1 | head -20
} > "$OUT/summary.txt" 2>&1
for f in /var/log/awb-tailscale.log /var/log/cloud-init-output.log /var/log/cloud-init.log; do
  [ -r "$f" ] && tail -c 200000 "$f" > "$OUT/$(basename "$f")"
done
journalctl -b --no-pager 2>/dev/null | tail -n 800 > "$OUT/journal.txt"
sync' \
		edit_user_data
	bump_instance_id
	say "Done"
	note "Boot the Pi, give it five minutes, then put the card back in here and run: show"
}

# ---------------------------------------------------------------- wifi

add_wifi() {
	local ssid="$1"
	[[ -f "${BOOT}/network-config" ]] || die "This card has no network-config on it."
	say "Another wifi network: ${ssid}"
	local password=""
	# This Mac is often on the very network the board has to join, and then the right password is
	# already here. Taking it from the keychain beats retyping it: a wifi password that is one
	# character off fails in a way that looks like anything but a typo - the board associates, the
	# handshake fails, and all you see afterwards is a device that never came online.
	if security find-generic-password -wa "${ssid}" >/dev/null 2>&1; then
		note "This Mac knows this network; taking the password from your keychain."
		password="$(security find-generic-password -wa "${ssid}" 2>/dev/null)"
	fi
	if [[ -z "${password}" ]]; then
		password="$(ask_secret "Password for \"${ssid}\" (empty for an open network)")"
	fi

	SSID="${ssid}" PSK="${password}" python3 - "${BOOT}" <<'PYTHON'
import os, pathlib, re, sys
boot = pathlib.Path(sys.argv[1])
net = boot / 'network-config'
text = net.read_text()
ssid, psk = os.environ['SSID'], os.environ['PSK']

# already there? then replace it, rather than have one network with two passwords
if '"%s":' % ssid in text:
    print('  That network was already on the card; replacing it.')
    text = re.sub(r'\n {8}"%s":\n(?: {10}.*\n)*' % re.escape(ssid), '\n', text)

entry = '        "%s":\n' % ssid
entry += ('          password: "%s"\n' % psk) if psk else '          auth:\n            key-management: none\n'

if 'access-points:' in text:
    text = re.sub(r'^( +)access-points:\n', lambda m: m.group(0) + entry, text, count=1, flags=re.M)
else:
    text += ('  wifis:\n    wlan0:\n      dhcp4: true\n      optional: true\n'
             '      access-points:\n' + entry)
net.write_text(text)
print('  Added.')
PYTHON
	bump_instance_id
	say "Done"
	note "It joins whichever of its networks it finds, so this one is a fallback and not a move."
}

# ---------------------------------------------------------------- main

case "${1:-}" in
	show) show_card ;;
	tailscale) add_tailscale ;;
	debug) add_debug ;;
	wifi) [[ -n "${2:-}" ]] || die "Which network? ./rpi/card-rescue.sh wifi \"SSID\""; add_wifi "$2" ;;
	bump) say "Making cloud-init do its first-boot work again"; bump_instance_id ;;
	*) awk 'NR > 2 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"; exit 1 ;;
esac
