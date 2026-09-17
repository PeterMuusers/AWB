#!/usr/bin/env bash
#
# Put this board on a Raspberry Pi from your own machine, over the network.
#
# Run it on the Mac, in the checkout you want on the board. It finds the Pi, copies the project
# across, hands your credentials over and then runs the setup on the Pi with your answers. Run it
# again later and it only copies what changed and restarts the screen: that is the update path.
#
#   ./rpi/deploy-from-mac.sh                 find awb.local and do the whole thing
#   ./rpi/deploy-from-mac.sh pi@192.168.1.7  when the name does not resolve, or the board is not awb.local
#   ./rpi/deploy-from-mac.sh --update        only copy the files over and restart, ask nothing
#
# The address is remembered after the first successful copy, so later runs need no argument.
#   ./rpi/deploy-from-mac.sh --check-card    look at the SD card in this Mac before you eject it
#
# What it does NOT do is write the SD card. Writing an image is the one step where a mistake costs
# you the wrong disk, and the Raspberry Pi Imager already does it properly, including the first user,
# SSH and the first wifi network. --check-card looks at the result and says whether those three
# things are actually on there, because a card that boots without them is a Pi you cannot reach and
# there is no way back in without a keyboard.

set -euo pipefail

APP_NAME="AWB"
REMOTE_DIR="AWB"                       # where the copy lands in the home directory on the Pi
DEFAULT_HOST="awb.local"
# Waar de Pi de vorige keer stond. Een bord dat anders heet dan awb.local is de regel en niet de
# uitzondering, en een adres dat je elke keer opnieuw moet intypen vergeet je precies op het moment
# dat je haast hebt. --update kan hierdoor ook echt zwijgen, zoals hij belooft.
TARGET_FILE="${XDG_CONFIG_HOME:-${HOME}/.config}/awb/target"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[1mStopped:\033[0m %s\n' "$*" >&2; exit 1; }

ask() {
	local question="$1" default="$2" answer
	read -r -p "${question} [${default}]: " answer </dev/tty
	echo "${answer:-${default}}"
}

confirm() {
	local answer
	read -r -p "$1 [y/N]: " answer </dev/tty
	[[ "${answer}" =~ ^[jJyY] ]]
}

remembered() {
	[[ -r "${TARGET_FILE}" ]] && head -n 1 "${TARGET_FILE}"
}

remember() {
	mkdir -p "$(dirname "${TARGET_FILE}")" && printf '%s\n' "$1" > "${TARGET_FILE}"
}

# ------------------------------------------------------------- the SD card

check_card() {
	say "The SD card"
	local boot=""
	for candidate in /Volumes/bootfs /Volumes/boot; do
		[[ -d "${candidate}" ]] && boot="${candidate}" && break
	done
	[[ -n "${boot}" ]] || die "No boot partition mounted. Put the freshly written card in this Mac. The Imager ejects it when it is done, so it has to go back in."
	note "Found ${boot}"

	# The Imager has written its settings two different ways. Up to 1.9 it was custom.toml, or a
	# firstrun.sh on older versions still; from 2.0 it is cloud-init, which is three files and no
	# toml at all. A card from a current Imager therefore has none of the old names on it, and
	# reading the absence of custom.toml as "not configured" sends you back to rewrite a card that
	# was perfectly good.
	local blob="" style=""
	for name in custom.toml firstrun.sh; do
		[[ -f "${boot}/${name}" ]] && { blob+="$(cat "${boot}/${name}")"; style="${name}"; }
	done
	for name in user-data network-config; do
		[[ -f "${boot}/${name}" ]] && { blob+="$(cat "${boot}/${name}")"; style="cloud-init"; }
	done
	[[ -n "${style}" ]] || die "This card has no Imager settings on it. Write it again and fill in the customisation: hostname, user, SSH and one wifi network."
	note "First-boot settings: ${style}"

	has() { grep -qiE "$1" <<<"${blob}"; }

	# Without a way in there is no way in: this board has no keyboard and no screen.
	if has 'ssh_authorized_keys'; then
		note "SSH: on, with a key"
		if has 'ssh_pwauth:[[:space:]]*false'; then
			note "     and passwords are off, so that key is the only way in - make sure it is yours"
		fi
	elif has 'ssh_pwauth:[[:space:]]*true|enable_ssh|ssh_pw'; then
		note "SSH: on, with a password"
	else
		note "SSH: NOT found - you will not be able to reach it"
	fi

	has 'access-points|ssid|wlan|wpa' && note "Wifi: configured" || note "Wifi: NOT found - without a cable this Pi never comes online"

	# The name matters here beyond being tidy: it is what you type to reach the thing.
	local name
	name="$(sed -n 's/^[[:space:]]*hostname[[:space:]]*[:=][[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' <<<"${blob}" | head -n 1)"
	if [[ -n "${name}" ]]; then
		note "Hostname: ${name}, so it answers to ${name}.local"
	else
		note "Hostname: not set, so it will be raspberrypi.local"
	fi

	# No country, no transmitter: the symptom is a Pi that sees no networks whatsoever.
	has 'regulatory-domain|country' && note "Wifi country: set" || note "Wifi country: not found - the radio stays off without one"

	say "If all four say yes, eject the card and boot the Pi."
	note "Then run this script again without --check-card."
}

# ------------------------------------------------------------- finding the Pi

find_pi() {
	local host="$1"
	if ping -c 1 -t 2 "${host%%@*}" >/dev/null 2>&1 || ping -c 1 -t 2 "${host#*@}" >/dev/null 2>&1; then
		echo "${host}"
		return 0
	fi
	return 1
}

# ------------------------------------------------------------- main

MODE="full"
TARGET=""
for argument in "$@"; do
	case "${argument}" in
		--check-card) MODE="card" ;;
		--update) MODE="update" ;;
		-h|--help) awk 'NR > 2 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"; exit 0 ;;
		*) TARGET="${argument}" ;;
	esac
