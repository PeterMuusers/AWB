/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { DATE_OPTIONS_LOCAL, UNIT_FEET, UNIT_KNOTS } from '../const.js';
import { LANGUAGE_SOURCE, LANGUAGE_LAST_UPDATED, LANGUAGE_NOW, LANGUAGE_GROUND, LANGUAGE_FREEZING_LEVEL_AT, LANGUAGE_MEASURED } from '../language.js';

/*
 * Wind profile for the dropzone: wind per altitude for now and the coming hours, plus the height
 * of the freezing level and the cloud layers the model expects.
 *
 * Open-Meteo gives wind and the geopotential height of a set of pressure levels per hour, free and
 * without a key, and it allows cross origin requests so the board can ask for it directly. From
 * those levels we interpolate the wind as a vector to the altitudes that matter for jumping, the
 * same way the radar screen of jumprun.nl does it. The wind at the bottom of the table is not
 * modelled but measured, taken from the luchtvaartmeteo module.
 */

const SOURCE = 'Open-Meteo';
const API_URL = 'https://api.open-meteo.com/v1/forecast';

const ID_WINDS_SOURCE_LABEL = 'winds-source-label';
const ID_WINDS_SOURCE_DATA = 'winds-source-data';
const ID_WINDS_LAST_UPDATED_LABEL = 'winds-last-updated-label';
const ID_WINDS_LAST_UPDATED_SPINNER = 'winds-last-updated-spinner';
const ID_WINDS_LAST_UPDATED_WARNING = 'winds-last-updated-warning';
const ID_LAST_UPDATED = 'winds-last-updated';
const ID_VALID_FROM = 'winds-valid-from';
const ID_TABLE_HEAD = 'upper-winds-content-head';
const ID_TABLE_BODY = 'uppper-winds-content-data';
const ID_FREEZING_ALTITUDE = 'freezing-altitude-data';

/* Pressure levels with wind, and the levels used for the cloud layers */
const WIND_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500];
const CLOUD_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300];
const CLOUD_MIN_PERCENT = 12.5;			// one eighth
const FEET_PER_METER = 3.28084;
const MAX_LAYERS = 3;

class Module {
	constructor() {
		this.config = document.config.aloft || {};
		this.model = this.config.model || 'icon_d2';
		this.hoursAhead = (this.config.hoursAhead !== undefined) ? this.config.hoursAhead : 2;
		this.altitudes = (document.config.upperwinds || []).slice().sort((first, second) => second - first);
		this.refreshInterval = 15 * 60 * 1000; // Refresh interval is 15 minutes

		this.last_updated = null;
		this.hours = [];		// [{time, levels: {ft: {kt, dir}}, freezing, layers}]

		/* Set language specific stuff */
		document.getElementById(ID_WINDS_SOURCE_LABEL).innerHTML = LANGUAGE_SOURCE;
		document.getElementById(ID_WINDS_SOURCE_DATA).innerHTML = SOURCE + ' ' + this.model;
		document.getElementById(ID_WINDS_LAST_UPDATED_LABEL).innerHTML = LANGUAGE_LAST_UPDATED;

		/* Schedule update of document content */
		this.task = setInterval(
			this.updateData.bind(this),
			this.refreshInterval
		);

		/* Initial fill of document content */
		this.updateData();
	}

	apiUrl() {
		var fields = ['freezing_level_height', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
		WIND_LEVELS.forEach(level => {
			fields.push('wind_speed_' + level + 'hPa', 'wind_direction_' + level + 'hPa', 'geopotential_height_' + level + 'hPa', 'temperature_' + level + 'hPa');
		});
		CLOUD_LEVELS.forEach(level => {
			fields.push('cloud_cover_' + level + 'hPa');
			if (WIND_LEVELS.indexOf(level) === -1) {
				fields.push('geopotential_height_' + level + 'hPa');
			}
		});
		var query = {
			latitude: document.config.location.lattitude,
			longitude: document.config.location.longitude,
			hourly: fields.join(','),
			models: this.model,
			wind_speed_unit: 'kn',
			past_hours: 1,
			forecast_hours: this.hoursAhead + 2,
			timezone: 'UTC',
		};
		return API_URL + '?' + Object.keys(query).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(query[key])).join('&');
	}

