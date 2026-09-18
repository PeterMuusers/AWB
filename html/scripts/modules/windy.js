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
 * Welke hoogte er getoond wordt bepaalt de module met de hoogtewinden (aloft.alerts()): hooguit
 * twee, een uit de lage reeks en een uit de hoge. Dit beeld voegt daar niets aan toe en trekt geen
 * conclusies; het toont hetzelfde getal dat in de tabel staat, op de kaart.
 *
 * De iframe krijgt zijn adres pas als het beeld aan de beurt is en raakt het daarna weer kwijt.
 * Windy tekent met WebGL en blijft doorrekenen zolang hij geladen is; op een Raspberry Pi is dat
 * niet iets wat je de hele dag op de achtergrond wil laten staan.
 */

import { UNIT_FEET, UNIT_KNOTS } from '../const.js';
import { LANGUAGE_WIND, LANGUAGE_JUMPRUN_AT_FT } from '../language.js';

const ID_LAYER = 'layer-windy-id';
const ID_FRAME = 'windy-frame-id';
const ID_CAPTION = 'windy-caption-id';

const EMBED_URL = 'https://embed.windy.com/embed2.html';
/* Windy rekent in drukniveaus; dit is de hoogte waarop elk niveau in de standaardatmosfeer ligt.
   Van de hoogte in de tabel wordt het dichtstbijzijnde niveau gekozen - tussenliggende niveaus
   bestaan daar niet, dus 9.000 ft wordt 700 hPa en dat is 9.900 ft. Het getal in de kop blijft de
   hoogte uit de tabel, want dat is waar de waarde bij hoort. */
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
		this.turn = -1;
		this.sequenceTimer = null;
		this.shown = null;
	}

	/* De hoogtes die op dit moment een beeld waard zijn; de hoogtewinden bepalen dat. */
	get waiting() {
		var aloft = (document.modules || {}).aloft;
		if (!aloft || typeof aloft.alerts !== 'function' || this.config.enabled === false) {
			return [];
		}
		return aloft.alerts();
	}

	get active() {
		return this.waiting.length > 0;
	}

	/* Het drukniveau van Windy dat het dichtst bij deze hoogte ligt */
	level(feet) {
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
		caption.innerHTML = '<span class="windy-what">' + LANGUAGE_WIND + ' '
			+ which.kt + '&nbsp;' + UNIT_KNOTS
			+ '<span class="windy-alt">' + LANGUAGE_JUMPRUN_AT_FT + ' '
			+ which.feet.toLocaleString(document.config.locale) + '&nbsp;' + UNIT_FEET + '</span></span>';
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
