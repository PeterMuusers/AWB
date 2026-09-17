#!/usr/bin/env bash

APP_NAME="AWB"
APP_FULLNAME="Aviation Weather Board"
# Waar het bord vandaan komt. Te overschrijven zodat je vanaf een fork kunt installeren:
#   curl -s .../install.sh | sudo APP_SOURCE=https://github.com/jouwnaam/AWB bash
# Draai je dit vanuit een bestaande checkout, dan wordt die herkomst genomen. De nachtelijke updater
# leest later dezelfde herkomst uit de gekloonde map, dus wie vanaf een fork installeert blijft die
# fork volgen in plaats van een nacht later bij upstream uit te komen.
APP_SOURCE="${APP_SOURCE:-}"
APP_BRANCH="${APP_BRANCH:-}"
if [[ -z "${APP_SOURCE}" ]]; then
	SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
	# alleen als dit echt een checkout van dit project is, anders pakt hij zomaar de repository
	# waar je toevallig in staat
	if [[ -n "${SELF_DIR}" && -f "${SELF_DIR}/../html/index.html" ]]; then
		APP_SOURCE="$(git -C "${SELF_DIR}" remote get-url origin 2>/dev/null || echo "")"
	fi
fi
APP_SOURCE="${APP_SOURCE:-https://github.com/eelcohn/${APP_NAME}}"
GPIO_SHUTDOWN_PIN="17"
# LOCALE="nl_NL.UTF-8"
LOG_FILE="/var/log/${APP_NAME}/install.log"
WEATHER_URL="http://127.0.0.1/"
VIDEO_RESOLUTION_HEIGHT="1080"
VIDEO_RESOLUTION_WIDTH="1920"
VIDEO_FRAMERATE="50"


# -----------------------------
# Function to display help text
# -----------------------------
show_help() {
	echo "Usage: $0 [OPTIONS]"
	echo ""
	echo "This script sets up the Aviation Weather Board (AWB) application on a Raspberry Pi."
	echo ""
	echo "Options:"
	echo "  -h, --help          Show this help message and exit"
	echo "  -g PIN, --gpio PIN  Set GPIO pin for shutdown button (default: $GPIO_SHUTDOWN_PIN)"
	echo "  -l LOCALE           Set the locale (default: nl_NL.UTF-8, commented out)"
	echo ""
	echo "Prerequisites:"
	echo "  - The script must be run as root."
	echo "  - The Raspberry Pi must be running Raspbian OS with a supported codename (buster or bookworm)."
	echo ""
	echo "Logs can be found at: ${LOG_FILE}"
}

# --------------------------------------
# Function to check for root permissions
# --------------------------------------
check_root_permissions() {
	if [ "$EUID" -ne 0 ]; then
		echo "Please run as root"
		exit
	fi
}

# --------------------------------------
# Function to check Raspbian OS codename
# --------------------------------------
check_os_codename() {
	if [[ ! $(echo "${OS_VERSION_CODENAME}" | grep -E "buster|bookworm|trixie") ]]
	then
		echo "This script is intended for Raspbian OS codename 'buster', 'bookworm' or 'trixie'. You're using a different version: ${OS_VERSION_CODENAME}"
		read -p "Are you sure you want to continue? "
	fi
}

# --------------------------------------------------
# Function to create log directory and start logging
# --------------------------------------------------
initialize_logging() {
	mkdir -m 755 -p "/var/log/${APP_NAME}/"
	chown root:root "/var/log/${APP_NAME}/"
	touch "${LOG_FILE}"
	tail -f "${LOG_FILE}" &
	echo "$(date +%c) Installer start for ${APP_NAME}" >> "${LOG_FILE}" 2>&1
	echo "$(date +%c) OS codename: ${OS_VERSION_CODENAME}" >> "${LOG_FILE}" 2>&1
	echo "$(date +%c) Window manager: ${WINDOW_MANAGER}" >> "${LOG_FILE}" 2>&1
}

# -----------------------------
# Function to update the system
# -----------------------------
update_system() {
	echo "$(date +%c) Updating system" >> "${LOG_FILE}" 2>&1

	apt-get -y autoremove >> "${LOG_FILE}" 2>&1
	apt-get -y update >> "${LOG_FILE}" 2>&1
	apt-get -y dist-upgrade >> "${LOG_FILE}" 2>&1
	apt-get -y --with-new-pkgs upgrade >> "${LOG_FILE}" 2>&1
	apt-get -y clean >> "${LOG_FILE}" 2>&1 
}

