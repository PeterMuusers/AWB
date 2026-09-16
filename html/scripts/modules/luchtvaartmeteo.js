/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { DATE_OPTIONS_LOCAL, UNIT_CELCIUS, UNIT_FEET, UNIT_HECTOPASCAL, UNIT_KILOMETERS, UNIT_KNOTS, UNIT_METERS_PER_SECOND } from '../const.js';
import { createSystemMessage, sunElevation, sunTimes } from '../functions.js';
import {
	LANGUAGE_SOURCE, LANGUAGE_LAST_UPDATED, LANGUAGE_WIND, LANGUAGE_WIND_DIRECTION, LANGUAGE_VISIBILITY,
	LANGUAGE_PRECIPITATION, LANGUAGE_TEMPERATURE, LANGUAGE_DEWPOINT, LANGUAGE_FREEZING_ALTITUDE, LANGUAGE_PRESSURE,
	LANGUAGE_SUNRISE, LANGUAGE_SUNSET, LANGUAGE_AT, LANGUAGE_NO_CLOUDS, LANGUAGE_DRY, LANGUAGE_MEASURED_AT,
	LANGUAGE_SKY,
} from '../language.js';

/*
 * KNMI observations from the API behind luchtvaartmeteo.nl (login required), measured at a real
 * station instead of modelled: wind and gusts, temperature, dew point, humidity, QNH, visibility,
 * the cloud layers of the ceilometer and precipitation. The login and the API calls are done
 * server-side by luchtvaartmeteo-proxy.php; this module fills the metrics panel with the result.
 *
 * The summary line, the icon and the sunrise and sunset times are derived here from those same
 * measurements and from the position of the sun, so the board needs no second weather source.
 */

const SOURCE = 'luchtvaartmeteo.nl';
const PROXY_URL = './luchtvaartmeteo-proxy.php';
const HTTP_SERVICE_UNAVAILABLE = 503; // the proxy has no (valid) credentials file

const ID_METRICS_SOURCE_LABEL = 'metrics-source-label';
const ID_METRICS_SOURCE_DATA = 'metrics-source-data';
const ID_METRICS_LAST_UPDATED_LABEL = 'metrics-last-updated-label';
const ID_METRICS_LAST_UPDATED_SPINNER = 'metrics-last-updated-spinner';
const ID_METRICS_LAST_UPDATED_WARNING = 'metrics-last-updated-warning';
const ID_LAST_UPDATED = 'metrics-last-updated';
const ID_LOCATION = 'location-data';
const ID_ICON = 'metrics-icon';
const ID_SUMMARY = 'metrics-data';
const ID_NOTE = 'metrics-note';
const ID_CLOUDBASE = 'cloudbase-data';
const ID_CLOUDBASE_LAYERS = 'cloudbase-layers';

/* Each cell of the grid: label, value, unit and an optional second line */
const CELLS = [
	{ label: 'wind-label', text: () => LANGUAGE_WIND },
	{ label: 'wind-direction-label', text: () => LANGUAGE_WIND_DIRECTION },
	{ label: 'visibility-label', text: () => LANGUAGE_VISIBILITY },
	{ label: 'precipitation-label', text: () => LANGUAGE_PRECIPITATION },
	{ label: 'temperature-label', text: () => LANGUAGE_TEMPERATURE },
	{ label: 'dewpoint-label', text: () => LANGUAGE_DEWPOINT },
	{ label: 'freezing-altitude-label', text: () => LANGUAGE_FREEZING_ALTITUDE },
	{ label: 'pressure-label', text: () => LANGUAGE_PRESSURE },
	{ label: 'sunrise-label', text: () => LANGUAGE_SUNRISE },
	{ label: 'sunset-label', text: () => LANGUAGE_SUNSET },
];

/* Cloud amount in eighths to the aviation abbreviation */
const CLOUD_AMOUNTS = [
	{ upto: 0, code: 'SKC' },
	{ upto: 2, code: 'FEW' },
	{ upto: 4, code: 'SCT' },
	{ upto: 7, code: 'BKN' },
	{ upto: 8, code: 'OVC' },
];

