/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */
/* jshint esversion: 6 */

/*
 * De windkaart van Windy, in de kaarttegel, maar alleen als het er toe doet.
 *
 * Staat er harde wind op hoogte, dan zegt een gekleurde cel in de tabel wel dát het zo is maar niet
 * hoe het eruitziet. Windy tekent dat veld over heel Nederland, en dit beeld neemt de kaart even
 * over - net als een jumprun - zodat je in één oogopslag ziet waar het vandaan komt en hoe breed
 * het zit.
 *
 * Dit beeld heeft zijn eigen grenzen, en die liggen hoger dan waar de windtabel zijn cellen kleurt.
 * Dat is met opzet: een gekleurde cel betekent "hier moet je even naar kijken", en dat is niet elke
 * keer een half scherm waard. Er komt pas een kaart bij:
 *
 *     - meer dan 30 kt op 1.000, 2.000 of 3.000 ft   -> de hardste van die drie
 *     - meer dan 45 kt tussen 9.000 en 12.000 ft     -> de hardste van die twee
 *     - meer dan 20 kt aan de grond                  -> de gemeten wind
 *
 * Ze kunnen alle drie tegelijk gelden, en dan komen ze ook alle drie langs, van de grond omhoog.
 * Dit beeld voegt niets toe en trekt geen conclusies; het toont hetzelfde getal dat elders op het
 * bord staat, op de kaart.
 *
 * De iframe krijgt zijn adres pas als het beeld aan de beurt is en raakt het daarna weer kwijt.
 * Windy tekent met WebGL en blijft doorrekenen zolang hij geladen is; op een Raspberry Pi is dat
 * niet iets wat je de hele dag op de achtergrond wil laten staan.
 */

import { UNIT_FEET, UNIT_KNOTS } from '../const.js';
import { LANGUAGE_WIND, LANGUAGE_JUMPRUN_AT_FT, LANGUAGE_AT_GROUND } from '../language.js';

const ID_LAYER = 'layer-windy-id';
const ID_FRAME = 'windy-frame-id';
const ID_CAPTION = 'windy-caption-id';

const EMBED_URL = 'https://embed.windy.com/embed2.html';
/* Windy rekent in drukniveaus; dit is de hoogte waarop elk niveau in de standaardatmosfeer ligt.
   Van de hoogte in de tabel wordt het dichtstbijzijnde niveau gekozen - tussenliggende niveaus
   bestaan daar niet, dus 9.000 ft wordt 700 hPa en dat is 9.900 ft. Het getal in de kop blijft de
   hoogte uit de tabel, want dat is waar de waarde bij hoort. */
/* Wanneer een hoogte een kaart waard is. Onderin gaat het om de koepelrit en om wat de wind met een
   landing doet; daarboven om de uitloop van de jumprun en de afstand tussen de groepen. De grond
   staat er apart in, want die wordt gemeten en niet gerekend. */
const LOW_BAND = [1000, 3000];			// feet, van en tot
const LOW_LIMIT = 30;					// knots, meer dan
const HIGH_BAND = [9000, 12000];
const HIGH_LIMIT = 45;
const GROUND_LIMIT = 20;

const LEVELS = [
	{ level: 'surface', feet: 0 },
	{ level: '100m', feet: 330 },
	{ level: '975h', feet: 1050 },
	{ level: '950h', feet: 1780 },
	{ level: '925h', feet: 2500 },
	{ level: '900h', feet: 3240 },
	{ level: '850h', feet: 4780 },
	{ level: '800h', feet: 6390 },
	{ level: '700h', feet: 9880 },
	{ level: '600h', feet: 13800 },
	{ level: '500h', feet: 18290 },
];

