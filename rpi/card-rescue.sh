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
#   ./rpi/card-rescue.sh wifi "SSID" [pri] teach it another wifi network (higher pri wins)
#   ./rpi/card-rescue.sh wifi-open "SSID" [pri]  the same, for a network without a password
#   ./rpi/card-rescue.sh forget "SSID"     take a network out of the Imager's own list
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
#   - network-config holds exactly one usable wifi network, whatever it looks like. Netplan renders
#     the access-points of one interface into a single NetworkManager profile, so a second network
#     does not sit beside the first: it takes its data and keeps the other one's name. What you get
#     is a profile called after one network that connects to the other. So extra networks go in as
#     NetworkManager keyfiles of their own, which netplan never touches.
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


def add_command(text, entry, first=False):
    """Last by default, so it runs after whatever was already there. Anything that brings the
    network up wants to be first instead: a step that waits three minutes for a name to resolve is
    no use when the wifi it waits for is configured after it."""
    if first:
        m = re.search(r'^runcmd:\n(?:  - \[ systemctl[^\n]*\n)?', text, re.M)
    else:
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
text = add_command(text, '  - [ /bin/sh, -c, "%s || true" ]\n' % path,
                   first=os.environ.get('AWB_FIRST') == '1')
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
    # Alles wat op een id lijkt eruit en er precies één terug. Er kan er namelijk al meer dan één
    # staan - de Pi schrijft er bij het opstarten zelf ook een achteraan - en cloud-init leest de
    # laatste. Eentje erbij zetten is dan hetzelfde als niets doen, en dat is niet te zien: de kaart
    # klopt, meta-data klopt, en de Pi doet stug niets van wat je hem meegaf.
    def one_id(match):
        parts = [part for part in match.group(0).split(';') if not part.startswith('i=')]
        return ';'.join(parts) + ';i=' + stamp

    fixed = re.sub(r'ds=nocloud[^\s]*', one_id, text, count=1) if 'ds=nocloud' in text else text
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

# ---------------------------------------------------------------- debug

add_debug() {
	say "Leave the logs on the card at the next boot"
	note "Everything that says what went wrong lives on the Linux partition, which a Mac cannot"
	note "read. This has the Pi copy it onto the boot partition, which is plain FAT."
	AWB_FIRST=1 \
	AWB_NAME=debug \
	AWB_BODY='#!/bin/bash
# Written onto the card by rpi/card-rescue.sh. Copies what happened onto the boot partition.
#
# Twee momentopnamen, en geen van beide houdt het opstarten op. Vroeg meten geeft een bord dat nog
# nergens verbonden is; laat meten geeft niets als iemand de stekker eruit trekt omdat het te lang
# duurt. Vandaar allebei - en via systemd-run, want alles wat dit script zelf op de achtergrond zou
# starten gaat mee in het graf van cloud-init zodra dat klaar is.
OUT=/boot/firmware/awb-debug
[ -d /boot/firmware ] || OUT=/boot/awb-debug
mkdir -p "$OUT"

if [ "$1" = collect ]; then
  {
    echo "== $(date -Is) ($2) =="
    echo "-- who am i"; hostname; head -2 /etc/os-release; uptime
    echo "-- network"; ip -br addr; ip route
    echo "-- wifi"; nmcli -t -f ACTIVE,SSID,SIGNAL device wifi list --rescan no 2>&1 | head -20
    echo "-- profiles"; nmcli -t -f NAME,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY connection show 2>&1
    echo "-- devices"; nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status 2>&1
    echo "-- what NetworkManager tried"; journalctl -b -u NetworkManager --no-pager 2>&1 \
      | grep -iE "skydive|manifest|psk|auth|assoc|secrets|fail|deactiv" | tail -30
    echo "-- name resolution"; getent hosts deb.debian.org
    echo "-- reaching the internet"; curl -sS -o /dev/null -w "%{http_code}\n" --max-time 20 https://deb.debian.org/
    echo "-- cloud-init"; cloud-init status --long 2>&1 | head -20
  } > "$OUT/summary-$2.txt" 2>&1
  cp -f /var/log/cloud-init-output.log /var/log/cloud-init.log "$OUT/" 2>/dev/null
  journalctl -b --no-pager 2>/dev/null | tail -2000 > "$OUT/journal.txt" 2>&1
  cp -f /var/log/awb-captive.log "$OUT/captive.log" 2>/dev/null
  cp -f /var/lib/awb/captive-last.html "$OUT/captive-last.html" 2>/dev/null
  sync
  exit 0
fi

systemctl reset-failed awb-debug-early.service awb-debug-late.service 2>/dev/null
systemd-run --unit=awb-debug-early --on-active=25 /usr/local/sbin/awb-debug.sh collect early >/dev/null 2>&1
systemd-run --unit=awb-debug-late --on-active=110 /usr/local/sbin/awb-debug.sh collect late >/dev/null 2>&1
echo "debug scheduled"' \
		edit_user_data
	bump_instance_id
	say "Done"
	note "Boot the Pi, give it five minutes, then put the card back in here and run: show"
}

