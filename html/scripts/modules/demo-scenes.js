/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */
/* jshint esversion: 6 */

/*
 * Vaste taferelen die je vanuit Discord even op het bord kunt zetten: dertig seconden, en dan is
 * het weer het echte bord. Bedoeld om te laten zien wat het bord doet als het er toe doet - harde
 * wind, een jumprun, een gesloten wolkendek - zonder daarop te hoeven wachten.
 *
 * Anders dan de mooiweerstand (zie demo.js) wordt de pagina hier niet opnieuw geladen. Dat kan ook
 * niet: laden kost een seconde of tien, en dat is een derde van de demo. In plaats daarvan krijgen
 * de draaiende modules hun waarden even overschreven en tekenen ze zichzelf opnieuw. Elk tafereel
 * geeft bij het aanzetten een functie terug die het weer terugdraait, zodat er niets van te raden
 * valt wat er precies hersteld moet worden.
 *
 * Zolang een tafereel loopt staat er DEMO in de bovenbalk. Bij de mooiweerstand hoeft dat niet - een
 * palmeiland op de radar spreekt voor zich - maar "24 kt aan de grond" is niet als grap te
 * herkennen, en er staat iemand naar dat scherm te kijken die zo gaat springen.
 */

import { computeAuto, computeAutoOffset } from '../jumprun/calc/auto.js';
import { DIR_DEG, planInput, targetOf, exitAltOf, tracksTrue, notationOf } from '../jumprun/calc/dropzone.js';
import { profileFromAloft } from '../jumprun/calc/wind.js';
import { destination } from '../jumprun/calc/geo.js';
import { NM } from '../jumprun/calc/units.js';

const POLL_MS = 5000;
const DROPZONES_URL = './jumprun-proxy.php?action=dropzones';
const TRACK_STEP_DEG = 10;			// zoals de piloot hem invoert, net als bij de automatische jumprun

/* De velden zoals jumprun.nl ze kent: ligging, voorkeurskoersen, exithoogte, notatie. Eén keer
   opgehaald bij het starten van het bord; ze veranderen hooguit een paar keer per jaar. */
var dropzones = [];
const ID_CHIP = 'demo-chip-id';
const STATE_URL = 'demo.php';

/* De waarden in de taferelen zijn met opzet rond en herkenbaar: ze horen eruit te zien als een dag
   die je je kunt voorstellen, niet als een meting. */
const SCENES = {
	'grondwind': {
		label: 'harde grondwind',
		apply: m => wind(m, { feet: 0, kt: 24, dir: 248 }, {}, { wind_kt: 24, wind_dir: 248, gust_kt: 31 }),
	},
	'wind-laag': {
		label: 'harde wind onderin',
		apply: m => wind(m, { feet: 3000, kt: 34, dir: 255 },
			{ 1000: { kt: 27, dir: 244 }, 2000: { kt: 31, dir: 250 }, 3000: { kt: 34, dir: 255 } }),
	},
	'wind-hoog': {
		label: 'harde wind bovenin',
		apply: m => wind(m, { feet: 12000, kt: 52, dir: 272 },
			{ 9000: { kt: 47, dir: 268 }, 12000: { kt: 52, dir: 272 }, 15000: { kt: 50, dir: 275 } }),
	},
	'windgrens': {
		label: 'de windgrens in de tabel',
		/* Onder de grens van de kaart (30 kt) en boven die van de tabel (25): zo zie je alleen de
		   gekleurde cellen, wat precies het verschil tussen die twee laat zien. */
		apply: m => wind(m, null,
			{ 1000: { kt: 26, dir: 240 }, 2000: { kt: 27, dir: 245 }, 3000: { kt: 28, dir: 248 },
				5000: { kt: 29, dir: 252 } }),
	},
	'stoten': {
		label: 'stoten in de grondwind',
		apply: m => wind(m, null, {}, { wind_kt: 12, wind_dir: 236, gust_kt: 24 }),
	},
	'handschoenen': {
		label: 'het nulgradenniveau onder de exithoogte',
		apply: m => {
			var hour = current(m);
			if (!hour) {
				return null;
			}
			var undo = patch(hour, { freezing: 6000 });
			paint(m);
			return () => { undo(); paint(m); };
		},
	},
	'wolkenlagen': {
		label: 'drie wolkenlagen',
		apply: m => clouds(m, [
			{ base: 1800, top: 3200, okta: 3 },
			{ base: 5500, top: 7000, okta: 5 },
			{ base: 9500, top: 11000, okta: 2 },
		]),
	},
	'dek': {
		label: 'een gesloten wolkendek',
		apply: m => clouds(m, [{ base: 1200, top: 4500, okta: 8 }]),
	},
	'onweer': {
		label: 'onweer in het bulletin',
		apply: m => {
			var llfc = m.knmi_llfc;
			if (!llfc || !llfc.llfc_items) {
				return null;
			}
			var undo = patch(llfc.llfc_items, {
				'SIGNIFICANT WEER': 'Vanaf 13 UTC lokaal zware <span class="llfc-item-text-alert">'
					+ 'onweersbuien</span> met hagel en zware windstoten tot 45 knopen. Boven het '
					+ 'IJsselmeer kans op <span class="llfc-item-text-alert">ijsaanzetting</span> '
					+ 'boven FL080.',
				'BEWOLKING': 'Buienwolken met basis 2.000 voet en toppen tot 28.000 voet.',
			});
			/* showBulletin() zet de tegel op het ruwe bulletin - en daar hoort dit ook: de
			   alarmwoorden worden alleen daar opgelicht. Na afloop dus niet alleen de tekst
			   terugzetten maar ook de herschreven versie weer laten ophalen, anders blijft het bord
			   in het ruwe bulletin hangen tot de volgende ronde. */
			llfc.showBulletin();
			return () => {
				undo();
				llfc.showBulletin();
				if (llfc.rewrite) {
					llfc.showRewrite();
				}
			};
		},
	},
	'jumprun': {
		label: 'een jumprun op de kaart',
		apply: m => jumpruns(m, [12000]),
	},
	'jumprun-hoog-laag': {
		label: 'een hoge en een lage jumprun',
		apply: m => jumpruns(m, [12000, 5000]),
	},
};

