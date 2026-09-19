/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */
/* jshint esversion: 6 */

/*
 * Het vooruitzicht voor morgen, op de plek waar het weerbulletin staat.
 *
 * Aangezet vanuit Discord (/vooruitzicht): dan komt er een minuut lang een tabel te staan met
 * dezelfde hoogtes als het windprofiel ernaast, voor vier momenten op de dag - tien, twaalf, twee en
 * vier uur - met daaronder de grondwind en wat het model aan bewolking verwacht. Daarna staat het
 * bulletin er weer.
 *
 * De cijfers komen uit dezelfde bron, hetzelfde model en dezelfde berekening als de tabel op het
 * bord: deze module haalt een dag op en laat `aloft.parse()` er dezelfde uren van maken. Zo kan het
 * vooruitzicht niet net iets anders rekenen dan wat er naast staat.
 *
 * Wat er staat zijn getallen, geen oordeel. Of het een springdag wordt beslist de springleiding.
 */

import { UNIT_FEET, UNIT_KNOTS } from '../const.js';
import { LANGUAGE_GROUND, LANGUAGE_OUTLOOK, LANGUAGE_OUTLOOK_CHART, LANGUAGE_CLOUDS, LANGUAGE_NO_CLOUDS } from '../language.js';
import { sunTimes } from '../functions.js';

const POLL_MS = 5000;
const STATE_URL = 'demo.php';
const ID_CONTENT = 'llfc-content';
const ID_SOURCE = 'llfc-source-data';
const ID_HEADER_NAME = 'llfc-header-name';
const ID_VALID_FROM = 'llfc-valid-from';

/* De momenten waarop je naar zo'n dag kijkt: de ochtend, rond het middaguur, en de twee uur waarop
   de thermiek en de wind meestal op hun sterkst zijn. Lokale tijd. */
const HOURS = [10, 12, 14, 16];
/* De uren die het grafiekje rechts beslaat: de springdag. Daarvoor gebeurt er niets - er wordt niet
   gesprongen voor negenen - en na zonsondergang ook niet meer. Het einde komt dus van de zon zelf,
   die het bord toch al uitrekent. */
const DAY_FROM = 9;

/* Dezelfde schaal, kleuren en maten als de wolkenbasistegel, want het is hetzelfde bord. */
const ALTITUDE_TICKS = [0, 1000, 3000, 5000, 7000, 9000, 12000, 15000];
const AXIS_TICKS = [1000, 3000, 5000, 9000, 12000, 15000];
const CLOUD_COLOUR = '143, 176, 204';
const AXIS_SIZE = 14;
const CHART_SIZE = 12;
const WIND_SIZE = 16;
const OKTA_SIZE = 13;
const OKTA_GAP = 4;					// ruimte tussen het blokje en het getal erboven
const AXIS_GAP = 8;
const WIND_HEIGHT = 86;				// pixels onderaan voor de grondwind, met ruimte voor de getallen
const LABEL_HEIGHT = 20;			// pixels daaronder voor de uren
const TOP_GAP = 6;

/* Bewolking in achtsten naar de afkorting uit de luchtvaart */
const CLOUD_AMOUNTS = [
	{ upto: 0, code: 'SKC' },
	{ upto: 2, code: 'FEW' },
	{ upto: 4, code: 'SCT' },
	{ upto: 7, code: 'BKN' },
	{ upto: 8, code: 'OVC' },
];

function cloudCode(okta) {
	var amount = CLOUD_AMOUNTS.find(step => okta <= step.upto);
	return amount ? amount.code : 'OVC';
}

class Module {
	constructor() {
		this.showing = false;
		this.busy = false;			// er wordt al een vooruitzicht opgehaald
		this.header = null;			// de kop van de tegel zoals hij was
		this.observer = null;
		this.drawn = null;
		this.task = setInterval(this.check.bind(this), POLL_MS);
		this.check();
	}

	/* Staat er een vooruitzicht klaar? Dezelfde markering-op-de-Pi als de demo's, want het is
	   dezelfde vraag: moet er even iets anders op het scherm dan normaal. */
	check() {
		fetch(STATE_URL, { cache: 'no-store' })
			.then(response => response.json())
			.then(state => {
				var wanted = !!(state && state.outlook);
				if (!wanted) {
					this.hide();
					return;
				}
				if (this.showing || this.busy) {
					return;
				}
				this.show();
			})
			.catch(() => {});
	}