/* Icon and summary, from our own measurements: precipitation and visibility first, then the
   cloud cover, and below the horizon the night variant. */
const SKY_ICONS = {
	rain: 'mdi-weather-pouring',
	fog: 'mdi-weather-fog',
	clear: 'mdi-weather-sunny',
	clear_night: 'mdi-weather-night',
	few: 'mdi-weather-partly-cloudy',
	few_night: 'mdi-weather-night-partly-cloudy',
	scattered: 'mdi-weather-partly-cloudy',
	scattered_night: 'mdi-weather-night-partly-cloudy',
	broken: 'mdi-weather-cloudy',
	overcast: 'mdi-weather-cloudy',
};

const VISIBILITY_FOG = 1000;			// metres, below this it counts as fog
const VISIBILITY_MAX = 100000;			// metres, the sensor caps out here
const KNOTS_TO_MS = 0.514444;
const FEET_ROUNDING = 100;				// cloud base is reported to the nearest hundred feet

function cloudAmountCode(okta) {
	var amount = CLOUD_AMOUNTS.find(step => okta <= step.upto);
	return amount ? amount.code : 'OVC';
}

class Module {
	constructor(location) {
		this.location = location;
		this.station = document.config.luchtvaartmeteo.station || 'hoogeveen';
		/* The station publishes every ten minutes and the proxy holds on to an answer until the next
		   one is due, so asking often costs nothing beyond the dropzone and keeps what the board shows
		   within a couple of minutes of what was measured. */
		this.refreshInterval = 2 * 60 * 1000; // Refresh interval is 2 minutes

		this.last_updated = null;
		this.observed_at = null;
		this.observation = null;
		this.series = null;		// the past hours per field, for the chart under the panel
		this.units = null;

		this.unit = (document.config.luchtvaartmeteo.windUnit === 'kt') ? UNIT_KNOTS : UNIT_METERS_PER_SECOND;
		this.jumpLimit = document.config.luchtvaartmeteo.jumpLimit;
		this.jumpLimitText = document.config.luchtvaartmeteo.jumpLimitText || '';

		/* Set language specific stuff */
		document.getElementById(ID_METRICS_SOURCE_LABEL).innerHTML = LANGUAGE_SOURCE;
		document.getElementById(ID_METRICS_SOURCE_DATA).innerHTML = SOURCE;
		document.getElementById(ID_METRICS_LAST_UPDATED_LABEL).innerHTML = LANGUAGE_LAST_UPDATED;
		CELLS.forEach(cell => {
			document.getElementById(cell.label).innerHTML = cell.text();
		});

		/* Schedule update of document content */
		this.task = setInterval(
			this.updateData.bind(this),
			this.refreshInterval
		);

		/* Initial fill of document content */
		this.updateData();
	}

	updateData() {
		/* Disable warning icon */
		document.getElementById(ID_METRICS_LAST_UPDATED_WARNING).style.display = 'none';

		/* Enable spinner icon */
		document.getElementById(ID_METRICS_LAST_UPDATED_SPINNER).style.display = 'block';

		var url = PROXY_URL + '?action=observations&station=' + encodeURIComponent(this.station);
		if (this.location) {
			url += '&location=' + encodeURIComponent(this.location);
		}

		/* Fetch data from the proxy */
		fetch(
			url,
			{
				keepalive: true,
				headers: {
					Accept: 'application/json',
				},
			}
		).then(response => {
			return response.json().then(data => {
				if (response.ok === true) {
					return data;
				}
				if (response.status === HTTP_SERVICE_UNAVAILABLE) {
					/* Credentials not set on the server: report once and stop polling */
					createSystemMessage(data && data.error ? data.error : 'luchtvaartmeteo.nl credentials not set.');
					clearInterval(this.task);
				}
				console.warn(SOURCE + ': returned HTTP error ' + response.status + ' (' + (data && data.error ? data.error : response.statusText) + ')');
				return null;
			});
		}).then(data => {
			/* Disable spinner icon */
			document.getElementById(ID_METRICS_LAST_UPDATED_SPINNER).style.display = 'none';

			if (data === null || !data.observation) {
				document.getElementById(ID_METRICS_LAST_UPDATED_WARNING).style.display = 'block';
				return;
			}
			this.last_updated = new Date();
			this.observed_at = data.time ? new Date(data.time) : null;
			this.observation = data.observation;
			this.series = data.series || null;
			this.units = data.units;
			this.showData();
		}).catch(error => {
			document.getElementById(ID_METRICS_LAST_UPDATED_SPINNER).style.display = 'none';
			document.getElementById(ID_METRICS_LAST_UPDATED_WARNING).style.display = 'block';
			console.error(error);
		});
	}

