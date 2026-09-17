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
apt-get -qq -y install lighttpd php-cgi php-curl rsync chromium >/dev/null
lighty-enable-mod fastcgi fastcgi-php >/dev/null 2>&1 || true

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
cat > /etc/lighttpd/conf-available/50-awb.conf <<EOF
# Written by rpi/setup.sh
server.document-root = "${APP_DIR}/html"
index-file.names = ( "index.html" )
EOF
ln -sf ../conf-available/50-awb.conf /etc/lighttpd/conf-enabled/50-awb.conf
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
WAYLAND_DISPLAY="wayland-0" wlr-randr --output ${OUTPUT} --mode ${RESOLUTION} 2>/dev/null || true

# A fresh profile every start: no crash bubble, no "restore pages?", no cache from last week.
rm -rf "\${HOME}/.config/chromium"

exec chromium --kiosk --password-store=basic --noerrdialogs --disable-infobars \\
	--disable-session-crashed-bubble --disable-features=Translate \\
	--check-for-update-interval=31536000 http://127.0.0.1/
EOF
chmod +x "${KIOSK}"
chown "${USER_NAME}:${USER_NAME}" "${KIOSK}"

# Which compositor starts it depends on the version: Bookworm uses wayfire, Trixie labwc. Write the
# one that is there, and an XDG autostart entry as a third way in case a future version changes
# again. Only one of them will actually fire.
if command -v wayfire >/dev/null 2>&1; then
	apt-get -qq -y install crudini >/dev/null
	crudini --set "${USER_HOME}/.config/wayfire.ini" "autostart" "awb" "${KIOSK}"
	# wayfire wants the refresh rate in millihertz: 50Hz is 50000.
	WAYFIRE_MODE="${RESOLUTION%Hz}"
	WAYFIRE_MODE="${WAYFIRE_MODE%@*}@$(( ${WAYFIRE_MODE##*@} * 1000 ))"
	crudini --set "${USER_HOME}/.config/wayfire.ini" "output:${OUTPUT}" "mode" "${WAYFIRE_MODE}"
	chown "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config/wayfire.ini"
	note "Started by wayfire."
fi
if command -v labwc >/dev/null 2>&1; then
	install -d -o "${USER_NAME}" -g "${USER_NAME}" "${USER_HOME}/.config/labwc"
	grep -qxF "${KIOSK} &" "${USER_HOME}/.config/labwc/autostart" 2>/dev/null \
		|| echo "${KIOSK} &" >> "${USER_HOME}/.config/labwc/autostart"
	chown "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config/labwc/autostart"
	note "Started by labwc."
fi
install -d -o "${USER_NAME}" -g "${USER_NAME}" "${USER_HOME}/.config/autostart"
cat > "${USER_HOME}/.config/autostart/awb.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Aviation Weather Board
Exec=${KIOSK}
X-GNOME-Autostart-enabled=true
EOF
chown "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config/autostart/awb.desktop"

# A board that goes black after ten minutes is not a board.
if command -v raspi-config >/dev/null 2>&1; then
	raspi-config nonint do_blanking 1 >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- check

say "Checking"
if curl -fsS -o /dev/null http://127.0.0.1/; then
	note "The web server answers on http://127.0.0.1/"
else
	note "The web server does not answer yet. Look at: journalctl -u lighttpd -n 40"
fi
if curl -fsS "http://127.0.0.1/luchtvaartmeteo-proxy.php?action=status" 2>/dev/null | grep -q '"configured":true'; then
	note "luchtvaartmeteo.nl credentials are in place."
else
	note "No luchtvaartmeteo.nl credentials yet, so the measurements stay empty. See ${APP_DIR}/.env"
fi

say "Done"
note "Reboot to see the board on the screen:  sudo reboot"
note "Add a network later, the club's for example:  sudo ${APP_DIR}/rpi/wifi.sh add \"Clubwifi\" 10"
note "Update the board from your own machine:"
note "  rsync -a --exclude .git --exclude .env ./ ${USER_NAME}@$(hostname):/tmp/awb/ && sudo rsync -a --exclude .env /tmp/awb/ ${APP_DIR}/"
