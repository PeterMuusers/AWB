#!/usr/bin/env bash

APP_MAINTAINER="eelcohn"
APP_NAME="AWB"
LOG_FILE="/var/log/${APP_NAME}/update.log"
LAST_RUN_FILE="/var/log/${APP_NAME}/update.last_run"
VERSION_FILE="/opt/${APP_NAME}/VERSION"
GIT_DIR="/opt/${APP_NAME}/.git"
BRANCH="$(git --git-dir=${GIT_DIR} rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

# Bijwerken vanaf de plek waar deze installatie vandaan komt, en niet vanaf een adres dat hier
# hardcoded staat. Wie vanaf een fork installeert wil de fork blijven volgen; anders verandert zijn
# bord na één nacht in dat van iemand anders.
APP_SOURCE="$(git --git-dir=${GIT_DIR} remote get-url origin 2>/dev/null || echo "https://github.com/${APP_MAINTAINER}/${APP_NAME}")"
# eigenaar/repo uit de herkomst halen, voor het VERSION-bestand dat we rauw opvragen
APP_SLUG="$(echo "${APP_SOURCE}" | sed -E 's#^(https?://[^/]+/|git@[^:]+:)##; s#\.git$##')"

echo "" >> "${LOG_FILE}" 2>&1
echo "$(date +%c) ---------- Updating and rebooting system ----------" >> "${LOG_FILE}" 2>&1

# ----------------------------------
# Check if user has root permissions
# ----------------------------------
if [ "$EUID" -ne 0 ]
then
	echo "$(date +%c) Please run as root" >> "${LOG_FILE}" 2>&1
	exit
fi

# ---------------------------
# Remount /boot as read/write
# ---------------------------
if [[ `findmnt -n -o OPTIONS /boot | egrep "^ro,|,ro,|,ro$"` ]]
then
	mount -o remount,rw /boot >> "${LOG_FILE}" 2>&1
fi

# ------------------------------------------------
# Create log directory if it doesn't exist already
# ------------------------------------------------
[ ! -d "/var/log/${APP_NAME}" ] && mkdir -m 755 -p "/var/log/${APP_NAME}/"

# -------------
# Update system
# -------------
touch "${LAST_RUN_FILE}" >> "${LOG_FILE}" 2>&1
apt-get -qq -y dist-upgrade >> "${LOG_FILE}" 2>&1
apt-get -qq -y --with-new-pkgs upgrade >> "${LOG_FILE}" 2>&1
apt-get -qq -y clean >> "${LOG_FILE}" 2>&1 
apt-get -qq -y autoremove >> "${LOG_FILE}" 2>&1

echo "$(date +%c) Updating system" >> "${LOG_FILE}" 2>&1
apt-get -qq -y update >> "${LOG_FILE}" 2>&1
echo "$(date +%c) Dist-upgrading system" >> "${LOG_FILE}" 2>&1
apt-get -qq -y dist-upgrade >> "${LOG_FILE}" 2>&1
echo "$(date +%c) Upgrading system" >> "${LOG_FILE}" 2>&1
apt-get -qq -y --with-new-pkgs upgrade >> "${LOG_FILE}" 2>&1
echo "$(date +%c) Cleaning system" >> "${LOG_FILE}" 2>&1
apt-get -qq -y clean >> "${LOG_FILE}" 2>&1 
echo "$(date +%c) Autoremove system" >> "${LOG_FILE}" 2>&1
apt-get -qq -y autoremove >> "${LOG_FILE}" 2>&1

# ------------------
# Update application
# ------------------
LOCAL_VERSION="`cat ${VERSION_FILE}`"
# Het VERSION-bestand van de tak waar deze installatie op staat, bij de eigenaar waar hij vandaan
# komt. Zit de herkomst niet op GitHub, dan kunnen we het zo niet opvragen en slaan we over in
# plaats van te gokken: een verkeerde bron binnenhalen is erger dan een nacht niet bijwerken.
case "${APP_SOURCE}" in
	*github.com*)
		EXT_VERSION="$(curl -s "https://raw.githubusercontent.com/${APP_SLUG}/${BRANCH}/VERSION")"
		;;
	*)
		echo "$(date +%c) ${APP_SOURCE} is not on GitHub, so the version cannot be checked; skipping" >> "${LOG_FILE}" 2>&1
		EXT_VERSION="${LOCAL_VERSION}"
		;;
esac
if [ "${LOCAL_VERSION}" != "${EXT_VERSION}" ]
then
	echo "`date +%c` New ${APP_NAME} version found: ${EXT_VERSION} (Local version: ${LOCAL_VERSION})" >> "${LOG_FILE}" 2>&1
	rm -rf "/opt/${APP_NAME}.new" >> "${LOG_FILE}" 2>&1
	if ! git clone ${APP_SOURCE} "/opt/${APP_NAME}.new" --branch ${BRANCH} >> "${LOG_FILE}" 2>&1
	then
		echo "$(date +%c) Could not clone new ${APP_NAME} version"
 	else
		sudo chmod +x /opt/${APP_NAME}.new/rpi/*.sh >> "${LOG_FILE}" 2>&1
		rm -rf "/opt/${APP_NAME}.old" >> "${LOG_FILE}" 2>&1
		mv -f "/opt/${APP_NAME}" "/opt/${APP_NAME}.old" >> "${LOG_FILE}" 2>&1
		mv -f "/opt/${APP_NAME}.new" "/opt/${APP_NAME}" >> "${LOG_FILE}" 2>&1
		rm -rf "/var/www/html.old" >> "${LOG_FILE}" 2>&1
		mv -f "/var/www/html" "/var/www/html.old" >> "${LOG_FILE}" 2>&1
		mv -f "/opt/${APP_NAME}/html" "/var/www/" >> "${LOG_FILE}" 2>&1
		cp -a "/var/www/html.old/config.json" "/var/www/html/" >> "${LOG_FILE}" 2>&1
		sudo chown -R www-data:www-data /var/www/html >> "${LOG_FILE}" 2>&1
		sudo chmod -R 755 /var/www/html >> "${LOG_FILE}" 2>&1
 	fi
fi

# -------
# Restart
# -------
echo "`date +%c` Updating done" >> "${LOG_FILE}" 2>&1

/usr/sbin/shutdown -r now >> "${LOG_FILE}" 2>&1