class Module {
	constructor() {
		this.config = document.config.windy || {};
		this.location = document.config.location || {};
		/* Het model. ecmwf is wat Windy zelf als standaard neemt; iconEu en arome zijn fijnmaziger
		   over Nederland, maar lopen niet altijd even ver door. */
		this.product = this.config.product || 'ecmwf';
		this.zoom = this.config.zoom || 7;
		this.lowBand = this.config.lowBand || LOW_BAND;
		this.lowLimit = (this.config.lowLimit !== undefined) ? this.config.lowLimit : LOW_LIMIT;
		this.highBand = this.config.highBand || HIGH_BAND;
		this.highLimit = (this.config.highLimit !== undefined) ? this.config.highLimit : HIGH_LIMIT;
		this.groundLimit = (this.config.groundLimit !== undefined) ? this.config.groundLimit : GROUND_LIMIT;
		this.turn = -1;
		this.sequenceTimer = null;
		this.shown = null;
	}

	/* Wat er op dit moment een kaart waard is, van de grond omhoog. Per band de hardste laag: twee
	   lagen die nauwelijks schelen zeggen hetzelfde, en dan is de hardste degene die je wil zien. */
	get waiting() {
		var aloft = (document.modules || {}).aloft;
		/* Het uur dat in de kolom NU staat, niet het eerste uur dat het model teruggaf: die reeks
		   begint eerder op de dag, en dan zou de kaart over een ander uur gaan dan de tabel ernaast.
		   Gemeten op 18 sep 2026: hours[0] was 06:00 UTC met 26 kt terwijl NU 08:00 UTC en 22 kt was. */
		var columns = (aloft && typeof aloft.columns === 'function') ? aloft.columns() : [];
		var now = columns.length ? columns[0] : null;
		if (!now || this.config.enabled === false) {
			return [];
		}
		var out = [];
		var ground = this.ground(now);
		if (ground !== null && ground.kt > this.groundLimit) {
			out.push({ feet: 0, kt: ground.kt, dir: ground.dir, range: 'ground' });
		}
		var low = this.hardest(now, this.lowBand, this.lowLimit, 'low');
		if (low !== null) {
			out.push(low);
		}
		var high = this.hardest(now, this.highBand, this.highLimit, 'high');
		if (high !== null) {
			out.push(high);
		}
		return out;
	}

	/* De hardste laag in een band die over zijn grens gaat, of null. De hoogtes komen uit
	   `upperwinds`, dus een bord met andere hoogtes krijgt vanzelf de zijne die in de band vallen. */
	hardest(hour, band, limit, range) {
		var best = null;
		Object.keys(hour.levels).forEach(key => {
			var feet = Number(key);
			var wind = hour.levels[key];
			if (feet < band[0] || feet > band[1] || !wind || wind.kt === null || wind.kt === undefined) {
				return;
			}
			if (wind.kt > limit && (best === null || wind.kt > best.kt)) {
				best = { feet: feet, kt: wind.kt, dir: wind.dir, range: range };
			}
		});
		return best;
	}

	/* De wind aan de grond: gemeten als er een meting is, anders wat het model voor dit uur zegt -
	   dezelfde volgorde als de onderste regel van de windtabel, zodat de twee niet uit elkaar lopen. */
	ground(hour) {
		var measured = (document.modules || {}).luchtvaartmeteo;
		var observation = measured ? measured.observation : null;
		if (observation && observation.wind_kt !== null && observation.wind_kt !== undefined) {
			return {
				kt: Math.round(observation.wind_kt),
				dir: (observation.wind_dir === null || observation.wind_dir === undefined)
					? null : Math.round(observation.wind_dir),
			};
		}
		return hour.ground ? { kt: hour.ground.kt, dir: hour.ground.dir } : null;
	}

	get active() {
		return this.waiting.length > 0;
	}

	/* Het drukniveau van Windy dat het dichtst bij deze hoogte ligt */
	level(feet) {
		if (feet <= 0) {
			return 'surface';
		}
		return LEVELS.reduce((best, one) =>
			(Math.abs(one.feet - feet) < Math.abs(best.feet - feet)) ? one : best, LEVELS[0]).level;
	}