	/* Value of a field, or null when the station did not report it */
	value(field) {
		var value = this.observation ? this.observation[field] : null;
		return (value === null || value === undefined || isNaN(Number(value))) ? null : Number(value);
	}

	/* The cloud layers of the ceilometer, lowest first */
	layers() {
		var layers = [];
		[1, 2, 3].forEach(number => {
			var base = this.value('base' + number + '_ft');
			var okta = this.value('okta' + number);
			if (base !== null && okta !== null && okta > 0) {
				layers.push({ base: Math.round(base / FEET_ROUNDING) * FEET_ROUNDING, okta: Math.round(okta) });
			}
		});
		return layers.sort((first, second) => first.base - second.base);
	}

	/* Summary and icon from our own measurements */
	sky() {
		var night = sunElevation(new Date(), document.config.location.lattitude, document.config.location.longitude) < 0;
		var rain = this.value('rain_mmh');
		var visibility = this.value('vis_m');
		if (rain !== null && rain > 0) {
			return { key: 'rain', icon: SKY_ICONS.rain };
		}
		if (visibility !== null && visibility < VISIBILITY_FOG) {
			return { key: 'fog', icon: SKY_ICONS.fog };
		}
		var okta = this.value('okta_total');
		var key = 'clear';
		if (okta !== null) {
			if (okta >= 7) {
				key = 'overcast';
			} else if (okta >= 5) {
				key = 'broken';
			} else if (okta >= 3) {
				key = 'scattered';
			} else if (okta >= 1) {
				key = 'few';
			}
		}
		var icon = (night && SKY_ICONS[key + '_night']) ? SKY_ICONS[key + '_night'] : SKY_ICONS[key];
		return { key: key, icon: icon };
	}

	set(id, html) {
		document.getElementById(id).innerHTML = (html === null || html === undefined) ? '' : html;
	}

