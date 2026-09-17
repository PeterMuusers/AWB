#!/usr/bin/env bash
#
# Put the Discord bot on the board.
#
#   sudo rpi/discord-bot/install.sh
#
# It asks for nothing. The token and the list of people who may use it go in /etc/awb-discord.env,
# which this writes as a template if it is not there yet; fill that in and start the service.
#
# The bot runs as its own user with no shell and no privileges. Everything that changes something is
# one of the small scripts below, owned by root, and the bot may run exactly those through sudo and
# nothing else. A stolen token therefore buys the commands in bot.py, not the machine.

set -euo pipefail

APP_DIR="/opt/AWB"
BOT_DIR="/opt/awb-discord"
BOT_USER="awbbot"
ENV_FILE="/etc/awb-discord.env"
KIOSK_USER="${SUDO_USER:-peter}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

[[ "${EUID}" -eq 0 ]] || { echo "Run this with sudo." >&2; exit 1; }

# the user whose session shows the board, needed for the screenshot and the browser
KIOSK_UID="$(id -u "${KIOSK_USER}")"

say "The scripts the bot is allowed to run"
install -d -m 755 /usr/local/sbin

cat > /usr/local/sbin/awb-kiosk-restart <<EOF
#!/bin/bash
# Stop the browser; the kiosk script starts it again a few seconds later.
pkill -x chromium && echo "browser gestopt, komt vanzelf terug" || echo "browser draaide niet"
EOF

cat > /usr/local/sbin/awb-cache-clear <<EOF
#!/bin/bash
# Chromium keeps its profile in .config and its HTTP cache in .cache. Clearing only the first leaves
# the board serving yesterday's stylesheet from disk, so both go.
HOME_DIR="\$(getent passwd ${KIOSK_USER} | cut -d: -f6)"
BEFORE="\$(du -sh "\${HOME_DIR}/.cache/chromium" 2>/dev/null | cut -f1)"
pkill -x chromium || true
sleep 2
rm -rf "\${HOME_DIR}/.config/chromium" "\${HOME_DIR}/.cache/chromium"
echo "cache weg (was \${BEFORE:-leeg}), browser start opnieuw"
EOF

cat > /usr/local/sbin/awb-screenshot <<EOF
#!/bin/bash
# A picture of the actual screen, not of the page: it shows where the loop is and which dropzone.
OUT="/tmp/awb-scherm.png"
sudo -u ${KIOSK_USER} env XDG_RUNTIME_DIR=/run/user/${KIOSK_UID} WAYLAND_DISPLAY=wayland-0 \\
        grim "\${OUT}" 2>/dev/null && echo "\${OUT}" || echo "geen scherm gevonden"
EOF

cat > /usr/local/sbin/awb-status <<EOF
#!/bin/bash
HOME_DIR="\$(getent passwd ${KIOSK_USER} | cut -d: -f6)"
echo "bord      : \$(hostname)  \$(uptime -p)"
echo "wifi      : \$(nmcli -t -f ACTIVE,SSID device wifi list --rescan no 2>/dev/null | grep '^yes' | cut -d: -f2)"
echo "adressen  : \$(hostname -I)"
echo "browser   : \$(pgrep -c chromium 2>/dev/null || echo 0) processen"
echo "webserver : \$(systemctl is-active lighttpd)  (\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/))"
echo "metingen  : \$(curl -s --max-time 15 'http://127.0.0.1/luchtvaartmeteo-proxy.php?action=status' | head -c 80)"
echo "cache     : \$(du -sh "\${HOME_DIR}/.cache/chromium" 2>/dev/null | cut -f1 || echo leeg)"
echo "schijf    : \$(df -h / | sed -n '2p' | tr -s ' ' | cut -d' ' -f4) vrij van \$(df -h / | sed -n '2p' | tr -s ' ' | cut -d' ' -f2)"
echo "temperatuur: \$(vcgencmd measure_temp 2>/dev/null | cut -d= -f2 || echo onbekend)"
echo "bord bijgewerkt: \$(date -r ${APP_DIR}/html/scripts/main.js '+%d-%m %H:%M' 2>/dev/null)"
EOF

# Deze twee zijn gewone Python-bestanden en geen heredoc: er zit JSON-verwerking in met
# aanhalingstekens, en die overleeft het niet om door drie lagen shell heen geschreven te worden.
install -o root -g root -m 750 "$(dirname "$0")/awb-weer" /usr/local/sbin/awb-weer
install -o root -g root -m 750 "$(dirname "$0")/awb-jumprun" /usr/local/sbin/awb-jumprun
install -o root -g root -m 750 "$(dirname "$0")/awb-summertime" /usr/local/sbin/awb-summertime

cat > /usr/local/sbin/awb-log <<'EOF'
#!/bin/bash
# The last things that went wrong, for when something looks off and you are not next to the board.
echo "== systeem =="
journalctl -p err -n 8 --no-pager -o short 2>/dev/null | tail -8 || echo "  niets"
echo
echo "== webserver =="
tail -n 6 /var/log/lighttpd/error.log 2>/dev/null || echo "  geen logbestand"
echo
echo "== browser =="
systemctl is-active lighttpd >/dev/null && echo "  webserver draait" || echo "  WEBSERVER LIGT PLAT"
pgrep -c chromium >/dev/null && echo "  browser draait ($(pgrep -c chromium) processen)" || echo "  BROWSER LIGT PLAT"
EOF

