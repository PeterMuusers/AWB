/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { DATE_OPTIONS_LOCAL, UNIT_CELCIUS, UNIT_FEET, UNIT_HECTOPASCAL, UNIT_KILOMETERS, UNIT_KNOTS, UNIT_METERS_PER_SECOND } from '../const.js';
import { createSystemMessage, sunElevation, sunTimes } from '../functions.js';
import {
	LANGUAGE_SOURCE, LANGUAGE_UPDATED_INLINE, LANGUAGE_WIND, LANGUAGE_WIND_DIRECTION, LANGUAGE_VISIBILITY,
	LANGUAGE_PRECIPITATION, LANGUAGE_TEMPERATURE, LANGUAGE_DEWPOINT, LANGUAGE_FREEZING_ALTITUDE, LANGUAGE_PRESSURE,
	LANGUAGE_SUNRISE, LANGUAGE_SUNSET, LANGUAGE_AT, LANGUAGE_NO_CLOUDS, LANGUAGE_DRY,
	LANGUAGE_SKY,
} from '../language.js';

/*
 * Het meetblok links op het bord. Waar de cijfers vandaan komen hangt van de instelling af:
 *
 *   - staat er een `luchtvaartmeteo`-blok in config.json, dan komen ze van de API achter
 *     luchtvaartmeteo.nl: gemeten op een echt station in plaats van gerekend, met wind en stoten,
 *     temperatuur, dauwpunt, QNH, zicht, neerslag en de wolkenlagen van de ceilometer. Inloggen en
 *     ophalen doet luchtvaartmeteo-proxy.php, zodat het wachtwoord niet in de browser komt.
 *   - staat dat blok er niet, dan valt het terug op Weerlive - de bron waar dit bord het vroeger van
 *     had. Dat vraagt geen account maar wel een sleutel in `weerlive.key`, en het levert minder:
 *     geen stoten, geen neerslag in mm/u en geen wolkenbasis, want daar hoort een ceilometer bij.
 *
 * Zo blijft een bestaand bord met zijn eigen config draaien zoals het draaide, en is het nieuwe een
 * keuze in plaats van een voorwaarde.
 *
 * De samenvatting, het icoontje en de tijden van zonsopkomst en -ondergang komen uit diezelfde
 * metingen en uit de stand van de zon, dus het bord heeft geen tweede weerbron nodig.
 */

const SOURCE = 'luchtvaartmeteo.nl';
const PROXY_URL = './luchtvaartmeteo-proxy.php';
const WEERLIVE_SOURCE = 'Weerlive';
const WEERLIVE_URL = 'https://weerlive.nl/api/weerlive_api_v2.php';
/* Het beeld dat Weerlive meestuurt, naar het icoontje dat dit bord gebruikt. Weerlive kent er meer;
   wat hier niet in staat valt terug op het icoontje dat bij de bewolking hoort. */
