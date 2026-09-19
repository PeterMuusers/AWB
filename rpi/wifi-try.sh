#!/usr/bin/env bash
#
# Een ander wifi-netwerk proberen zonder het bord kwijt te raken.
#
#   sudo rpi/wifi-try.sh "Skydive Hoogeveen" [terugval] [minuten]
#
# Overstappen naar een netwerk dat je nog niet kent is eenrichtingsverkeer: lukt het niet, dan hangt
# het bord aan een netwerk waar niemand meer bij kan. Dit script maakt er een proef van met een
# afloop. Het onthoudt waar je vandaan komt, kijkt eerst of dat er straks nog is, stapt dan over,
# probeert een eventueel captive portal te openen, en zet het bord terug als het niet lukt - net
# zolang tot het oude netwerk hem weer aanneemt.
#
# Wat het onderweg tegenkomt komt in /var/lib/awb/wifi-try.log te staan. Dat is het hele punt van
# deze omweg: na afloop zit het bord weer op het oude netwerk en ligt het verslag klaar.
#
# De proef draait los van de aanroep (systemd-run), want de verbinding waarover je hem start valt
# er zelf uit zodra hij overstapt.

set -uo pipefail

SSID="${1:-}"
BACK="${2:-}"
MINUTES="${3:-4}"
REPORT=/var/lib/awb/wifi-try.log
CAPTIVE=/usr/local/sbin/awb-captive
# De bootpartitie is FAT, en dat is de enige partitie die een Mac kan lezen. Blijft het bord toch
# ergens hangen, dan is de kaart eruit halen de laatste weg naar binnen - en dan ligt het verslag
# daar klaar in plaats van op een partitie waar je niet bij kunt.
CARD=/boot/firmware/awb-debug

if [[ "${EUID}" -ne 0 ]]; then
	echo "Run this with sudo." >&2
	exit 1
fi
if [[ -z "${SSID}" ]]; then
	awk 'NR > 2 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"
	exit 1
fi

mkdir -p /var/lib/awb
say() {
	echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "${REPORT}"
	echo "$*"
}

# Het verslag mee naar de kaart. Na elke stap, niet alleen aan het eind: als dit misgaat is het
# juist de laatste regel die we willen lezen, en een proef die halverwege sneuvelt schrijft die
# niet meer.
keep() {
	[[ -d /boot/firmware ]] || return 0
	mkdir -p "${CARD}" 2>/dev/null || return 0
	cp -f "${REPORT}" "${CARD}/wifi-try.log" 2>/dev/null
	cp -f /var/lib/awb/captive-last.html "${CARD}/captive-last.html" 2>/dev/null
	sync
}

# Waar komen we vandaan? Het actieve profiel, tenzij je zelf iets anders noemt.
if [[ -z "${BACK}" ]]; then
	BACK="$(nmcli -t -f NAME,DEVICE connection show --active | awk -F: '$2 != "" { print $1; exit }')"
fi
if [[ -z "${BACK}" ]]; then
	say "er is nu geen actieve verbinding; dan is er ook niets om op terug te vallen"
	exit 1
fi

# Is dat terugvalnetwerk er straks nog? Een telefoonhotspot zet zichzelf uit zodra de laatste
# client vertrekt - precies wat er gebeurt als dit bord ervan af stapt. Dan is de weg terug al
# afgesloten voor we vertrekken, en daar komen we pas achter als het te laat is.
BACK_SSID="$(nmcli -t -f 802-11-wireless.ssid connection show "${BACK}" 2>/dev/null | cut -d: -f2-)"
if [[ -n "${BACK_SSID}" ]]; then
	if ! nmcli -t -f SSID device wifi list --rescan yes | grep -Fxq "${BACK_SSID}"; then
		say "\"${BACK_SSID}\" is nu niet in de lucht; zet hem aan voor we vertrekken"
		exit 1
	fi
fi

say "proef: van \"${BACK}\" naar \"${SSID}\", uiterlijk ${MINUTES} minuten"
keep

# De wachthond loopt apart en overleeft alles wat hierna misgaat, ook een script dat halverwege
# sneuvelt. Hij is de enige reden dat deze proef veilig is.
systemctl reset-failed awb-wifi-back.service 2>/dev/null
systemd-run --unit=awb-wifi-back --on-active="$((MINUTES * 60))" \
	/bin/bash -c "for i in \$(seq 1 30); do nmcli connection up '${BACK}' && exit 0; sleep 20; done" \
	>/dev/null 2>&1
say "wachthond staat: over ${MINUTES} minuten terug naar \"${BACK}\", en dan tien minuten lang blijven proberen"

if ! nmcli connection up "${SSID}" >/dev/null 2>&1; then
	say "verbinden met \"${SSID}\" lukte niet"
	nmcli connection up "${BACK}" >/dev/null 2>&1
	systemctl stop awb-wifi-back.timer 2>/dev/null
	exit 1
fi
say "verbonden met \"${SSID}\" ($(nmcli -t -f IP4.ADDRESS device show wlan0 | cut -d: -f2- | head -1))"
keep

# Nu het portaal. Het script hierachter probeert het een paar keer: vlak na een lease is er wel een
# adres maar nog geen naamserver, en dan lijkt een netwerk dat prima werkt even helemaal dood.
if [[ -x "${CAPTIVE}" ]]; then
	"${CAPTIVE}" run >> "${REPORT}" 2>&1
	RESULT=$?
else
	say "geen ${CAPTIVE} gevonden"
	RESULT=1
fi

if [[ "${RESULT}" -eq 0 ]]; then
	say "het werkt: er is internet op \"${SSID}\""
	systemctl stop awb-wifi-back.timer 2>/dev/null
	systemctl reset-failed awb-wifi-back.service 2>/dev/null
	say "de wachthond is weggehaald; \"${SSID}\" blijft staan"
	keep
	exit 0
fi

say "geen internet op \"${SSID}\"; terug naar \"${BACK}\""
keep
nmcli connection up "${BACK}" >/dev/null 2>&1 && say "terug op \"${BACK}\"" || say "terugkeren lukte niet; de wachthond blijft het proberen"
keep
exit 1