/* ------------------------------------------------------------------ gereedschap */

/* Waarden zetten en een functie teruggeven die ze weer terugzet */
function patch(target, values) {
	var before = {};
	Object.keys(values).forEach(key => { before[key] = target[key]; });
	Object.assign(target, values);
	return () => Object.assign(target, before);
}

/* Het uur dat het bord in de kolom NU toont - hetzelfde uur waar de tabel en de windkaart naar
   kijken, en niet het eerste uur dat het model teruggaf. */
function current(m) {
	var columns = (m.aloft && typeof m.aloft.columns === 'function') ? m.aloft.columns() : [];
	return columns.length ? columns[0] : null;
}

/* Een module opnieuw laten tekenen, als hij er is en al iets heeft om te tekenen */
function redraw(module, method) {
	var draw = module ? module[method || 'showData'] : null;
	if (typeof draw === 'function') {
		try {
			draw.call(module);
		} catch (error) {
			console.warn('Demo kan een tegel niet opnieuw tekenen: ' + error.message);
		}
	}
}

/* Alles wat van deze gegevens leeft opnieuw tekenen. De wolkenbasisgrafiek hoort erbij: die leest
   dezelfde meting en dezelfde lagen, en anders staat daar nog de echte grondwind naast een tegel
   die de verzonnen wind toont. */
function paint(m) {
	redraw(m.aloft);
	redraw(m.luchtvaartmeteo);
	redraw(m.cloudprofile, 'updateData');
}

/* De laatste meting in een reeks van de wolkenbasisgrafiek; die tekent het verloop van de afgelopen
   uren, dus het gaat om het laatste punt. */
function lastPoint(m, field, value) {
	var series = (m.luchtvaartmeteo && m.luchtvaartmeteo.series) ? m.luchtvaartmeteo.series[field] : null;
	if (!series || series.length === 0) {
		return () => {};
	}
	var point = series[series.length - 1];
	var before = point[1];
	point[1] = value;
	return () => { point[1] = before; };
}

/* Wind op hoogte, aan de grond, of allebei; en desgewenst de kaart van Windy erbij.
   `map` is wat er op de kaart moet komen (of null), `levels` de hoogtes in de tabel,
   `ground` de meting onderin. */
function wind(m, map, levels, ground) {
	var undos = [];
	var hour = current(m);
	if (hour) {
		Object.keys(levels || {}).forEach(feet => {
			if (hour.levels[feet]) {
				undos.push(patch(hour.levels[feet], levels[feet]));
			}
		});
	}
	if (ground && m.luchtvaartmeteo && m.luchtvaartmeteo.observation) {
		undos.push(patch(m.luchtvaartmeteo.observation, ground));
		if (ground.wind_kt !== undefined) {
			undos.push(lastPoint(m, 'wind_kt', ground.wind_kt));
		}
		if (ground.gust_kt !== undefined) {
			undos.push(lastPoint(m, 'gust_kt', ground.gust_kt));
		}
	}
	paint(m);
	if (map && m.windy) {
		clearTimeout(m.windy.sequenceTimer);
		m.windy.show({ feet: map.feet, kt: map.kt, dir: map.dir, range: map.feet > 0 ? 'high' : 'ground' });
	}
	return () => {
		undos.forEach(undo => undo());
		paint(m);
		if (m.windy) {
			m.windy.hide();
		}
	};
}

