#!/usr/bin/env bash
#
# Set up a Raspberry Pi as a weather board, from the copy of the project you are standing in.
#
# This sits next to install.sh rather than replacing it. install.sh is the one-line installer that
# fetches the project from GitHub and configures a Pi in one go; use that if you want the released
# board and nothing else. This one exists for the cases that one does not cover:
#
#   - it installs what is in this checkout, not what is on GitHub, so a fork or a branch that has
#     not been published anywhere still ends up on the board;
#   - it sets up wifi, because a board that has no network cable has to know its networks before it
#     is any use, and it can know several (see wifi.sh);
#   - it puts the credentials file in place and says what happens without it;
#   - it can put the board in your Tailscale network, which is the only way you will still
#     reach it once it hangs on a club's wifi that you do not control;
#   - it does not install a nightly updater. install.sh does, and that updater pulls from the
#     repository it was built with. On a fork that means your board quietly turns back into
#     somebody else's overnight.
#
# It asks before it changes anything and every answer has a default, so pressing enter all the way
# through is a reasonable install. Running it again is safe: it rewrites what it owns and leaves the
# rest alone.
#
#   sudo rpi/setup.sh              ask about everything
#   sudo rpi/setup.sh --yes        take every default, ask nothing
#
# Raspberry Pi OS Bookworm or Trixie, the version with a desktop: the board is a browser in kiosk
# mode, so there has to be something to put it on.

set -euo pipefail

APP_NAME="AWB"
APP_DIR="/opt/${APP_NAME}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="${SUDO_USER:-${USER}}"
USER_HOME="$(getent passwd "${USER_NAME}" | cut -d: -f6)"
ASSUME_YES=0
[[ "${1:-}" == "--yes" ]] && ASSUME_YES=1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

ask() {
	local question="$1" default="$2" answer
	if [[ "${ASSUME_YES}" -eq 1 ]]; then
		echo "${default}"
		return
	fi
	read -r -p "${question} [${default}]: " answer </dev/tty
	echo "${answer:-${default}}"
}

confirm() {
	local question="$1" answer
	[[ "${ASSUME_YES}" -eq 1 ]] && return 0
	read -r -p "${question} [y/N]: " answer </dev/tty
	[[ "${answer}" =~ ^[jJyY] ]]
}

# ---------------------------------------------------------------- checks

[[ "${EUID}" -eq 0 ]] || { echo "Run this with sudo." >&2; exit 1; }

CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-unknown}")"
case "${CODENAME}" in
	bookworm|trixie) ;;
	*)
		echo "This is written for Raspberry Pi OS bookworm or trixie; this one says '${CODENAME}'." >&2
		echo "Older versions set wifi up differently and use a different compositor." >&2
		exit 1
		;;
esac

if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
	note "No Chromium found yet; it will be installed. Make sure this is the desktop version of"
	note "Raspberry Pi OS: the board is a browser filling the screen, so it needs one."
fi

say "Board setup for ${USER_NAME} on ${CODENAME}"
note "This checkout: ${SOURCE_DIR}"
note "Will be installed to: ${APP_DIR}"

# ---------------------------------------------------------------- wifi

if confirm "Set up wifi networks now?"; then
	COUNTRY="$(ask "Wifi country (two letters)" "NL")"
	"${SOURCE_DIR}/rpi/wifi.sh" country "${COUNTRY}"
	while true; do
		SSID="$(ask "Network name, empty to stop" "")"
		[[ -z "${SSID}" ]] && break
		PRIORITY="$(ask "Priority for \"${SSID}\" (higher wins; give a hotspot a low one)" "0")"
		"${SOURCE_DIR}/rpi/wifi.sh" add "${SSID}" "${PRIORITY}"
	done
	"${SOURCE_DIR}/rpi/wifi.sh" list
fi

# ---------------------------------------------------------------- packages

say "Installing what the board needs"
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq -y install lighttpd php-cgi php-curl rsync chromium curl >/dev/null
lighty-enable-mod fastcgi fastcgi-php >/dev/null 2>&1 || true