	/* Morgen, als datum zoals Open-Meteo hem wil (lokale dag, niet UTC) */
	tomorrow() {
		var day = new Date();
		day.setDate(day.getDate() + 1);
		return day.getFullYear() + '-'
			+ String(day.getMonth() + 1).padStart(2, '0') + '-'
			+ String(day.getDate()).padStart(2, '0');
	}

	show() {
		var aloft = (document.modules || {}).aloft;
		var content = document.getElementById(ID_CONTENT);
		if (!aloft || !content) {
			return;
		}
		/* De dag ervoor en erna mee: we vragen in UTC en kijken naar lokale uren, dus de randen van
		   de dag liggen aan weerszijden van de datumgrens. */
		var day = this.tomorrow();
		var before = new Date(day + 'T12:00:00Z');
		before.setDate(before.getDate() - 1);
		var after = new Date(day + 'T12:00:00Z');
		after.setDate(after.getDate() + 1);
		var iso = when => when.toISOString().slice(0, 10);

		/* Het ophalen duurt langer dan de vijf seconden tussen twee rondes; zonder deze vlag vraagt de
		   volgende ronde hetzelfde nog een keer. */
		this.busy = true;
		fetch(aloft.apiUrl({ start_date: iso(before), end_date: iso(after) }), { headers: { Accept: 'application/json' } })
			.then(response => {
				if (response.ok !== true) {
					throw new Error('HTTP ' + response.status);
				}
				return response.json();
			})
			.then(data => {
				var ofDay = aloft.parse(data).filter(hour => this.sameDay(hour.time, day));
				var hours = ofDay.filter(hour => HOURS.indexOf(hour.time.getHours()) !== -1);
				if (hours.length === 0) {
					throw new Error('geen uren voor ' + day);
				}
				var sunset = sunTimes(hours[0].time, document.config.location.lattitude,
					document.config.location.longitude).sunset;
				/* tot en met het uur waarin de zon ondergaat: dat uur springt er nog in */
				var laatste = sunset ? sunset.getHours() : 21;
				var verloop = ofDay.filter(hour => {
					var uur = hour.time.getHours();
					return uur >= DAY_FROM && uur <= laatste;
				});
				/* eerst de vlag, dan pas tekenen: het bulletin kijkt ernaar om te weten dat deze tegel
				   even van iemand anders is */
				this.showing = true;
				this.draw(hours, verloop, aloft);
			})
			.catch(error => console.warn('Vooruitzicht mislukt: ' + error.message))
			.then(() => { this.busy = false; });
	}

	/* Valt dit moment op de lokale dag die we willen tonen? */
	sameDay(when, day) {
		return when.getFullYear() + '-'
			+ String(when.getMonth() + 1).padStart(2, '0') + '-'
			+ String(when.getDate()).padStart(2, '0') === day;
	}