	/* Het adres van de ingesloten kaart. De onderdelen van Windy zelf blijven uit: geen menu, geen
	   kalender, geen boodschappen, en ook de speld niet. Die opent namelijk een ballonnetje met
	   Windy's eigen windwaarde erin, en die wijkt af van het getal in de kop: Windy rekent met een
	   ander model en op het dichtstbijzijnde drukniveau, dus op 9.000 ft stond er 22 kt naast onze
	   26. Twee getallen die elkaar tegenspreken op hetzelfde scherm is erger dan geen speld. Waar de
	   dropzone ligt wijst het bord zelf aan: de kaart is erop gecentreerd en er wordt aan alle
	   kanten evenveel afgesneden, dus dat is het midden van het venster. */
	source(feet) {
		var parameters = {
			lat: this.location.lattitude,
			lon: this.location.longitude,
			detailLat: this.location.lattitude,
			detailLon: this.location.longitude,
			zoom: this.zoom,
			level: this.level(feet),
			overlay: 'wind',
			product: this.product,
			menu: '',
			message: '',
			marker: 'false',
			calendar: '',
			pressure: '',
			type: 'map',
			detail: '',
			metricWind: 'kt',
			metricTemp: 'default',
			radarRange: -1,
		};
		return EMBED_URL + '?' + Object.keys(parameters)
			.map(key => key + '=' + encodeURIComponent(parameters[key])).join('&');
	}

	/* Alle hoogtes die het aangaat achter elkaar, elk een eigen beurt. Geeft terug hoeveel beelden
	   dat zijn, zodat de radar weet hoe lang hij moet wachten - dezelfde afspraak als de jumprun. */
	sequence(seconds) {
		var waiting = this.waiting;
		if (waiting.length === 0 || !document.getElementById(ID_LAYER)) {
			return 0;
		}
		var step = 0;
		var next = () => {
			if (step >= waiting.length) {
				this.hide();
				return;
			}
			this.show(waiting[step]);
			step += 1;
			this.sequenceTimer = setTimeout(next, seconds * 1000);
		};
		clearTimeout(this.sequenceTimer);
		next();
		return waiting.length;
	}

	/* De kaart even overnemen. De radar draait eronder gewoon door, net als bij de jumprun. */
	show(which) {
		var waiting = this.waiting;
		var layer = document.getElementById(ID_LAYER);
		var frame = document.getElementById(ID_FRAME);
		if (waiting.length === 0 || !layer || !frame) {
			return false;
		}
		if (!which) {
			this.turn = (this.turn + 1) % waiting.length;
			which = waiting[this.turn];
		}
		/* alleen opnieuw laden als het een ander niveau is: dezelfde kaart twee keer ophalen kost
		   een Raspberry Pi meer dan het oplevert */
		var source = this.source(which.feet);
		if (frame.getAttribute('src') !== source) {
			frame.setAttribute('src', source);
		}
		this.caption(which);
		this.shown = which;
		layer.hidden = false;
		return true;
	}

	/* Wat er boven de kaart staat: het getal uit de tabel, met de hoogte waar het bij hoort. Geen
	   oordeel erbij - wat dit betekent voor de sprong is aan de springleiding. */
	caption(which) {
		var caption = document.getElementById(ID_CAPTION);
		if (!caption) {
			return;
		}
		var where = (which.range === 'ground')
			? LANGUAGE_AT_GROUND
			: LANGUAGE_JUMPRUN_AT_FT + ' ' + which.feet.toLocaleString(document.config.locale) + '&nbsp;' + UNIT_FEET;
		caption.innerHTML = '<span class="windy-what">' + LANGUAGE_WIND + ' '
			+ which.kt + '&nbsp;' + UNIT_KNOTS
			+ '<span class="windy-alt">' + where + '</span></span>';
	}

	hide() {
		clearTimeout(this.sequenceTimer);
		var layer = document.getElementById(ID_LAYER);
		var frame = document.getElementById(ID_FRAME);
		if (layer) {
			layer.hidden = true;
		}
		/* Het adres weghalen zet de kaart stil. Windy blijft anders met WebGL doorrekenen achter een
		   verborgen tegel, en dat is precies de rekentijd die het bord nodig heeft voor de radar. */
		if (frame) {
			frame.removeAttribute('src');
		}
		this.shown = null;
	}
}

export { Module };
