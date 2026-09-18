/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { DATE_OPTIONS_LOCAL, UNIT_FEET, UNIT_KNOTS } from '../const.js';
import { LANGUAGE_SOURCE, LANGUAGE_UPDATED_INLINE, LANGUAGE_NOW, LANGUAGE_GROUND, LANGUAGE_FREEZING_LEVEL_AT, LANGUAGE_MEASURED, LANGUAGE_GLOVES } from '../language.js';

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
/* The altitude the aircraft drops from. A freezing level under it means the jumpers meet the cold
   on the way out, which is where the club rule about gloves comes from, so the board marks it. */
const EXIT_ALTITUDE = 12000;			// feet
const SIGNIFICANT_SHIFT = 30;			// degrees; a turn of this much gets a colour of its own
/* De wind onderin bepaalt hoe ver de spot eruit moet en of een koepel nog terugkomt. Boven deze
   grens wordt hij gemarkeerd, op elke hoogte tot en met vijfduizend voet. De grondrij blijft
   ongemoeid: die draagt al de kleur van de stoten en zou anders twee signalen tegelijk dragen. */
const LOW_WIND_LIMIT = 25;				// knots
const LOW_WIND_BELOW = 5000;			// feet; hieronder telt de grens, want dat is de hoogte waar je
										// nog iets aan je plek kunt doen en waar de koepelrit begint
/* Boven die hoogte hangt de springer nog aan de vrije val en drijft hij gewoon mee; daar telt pas
   veel hardere wind, omdat die de uitloop van de jumprun en de afstand tussen de groepen bepaalt. */
const HIGH_WIND_LIMIT = 45;				// knots, boven LOW_WIND_BELOW