	/* De tabel, met dezelfde klassen als het windprofiel ernaast zodat hij er ook zo uitziet. */
	draw(hours, verloop, aloft) {
		var clock = when => String(when.getHours()).padStart(2, '0') + ':00';
		var altitudes = aloft.altitudes;		// al van hoog naar laag gesorteerd

		/* Dezelfde tabel als het windprofiel ernaast: dezelfde cellen, dezelfde klassen, dezelfde
		   opmaak. Alleen de kolommen zijn anders - vier momenten van morgen in plaats van nu en de
		   twee uur erna. Daarom wordt aloft.cell() hier gewoon aangeroepen: één plek waar bepaald
		   wordt hoe een windwaarde eruitziet. */
		var head = '<tr><th><span class="windtext-header">' + UNIT_FEET + '</span></th>'
			+ hours.map(hour => '<th><span class="windtext-header">' + clock(hour.time) + '</span></th>').join('')
			+ '</tr>';

		var rows = altitudes.map(feet => {
			var temperature = (hours[0].levels[feet] && hours[0].levels[feet].temp !== null
					&& hours[0].levels[feet].temp !== undefined)
				? '<span class="windtemperature">' + Math.round(hours[0].levels[feet].temp) + '&nbsp;&deg;C</span>' : '';
			return '<tr data-feet="' + feet + '"><td class="windtext">' + feet.toLocaleString(document.config.locale) + temperature + '</td>'
				+ hours.map(hour => aloft.cell(hour.levels[feet], '', false, null,
					aloft.overLimit(feet, hour.levels[feet]))).join('')
				+ '</tr>';
		}).join('');

		var ground = '<tr class="ground-row" data-feet="0"><td class="windtext">' + LANGUAGE_GROUND + '</td>'
			+ hours.map(hour => aloft.cell({ kt: hour.ground.kt, dir: hour.ground.dir },
				aloft.gust(hour.ground.gust, hour.ground.kt), false, null, false)).join('')
			+ '</tr>';

		/* De wolkenbasis heeft geen tegenhanger in het windprofiel; hij leent de opmaak van de
		   grondrij, want hij hoort er net zo bij te staan. */
		var clouds = '<tr class="outlook-clouds"><td class="windtext">' + LANGUAGE_CLOUDS + '</td>'
			+ hours.map(hour => {
				var layers = hour.layers || [];
				if (layers.length === 0) {
					return '<td class="windcell"><span class="outlook-cloud-code">'
						+ LANGUAGE_NO_CLOUDS + '</span></td>';
				}
				/* twee regels: de basis waar de getallen van de wind ook staan, en eronder hoeveel er
				   hangt. Naast elkaar past het niet in deze kolom. */
				return '<td class="windcell">'
					+ '<span class="outlook-cloud-base">' + layers[0].base.toLocaleString(document.config.locale) + '</span>'
					+ '<span class="outlook-cloud-code">' + cloudCode(layers[0].okta) + ' ' + layers[0].okta + '/8</span>'
					+ '</td>';
			}).join('')
			+ '</tr>';

		/* De volgorde: de uren, dan wat er aan bewolking hangt, dan een streep, en daaronder pas de
		   wind. Zo staan de twee dingen die je van elkaar wil onderscheiden ook los van elkaar. */
		var divider = '<tr class="outlook-divider"><td colspan="' + (hours.length + 1) + '"></td></tr>';
		document.getElementById(ID_CONTENT).innerHTML =
			'<div class="outlook">'
			+ '<div class="outlook-left upper-winds-content">'
			+ '<table class="outlook-table"><thead>' + head + '</thead><tbody>'
			+ clouds + divider + rows + ground + '</tbody></table>'
			+ '</div>'
			+ '<div class="outlook-right"><span class="outlook-chart-title">' + LANGUAGE_OUTLOOK_CHART + '</span>'
			+ '<canvas class="outlook-chart"></canvas></div>'
			+ '</div>';

		/* De tegel is van het bulletin, en dat bepaalt hoe hoog hij is: tot onderaan de kolom, gelijk
		   met de kaart ernaast. Zolang het vooruitzicht erin staat schrijft die module hier niets, dus
		   moet hij wel even opnieuw meten - anders houdt de tegel de maat van het bulletin en valt de
		   grondwind, de onderste rij van de tabel, eronder weg. */
		var llfc = (document.modules || {}).knmi_llfc;
		if (llfc && llfc.fit) {
			llfc.fit();
		}

		/* De kop van de tegel gaat mee: daar staat normaal het weerbulletin aangekondigd, en dat is
		   niet wat je nu leest. */
		var when = hours[0].time.toLocaleDateString(document.config.locale, { weekday: 'long', day: 'numeric', month: 'long' });
		var name = document.getElementById(ID_HEADER_NAME);
		var valid = document.getElementById(ID_VALID_FROM);
		var source = document.getElementById(ID_SOURCE);
		if (name && this.header === null) {
			this.header = {
				name: name.innerHTML,
				valid: valid ? valid.innerHTML : '',
				source: source ? source.innerHTML : '',
			};
		}
		if (name) {
			name.innerHTML = LANGUAGE_OUTLOOK;
		}
		if (valid) {
			valid.innerHTML = when;
		}
		/* Geen eigen bron in de kopbalk. Deze tabel komt uit hetzelfde antwoord van hetzelfde model
		   als het windprofiel ernaast, en die staat er al - Open-Meteo twee keer noemen is één bron te
		   veel. Het bulletin waar deze tegel van is zegt hier even niets, en een bron zonder naam valt
		   vanzelf weg uit de kopbalk (zie tiles.css). */
		if (source) {
			source.innerHTML = '';
		}

		/* Tekenen zodra het vak zijn maat heeft. Eén beeldje wachten is niet genoeg: de tegel staat in
		   een flexindeling die pas een hoogte krijgt als de rest gezet is, en dan tekent hij op een
		   canvas van honderdvijftig pixels dat daarna naar vierhonderd wordt uitgerekt. Vandaar een
		   waarnemer die opnieuw tekent als de maat verandert. */
		var canvas = document.querySelector('.outlook-chart');
		this.drawn = null;
		var teken = () => {
			var maat = canvas.clientWidth + 'x' + canvas.clientHeight;
			if (maat === this.drawn || canvas.clientHeight < 40) {
				return;
			}
			this.drawn = maat;
			this.chart(canvas, verloop);
		};
		window.requestAnimationFrame(teken);
		if (typeof ResizeObserver !== 'undefined') {
			this.observer = new ResizeObserver(teken);
			this.observer.observe(canvas);
		}
	}