# PHP onder lighttpd mag geen uitvoerbaar geheugen aanvragen, dus de JIT van de reguliere-
# expressiemotor kan niet starten. Dat is onschuldig - hij valt terug op de gewone motor en de
# proxies draaien een handvol kleine patronen - maar het levert bij elk verzoek een waarschuwing in
# het foutlogboek op, en een logboek vol ruis is een logboek waarin je een echt probleem mist.
for ini in /etc/php/*/cgi/conf.d; do
	[ -d "${ini}" ] || continue
	printf '; Geschreven door rpi/setup.sh\n; De JIT kan onder lighttpd toch niet starten; dit scheelt een waarschuwing per verzoek.\npcre.jit=0\n' > "${ini}/99-awb.ini"
	note "PCRE JIT uit in $(basename "$(dirname "${ini}")")"
done

# Een logboek dat een herstart overleeft. Zonder dit staat het journaal in RAM, en dan is na een
# onverwachte herstart precies het stuk weg dat je nodig hebt: wat er vlak daarvoor gebeurde. Met
# grenzen erbij, want dit is een SD-kaart: tweehonderd megabyte in totaal, bestanden van hoogstens
# twintig, en niets ouder dan een maand.
install -d -m 2755 -o root -g systemd-journal /var/log/journal 2>/dev/null || mkdir -p /var/log/journal
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/99-awb.conf <<'EOF'
# Geschreven door rpi/setup.sh
[Journal]
Storage=persistent
SystemMaxUse=200M
SystemMaxFileSize=20M
MaxRetentionSec=1month
EOF
systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
systemctl restart systemd-journald >/dev/null 2>&1 || true
note "Logboek blijft nu bewaard over herstarts heen (max 200 MB, een maand)"

# ---------------------------------------------------------------- reaching it later

# A board at a club hangs on somebody else's network. You do not control that router, .local names
# are often blocked between clients, and nobody is going to read an IP address off a screen in the
# hangar for you. Tailscale gives the board one name that works from anywhere, over a network you
# do not have to ask permission for.
#
# The key is a one-off: Tailscale trades it for the machine's own identity at first login and it is
# never needed again. Make it single-use and short-lived at https://login.tailscale.com/admin/settings/keys
# and it is worthless by the time anyone could find it.
if confirm "Put this board in your Tailscale network, so you can reach it from anywhere?"; then
	if ! command -v tailscale >/dev/null 2>&1; then
		# Their own apt repository rather than piping their install script into a shell: signed
		# packages, and updates come along with every other package on the machine.
		say "Installing Tailscale"
		# Their apt repository, so updates arrive with every other package. It is keyed on the Debian
		# codename, and a brand new Raspberry Pi OS can be out before that path exists; then their own
		# install script, which works out what the machine is, is the honest fallback.
		if curl -fsSL "https://pkgs.tailscale.com/stable/raspbian/${CODENAME}.noarmor.gpg" \
				> /usr/share/keyrings/tailscale-archive-keyring.gpg \
			&& curl -fsSL "https://pkgs.tailscale.com/stable/raspbian/${CODENAME}.tailscale-keyring.list" \
				> /etc/apt/sources.list.d/tailscale.list \
			&& apt-get -qq update && apt-get -qq -y install tailscale >/dev/null; then
			note "From the Tailscale apt repository for ${CODENAME}."
		else
			note "No apt repository for ${CODENAME}; using the Tailscale install script instead."
			rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg
			curl -fsSL https://tailscale.com/install.sh | sh
		fi
	fi
	if tailscale status >/dev/null 2>&1; then
		note "Already signed in as $(tailscale status --json | sed -n 's/.*"DNSName": *"\([^.]*\).*/\1/p' | head -n 1)"
	else
		note "Paste an auth key (tskey-auth-...). Leave it empty to sign in from a browser instead."
		read -r -s -p "  Auth key: " TSKEY </dev/tty
		echo
		if [[ -n "${TSKEY}" ]]; then
			# --ssh: reach the board over Tailscale even when the wifi it is on blocks everything
			# else. Same identity as the rest of your tailnet, no second set of keys to lose.
			tailscale up --authkey "${TSKEY}" --hostname "$(hostname)" --ssh
			note "In your tailnet as $(hostname). Reach it with: ssh ${USER_NAME}@$(hostname)"
		else
			tailscale up --hostname "$(hostname)" --ssh --timeout 120s || true
		fi
	fi
fi

# ---------------------------------------------------------------- the board itself

