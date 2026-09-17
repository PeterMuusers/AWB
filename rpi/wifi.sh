#!/usr/bin/env bash
#
# Wifi networks for a board that has no keyboard and no network cable.
#
# Raspberry Pi OS from Bookworm on uses NetworkManager, which keeps every network as its own
# profile and connects to whichever one is in range. So a board can know the network at home, the
# hotspot in your pocket and the one at the club all at once, and it will pick whatever it finds.
# That is the whole point here: you set it up on your desk and it works when you hang it up.
#
#   sudo rpi/wifi.sh add "SSID" [priority]     ask for the password and remember the network
#   sudo rpi/wifi.sh list                      what it knows, and what it is on now
#   sudo rpi/wifi.sh forget "SSID"             remove one
#   sudo rpi/wifi.sh country NL                set the wifi country (the radio stays off without it)
#
# Priority decides who wins when two are in range: higher first, and the default of 0 means "no
# opinion". Give the hotspot a low one and the club a high one, or you will be paying for mobile
# data while sitting next to the club's own access point.
#
# Adding a network does not need that network to be in range. You can teach it the club's wifi from
# your kitchen table weeks before the board ever gets there.

set -euo pipefail

usage() {
	# de kop van dit bestand is de handleiding; alles tot de eerste regel die geen commentaar is
	awk 'NR > 2 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"
	exit 1
}

require_root() {
	if [[ "${EUID}" -ne 0 ]]; then
		echo "Run this with sudo." >&2
		exit 1
	fi
}

require_nm() {
	if ! command -v nmcli >/dev/null 2>&1; then
		echo "nmcli not found. This needs Raspberry Pi OS Bookworm or newer, which uses NetworkManager." >&2
		echo "On Bullseye and older, put the networks in /etc/wpa_supplicant/wpa_supplicant.conf instead." >&2
		exit 1
	fi
}

add_network() {
	local ssid="$1"
	local priority="${2:-0}"
	local password

	# -s so the password does not stay in the terminal, and not as an argument either: everything
	# on the command line is visible to every process on the machine.
	read -r -s -p "Password for \"${ssid}\" (empty for an open network): " password
	echo

	# A profile with this name may already exist, from the Imager or from an earlier run.
	if nmcli -t -f NAME connection show | grep -Fxq "${ssid}"; then
		echo "Replacing the profile that was already there for \"${ssid}\"."
		nmcli connection delete "${ssid}" >/dev/null
	fi

	if [[ -z "${password}" ]]; then
		nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}" \
			wifi-sec.key-mgmt none >/dev/null
	else
		nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}" \
			wifi-sec.key-mgmt wpa-psk wifi-sec.psk "${password}" >/dev/null
	fi
	nmcli connection modify "${ssid}" \
		connection.autoconnect yes \
		connection.autoconnect-priority "${priority}" \
		802-11-wireless.hidden no >/dev/null

	echo "Added \"${ssid}\" with priority ${priority}."
	echo "It will connect by itself whenever this network is in range."
}

list_networks() {
	echo "Known wifi networks, most preferred first:"
	nmcli -t -f NAME,TYPE,AUTOCONNECT-PRIORITY connection show \
		| awk -F: '$2 == "802-11-wireless" { printf "  %-28s priority %s\n", $1, $3 }' \
		| sort -k3 -rn
	echo
	echo "Connected now:"
	nmcli -t -f ACTIVE,SSID,SIGNAL device wifi list --rescan no \
		| awk -F: '$1 == "yes" { printf "  %s (signal %s%%)\n", $2, $3 }' || true
	echo
	echo "Wifi country: $(iw reg get 2>/dev/null | awk '/country/ {print $2; exit}' || echo unknown)"
}

case "${1:-}" in
	add)
		require_root; require_nm
		[[ -n "${2:-}" ]] || usage
		add_network "$2" "${3:-0}"
		;;
	list)
		require_nm
		list_networks
		;;
	forget)
		require_root; require_nm
		[[ -n "${2:-}" ]] || usage
		nmcli connection delete "$2" >/dev/null && echo "Forgot \"$2\"."
		;;
	country)
		require_root
		[[ -n "${2:-}" ]] || usage
		# Without a country the radio refuses to transmit on most channels, and the symptom is a
		# board that sees no networks at all.
		raspi-config nonint do_wifi_country "$2"
		echo "Wifi country set to $2."
		;;
	*)
		usage
		;;
esac