	/* Het verloop van de dag, in dezelfde vormentaal als de wolkenbasistegel: de wolkenlagen die het
	   model verwacht op een hoogteschaal, met daaronder de grondwind en de stoten. De tabel links
	   geeft vier momenten, dit geeft het ritme ertussen - en allebei uit hetzelfde antwoord, dus ze
	   kunnen elkaar niet tegenspreken. */
	chart(canvas, day) {
		/* clientWidth en clientHeight, niet getBoundingClientRect: het bord wordt met een CSS-transform
		   op het scherm gepast, en dan geeft die laatste geschaalde pixels terug. De grafiek zou dan
		   op een andere maat getekend worden dan het vak waarin hij staat. */
		var box = { width: canvas.clientWidth, height: canvas.clientHeight };
		var ratio = Math.min(2, window.devicePixelRatio || 1);
		if (box.width === 0 || box.height === 0 || day.length === 0) {
			return;
		}
		canvas.width = Math.round(box.width * ratio);
		canvas.height = Math.round(box.height * ratio);
		var ctx = canvas.getContext('2d');
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, box.width, box.height);

		var style = window.getComputedStyle(document.documentElement);
		var pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
		var family = pick('--font-condensed', '"Roboto Condensed", "Roboto", sans-serif');
		var ink = pick('--textcolor-2', pick('--textcolor', '#ffffff'));
		var muted = pick('--metadata-textcolor', '#8a96a3');
		var grid = pick('--block-border-color', 'rgba(127,127,127,0.25)');
		var windColour = pick('--wind-color', '#2a78d6');
		var gustColour = pick('--gust-color', '#eb6834');
		var coldColour = pick('--cold-color', '#7fbde8');

		/* de hoogteschaal: tussen twee streepjes lineair, zodat de onderste duizend voet net zoveel
		   ruimte krijgen als de bovenste drieduizend */
		var fraction = feet => {
			if (feet <= ALTITUDE_TICKS[0]) {
				return 0;
			}
			for (var i = 0; i < ALTITUDE_TICKS.length - 1; i++) {
				if (feet <= ALTITUDE_TICKS[i + 1]) {
					var within = (feet - ALTITUDE_TICKS[i]) / (ALTITUDE_TICKS[i + 1] - ALTITUDE_TICKS[i]);
					return (i + within) / (ALTITUDE_TICKS.length - 1);
				}
			}
			return 1;
		};

		/* De hoogtes van de tabel ernaast, opgemeten in het beeld: dan ligt 15k hier op dezelfde
		   hoogte als de rij 15.000 daar, en 1k op de rij 1.000. Zo zeggen links en rechts op dezelfde
		   ooghoogte hetzelfde. Lukt het opmeten niet, dan verdeelt de grafiek de ruimte zelf. */
		var levels = this.levels(canvas);

		ctx.font = AXIS_SIZE + 'px ' + family;
		var axisWidth = Math.max.apply(null, AXIS_TICKS.map(feet => ctx.measureText(this.tickLabel(feet)).width)) + AXIS_GAP;
		var left = axisWidth;
		var right = box.width - 2;
		var bottom = levels ? levels[levels.length - 1].y : box.height - LABEL_HEIGHT - WIND_HEIGHT;
		var top = levels ? levels[0].y : TOP_GAP;
		var ceiling = levels ? levels[0].feet : ALTITUDE_TICKS[ALTITUDE_TICKS.length - 1];
		var y = feet => {
			if (!levels) {
				return bottom - fraction(feet) * (bottom - top);
			}
			if (feet >= levels[0].feet) {
				return levels[0].y;
			}
			for (var i = 0; i < levels.length - 1; i++) {
				if (feet >= levels[i + 1].feet) {
					var within = (feet - levels[i + 1].feet) / (levels[i].feet - levels[i + 1].feet);
					return levels[i + 1].y + within * (levels[i].y - levels[i + 1].y);
				}
			}
			return levels[levels.length - 1].y;
		};
		var span = (right - left) / day.length;
		var x = index => left + index * span;