say "Putting the board in ${APP_DIR}"
if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
	mkdir -p "${APP_DIR}"
	# --exclude .git: the board does not need the history, and it keeps the card smaller.
	# .env is excluded on purpose too; it is handled below and must never be overwritten by a copy.
	rsync -a --delete --exclude '.git' --exclude '.env' "${SOURCE_DIR}/" "${APP_DIR}/"
fi
chown -R root:www-data "${APP_DIR}/html"
chmod -R a+rX "${APP_DIR}/html"

# lighttpd serves the checkout directly, so updating the board is copying files and nothing else.
# The document root is changed in lighttpd.conf itself rather than added in a file of our own:
# lighttpd.conf already sets it, and lighttpd refuses a second assignment of the same setting
# outright - "Duplicate config variable in conditional 0 global" - and then does not start at all.
rm -f /etc/lighttpd/conf-enabled/50-awb.conf /etc/lighttpd/conf-available/50-awb.conf
if grep -q '^server.document-root' /etc/lighttpd/lighttpd.conf; then
	sed -i "s|^server.document-root.*|server.document-root        = \"${APP_DIR}/html\"|" /etc/lighttpd/lighttpd.conf
else
	echo "server.document-root        = \"${APP_DIR}/html\"" >> /etc/lighttpd/lighttpd.conf
fi
# Say what is wrong while the reason is still on the screen, instead of failing three steps later.
if ! lighttpd -tt -f /etc/lighttpd/lighttpd.conf >/dev/null 2>&1; then
	note "The lighttpd configuration does not pass its own check:"
	lighttpd -tt -f /etc/lighttpd/lighttpd.conf 2>&1 | grep -viE 'locale|perl:|LANG|LC_' | tail -5
fi
systemctl restart lighttpd

# ---------------------------------------------------------------- credentials

say "Credentials"
if [[ -f "${APP_DIR}/.env" ]]; then
	note "There is already a .env; leaving it alone."
else
	install -m 600 -o root -g www-data "${APP_DIR}/.env.example" "${APP_DIR}/.env"
	note "Made ${APP_DIR}/.env from the example. Nothing in it is filled in yet."
	note "Without an account for luchtvaartmeteo.nl the board shows no measurements at all."
	note "Fill it in with:  sudo nano ${APP_DIR}/.env"
fi
chmod 640 "${APP_DIR}/.env"
chown root:www-data "${APP_DIR}/.env"

# ---------------------------------------------------------------- kiosk

say "Starting the board on the screen"
RESOLUTION="$(ask "Screen resolution and refresh rate" "1920x1080@50Hz")"
OUTPUT="$(ask "Which HDMI output" "HDMI-A-1")"

install -d -o "${USER_NAME}" -g "${USER_NAME}" "${USER_HOME}/.config"
KIOSK="${USER_HOME}/awb-kiosk.sh"
cat > "${KIOSK}" <<EOF
#!/usr/bin/env bash
# Written by rpi/setup.sh. The board in kiosk mode.

# One board, one browser. More than one autostart can fire - a compositor's own and the XDG entry
# both did on Trixie - and two browsers on one screen is two of everything: two loops, two sets of
# requests, and a screen that flickers between them.
exec 9>/tmp/awb-kiosk.lock
flock -n 9 || exit 0

WAYLAND_DISPLAY="wayland-0" wlr-randr --output ${OUTPUT} --mode ${RESOLUTION} 2>/dev/null || true

# Keep starting it. A browser that falls over takes the whole screen with it, and there is nobody
# at the club to notice, let alone to start it again. A few seconds later it is simply back.
while true; do
	# A fresh profile every start: no crash bubble, no "restore pages?", no cache from last week.
	# Both directories, because Chromium keeps its profile in .config and its HTTP cache in .cache:
	# clearing only the first leaves the board serving yesterday's stylesheet from disk, and a change
	# you just deployed does not appear however often you restart it.
	rm -rf "\${HOME}/.config/chromium" "\${HOME}/.cache/chromium"
	chromium --kiosk --password-store=basic --noerrdialogs --disable-infobars \\
		--disable-session-crashed-bubble --disable-features=Translate,TranslateUI \\
		--check-for-update-interval=31536000 "http://127.0.0.1/?kiosk=1"
	sleep 3