class Module {
	constructor() {
		this.config = document.config.aloft || {};
		/* Het KNMI-mengsel: HARMONIE voor de korte termijn met ECMWF daarachter, en hetzelfde model
		   waarmee jumprun.nl rekent. HARMONIE zelf kan niet: Open-Meteo geeft daarvoor geen waarden op
		   drukniveaus terug, en zonder drukniveaus is er geen windprofiel. */
		this.model = this.config.model || 'knmi_seamless';
		this.hoursAhead = (this.config.hoursAhead !== undefined) ? this.config.hoursAhead : 2;
		this.altitudes = (document.config.upperwinds || []).slice().sort((first, second) => second - first);
		this.exitAltitude = (this.config.exitAltitude !== undefined) ? this.config.exitAltitude : EXIT_ALTITUDE;
		this.coldText = (this.config.coldText !== undefined) ? this.config.coldText : LANGUAGE_GLOVES;
		this.windLimit = (this.config.windLimit !== undefined) ? this.config.windLimit : LOW_WIND_LIMIT;
		this.windLimitBelow = (this.config.windLimitBelow !== undefined) ? this.config.windLimitBelow : LOW_WIND_BELOW;
		this.windLimitHigh = (this.config.windLimitHigh !== undefined) ? this.config.windLimitHigh : HIGH_WIND_LIMIT;
		this.refreshInterval = 15 * 60 * 1000; // Refresh interval is 15 minutes

		this.last_updated = null;
		this.hours = [];		// [{time, levels: {ft: {kt, dir}}, freezing, layers}]

		/* Set language specific stuff */
		document.getElementById(ID_WINDS_SOURCE_LABEL).innerHTML = LANGUAGE_SOURCE;
		document.getElementById(ID_WINDS_SOURCE_DATA).innerHTML = SOURCE;
		document.getElementById(ID_WINDS_LAST_UPDATED_LABEL).innerHTML = LANGUAGE_UPDATED_INLINE;

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

	/* The height where the temperature crosses zero, interpolated from the profile. Not every model
	   reports a freezing level of its own, and this keeps it consistent with the temperatures shown
	   next to the altitudes. */
	freezingLevel(profile) {
		for (var i = 0; i < profile.length - 1; i++) {
			var below = profile[i];
			var above = profile[i + 1];
			if (below.temp === null || above.temp === null) {
				continue;
			}
			if (below.temp > 0 && above.temp <= 0) {
				var fraction = (below.temp === above.temp) ? 0 : below.temp / (below.temp - above.temp);
				return Math.round((below.feet + fraction * (above.feet - below.feet)) / 100) * 100;
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
			var reported = (hourly.freezing_level_height || [])[index];
			var freezing = (reported === null || reported === undefined)
				? this.freezingLevel(profile)
				: Math.round((reported - elevation) * FEET_PER_METER / 100) * 100;
			return {
				time: new Date(time + 'Z'),
				levels: levels,
				ground: {
					kt: Math.round(hourly.wind_speed_10m[index]),
					dir: Math.round(hourly.wind_direction_10m[index]),
					gust: Math.round(hourly.wind_gusts_10m[index]),
				},
				freezing: freezing,
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

	/* An arrow pointing the way the wind blows. The rotation sits on an outer span: iconify
	   replaces the inner element with an svg of its own and would drop the style. */
	arrow(direction, shifted) {
		return '<span class="wind-arrow' + (shifted ? ' wind-arrow-shifted' : '') + '"'
			+ ' style="transform: rotate(' + ((direction + 180) % 360) + 'deg)">'
			+ '<span class="iconify" data-icon="mdi-arrow-up"></span></span>';
	}

	/* How far a direction differs from the one measured now, in degrees */
	shift(direction, reference) {
		if (reference === null || reference === undefined) {
			return 0;
		}
		var difference = Math.abs(direction - reference) % 360;
		return (difference > 180) ? 360 - difference : difference;
	}

	/* A gust is only worth a second number when it stands out from the wind itself */
	gust(gust, wind) {
		if (gust === null || gust === undefined || wind === null || gust <= wind + 1) {
			return '';
		}
		return '<span class="windgust">G' + Math.round(gust) + '</span>';
	}

	/* Of deze wind op deze hoogte het bekijken waard is. Twee grenzen, want ze gaan over twee
	   verschillende dingen: onderin waar je koepel doorheen moet, daarboven waar het vliegtuig en de
	   groepsafstand mee te maken hebben. */
	overLimit(feet, wind) {
		if (!wind || wind.kt === null || wind.kt === undefined) {
			return false;
		}
		return (feet <= this.windLimitBelow)
			? (wind.kt >= this.windLimit)
			: (wind.kt >= this.windLimitHigh);
	}

	cell(wind, extra, forecast, reference, limit) {
		if (!wind) {
			return '<td class="windcell' + (forecast ? ' windcell-forecast' : '') + '"></td>';
		}
		/* over the limit the whole cell is marked, not just the number: the gusts in this table are
		   already a coloured number, and two colours of number in one table read as one thing */
		var over = (limit === true) ? ' windcell-limit' : '';
		/* every part gets its own slot, so arrows, speeds and degrees line up down the column */
		/* Voor de uren vooruit zegt de pijl genoeg; de graden zouden alleen ruis toevoegen. In de
		   kolom van nu staan ze er wel, en dan komt een eventuele stoot erboven in plaats van
		   ernaast: met allebei op één regel duwde de stoot de graden weg, en dat zijn juist de
		   twee getallen waarvoor je naar deze regel kijkt. */
		var tail = forecast
			? (extra || '')
			: '<span class="windcell-tail">' + (extra || '') + '<span class="winddirection">' + wind.dir + '&deg;</span></span>';
		return '<td class="windcell' + (forecast ? ' windcell-forecast' : '') + over + '"><span class="windcell-row">'
			+ this.arrow(wind.dir, forecast && this.shift(wind.dir, reference) >= SIGNIFICANT_SHIFT)
			+ '<span class="windspeed">' + wind.kt + '</span>'
			+ tail + '</span></td>';
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
		/* Ligt het vriesniveau boven de hoogste regel van de tabel, dan zegt die regel niets meer over
		   deze sprong: alles wat je hier leest is dan warmer dan nul, en de kou begint boven het beeld.
		   Hij blijft wel staan zolang hij tussen de hoogtes valt, ook boven de exithoogte - daar is hij
		   alleen niet meer de kleur van "hier heb je handschoenen nodig". */
		var top = this.altitudes.length ? Math.max.apply(null, this.altitudes) : null;
		/* alleen voor deze tabel; het meetblok links blijft de hoogte gewoon noemen */
		var inTable = (freezing !== null && (top === null || freezing <= top)) ? freezing : null;
		var rows = '';
		var freezingDrawn = false;
		this.altitudes.forEach(feet => {
			if (inTable !== null && !freezingDrawn && feet < inTable) {
				/* marked the same way as in the metrics panel when it is low enough to climb through */
				var cold = (inTable <= this.exitAltitude) ? ' freezing-row-cold' : '';
				rows += '<tr class="freezing-row' + cold + '"><td colspan="' + (columns.length + 1) + '">'
					+ LANGUAGE_FREEZING_LEVEL_AT + ' ' + inTable.toLocaleString(document.config.locale) + '&nbsp;' + UNIT_FEET + '</td></tr>';
				freezingDrawn = true;
			}
			var temperature = (columns[0].levels[feet] && columns[0].levels[feet].temp !== null)
				? '<span class="windtemperature">' + columns[0].levels[feet].temp + '&nbsp;&deg;C</span>' : '';
			rows += '<tr><td class="windtext">' + feet.toLocaleString(document.config.locale) + temperature + '</td>'
				+ columns.map((hour, index) => this.cell(hour.levels[feet], '', index > 0,
					columns[0].levels[feet] ? columns[0].levels[feet].dir : null,
					this.overLimit(feet, hour.levels[feet]))).join('') + '</tr>';
		});

		/* The ground row: measured now, modelled for the hours after it, with the gust behind the
		   speed wherever there is one worth naming. */
		var measured = (document.modules || {}).luchtvaartmeteo;
		var observation = measured ? measured.observation : null;
		var groundNow = (observation && observation.wind_dir !== null) ? Math.round(observation.wind_dir) : columns[0].ground.dir;
		rows += '<tr class="ground-row"><td class="windtext">' + LANGUAGE_GROUND + '</td>';
		rows += columns.map((hour, index) => {
			if (index === 0 && observation && observation.wind_kt !== null && observation.wind_dir !== null) {
				return this.cell({ kt: Math.round(observation.wind_kt), dir: Math.round(observation.wind_dir) },
					this.gust(observation.gust_kt, observation.wind_kt), false, groundNow);
			}
			return this.cell(hour.ground, this.gust(hour.ground.gust, hour.ground.kt), index > 0, groundNow);
		}).join('');
		rows += '</tr>';

		document.getElementById(ID_TABLE_BODY).innerHTML = rows;

		/* The freezing level also goes in the metrics panel. Below the altitude the aircraft drops
		   from, the jumpers leave it into air under zero, and the board says what that means here
		   rather than leaving it to be worked out from a number. */
		var element = document.getElementById(ID_FREEZING_ALTITUDE);
		if (freezing !== null && element) {
			var cold = freezing <= this.exitAltitude;
			element.innerHTML = (cold ? '<span class="iconify metrics-cold-icon" data-icon="mdi-snowflake"></span>' : '')
				+ freezing.toLocaleString(document.config.locale) + '&nbsp;<span class="metrics-unit">' + UNIT_FEET + '</span>'
				+ ((cold && this.coldText) ? '<span class="metrics-sub metrics-sub-cold">' + this.coldText + '</span>' : '');
			var cell = element.closest('.metrics-cell');
			if (cell) {
				cell.classList.toggle('metrics-cell-cold', cold);
			}
		}

		/* the unit stays on the title line, the explanation goes on its own line below it */
		document.getElementById(ID_VALID_FROM).innerHTML = UNIT_KNOTS
			+ '<span class="upper-winds-note">' + LANGUAGE_MEASURED + '</span>';
		document.getElementById(ID_LAST_UPDATED).innerHTML = this.last_updated.toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL);
	}
}

export { Module };