		/* de streepjes van de hoogteschaal */
		ctx.textBaseline = 'middle';
		AXIS_TICKS.forEach(feet => {
			var line = y(feet);
			ctx.strokeStyle = grid;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(left, Math.round(line) + 0.5);
			ctx.lineTo(right, Math.round(line) + 0.5);
			ctx.stroke();
			ctx.fillStyle = ink;
			ctx.font = '600 ' + AXIS_SIZE + 'px ' + family;
			ctx.textAlign = 'right';
			ctx.fillText(this.tickLabel(feet), axisWidth - AXIS_GAP, line);
		});

		/* de wolkenlagen: per uur een blokje van basis tot top, lichter naarmate er meer hangt */
		var towardsWhite = okta => {
			var share = Math.pow(Math.min(Math.max(okta, 0), 8) / 8, 2);
			return CLOUD_COLOUR.split(',').map(part => Math.round(Number(part) + (255 - Number(part)) * share)).join(', ');
		};
		day.forEach((hour, index) => {
			(hour.layers || []).forEach(layer => {
				var hoog = y(Math.min(layer.top, ceiling));
				var laag = y(Math.min(layer.base, ceiling));
				ctx.fillStyle = 'rgba(' + towardsWhite(layer.okta) + ', 0.85)';
				ctx.fillRect(x(index) + 1, hoog, Math.max(2, span - 2), Math.max(2, laag - hoog));
			});
		});

		/* Hoeveel er hangt, in achtsten, boven het blokje in plaats van erin: een dun laagje heeft
		   binnenin geen ruimte voor een getal, en zo staan ze allemaal op dezelfde plek. Past het niet
		   naast elkaar, dan om de drie uur - dezelfde uren die onderaan hun tijd krijgen. */
		ctx.font = '600 ' + OKTA_SIZE + 'px ' + family;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = ink;
		var elkUur = (ctx.measureText('8/8').width + OKTA_GAP) <= span;
		day.forEach((hour, index) => {
			var lagen = hour.layers || [];
			if (lagen.length === 0) {
				return;
			}
			if (!elkUur && hour.time.getHours() % 3 !== 0) {
				return;
			}
			var vorige = null;
			lagen.forEach(layer => {
				var hoog = y(Math.min(layer.top, ceiling));
				var laag = y(Math.min(layer.base, ceiling));
				/* boven het blokje, tenzij het tegen de bovenrand aan ligt: dan eronder */
				var regel = (hoog - OKTA_GAP - OKTA_SIZE < top) ? laag + OKTA_SIZE + OKTA_GAP : hoog - OKTA_GAP;
				if (vorige !== null && Math.abs(regel - vorige) < OKTA_SIZE) {
					return;			// twee lagen vlak boven elkaar: één getal is leesbaar, twee niet
				}
				vorige = regel;
				ctx.fillText(layer.okta + '/8', x(index) + span / 2, regel);
			});
		});

		/* het nulgradenniveau als lijn, zoals in de tegel ernaast */
		ctx.strokeStyle = coldColour;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([4, 4]);
		ctx.beginPath();
		day.forEach((hour, index) => {
			if (hour.freezing === null || hour.freezing === undefined) {
				return;
			}
			var punt = y(Math.min(hour.freezing, ceiling));
			var midden = x(index) + span / 2;
			if (index === 0) {
				ctx.moveTo(midden, punt);
			} else {
				ctx.lineTo(midden, punt);
			}
		});
		ctx.stroke();
		ctx.setLineDash([]);

		/* De grondwind eronder, in dezelfde vormentaal als de wolkenbasistegel: een stip op elk uur,
		   de stoten in hun eigen kleur erboven en de wind eronder. Gestreept, want dit is allemaal
		   verwachting - net als de verwachte helft in die tegel. */
		var speeds = day.map(hour => hour.ground.kt).concat(day.map(hour => hour.ground.gust || 0));
		var hoogste = Math.max(10, Math.max.apply(null, speeds));
		var windBottom = box.height - LABEL_HEIGHT - 14;
		var windTop = Math.min(Math.max(bottom + 26, box.height - LABEL_HEIGHT - WIND_HEIGHT + 26), windBottom - 30);
		var yWind = kt => windBottom - (kt / hoogste) * (windBottom - windTop);
		var midden = index => x(index) + span / 2;