	/* Wind at one altitude, interpolated as a vector between the two pressure levels around it */
	interpolate(profile, feet) {
		if (profile.length < 2 || feet < profile[0].feet || feet > profile[profile.length - 1].feet) {
			return null;
		}
		for (var i = 0; i < profile.length - 1; i++) {
			var below = profile[i];
			var above = profile[i + 1];
			if (below.feet <= feet && feet <= above.feet) {
				var fraction = (above.feet === below.feet) ? 0 : (feet - below.feet) / (above.feet - below.feet);
				var east = below.east + fraction * (above.east - below.east);
				var north = below.north + fraction * (above.north - below.north);
				return {
					kt: Math.round(Math.sqrt(east * east + north * north)),
					/* the direction the wind comes from */
					dir: Math.round((Math.atan2(-east, -north) * 180 / Math.PI + 360) % 360),
					temp: (below.temp === null || above.temp === null) ? null : Math.round(below.temp + fraction * (above.temp - below.temp)),
				};
			}
		}
		return null;
	}

	/* Cloud layers from the cover per pressure level: neighbouring levels with at least one eighth
	   form one layer. A model estimate, not a ceilometer. */
	cloudLayers(hourly, index, elevation) {
		var layers = [];
		var current = null;
		CLOUD_LEVELS.slice().sort((first, second) => second - first).forEach(level => {
			var cover = (hourly['cloud_cover_' + level + 'hPa'] || [])[index];
			var height = (hourly['geopotential_height_' + level + 'hPa'] || [])[index];
			if (cover === null || cover === undefined || height === null || height === undefined) {
				return;
			}
			var feet = Math.round((height - elevation) * FEET_PER_METER / 100) * 100;
			if (cover >= CLOUD_MIN_PERCENT) {
				if (current === null) {
					current = { base: feet, top: feet, percent: cover };
				} else {
					current.top = feet;
					current.percent = Math.max(current.percent, cover);
				}
			} else if (current !== null) {
				layers.push(current);
				current = null;
			}
		});
		if (current !== null) {
			layers.push(current);
		}
		return layers.map(layer => ({ base: layer.base, top: layer.top, okta: Math.round(layer.percent / 12.5) }))
			.filter(layer => layer.okta >= 1)
			.slice(0, MAX_LAYERS);
	}

	updateData() {
		/* Disable warning icon */
		document.getElementById(ID_WINDS_LAST_UPDATED_WARNING).style.display = 'none';

		/* Enable spinner icon */
		document.getElementById(ID_WINDS_LAST_UPDATED_SPINNER).style.display = 'block';

		/* Fetch data from the API (Open-Meteo allows cross origin requests, so no proxy) */
		fetch(
			this.apiUrl(),
			{
				keepalive: true,
				headers: {
					Accept: 'application/json',
				},
			}
		).then(response => {
			if (response.ok === true) {
				return response.json();
			}
			console.warn(SOURCE + ': returned HTTP error ' + response.status + ' (' + response.statusText + ')');
			return null;
		}).then(data => {
			document.getElementById(ID_WINDS_LAST_UPDATED_SPINNER).style.display = 'none';
			if (data === null || !data.hourly || !data.hourly.time) {
				document.getElementById(ID_WINDS_LAST_UPDATED_WARNING).style.display = 'block';
				return;
			}
			this.hours = this.parse(data);
			this.last_updated = new Date();
			this.showData();
		}).catch(error => {
			document.getElementById(ID_WINDS_LAST_UPDATED_SPINNER).style.display = 'none';
			document.getElementById(ID_WINDS_LAST_UPDATED_WARNING).style.display = 'block';
			console.error(error);
		});
	}

	parse(data) {
		var hourly = data.hourly;
		var elevation = Number(data.elevation || 0);
		return hourly.time.map((time, index) => {
			var profile = [];
			WIND_LEVELS.forEach(level => {
				var height = hourly['geopotential_height_' + level + 'hPa'][index];
				var speed = hourly['wind_speed_' + level + 'hPa'][index];
				var direction = hourly['wind_direction_' + level + 'hPa'][index];
				var temperature = (hourly['temperature_' + level + 'hPa'] || [])[index];
				if (height === null || speed === null || direction === null) {
					return;
				}
				var radians = direction * Math.PI / 180;
				profile.push({
					feet: (height - elevation) * FEET_PER_METER,
					/* where the wind blows to, as a vector */
					east: -speed * Math.sin(radians),
					north: -speed * Math.cos(radians),
					temp: (temperature === null || temperature === undefined) ? null : Number(temperature),
				});
			});
			profile.sort((first, second) => first.feet - second.feet);

			var levels = {};
			this.altitudes.forEach(feet => {
				var wind = this.interpolate(profile, feet);
				if (wind !== null) {
					levels[feet] = wind;
				}
			});
			var freezing = hourly.freezing_level_height[index];
			return {
				time: new Date(time + 'Z'),
				levels: levels,
				ground: {
					kt: Math.round(hourly.wind_speed_10m[index]),
					dir: Math.round(hourly.wind_direction_10m[index]),
					gust: Math.round(hourly.wind_gusts_10m[index]),
				},
				freezing: (freezing === null) ? null : Math.round((freezing - elevation) * FEET_PER_METER / 100) * 100,
				layers: this.cloudLayers(hourly, index, elevation),
			};
		});
	}