# ----------------------------------
# Function to fix unattended updates
# ----------------------------------
fix_unattended_updates() {
	echo "$(date +%c) Fixing unattended updates" >> "${LOG_FILE}" 2>&1

	echo 'Unattended-Upgrade::Origins-Pattern {
		"origin=Debian,codename=${distro_codename},label=Debian";
		"origin=Debian,codename=${distro_codename},label=Debian-Security";
		"origin=Raspbian,codename=${distro_codename},label=Raspbian";
		"origin=Raspberry Pi Foundation,codename=${distro_codename},label=Raspberry Pi Foundation";
	};' | sudo tee "/etc/apt/apt.conf.d/51unattended-upgrades-raspbian"
}

# ----------------------------
# Function to install packages
# ----------------------------
install_packages() {
	echo "$(date +%c) Installing packages" >> "${LOG_FILE}" 2>&1

	if [[ $(echo "${OS_VERSION_CODENAME}" | grep -E "buster|bookworm") ]]
	then
		BROWSER="chromium-browser"
	else
		BROWSER="chromium"
	fi

	echo apt-get install --yes avahi-daemon ${BROWSER} crudini git nano sed tightvncserver unattended-upgrades >> "${LOG_FILE}" 2>&1
	apt-get install --yes avahi-daemon ${BROWSER} crudini git nano sed tightvncserver unattended-upgrades >> "${LOG_FILE}" 2>&1
}

# -----------------------
# Function to enable mDNS
# -----------------------
enable_mdns() {
	echo "$(date +%c) Installing packages" >> "${LOG_FILE}" 2>&1

	systemctl enable avahi-daemon
	systemctl start avahi-daemon
}
# -------------------------------------
# Function to install webserver and PHP
# -------------------------------------
install_webserver_and_php() {
	echo "$(date +%c) Installing lighttpd and PHP" >> "${LOG_FILE}" 2>&1

	apt-get install -y lighttpd php php-common php-cgi php-curl php-fpm >> "${LOG_FILE}" 2>&1
	usermod -a -G "www-data" "${USER}" >> "${LOG_FILE}" 2>&1
	echo '
	$HTTP["remoteip"] !~ "127.0.0.1" {
		url.access-deny = ( "" )
	}' >> "/etc/lighttpd/lighttpd.conf"

	# Enable the curl extention
	find /etc -name php.ini -exec crudini --set {} Global extension 'curl' \; >> "${LOG_FILE}" 2>&1

	# Enable error logging for PHP
	mkdir -p "/var/log/php"
	find /etc -name php.ini -exec crudini --set {} Global error_log '/var/log/php/error.log' \; >> "${LOG_FILE}" 2>&1
	find /etc -name php.ini -exec crudini --set {} Global log_errors 'On' \; >> "${LOG_FILE}" 2>&1
	find /etc -name php.ini -exec crudini --set {} Global error_reporting 'E_ALL & ~E_NOTICE' \; >> "${LOG_FILE}" 2>&1
}