/* De wolkenlagen in het meetblok. Die komen van de ceilometer op het veld en niet uit het model,
   dus ze worden daar gezet: base1_ft/okta1 tot en met drie, laagste eerst. */
function clouds(m, layers) {
	var measured = m.luchtvaartmeteo;
	if (!measured || !measured.observation) {
		return null;
	}
	var values = { okta_total: layers[layers.length - 1].okta };
	[1, 2, 3].forEach(number => {
		var layer = layers[number - 1];
		values['base' + number + '_ft'] = layer ? layer.base : null;
		values['okta' + number] = layer ? layer.okta : null;
	});
	var undos = [patch(measured.observation, values)];
	/* De grafiek ernaast tekent het verloop van de afgelopen uren en leest daarvoor niet de meting
	   maar de reeksen. Alleen het laatste punt meeveranderen: dan staat de demo-laag bij "Nu" en
	   blijft het echte verloop ervoor staan, wat het ook is. Een basis van nul valt daar vanzelf af. */
	[1, 2, 3].forEach(number => {
		var layer = layers[number - 1];
		undos.push(lastPoint(m, 'base' + number + '_ft', layer ? layer.base : 0));
		undos.push(lastPoint(m, 'okta' + number, layer ? layer.okta : 0));
	});
	paint(m);
	return () => { undos.forEach(undo => undo()); paint(m); };
}

/* Een of twee jumpruns op de kaart. Alleen het moment is verzonnen: de koers, de offset, het groene
   licht en het bereik komen uit dezelfde automatiek als /jumprun-zetten, met de wind van nu. Dus de
   voorkeurskoersen van het veld tellen mee, en de offset wordt zo gekozen dat het groene licht op de
   bak uitkomt - een run waar je werkelijk mee zou vliegen, geen streep over de kaart.

   Eerst de run over de bak zelf, want die geeft het offsetadvies; dan de lijn op de plek waar hij
   komt te liggen, want daar hangt het groene licht van af. Precies de volgorde van jumprun-auto.mjs. */
function jumpruns(m, altitudes) {
	var jumprun = m.jumprun;
	if (!jumprun || dropzones.length === 0) {
		return null;
	}
	var station = jumprun.stations[0];
	var dz = dropzones.find(one => one.id === station || (one.aliases || []).indexOf(station) !== -1);
	var wind = (typeof jumprun.currentWind === 'function') ? jumprun.currentWind() : null;
	var profile = wind ? profileFromAloft(wind.levels) : null;
	if (!dz || !profile) {
		return null;
	}
	var landing = targetOf(dz);
	var dirDeg = one => (typeof one === 'number') ? one : (DIR_DEG[one] || 0);

	var runs = altitudes.map(feet => {
		var base = { profile: profile, elevationM: 0, exitAltFt: feet, openAltFt: 3500 };
		var auto = {
			preferredTracks: tracksTrue(dz),
			trackStep: TRACK_STEP_DEG,
			highExitAltFt: exitAltOf(dz),
			lowRunRule: true,
		};
		var at = target => computeAuto(planInput(dz, { ...base, target: target }), auto);
		try {
			var overTheTarget = at(landing);
			var advised = computeAutoOffset(overTheTarget, { landing: landing, notation: notationOf(dz), compute: at });
			var result = (advised.nm > 0)
				? at(destination(landing, dirDeg(advised.dir), advised.nm * NM))
				: overTheTarget;
			return {
				entry: {
					station: dz.id,
					set_at: new Date().toISOString(),
					version: 1,
					plan: result.input,
					wind: wind,
					who: 'demo',
				},
				planned: result,
			};
		} catch (error) {
			console.warn('Demo kan geen jumprun uitrekenen op ' + feet + ' ft: ' + error.message);
			return null;
		}
	}).filter(run => run !== null);
	if (runs.length === 0) {
		return null;
	}

	var before = jumprun.all[station];
	var hidden = jumprun.hidden;
	jumprun.all[station] = { notation: notationOf(dz) === 'polar' ? 'polar' : 'offset', runs: runs };
	jumprun.hidden = false;
	jumprun.sequence(Math.max(6, Math.floor(30 / runs.length)));
	return () => {
		clearTimeout(jumprun.sequenceTimer);
		jumprun.hide();
		if (before === undefined) {
			delete jumprun.all[station];
		} else {
			jumprun.all[station] = before;
		}
		jumprun.hidden = hidden;
	};
}

/* ------------------------------------------------------------------ de module */