	showData() {
		/* Station and how far it is from the dropzone */
		this.set(ID_LOCATION, document.config.luchtvaartmeteo.stationName || this.station);
		this.set(ID_NOTE, document.config.luchtvaartmeteo.note || LANGUAGE_MEASURED_AT + ' ' + (document.config.luchtvaartmeteo.stationName || this.station));

		/* Summary and icon */
		var sky = this.sky();
		document.getElementById(ID_ICON).setAttribute('data-icon', sky.icon);
		this.set(ID_SUMMARY, LANGUAGE_SKY[sky.key] || '');

		/* Cloud base: the lowest layer as the big number, the rest behind it */
		var layers = this.layers();
		if (layers.length === 0) {
			this.set(ID_CLOUDBASE, LANGUAGE_NO_CLOUDS);
			this.set(ID_CLOUDBASE_LAYERS, '');
		} else {
			var lowest = layers[0];
			this.set(ID_CLOUDBASE, lowest.base.toLocaleString(document.config.locale)
				+ '&nbsp;<span class="metrics-unit">' + UNIT_FEET + '</span>'
				+ '<span class="metrics-cloudbase-code">' + cloudAmountCode(lowest.okta) + ' ' + lowest.okta + '/8</span>');
			/* the layers above it, so the headline stays about the lowest one */
			this.set(ID_CLOUDBASE_LAYERS, layers.slice(1).map(layer => cloudAmountCode(layer.okta) + ' ' + layer.okta + '/8 '
				+ LANGUAGE_AT + ' ' + layer.base.toLocaleString(document.config.locale) + ' ' + UNIT_FEET).join(' &middot; '));
		}

		/* Wind, in the unit from config.json */
		var wind = this.value('wind_kt');
		var gust = this.value('gust_kt');
		var toUnit = knots => (this.unit === UNIT_KNOTS) ? Math.round(knots) : (knots * KNOTS_TO_MS).toFixed(1);
		this.set('wind-value', wind === null ? '' : toUnit(wind));
		this.set('wind-unit', this.unit);
		this.set('wind-gust', (gust !== null && wind !== null && gust > wind + 1) ? '&nbsp;G' + toUnit(gust) : '');
		var direction = this.value('wind_dir');
		this.set('wind-direction-degrees', direction === null ? '' : Math.round(direction));
		/* an arrow pointing the way the wind blows, the same one the wind profile uses. The rotation
		   sits on an outer span: iconify replaces the inner element with an svg of its own. */
		this.set('wind-direction-arrow', direction === null ? ''
			: '<span class="wind-arrow" style="transform: rotate(' + ((Math.round(direction) + 180) % 360) + 'deg)">'
				+ '<span class="iconify" data-icon="mdi-arrow-up"></span></span>');

		/* Jump limit warning, when configured */
		var limitElement = document.getElementById('wind-jumplimit');
		var strongest = (gust !== null) ? gust : wind;
		if (this.jumpLimit && strongest !== null && Number(toUnit(strongest)) >= this.jumpLimit) {
			limitElement.innerHTML = this.jumpLimitText;
			limitElement.style.display = 'block';
		} else {
			limitElement.style.display = 'none';
		}

		/* Visibility: the sensor caps out, show that as a plus */
		var visibility = this.value('vis_m');
		if (visibility === null) {
			this.set('visibility-value', '');
			this.set('visibility-unit', '');
		} else if (visibility >= VISIBILITY_MAX) {
			this.set('visibility-value', Math.round(visibility / 1000) + '+');
			this.set('visibility-unit', UNIT_KILOMETERS);
		} else if (visibility >= 5000) {
			this.set('visibility-value', (visibility / 1000).toFixed(0));
			this.set('visibility-unit', UNIT_KILOMETERS);
		} else {
			this.set('visibility-value', Math.round(visibility / 100) * 100);
			this.set('visibility-unit', 'm');
		}

		/* Precipitation */
		var rain = this.value('rain_mmh');
		this.set('precipitation-data', (rain === null || rain === 0) ? LANGUAGE_DRY : rain.toFixed(1) + '&nbsp;<span class="metrics-unit">mm/h</span>');

		/* Temperature, dew point and pressure */
		var temperature = this.value('temp_c');
		this.set('temperature-data', temperature === null ? '' : temperature.toFixed(1));
		var dewpoint = this.value('dewpoint_c');
		this.set('dewpoint-data', dewpoint === null ? '' : dewpoint.toFixed(1));
		var pressure = this.value('qnh_hpa');
		this.set('pressure-value', pressure === null ? '' : pressure.toFixed(0));
		this.set('pressure-unit', UNIT_HECTOPASCAL);

		/* Sunrise and sunset, computed for the dropzone itself */
		var sun = sunTimes(new Date(), document.config.location.lattitude, document.config.location.longitude);
		var clock = moment => (moment === null) ? '' : moment.toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL);
		this.set('sunrise-data', clock(sun.sunrise));
		this.set('sunset-data', clock(sun.sunset));

		this.set(ID_LAST_UPDATED, (this.observed_at || this.last_updated).toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL));
	}
}

export { Module };