# ---------------------------------------------------------------- wifi

add_wifi() {
	local ssid="$1" priority="${2:-0}" open="${3:-}"
	say "Wifi network: ${ssid} (priority ${priority})"

	# Een open netwerk heeft geen wachtwoord om te zoeken. Dat is geen randgeval: juist het netwerk
	# met een portaal ervoor is open, en dat is precies het soort netwerk waar je een bord op kwijt
	# raakt en met de kaart weer bij moet zien te komen.
	if [[ -n "${open}" ]]; then
		note "Open network: no password."
		AWB_FIRST=1 \
		AWB_NAME="wifi-$(echo "${ssid}" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')" \
		AWB_EXTRA="/etc/NetworkManager/system-connections/${ssid}.nmconnection
'0600'
|
      [connection]
      id=${ssid}
      type=wifi
      autoconnect=true
      autoconnect-priority=${priority}

      [wifi]
      mode=infrastructure
      ssid=${ssid}

      [ipv4]
      method=auto

      [ipv6]
      method=auto
      addr-gen-mode=default" \
		AWB_BODY='#!/bin/bash
# Written onto the card by rpi/card-rescue.sh. NetworkManager refuses a keyfile that anyone else
# can read, and cloud-init writes it before NetworkManager is up, so tell it to look again.
chown root:root "/etc/NetworkManager/system-connections/SSID.nmconnection" 2>/dev/null
chmod 600 "/etc/NetworkManager/system-connections/SSID.nmconnection" 2>/dev/null
nmcli connection reload 2>/dev/null || systemctl reload NetworkManager 2>/dev/null
echo "reloaded NetworkManager for SSID"' \
			edit_user_data_ssid "${ssid}"
		bump_instance_id
		say "Done"
		note "An open network: whatever sits in front of it still has to let the board through."
		return 0
	fi

	local password=""
	local source=""
	if [[ "${AWB_CLIPBOARD:-0}" == "1" ]] && command -v pbpaste >/dev/null; then
		password="$(pbpaste)"
		source="your clipboard"
	elif security find-generic-password -wa "${ssid}" >/dev/null 2>&1; then
		password="$(security find-generic-password -wa "${ssid}" 2>/dev/null)"
		source="your keychain"
	fi
	if [[ -z "${password}" ]]; then
		password="$(ask_secret "Password for \"${ssid}\"")"
		source="what you typed"
	fi
	[[ -n "${password}" ]] || die "No password given."
	note "Password taken from ${source} (${#password} characters)."

	# A NetworkManager keyfile of its own, not another entry in network-config: see the note at the
	# top about netplan folding the access-points of one interface into a single profile. A keyfile
	# is read straight from disk, survives every boot, and nothing regenerates over it.
	AWB_FIRST=1 \
	AWB_NAME="wifi-$(echo "${ssid}" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')" \
	AWB_EXTRA="/etc/NetworkManager/system-connections/${ssid}.nmconnection
'0600'
|
      [connection]
      id=${ssid}
      type=wifi
      autoconnect=true
      autoconnect-priority=${priority}

      [wifi]
      mode=infrastructure
      ssid=${ssid}

      [wifi-security]
      key-mgmt=wpa-psk
      psk=${password}

      [ipv4]
      method=auto

      [ipv6]
      method=auto
      addr-gen-mode=default" \
	AWB_BODY='#!/bin/bash