	/* The hours shown in the table: the one closest to now, then the hours after it */
	columns() {
		if (this.hours.length === 0) {
			return [];
		}
		var now = Date.now();
		var nearest = 0;
		this.hours.forEach((hour, index) => {
			if (Math.abs(hour.time.getTime() - now) < Math.abs(this.hours[nearest].time.getTime() - now)) {
				nearest = index;
			}
		});
		return this.hours.slice(nearest, nearest + this.hoursAhead + 1);
	}

	/* An arrow pointing the way the wind blows */
	arrow(direction) {
		return '<span class="wind-arrow iconify" data-icon="mdi-arrow-up" style="transform: rotate(' + ((direction + 180) % 360) + 'deg)"></span>';
	}

	cell(wind, extra, forecast) {
		if (!wind) {
			return '<td class="windcell' + (forecast ? ' windcell-forecast' : '') + '"></td>';
		}
		return '<td class="windcell' + (forecast ? ' windcell-forecast' : '') + '">' + this.arrow(wind.dir)
			+ '<span class="windspeed">' + wind.kt + '</span>'
			+ (extra || '')
			+ '<span class="winddirection">' + wind.dir + '&deg;</span></td>';
	}

	showData() {
		var columns = this.columns();
		if (columns.length === 0) {
			return;
		}
		var clock = time => time.toLocaleTimeString(document.config.locale, { hour: '2-digit', minute: '2-digit' });

		/* Column headers: now and the hours after it */
		document.getElementById(ID_TABLE_HEAD).innerHTML = '<tr><th><span class="windtext-header">' + UNIT_FEET + '</span></th>'
			+ columns.map((hour, index) => '<th' + (index === 0 ? '' : ' class="windcell-forecast"') + '><span class="windtext-header">' + (index === 0 ? LANGUAGE_NOW : clock(hour.time)) + '</span></th>').join('')
			+ '</tr>';

		/* One row per altitude, highest first, with the freezing level drawn in between */
		var freezing = columns[0].freezing;
		var rows = '';
		var freezingDrawn = false;
		this.altitudes.forEach(feet => {
			if (freezing !== null && !freezingDrawn && feet < freezing) {
				rows += '<tr class="freezing-row"><td colspan="' + (columns.length + 1) + '">'
					+ LANGUAGE_FREEZING_LEVEL_AT + ' ' + freezing.toLocaleString(document.config.locale) + '&nbsp;' + UNIT_FEET + '</td></tr>';
				freezingDrawn = true;
			}
			var temperature = (columns[0].levels[feet] && columns[0].levels[feet].temp !== null)
				? '<span class="windtemperature">' + columns[0].levels[feet].temp + '&nbsp;&deg;C</span>' : '';
			rows += '<tr><td class="windtext">' + feet.toLocaleString(document.config.locale) + temperature + '</td>'
				+ columns.map((hour, index) => this.cell(hour.levels[feet], '', index > 0)).join('') + '</tr>';
		});

		/* The ground row: measured now, modelled for the hours after it */
		var measured = (document.modules || {}).luchtvaartmeteo;
		var observation = measured ? measured.observation : null;
		rows += '<tr class="ground-row"><td class="windtext">' + LANGUAGE_GROUND + '</td>';
		rows += columns.map((hour, index) => {
			if (index === 0 && observation && observation.wind_kt !== null && observation.wind_dir !== null) {
				var gust = (observation.gust_kt !== null && observation.gust_kt > observation.wind_kt + 1)
					? '<span class="windgust">G' + Math.round(observation.gust_kt) + '</span>' : '';
				return this.cell({ kt: Math.round(observation.wind_kt), dir: Math.round(observation.wind_dir) }, gust);
			}
			var modelled = (hour.ground.gust > hour.ground.kt + 1) ? '<span class="windgust">G' + hour.ground.gust + '</span>' : '';
			return this.cell(hour.ground, modelled, index > 0);
		}).join('');
		rows += '</tr>';
		document.getElementById(ID_TABLE_BODY).innerHTML = rows;

		/* The freezing level also goes in the metrics panel */
		if (freezing !== null && document.getElementById(ID_FREEZING_ALTITUDE)) {
			document.getElementById(ID_FREEZING_ALTITUDE).innerHTML = freezing.toLocaleString(document.config.locale) + '&nbsp;<span class="metrics-unit">' + UNIT_FEET + '</span>';
		}

		document.getElementById(ID_VALID_FROM).innerHTML = UNIT_KNOTS + ' &middot; ' + LANGUAGE_MEASURED;
		document.getElementById(ID_LAST_UPDATED).innerHTML = this.last_updated.toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL);
	}
}

export { Module };