class Module {
	constructor() {
		this.scene = null;			// wat er nu loopt
		this.undo = null;
		this.timer = null;
		this.loop = null;			// de beurten die de radarlus even is kwijtgeraakt
		this.task = setInterval(this.check.bind(this), POLL_MS);
		this.check();
		this.loadDropzones();
	}

	/* De velden van jumprun.nl, voor de jumprun-demo. Eén keer bij het starten: ze staan achter een
	   proxy die het antwoord uren bewaart, en zonder deze gegevens kan die demo niet rekenen. */
	loadDropzones() {
		fetch(DROPZONES_URL, { headers: { Accept: 'application/json' } })
			.then(response => response.json())
			.then(data => { dropzones = (data && data.dropzones) ? data.dropzones : []; })
			.catch(error => console.warn('Demo kent de velden niet: ' + error.message));
	}

	/* Vraagt de Pi of er een tafereel klaarstaat. Hetzelfde adres als de mooiweerstand, want het is
	   dezelfde vraag: staat er iets anders dan het echte bord op het programma? */
	check() {
		fetch(STATE_URL, { cache: 'no-store' })
			.then(response => response.json())
			.then(state => {
				/* Hangt er een tweede scherm met de jumpruns erop? Dan hoeft de kaartlus van dit
				   bord ze niet ook te tonen - dat zou hetzelfde twee keer zijn. Deze module vraagt
				   het toch al elke vijf seconden, dus het antwoord komt gratis mee. */
				document.secondScreen = !!(state && state.screen2);
				var wanted = (state && state.scene) ? state.scene : null;
				if (wanted === null) {
					this.stop();
					return;
				}
				if (this.scene === wanted.name) {
					return;
				}
				this.start(wanted.name, wanted.until);
			})
			.catch(() => {});
	}

	start(name, until) {
		var scene = SCENES[name];
		var modules = document.modules || {};
		if (!scene) {
			console.warn('Onbekende demo: ' + name);
			return;
		}
		this.stop();
		var undo = null;
		try {
			undo = scene.apply(modules);
		} catch (error) {
			console.warn('Demo ' + name + ' mislukt: ' + error.message);
			return;
		}
		if (undo === null) {
			console.warn('Demo ' + name + ' kan nu niet: het bord heeft de gegevens nog niet.');
			return;
		}
		/* De lus mag er niet doorheen fietsen: die geeft de kaart om de zoveel tijd aan een jumprun
		   of aan de windkaart, en dat zou midden in een demo gebeuren. */
		this.loop = suppressLoop(modules);
		this.scene = name;
		this.undo = undo;
		this.chip(true);
		var left = Math.max(1000, (Number(until) * 1000) - Date.now());
		this.timer = setTimeout(this.stop.bind(this), left);
	}

	stop() {
		/* Niets aan de hand, niets op te ruimen. Deze module kijkt elke vijf seconden of er een
		   tafereel klaarstaat, en vrijwel altijd staat dat er niet - dan hoort hij van het bord af
		   te blijven. Deed hij dat niet, dan sloot hij onderaan ook de windkaart en de jumprun,
		   terwijl de radarlus die net zijn beurt had gegeven: de kaart stond vijf tellen in beeld
		   en de lus wachtte daarna nog een halve minuut op iets dat er niet meer was. */
		if (!this.scene && !this.timer && !this.undo && !this.loop) {
			return;
		}
		clearTimeout(this.timer);
		this.timer = null;
		if (this.undo !== null) {
			try {
				this.undo();
			} catch (error) {
				console.warn('Demo terugdraaien mislukt: ' + error.message);
			}
		}
		if (this.loop) {
			this.loop();
			this.loop = null;
		}
		/* Wat er ook misging bij het terugdraaien: de twee lagen die de kaart kunnen overnemen gaan
		   dicht. Een tafereel dat half blijft hangen is erger dan een tafereel dat niet komt. */
		var modules = document.modules || {};
		if (modules.jumprun && typeof modules.jumprun.hide === 'function') {
			modules.jumprun.hide();
		}
		if (modules.windy && typeof modules.windy.hide === 'function') {
			modules.windy.hide();
		}
		this.undo = null;
		this.scene = null;
		this.chip(false);
	}

	chip(on) {
		var chip = document.getElementById(ID_CHIP);
		if (chip) {
			chip.hidden = !on;
		}
	}
}

/* De radarlus even zijn beurten afnemen, en ze daarna teruggeven */
function suppressLoop(m) {
	if (!m.radar) {
		return () => {};
	}
	var undo = patch(m.radar, { jumprunAfterRuns: 0, windAfterRuns: 0 });
	return undo;
}

export { Module, SCENES };