# Written onto the card by rpi/card-rescue.sh. NetworkManager refuses a keyfile that anyone else
# can read, and cloud-init writes it before NetworkManager is up, so tell it to look again.
chown root:root "/etc/NetworkManager/system-connections/SSID.nmconnection" 2>/dev/null
chmod 600 "/etc/NetworkManager/system-connections/SSID.nmconnection" 2>/dev/null
nmcli connection reload 2>/dev/null || systemctl reload NetworkManager 2>/dev/null
echo "reloaded NetworkManager for SSID"' \
		edit_user_data_ssid "${ssid}"
	bump_instance_id
	say "Done"
	note "It joins whichever of its networks it finds; the higher priority wins when both are there."
}

# The body needs the SSID in it, and doing that inline turns into quoting soup.
edit_user_data_ssid() {
	AWB_BODY="${AWB_BODY//SSID/$1}" edit_user_data
}

# ---------------------------------------------------------------- forget

# Two lists to take it out of, because a Pi can know a network in two ways: the one the Imager
# seeded (network-config) and the NetworkManager profiles that were added later, on the Pi or by
# this script. Forgetting one and not the other leaves a board that still walks back into the
# network you were trying to get it out of - which is exactly the trouble you took the card out
# for. The profile is deleted at the next boot, by a script this puts on the card.
forget_wifi() {
	local ssid="$1"
	forget_profile "${ssid}"
	if [[ ! -f "${BOOT}/network-config" ]]; then
		bump_instance_id
		return 0
	fi
	say "Taking ${ssid} out of the Imager's network list"
	SSID="${ssid}" python3 - "${BOOT}" <<'PYTHON'
import os, pathlib, re, sys
boot = pathlib.Path(sys.argv[1])
net = boot / 'network-config'
text = net.read_text()
ssid = os.environ['SSID']
if '"%s":' % ssid not in text:
    print('  Not in there; nothing to do.')
    sys.exit(0)
text = re.sub(r'\n {8}"%s":\n(?: {10}.*\n)*' % re.escape(ssid), '\n', text)
net.write_text(text)
rest = re.findall(r'^ {8}"?([^"\n:]+?)"?:\s*$', text, re.M)
print('  Removed. Still in the list:', ', '.join(rest) if rest else 'nothing')
PYTHON
	bump_instance_id
}

# Een NetworkManager-profiel weghalen bij de volgende start. Dat bestand staat op de ext4-partitie
# en die kan een Mac niet eens lezen, dus het gebeurt op de Pi zelf - door een scriptje dat hier
# op de bootpartitie wordt neergezet en bij het opstarten één keer langskomt.
forget_profile() {
	local ssid="$1"
	say "Removing the NetworkManager profile for ${ssid} at the next boot"
	AWB_FIRST=1 \
	AWB_NAME="drop-$(echo "${ssid}" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')" \
	AWB_BODY='#!/bin/bash
# Written onto the card by rpi/card-rescue.sh: take this network off the board.
rm -f "/etc/NetworkManager/system-connections/SSID.nmconnection"
nmcli connection delete "SSID" 2>/dev/null
nmcli connection reload 2>/dev/null || systemctl reload NetworkManager 2>/dev/null
echo "removed SSID"' \
		edit_user_data_ssid "${ssid}"
	note "It will not join \"${ssid}\" again until you teach it that network anew."
}

# ---------------------------------------------------------------- main

case "${1:-}" in
	show) show_card ;;
	debug) add_debug ;;
	wifi) [[ -n "${2:-}" ]] || die "Which network? ./rpi/card-rescue.sh wifi \"SSID\" [priority]"; add_wifi "$2" "${3:-0}" ;;
	wifi-open) [[ -n "${2:-}" ]] || die "Which network? ./rpi/card-rescue.sh wifi-open \"SSID\" [priority]"; add_wifi "$2" "${3:-0}" open ;;
	forget) [[ -n "${2:-}" ]] || die "Which network? ./rpi/card-rescue.sh forget \"SSID\""; forget_wifi "$2" ;;
	bump) say "Making cloud-init do its first-boot work again"; bump_instance_id ;;
	*) awk 'NR > 2 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"; exit 1 ;;
esac
