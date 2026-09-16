/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

const ID_SYSTEMMESSAGE = 'systemmessage';
const CLASS_SYSTEMMESSAGE_SHOW = 'systemmessage-show';
const ICON_TREND_DOWN = 'mdi-arrow-bottom-right';
const ICON_TREND_UP = 'mdi-arrow-top-right';
const SUN_HORIZON = -0.833;		// degrees, the standard horizon including refraction
const WIND_DIRECTIONS = [
	'N',
	'NNE',
	'NE',
	'ENE',
	'E',
	'ESE',
	'SE',
	'SSE',
	'S',
	'SSW',
	'SW',
	'WSW',
	'W',
	'WNW',
	'NW',
	'NNW',
];

/* Create a system message popup modal */
function createSystemMessage(message) {
	document.getElementById(ID_SYSTEMMESSAGE).innerHTML = message;
	document.getElementById(ID_SYSTEMMESSAGE).classList.add(CLASS_SYSTEMMESSAGE_SHOW);
}

/* Remove a system message popup modal */
function removeSystemMessage() {
	document.getElementById(ID_SYSTEMMESSAGE).classList.remove(CLASS_SYSTEMMESSAGE_SHOW);
}

/* Set compass needle */
function setCompass(id, degrees) {
	if (degrees > 180) {
		degrees -= 360;
	}
	document.getElementById(id).style.transform = 'rotate(' + degrees + 'deg)';
}

/* Calculate trend TODO make a generic function */
function setTrend(id, current, previous) {
	if (previous !== null) {
		if (Number(current) < Number(previous)) {
			document.getElementById(id).innerHTML = '<span class="iconify" data-icon="' + ICON_TREND_DOWN + '"></span>';
//			document.getElementById(id).dataset.icon = ICON_TREND_DOWN;
		} else if (Number(current) > Number(previous)) {
			document.getElementById(id).innerHTML = '<span class="iconify" data-icon="' + ICON_TREND_UP + '"></span>';
//			document.getElementById(id).dataset.icon = ICON_TREND_UP;
		} else {
			document.getElementById(id).innerHTML = '';
//			document.getElementById(id).dataset.icon = null;
		}
	}
}

/* Elevation of the sun in degrees (standard low-precision solar position, good to about 0.1
   degree), so sunrise and sunset can be computed on the board itself instead of being fetched. */
function sunElevation(date, latitude, longitude) {
	var rad = Math.PI / 180;
	var days = (date.getTime() / 86400000) - 10957.5;	// days since 1 January 2000, 12:00 UTC
	var meanLongitude = 280.460 + 0.9856474 * days;
	var meanAnomaly = (357.528 + 0.9856003 * days) * rad;
	var eclipticLongitude = (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * rad;
	var obliquity = (23.439 - 0.0000004 * days) * rad;
	var declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
	var rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)) / rad;
	var siderealTime = 18.697374558 + 24.06570982441908 * days;
	var hourAngle = (((siderealTime % 24) * 15 + longitude - rightAscension + 180) % 360 - 180) * rad;
	return Math.asin(Math.sin(latitude * rad) * Math.sin(declination) + Math.cos(latitude * rad) * Math.cos(declination) * Math.cos(hourAngle)) / rad;
}

/* Sunrise and sunset for the day of the given date, as {sunrise, sunset} (null when the sun does
   not cross the horizon that day). Found by walking the day in minutes and looking for the
   crossing of -0.833 degrees, the standard horizon including refraction: short and robust, and
   the board only does this once per update. */
function sunTimes(date, latitude, longitude) {
	var start = new Date(date);
	start.setHours(0, 0, 0, 0);
	var result = { sunrise: null, sunset: null };
	var previous = sunElevation(start, latitude, longitude);
	for (var minute = 1; minute <= 24 * 60; minute++) {
		var moment = new Date(start.getTime() + minute * 60000);
		var elevation = sunElevation(moment, latitude, longitude);
		if (previous < SUN_HORIZON && elevation >= SUN_HORIZON && result.sunrise === null) {
			result.sunrise = moment;
		}
		if (previous >= SUN_HORIZON && elevation < SUN_HORIZON && result.sunset === null) {
			result.sunset = moment;
		}
		previous = elevation;
	}
	return result;
}

/* Returns a readable string representing the wind direction */
function windDegreesToDirection(degrees) {
	degrees += ((360 / WIND_DIRECTIONS.length) / 2);
	if (degrees >= 360) {
		degrees -= 360;
	}
	return WIND_DIRECTIONS[Math.floor(degrees / (360 / WIND_DIRECTIONS.length))];
}

export {
	createSystemMessage,
	removeSystemMessage,
	setCompass,
	setTrend,
	sunElevation,
	sunTimes,
	windDegreesToDirection,
};