const WEERLIVE_SKY = {
	zonnig: 'clear', helderenacht: 'clear_night',
	lichtbewolkt: 'few', wolkennacht: 'few_night', halfbewolkt: 'scattered',
	halfbewolkt_regen: 'rain', bewolkt: 'broken', zwaarbewolkt: 'overcast', nachtbewolkt: 'overcast',
	regen: 'rain', buien: 'rain', hagel: 'rain', bliksem: 'rain', sneeuw: 'fog',
	mist: 'fog', nachtmist: 'fog',
};
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
const ID_CLOUDBASE_BLOCK = 'metrics-cloudbase';

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
		/* Zonder het blok valt hij terug op Weerlive; alles hieronder moet dus tegen een lege
		   instelling kunnen. */
		this.settings = document.config.luchtvaartmeteo || {};
		this.measured = (document.config.luchtvaartmeteo !== undefined);
		this.source = this.measured ? SOURCE : WEERLIVE_SOURCE;
		this.summaryText = null;			// alleen bij Weerlive: hun eigen samenvatting
		this.station = this.settings.station || 'hoogeveen';
		/* The station publishes every ten minutes and the proxy holds on to an answer until the next
		   one is due, so asking often costs nothing beyond the dropzone and keeps what the board shows
		   within a couple of minutes of what was measured. */
		this.refreshInterval = 2 * 60 * 1000; // Refresh interval is 2 minutes

		this.last_updated = null;
		this.observed_at = null;
		this.observation = null;
		this.series = null;		// the past hours per field, for the chart under the panel
		this.units = null;

		this.unit = (this.settings.windUnit === 'kt') ? UNIT_KNOTS : UNIT_METERS_PER_SECOND;

		/* Set language specific stuff */
		document.getElementById(ID_METRICS_SOURCE_LABEL).innerHTML = LANGUAGE_SOURCE;
		document.getElementById(ID_METRICS_SOURCE_DATA).innerHTML = this.source;
		document.getElementById(ID_METRICS_LAST_UPDATED_LABEL).innerHTML = LANGUAGE_UPDATED_INLINE;
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
		if (!this.measured) {
			return this.updateFromWeerlive();
		}
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

	/* De terugval: Weerlive in plaats van een meetstation. Hun antwoord wordt omgezet naar dezelfde
	   velden die de rest van deze module leest, zodat er verder niets van hoeft te weten. Wat Weerlive
	   niet heeft blijft leeg - stoten, neerslag in mm/u en de wolkenbasis - en dat is beter dan een
	   getal verzinnen dat er niet is. */
	updateFromWeerlive() {
		var key = (document.config.weerlive || {}).key;
		if (!key) {
			createSystemMessage('Geen meetbron ingesteld: vul `luchtvaartmeteo` of `weerlive` in config.json in.');
			clearInterval(this.task);
			return;
		}
		document.getElementById(ID_METRICS_LAST_UPDATED_WARNING).style.display = 'none';
		document.getElementById(ID_METRICS_LAST_UPDATED_SPINNER).style.display = 'block';

		var url = WEERLIVE_URL + '?key=' + encodeURIComponent(key)
			+ '&locatie=' + document.config.location.lattitude + ',' + document.config.location.longitude;
		fetch(url, { headers: { Accept: 'application/json' } })
			.then(response => {
				if (response.ok !== true) {
					throw new Error('HTTP ' + response.status + ' (' + response.statusText + ')');
				}
				return response.json();
			})
			.then(data => {
				document.getElementById(ID_METRICS_LAST_UPDATED_SPINNER).style.display = 'none';
				var live = (data && Array.isArray(data.liveweer) && data.liveweer.length) ? data.liveweer[0] : null;
				if (live === null) {
					document.getElementById(ID_METRICS_LAST_UPDATED_WARNING).style.display = 'block';
					return;
				}
				var number = one => {
					var value = Number(one);
					return (one === undefined || one === null || one === '' || isNaN(value)) ? null : value;
				};
				/* Weerlive v2 geeft het zicht in meters, ondanks dat weerlive.js er km achter zet -
				   daar staat op een onbewolkte dag dus "61700 km" op het scherm. */
				var visibility = number(live.zicht);
				this.last_updated = new Date();
				this.observed_at = null;
				this.series = null;
				this.units = null;
				this.observation = {
					wind_kt: number(live.windknp),
					wind_dir: number(live.windrgr),
					gust_kt: null,
					temp_c: number(live.temp),
					dewpoint_c: number(live.dauwp),
					qnh_hpa: number(live.luchtd),
					vis_m: visibility,
					rain_mmh: null,
				};
				/* Hun eigen samenvatting en beeld: zonder ceilometer valt er hier niets af te leiden. */
				this.summaryText = live.samenv || null;
				this.summaryKey = WEERLIVE_SKY[live.image] || null;
				if (this.settings.stationName === undefined && live.plaats) {
					this.settings = { ...this.settings, stationName: live.plaats };
				}
				this.showData();
			})
			.catch(error => {
				document.getElementById(ID_METRICS_LAST_UPDATED_SPINNER).style.display = 'none';
				document.getElementById(ID_METRICS_LAST_UPDATED_WARNING).style.display = 'block';
				console.warn(WEERLIVE_SOURCE + ': ' + error.message);
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
		/* Bij Weerlive is er geen ceilometer om iets uit af te leiden; dan telt het beeld dat zij
		   meesturen. */
		if (this.summaryKey) {
			var theirs = (night && SKY_ICONS[this.summaryKey + '_night'])
				? SKY_ICONS[this.summaryKey + '_night'] : SKY_ICONS[this.summaryKey];
			return { key: this.summaryKey, icon: theirs || SKY_ICONS.clear };
		}
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
		this.set(ID_LOCATION, this.settings.stationName || this.station);
		/* De regel onder het blok: wat er in de instelling staat, en anders niets. Hier stond vanzelf
		   "Gemeten op <station>", maar waar de cijfers vandaan komen staat in de kopbalk bij de bronnen
		   en hoort niet nog eens in de tegel. Wie er wél iets te melden heeft dat ertoe doet - een
		   ceilometer elf kilometer verderop, bijvoorbeeld - zet dat in "note". */
		var note = this.settings.note;
		this.set(ID_NOTE, (note === undefined || note === null) ? '' : note);

		/* Summary and icon */
		var sky = this.sky();
		document.getElementById(ID_ICON).setAttribute('data-icon', sky.icon);
		var summary = this.summaryText || LANGUAGE_SKY[sky.key] || '';

		/* Zonder ceilometer valt er over de wolkenbasis niets te zeggen, en dan hoort dat vak er ook
		   niet te staan: een leeg veld leest als "geen wolken" en dat is iets anders dan "niet
		   gemeten". De samenvatting neemt het dan over. */
		var block = document.getElementById(ID_CLOUDBASE_BLOCK);
		if (block) {
			block.hidden = !this.measured;
		}
		if (!this.measured) {
			this.set(ID_SUMMARY, summary);
			document.getElementById(ID_ICON).style.display = summary === '' ? 'none' : '';
			this.showCells();
			return;
		}

		/* Cloud base: the lowest layer as the big number, the rest behind it */
		var layers = this.layers();
		if (layers.length === 0) {
			this.set(ID_CLOUDBASE, LANGUAGE_NO_CLOUDS);
			this.set(ID_CLOUDBASE_LAYERS, '');
			/* Zonder wolken zegt het grote veld al "onbewolkt"; twee keer hetzelfde woord onder
			   elkaar leest als een fout. De samenvatting valt dan weg, het icoontje blijft. */
			if (summary === LANGUAGE_NO_CLOUDS) {
				summary = '';
			}
		} else {
			var lowest = layers[0];
			this.set(ID_CLOUDBASE, lowest.base.toLocaleString(document.config.locale)
				+ '&nbsp;<span class="metrics-unit">' + UNIT_FEET + '</span>'
				+ '<span class="metrics-cloudbase-code">' + cloudAmountCode(lowest.okta) + ' ' + lowest.okta + '/8</span>');
			/* De lagen daarboven, in het lege vlak naast het grote getal: de hoogste bovenaan, elk met
			   een balkje dat donkerder wordt naarmate er meer bedekking is. Als regel tekst achter de
			   kop viel dit weg; zo staat het als een lijstje dat je in één oogopslag afleest, net als
			   op jumprun.nl. De onderste laag staat al groot, dus die hoort hier niet nog eens. */
			this.set(ID_CLOUDBASE_LAYERS, layers.slice(1).reverse().map(layer => {
				/* Hoe meer bedekking, hoe zwaarder de regel weegt: acht achtsten boven je hoofd is een
				   ander bericht dan een enkel wolkje, en dat hoor je te zien zonder het getal te lezen. */
				var share = ' style="--okta: ' + (layer.okta / 8).toFixed(3) + '"';
				return '<span class="metrics-layer">'
					+ '<span class="metrics-layer-bar"' + share + '></span>'
					+ '<span class="metrics-layer-base"' + share + '>' + layer.base.toLocaleString(document.config.locale)
						+ '&nbsp;<span class="metrics-unit">' + UNIT_FEET + '</span></span>'
					+ '<span class="metrics-layer-code"' + share + '>' + cloudAmountCode(layer.okta) + '</span>'
					+ '</span>';
			}).join(''));
		}

		/* Zonder tekst ook geen icoontje: een wolkje op een lege regel is een halve zin. */
		this.set(ID_SUMMARY, summary);
		document.getElementById(ID_ICON).style.display = summary === '' ? 'none' : '';
		this.showCells();
	}

	/* De cijfers in het raster. Apart, omdat de terugval op Weerlive hier ook langskomt
	   maar het stuk over de wolkenbasis erboven overslaat. */
	showCells() {
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

		/* Precipitation. Niets gemeten is iets anders dan nul gemeten: Weerlive kent geen mm/u, en
		   dan hoort er een streepje te staan en niet "droog". */
		var rain = this.value('rain_mmh');
		var dry = this.measured ? LANGUAGE_DRY : '&ndash;';
		this.set('precipitation-data', (rain === null) ? dry
			: (rain === 0 ? LANGUAGE_DRY : rain.toFixed(1) + '&nbsp;<span class="metrics-unit">mm/h</span>'));

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