# -------------------------------
# Function to install application
# -------------------------------
install_application() {
	echo "$(date +%c) Installing ${APP_NAME}" >> "${LOG_FILE}" 2>&1

	echo "$(date +%c) Source: ${APP_SOURCE}${APP_BRANCH:+ (branch ${APP_BRANCH})}" >> "${LOG_FILE}" 2>&1
	git clone ${APP_SOURCE} ${APP_BRANCH:+--branch "${APP_BRANCH}"} "/opt/${APP_NAME}" >> "${LOG_FILE}" 2>&1
	chmod +x /opt/${APP_NAME}/rpi/*.sh >> "${LOG_FILE}" 2>&1
	mv -f "/var/www/html" "/var/www/html.old" >> "${LOG_FILE}" 2>&1
	mv -f "/opt/${APP_NAME}/html" "/var/www/" >> "${LOG_FILE}" 2>&1
	chown -R www-data:www-data "/var/www/html" >> "${LOG_FILE}" 2>&1
	chmod -R 755 "/var/www/html" >> "${LOG_FILE}" 2>&1
}

# ----------------------------------
# Function to set locale (if needed)
# ----------------------------------
set_locale() {
	if [[ -n "${LOCALE}" ]]; then
		echo "$(date +%c) Setting locale to ${LOCALE}" >> "${LOG_FILE}" 2>&1

		locale-gen "${LOCALE}" >> "${LOG_FILE}" 2>&1
		localectl set-locale "LANG=${LOCALE}" >> "${LOG_FILE}" 2>&1
	fi
}

# --------------------------------
# Function to enable NTP time sync
# --------------------------------
enable_ntp_sync() {
	echo "$(date +%c) Enabling NTP time sync" >> "${LOG_FILE}" 2>&1

	timedatectl set-ntp True >> "${LOG_FILE}" 2>&1
}

# ------------------------------------------
# Function to add cron job for daily updates
# ------------------------------------------
add_cron_job() {
	echo "$(date +%c) Adding cron job" >> "${LOG_FILE}" 2>&1

	[[ -e "/var/spool/cron/crontabs/${SUDO_USER}" ]] || touch "/var/spool/cron/crontabs/${SUDO_USER}" >> "${LOG_FILE}" 2>&1
	grep -qxF "0 1 * * * /usr/bin/bash /opt/${APP_NAME}/rpi/updater.sh" "/var/spool/cron/crontabs/${SUDO_USER}" || echo "0 1 * * * /usr/bin/bash /opt/${APP_NAME}/rpi/updater.sh" >> "/var/spool/cron/crontabs/${SUDO_USER}"
	chown "${SUDO_USER}":"crontab" "/var/spool/cron/crontabs/${SUDO_USER}" >> "${LOG_FILE}" 2>&1
	chmod 600 "/var/spool/cron/crontabs/${SUDO_USER}" >> "${LOG_FILE}" 2>&1
	systemctl force-reload cron >> "${LOG_FILE}" 2>&1
}

# ------------------------------------------
# Function to configure GPIO shutdown button
# ------------------------------------------
configure_gpio_shutdown() {
	if [[ -n "${GPIO_SHUTDOWN_PIN}" ]]; then
		if [[ -e "/boot/config.txt" ]]; then
			CONFIG_TXT_FILE="/boot/config.txt"
		else
			CONFIG_TXT_FILE="/boot/firmware/config.txt"
		fi
		echo "$(date +%c) Configure GPIO${GPIO_SHUTDOWN_PIN} as a shutdown button for the Raspberry PI (active-low)" >> "${LOG_FILE}" 2>&1
		echo "dtoverlay=gpio-shutdown,gpio_pin=${GPIO_SHUTDOWN_PIN},active_low=1,gpio_pull=up" >> "${CONFIG_TXT_FILE}"
	fi
}

# -------------------------------------
# Function to configure TightVNC server
# -------------------------------------
configure_vnc() {
	echo "$(date +%c) Configuring TightVNC" >> "${LOG_FILE}" 2>&1

	cp "/opt/${APP_NAME}/rpi/tightvncserver.service" "/etc/systemd/system/" >> "${LOG_FILE}" 2>&1
	crudini --set "/etc/systemd/system/tightvncserver.service" Service User '${SUDO_USER}' >> "${LOG_FILE}" 2>&1
	systemctl enable tightvncserver >> "${LOG_FILE}" 2>&1
}

# ----------------------------------------------------
# Function to execute window-manager-specific commands
# ----------------------------------------------------
execute_window_manager_commands() {
	echo "$(date +%c) Executing window-manager-specific commands" >> "${LOG_FILE}" 2>&1

	case "${OS_VERSION_CODENAME}" in

		buster)
			echo "@/opt/${APP_NAME}/rpi/autostart.sh" > "/etc/xdg/lxsession/LXDE-pi/autostart"
			# Copy desktop settings to user
			mkdir -p "/home/${USER}/.config/lxsession/LXDE-pi" >> "${LOG_FILE}" 2>&1
			cp "/etc/xdg/lxsession/LXDE-pi/autostart" "/home/${USER}/.config/lxsession/LXDE-pi/" >> "${LOG_FILE}" 2>&1
#			source "/opt/${APP_NAME}/rpi/install-LXDE.sh"
			;;


		bookworm)
			source "/opt/${APP_NAME}/rpi/install-Wayland.sh"
			;;

		trixie)
			echo "/opt/${APP_NAME}/rpi/autostart.sh &" > "/home/${SUDO_USER}/.config/labwc/autostart"
			chown ${SUDO_USER}:${SUDO_USER} "/home/${SUDO_USER}/.config/labwc/autostart"
			;;

		*)
			echo "Unsupported OS version ${OS_VERSION_CODENAME} / window manager ${WINDOW_MANAGER}. You'll need to configure the auto-start of the chromium browser manually"
			;;

	esac

}

# ------------------------------------------------------
# Function to change the video resolution
# ------------------------------------------------------
change_video_resolution() {
	echo "$(date +%c) Changing video resolution" >> "${LOG_FILE}" 2>&1

	case "${OS_VERSION_CODENAME}" in

		buster)
			echo "video=HDMI-1:${VIDEO_RESOLUTION_WIDTH}${VIDEO_RESOLUTION_HEIGHT}@${VIDEO_FRAMERATE},margin_left=40,margin_right=40,margin_top=24,margin_bottom=24" >> "/boot/firmware/config.txt"
			;;

		bookworm|trixie)
			WAYLAND_DISPLAY="wayland-0" wlr-randr --output HDMI-A-1 --mode ${VIDEO_RESOLUTION_WIDTH}${VIDEO_RESOLUTION_HEIGHT}@${VIDEO_FRAMERATE}Hz >> "${LOG_FILE}" 2>&1
#			echo "video=HDMI-A-1:1920x1080M@50" >> "/boot/firmware/config.txt"
			;;

		*)
			echo "Unsupported OS version ${OS_VERSION_CODENAME} / window manager ${WINDOW_MANAGER}. You'll need to configure the video resolution manually"
			;;

	esac
}

# ------------------------------------------------------
# Function to change the Raspberry Pi boot splash screen
# ------------------------------------------------------
change_splash_screen() {
	echo "$(date +%c) Setting custom Raspberry Pi boot splash screen" >> "${LOG_FILE}" 2>&1

	apt-get install -y imagemagick >> "${LOG_FILE}" 2>&1

	SPLASH_SCREEN="/usr/share/plymouth/themes/pix/splash.png"
	mv "${SPLASH_SCREEN}" "${SPLASH_SCREEN}.backup" >> "${LOG_FILE}" 2>&1
	convert "/opt/${APP_NAME}/rpi/splash.png" \
		-font 'Cantarell-Light' \
		-pointsize 60 -fill black -gravity North -draw "text 1,26 '${APP_FULLNAME}'" \
		-pointsize 60 -fill white -gravity North -draw "text 0,25 '${APP_FULLNAME}'" \
		-pointsize 18 -fill black -gravity SouthWest -draw "text 24,24 'Raspberry Pi OS v$(cat /etc/debian_version) $(getconf LONG_BIT) bit'" \
		-pointsize 18 -fill white -gravity SouthWest -draw "text 25,25 'Raspberry Pi OS v$(cat /etc/debian_version) $(getconf LONG_BIT) bit'" \
		-pointsize 18 -fill black -gravity SouthEast -draw "text 24,24 '${APP_SOURCE}'" \
		-pointsize 18 -fill white -gravity SouthEast -draw "text 25,25 '${APP_SOURCE}'" \
		"${SPLASH_SCREEN}" >> "${LOG_FILE}" 2>&1
	plymouth-set-default-theme --rebuild-initrd pix >> "${LOG_FILE}" 2>&1

	apt-get remove -y imagemagick >> "${LOG_FILE}" 2>&1

}

# ------------------------------
# Function to restart the system
# ------------------------------
restart_system() {
	echo "$(date +%c) Installer done for ${APP_NAME}" >> "${LOG_FILE}" 2>&1

	echo -n 'Restarting in 10 seconds...'
	for i in {0..10}; do
		sleep 1
		echo -n .
	done
	reboot >> "${LOG_FILE}" 2>&1
}

# --------------------------
# Main installation function
# --------------------------
main() {

	# Parse options
	while [[ "$1" ]]; do
		case "$1" in
			-h|--help)
				show_help
				exit 0
				;;
			-g)
				GPIO_SHUTDOWN_PIN="$2"
				shift 2
				;;
			-l)
				LOCALE="$2"
				shift 2
				;;
			*)
				echo "Invalid option: $1"
				show_help
				exit 1
				;;
		esac
	done

	OS_VERSION_CODENAME="$(cat /etc/os-release | grep VERSION_CODENAME | cut -d = -f 2)"
	SESSION_ID="$(loginctl list-sessions | awk '/^ *[0-9]+/ {print $1; exit}')"
	WINDOW_MANAGER="$(loginctl show-session 1 | grep Type | cut -d = -f 2)"

	check_root_permissions
	check_os_codename
	initialize_logging
	update_system
	fix_unattended_updates
	install_packages
	install_webserver_and_php
	install_application
	enable_mdns
	set_locale
	enable_ntp_sync
	add_cron_job
	configure_gpio_shutdown
	configure_vnc
	execute_window_manager_commands
	change_video_resolution
	change_splash_screen
	restart_system
}

# Execute the main function
main "$@"