cat > /usr/local/sbin/awb-update <<EOF
#!/bin/bash
# Fetch the latest board from the repository it was installed from and put it live.
#
# .env and config.json stay put: the first holds the credentials and the second the settings of this
# particular board, and neither belongs to the repository. Everything else is replaced, so a file
# that was deleted upstream disappears here too.
set -uo pipefail
SRC=/opt/AWB-src
[ -d "\${SRC}/.git" ] || { echo "geen herkomst ingesteld; \${SRC} is geen git-kopie"; exit 1; }
WAS="\$(git -C "\${SRC}" rev-parse --short HEAD)"
GIT_SSH_COMMAND="ssh -o BatchMode=yes" git -C "\${SRC}" fetch -q origin main 2>&1 | tail -2
git -C "\${SRC}" reset -q --hard origin/main
NU="\$(git -C "\${SRC}" rev-parse --short HEAD)"
if [ "\${WAS}" = "\${NU}" ]; then
        echo "al bij: \${NU} \$(git -C "\${SRC}" log -1 --format=%s)"
else
        echo "van \${WAS} naar \${NU}"
        git -C "\${SRC}" log --oneline "\${WAS}..\${NU}" | head -6
fi
rsync -a --delete --exclude .git --exclude .env --exclude html/config.json "\${SRC}/" ${APP_DIR}/
chown -R root:www-data ${APP_DIR}/html && chmod -R a+rX ${APP_DIR}/html
/usr/local/sbin/awb-cache-clear
EOF

cat > /usr/local/sbin/awb-reboot <<'EOF'

#!/bin/bash
# A moment's grace, so the bot can answer before the machine goes down.
systemd-run --on-active=3 systemctl reboot >/dev/null 2>&1 && echo "herstart ingepland"
EOF

chmod 750 /usr/local/sbin/awb-kiosk-restart /usr/local/sbin/awb-cache-clear \
        /usr/local/sbin/awb-screenshot /usr/local/sbin/awb-status /usr/local/sbin/awb-reboot \
        /usr/local/sbin/awb-weer /usr/local/sbin/awb-jumprun /usr/local/sbin/awb-log \
        /usr/local/sbin/awb-update /usr/local/sbin/awb-summertime
note "status, scherm, kiosk-herstart, cache leegmaken, weer, jumprun, log, update, herstart"

say "The bot's own user"
id -u "${BOT_USER}" >/dev/null 2>&1 || useradd --system --home-dir "${BOT_DIR}" --shell /usr/sbin/nologin "${BOT_USER}"
install -d -o "${BOT_USER}" -g "${BOT_USER}" "${BOT_DIR}"
install -o root -g root -m 644 "$(dirname "$0")/bot.py" "${BOT_DIR}/bot.py"

# Exactly these five, nothing else, and without a password because a service cannot type one.
cat > /etc/sudoers.d/awb-discord <<EOF
${BOT_USER} ALL=(root) NOPASSWD: /usr/local/sbin/awb-kiosk-restart, /usr/local/sbin/awb-cache-clear, /usr/local/sbin/awb-screenshot, /usr/local/sbin/awb-status, /usr/local/sbin/awb-reboot, /usr/local/sbin/awb-weer, /usr/local/sbin/awb-jumprun, /usr/local/sbin/awb-log, /usr/local/sbin/awb-update, /usr/local/sbin/awb-summertime
EOF
chmod 440 /etc/sudoers.d/awb-discord
visudo -c -f /etc/sudoers.d/awb-discord >/dev/null && note "sudo-regels nagekeken en in orde"

say "Python for the bot"
python3 -m venv "${BOT_DIR}/venv" 2>/dev/null || true
"${BOT_DIR}/venv/bin/pip" -q install --upgrade pip >/dev/null 2>&1 || true
"${BOT_DIR}/venv/bin/pip" -q install "discord.py>=2.3" >/dev/null 2>&1 && note "discord.py geïnstalleerd"
chown -R "${BOT_USER}:${BOT_USER}" "${BOT_DIR}/venv"

if [[ ! -f "${ENV_FILE}" ]]; then
	cat > "${ENV_FILE}" <<'EOF'
# Het token van de bot, van https://discord.com/developers/applications -> Bot -> Reset Token.
# Dit bestand is het wachtwoord van de bot: alleen leesbaar voor de bot zelf.
AWB_DISCORD_TOKEN=

# De server waar de commando's moeten verschijnen. Met een id staan ze er meteen in; zonder duurt
# het tot een uur voordat Discord ze uitdeelt.
AWB_DISCORD_GUILD=

# Wie de commando's mag gebruiken: Discord-gebruikers-ids, gescheiden door spaties. Leeg betekent
# iedereen, en dat wil je niet voor een commando dat het bord herstart.
AWB_DISCORD_USERS=

AWB_BOARD_NAME=Het weerbord van Hoogeveen
EOF
	note "Sjabloon gezet in ${ENV_FILE} — vul het token en je eigen id in."
else
	note "${ENV_FILE} bestond al; ongemoeid gelaten."
fi
chown root:"${BOT_USER}" "${ENV_FILE}"
chmod 640 "${ENV_FILE}"

cat > /etc/systemd/system/awb-discord.service <<EOF
[Unit]
Description=Discord-bot voor het weerbord
After=network-online.target
Wants=network-online.target

[Service]
User=${BOT_USER}
EnvironmentFile=${ENV_FILE}
ExecStart=${BOT_DIR}/venv/bin/python ${BOT_DIR}/bot.py
Restart=always
RestartSec=10
# Niets meer dan nodig: geen eigen schrijfrechten buiten /tmp, geen nieuwe rechten.
NoNewPrivileges=false
PrivateTmp=false
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
note "Dienst awb-discord aangemaakt."

say "Klaar"
note "Vul ${ENV_FILE} in en start hem dan met:"
note "  sudo systemctl enable --now awb-discord"
note "Kijken of hij draait:  systemctl status awb-discord"