		var lijn = (waarden, kleur) => {
			ctx.strokeStyle = kleur;
			ctx.lineWidth = 2;
			ctx.setLineDash([5, 4]);
			ctx.beginPath();
			waarden.forEach((kt, index) => {
				var punt = yWind(kt);
				if (index === 0) {
					ctx.moveTo(midden(index), punt);
				} else {
					ctx.lineTo(midden(index), punt);
				}
			});
			ctx.stroke();
			ctx.setLineDash([]);
		};
		var gusts = day.map(hour => hour.ground.gust || hour.ground.kt);
		var winds = day.map(hour => hour.ground.kt);
		lijn(gusts, gustColour);
		lijn(winds, windColour);

		ctx.font = '600 ' + WIND_SIZE + 'px ' + family;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'alphabetic';
		var stip = (index, kt, kleur, label, boven) => {
			ctx.fillStyle = kleur;
			ctx.beginPath();
			ctx.arc(midden(index), yWind(kt), 3, 0, 2 * Math.PI);
			ctx.fill();
			if (label === null) {
				return;
			}
			/* het getal in de gewone kleur van de cijfers; de stoten houden hun eigen kleur, want die
			   is een signaal */
			ctx.fillStyle = (kleur === gustColour) ? gustColour : ink;
			ctx.fillText(label, midden(index), yWind(kt) + (boven ? -10 : 16));
		};
		day.forEach((hour, index) => {
			var noemen = hour.time.getHours() % 3 === 0;
			stip(index, gusts[index], gustColour, noemen ? 'G' + Math.round(gusts[index]) : null, true);
			stip(index, winds[index], windColour, noemen ? Math.round(winds[index]) + ' ' + UNIT_KNOTS : null, false);
		});

		/* de uren onderaan */
		ctx.font = CHART_SIZE + 'px ' + family;
		ctx.fillStyle = muted;
		ctx.textBaseline = 'alphabetic';
		day.forEach((hour, index) => {
			if (hour.time.getHours() % 3 !== 0) {
				return;
			}
			ctx.fillText(String(hour.time.getHours()).padStart(2, '0') + ':00', midden(index), box.height - 4);
		});
	}

	/* De hoogtes van de tabel, met de plek waar hun rij begint - in de maat van het canvas, dus
	   gedeeld door de schaal waarmee het bord op het scherm gepast wordt. Geeft null als er niets te
	   meten valt; dan verdeelt de grafiek de ruimte zelf. */
	levels(canvas) {
		var rows = document.querySelectorAll('.outlook-table tr[data-feet]');
		if (rows.length < 2 || canvas.clientHeight === 0) {
			return null;
		}
		var frame = canvas.getBoundingClientRect();
		var scale = frame.height / canvas.clientHeight;
		if (!(scale > 0)) {
			return null;
		}
		var list = [];
		Array.prototype.forEach.call(rows, row => {
			list.push({
				feet: Number(row.getAttribute('data-feet')),
				y: (row.getBoundingClientRect().top - frame.top) / scale,
			});
		});
		list.sort((a, b) => b.feet - a.feet);
		/* de bovenste rij moet wel in beeld liggen, anders valt de hele grafiek buiten het vak */
		if (list[0].y < 0 || list[list.length - 1].y > canvas.clientHeight) {
			return null;
		}
		return list;
	}

	/* 9.000 ft heet "9k" op de schaal, net als in de tegel ernaast */
	tickLabel(feet) {
		return (feet === 0) ? '0' : (feet / 1000) + 'k';
	}

	hide() {
		if (!this.showing) {
			return;
		}
		this.showing = false;
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		var name = document.getElementById(ID_HEADER_NAME);
		var valid = document.getElementById(ID_VALID_FROM);
		var source = document.getElementById(ID_SOURCE);
		if (this.header !== null && name) {
			name.innerHTML = this.header.name;
			if (valid) {
				valid.innerHTML = this.header.valid;
			}
			if (source) {
				source.innerHTML = this.header.source;
			}
			this.header = null;
		}
		/* Terug naar het bulletin: de module heeft alles nog in huis, hij hoeft alleen opnieuw te
		   tekenen. Is de herschreven versie aan de beurt, dan komt die er zelf achteraan. */
		var llfc = (document.modules || {}).knmi_llfc;
		if (llfc) {
			/* de kop liever vers dan uit de kopie: er kan intussen een nieuw bulletin zijn geweest */
			if (llfc.showValidity) {
				llfc.showValidity();
			}
			if (llfc.llfc) {
				llfc.showBulletin();
				if (llfc.rewrite) {
					llfc.showRewrite();
				}
			}
		}
	}
}

export { Module };