done

if [[ "${MODE}" == "card" ]]; then
	check_card
	exit 0
fi

command -v rsync >/dev/null || die "rsync not found."
command -v ssh >/dev/null || die "ssh not found."

say "Looking for the Pi"
[[ -z "${TARGET}" ]] && TARGET="$(remembered || true)"
if [[ -z "${TARGET}" ]]; then
	TARGET="$(ask "Where is it (user@host)" "$(whoami)@${DEFAULT_HOST}")"
elif [[ "${MODE}" != "update" ]]; then
	# onthouden, maar niet opgelegd: een tweede bord is een kwestie van de regel overtypen
	TARGET="$(ask "Where is it (user@host)" "${TARGET}")"
else
	note "${TARGET} (van de vorige keer)"
fi
HOST="${TARGET#*@}"
if ! find_pi "${HOST}" >/dev/null; then
	note "${HOST} does not answer a ping."
	note "It can take a couple of minutes on the first boot, and it has to be on a network this Mac can see."
	confirm "Try anyway?" || die "Nothing done."
else
	note "${HOST} answers."
fi

# One key beats typing a password four times, and the later --update runs need no typing at all.
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "${TARGET}" true 2>/dev/null; then
	note "No key on the Pi yet, so it will ask for the password a few times."
	if command -v ssh-copy-id >/dev/null && confirm "Put your SSH key on it now, so this is the last time?"; then
		ssh-copy-id "${TARGET}"
	fi
fi

say "Copying the board across"
# --delete so a file you removed here disappears there too; without it the board keeps running old
# modules that nothing imports any more. .env stays put: it lives on the Pi and nowhere else.
rsync -a --delete --exclude '.git' --exclude '.env' --exclude 'node_modules' \
	"${SOURCE_DIR}/" "${TARGET}:${REMOTE_DIR}/"
# pas onthouden als er echt iets overheen gegaan is: een adres dat niet werkt hoef je niet terug
remember "${TARGET}"
note "Done."

if [[ "${MODE}" == "update" ]]; then
	say "Putting it live"
	# shellcheck disable=SC2029
	ssh "${TARGET}" "sudo rsync -a --delete --exclude .env '${REMOTE_DIR}/' /opt/${APP_NAME}/ && sudo systemctl restart lighttpd"
	note "The screen picks it up at the next nightly reload, or reboot it now to see it straight away."
	exit 0
fi

# The credentials never travel through git, so they have to be handed over separately, once.
if [[ -f "${SOURCE_DIR}/.env" ]]; then
	say "Credentials"
	note "There is a .env here. It holds the account for luchtvaartmeteo.nl and the API keys."
	if confirm "Copy it to the Pi?"; then
		scp -q "${SOURCE_DIR}/.env" "${TARGET}:${REMOTE_DIR}/.env"
		ssh "${TARGET}" "chmod 600 ${REMOTE_DIR}/.env"
		note "Copied. The setup will put it in place with the right owner."
	fi
fi

say "Now the setup on the Pi itself"
note "It asks about wifi, the screen and the credentials. Every question has a default."
note "This is where the hotspot and the club's wifi go in."
echo
# -t so it is a real terminal on the other side: without it the questions never appear.
ssh -t "${TARGET}" "sudo ${REMOTE_DIR}/rpi/setup.sh"

say "Ready"
note "Reboot it and the board comes up by itself:  ssh ${TARGET} sudo reboot"
note "Next time, after changing something here:    ./rpi/deploy-from-mac.sh --update"
note "Add a network later:                         ssh ${TARGET} sudo /opt/${APP_NAME}/rpi/wifi.sh add \\\"Clubwifi\\\" 10"