done
EOF
chmod +x "${KIOSK}"
chown "${USER_NAME}:${USER_NAME}" "${KIOSK}"

# Geen muisaanwijzer op dit scherm, van welke muis hij ook komt. De stylesheet zet hem al op none,
# maar dat werkt pas zodra de aanwijzer over de pagina beweegt - en er hangt geen muis aan de Pi:
# wie op afstand meekijkt stuurt er een, en dan staat er een pijltje midden op de televisie in de
# kantine dat daar blijft staan. Een cursorthema dat uit een doorzichtig plaatje bestaat haalt het
# bij de wortel weg: de compositor tekent hem, maar er is niets te zien.
CURSOR_THEME="awb-onzichtbaar"
python3 - "/usr/share/icons/${CURSOR_THEME}/cursors" <<'PYEOF'
import os, struct, sys

# Het Xcursor-formaat, met een beeldje van één doorzichtige pixel.
SIZE, IMAGE = 24, 0xfffd0002
image = struct.pack('<IIIIIIIII', 36, IMAGE, SIZE, 1, 1, 1, 0, 0, 0) + struct.pack('<I', 0)
header = struct.pack('<IIII', 0x72756358, 16, 0x00010000, 1)
toc = struct.pack('<III', IMAGE, SIZE, len(header) + 12)

folder = sys.argv[1]
os.makedirs(folder, exist_ok=True)
with open(os.path.join(folder, 'left_ptr'), 'wb') as handle:
    handle.write(header + toc + image)
for name in ('default', 'arrow', 'top_left_arrow', 'left_ptr_watch', 'watch',
             'text', 'xterm', 'hand1', 'hand2', 'pointer', 'grab', 'grabbing'):
    link = os.path.join(folder, name)
    if not os.path.exists(link):
        os.symlink('left_ptr', link)
PYEOF
printf '[Icon Theme]\nName=%s\n' "${CURSOR_THEME}" > "/usr/share/icons/${CURSOR_THEME}/index.theme"

# Which compositor starts it depends on the version: Bookworm uses wayfire, Trixie labwc. Write the
# one that is there, and an XDG autostart entry as a third way in case a future version changes
# again. Only one of them will actually fire.
STARTED_BY="none"
if command -v wayfire >/dev/null 2>&1; then
	apt-get -qq -y install crudini >/dev/null
	crudini --set "${USER_HOME}/.config/wayfire.ini" "autostart" "awb" "${KIOSK}"
	# wayfire wants the refresh rate in millihertz: 50Hz is 50000.
	WAYFIRE_MODE="${RESOLUTION%Hz}"
	WAYFIRE_MODE="${WAYFIRE_MODE%@*}@$(( ${WAYFIRE_MODE##*@} * 1000 ))"
	crudini --set "${USER_HOME}/.config/wayfire.ini" "output:${OUTPUT}" "mode" "${WAYFIRE_MODE}"
	crudini --set "${USER_HOME}/.config/wayfire.ini" "input" "cursor_theme" "${CURSOR_THEME}"
	chown "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config/wayfire.ini"
	STARTED_BY="wayfire"
	note "Started by wayfire."
fi
# Het scherm vastzetten op de maat waarop dit bord gemaakt is. Het kioskscript zet die maat al bij
# het starten, maar dat is één keer: gaat de televisie uit en weer aan, dan onderhandelt hij opnieuw
# en kiest hij zijn eigen voorkeur - een 4K-scherm kiest 4K, en dan wordt dit bord van 1920 bij 1080
# omhoog geschaald. Zwaarder voor de Pi, en de twee grafieken worden er onscherp van, want die
# tekenen op canvas. kanshi kijkt mee en zet hem terug zodra het scherm zich opnieuw meldt.
if command -v labwc >/dev/null 2>&1 || command -v wayfire >/dev/null 2>&1; then
	apt-get -qq -y install kanshi >/dev/null 2>&1 || true
	install -d -o "${USER_NAME}" -g "${USER_NAME}" "${USER_HOME}/.config/kanshi"
	cat > "${USER_HOME}/.config/kanshi/config" <<EOF
# Geschreven door rpi/setup.sh; zet het scherm terug op de maat van dit bord.
profile {
	output ${OUTPUT} enable mode ${RESOLUTION} position 0,0 scale 1
}
EOF
	chown "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config/kanshi/config"
fi

if command -v labwc >/dev/null 2>&1; then
	install -d -o "${USER_NAME}" -g "${USER_NAME}" "${USER_HOME}/.config/labwc"
	grep -qxF "kanshi &" "${USER_HOME}/.config/labwc/autostart" 2>/dev/null \
		|| sed -i '1i kanshi &' "${USER_HOME}/.config/labwc/autostart" 2>/dev/null \
		|| echo "kanshi &" > "${USER_HOME}/.config/labwc/autostart"
	grep -qxF "${KIOSK} &" "${USER_HOME}/.config/labwc/autostart" 2>/dev/null \
		|| echo "${KIOSK} &" >> "${USER_HOME}/.config/labwc/autostart"
	chown "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config/labwc/autostart"
	touch "${USER_HOME}/.config/labwc/environment"
	grep -q '^XCURSOR_THEME=' "${USER_HOME}/.config/labwc/environment" \
		|| printf 'XCURSOR_THEME=%s\nXCURSOR_SIZE=24\n' "${CURSOR_THEME}" >> "${USER_HOME}/.config/labwc/environment"
	chown "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config/labwc/environment"
	STARTED_BY="labwc"
	note "Started by labwc."
fi
# Only when neither compositor took it: on Trixie labwc and this entry both fired, and the board
# came up twice. A third way in is worth having, but not at the same time as the first.
if [ "${STARTED_BY}" = "none" ]; then
install -d -o "${USER_NAME}" -g "${USER_NAME}" "${USER_HOME}/.config/autostart"
cat > "${USER_HOME}/.config/autostart/awb.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Aviation Weather Board
Exec=${KIOSK}
X-GNOME-Autostart-enabled=true
EOF
chown "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config/autostart/awb.desktop"
	note "Started by an XDG autostart entry."
else
	rm -f "${USER_HOME}/.config/autostart/awb.desktop"
fi

# A board that goes black after ten minutes is not a board.
if command -v raspi-config >/dev/null 2>&1; then
	raspi-config nonint do_blanking 1 >/dev/null 2>&1 || true
	# And a board showing a login screen is not a board either. Nobody types a password into a
	# screen in a hangar, and until somebody logs in there is no session, so nothing starts the
	# browser at all. B4 is the desktop with automatic login, for the first user.
	if [ "$(raspi-config nonint get_autologin 2>/dev/null)" != "0" ]; then
		raspi-config nonint do_boot_behaviour B4 >/dev/null 2>&1 \
			&& note "Logging in automatically as ${USER_NAME} from now on." \
			|| note "Could not switch on automatic login; the board will stop at a login screen."
	fi
fi

# ---------------------------------------------------------------- check

say "Checking"
# A moment for lighttpd to finish coming up. Asking the instant after a restart gets a refused
# connection and prints a worrying message about a board that is in fact perfectly fine.
for _ in 1 2 3 4 5; do
	curl -fsS -o /dev/null http://127.0.0.1/ 2>/dev/null && break
	sleep 1
done
if curl -fsS -o /dev/null http://127.0.0.1/; then
	note "The web server answers on http://127.0.0.1/"
else
	note "The web server does not answer yet. Look at: journalctl -u lighttpd -n 40"
fi
# The proxy talks to luchtvaartmeteo.nl, so give it longer than a local page would need.
if curl -fsS --max-time 25 "http://127.0.0.1/luchtvaartmeteo-proxy.php?action=status" 2>/dev/null | grep -q '"configured":true'; then
	note "luchtvaartmeteo.nl credentials are in place."
else
	note "No luchtvaartmeteo.nl credentials yet, so the measurements stay empty. See ${APP_DIR}/.env"
fi

say "Done"
note "Reboot to see the board on the screen:  sudo reboot"
note "Add a network later, the club's for example:  sudo ${APP_DIR}/rpi/wifi.sh add \"Clubwifi\" 10"
note "Update the board from your own machine:"
note "  rsync -a --exclude .git --exclude .env ./ ${USER_NAME}@$(hostname):/tmp/awb/ && sudo rsync -a --exclude .env /tmp/awb/ ${APP_DIR}/"
