/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */
/* jshint esversion: 8 */

/*
 * Het tweede scherm: de jumpruns van vandaag, naast elkaar.
 *
 * Op het bord krijgt elke jumprun om beurten de kaarttegel, tussen de radar door. Hangt er een
 * tweede scherm aan de Pi, dan hoeft dat niet: daar past Hoogeveen naast Echten en staan ze er
 * allebei de hele dag. Wie de trap op loopt ziet in één oogopslag wat er hangt.
 *
 * Er wordt hier niets uitgerekend wat het bord niet al uitrekent: dit is dezelfde module met
 * dezelfde sommen, alleen twee keer, elk met zijn eigen kaart. Zo kunnen de twee schermen elkaar
 * niet tegenspreken.
 *
 * Staat er voor een veld niets, dan blijft de luchtfoto staan met de bak erop. Dat is het antwoord:
 * hier hangt vandaag geen run. Een leeg vak zou eruitzien als iets dat stuk is.
 */

import { applyTheme, loadConfig } from './config.js';
import { Module as Jumprun } from './modules/jumprun.js';

/* Hetzelfde adresje als op het bord: ?location=hilversum pakt config-hilversum.json. */
function getURLParameter(variable) {
	var found = new URLSearchParams(window.location.search).get(variable);
	return (found === null) ? null : found;
}

const DROPZONES_URL = './jumprun-proxy.php?action=dropzones';
const ID_RUNS = 'runs';
const ID_CLOCK = 'runs-clock';
/* Hoe lang één run in beeld blijft. Alleen van belang voor een veld waar er twee hangen - de hoge
   en de lage run - want dan wisselen die elkaar in dit vak af. Hetzelfde tempo als op het bord. */
const TURN_MS = 20 * 1000;
const CLOCK_MS = 10 * 1000;

/* De dropzones die dit scherm laat zien: dezelfde instelling als het bord gebruikt. */
function stations() {
	var jumprun = document.config.jumprun || {};
	if (Array.isArray(jumprun.stations) && jumprun.stations.length > 0) {
		return jumprun.stations;
	}
	var one = jumprun.station
		|| (document.config.radar && document.config.radar.forecast && document.config.radar.forecast.station);
	return one ? [one] : [];
}

/* De namen en de ligging van de velden, van jumprun.nl zelf. Zonder deze lijst weet dit scherm
   niet waar het de luchtfoto heen moet draaien als er geen run hangt. */
function dropzones() {
	return fetch(DROPZONES_URL, { headers: { Accept: 'application/json' } })
		.then(response => response.json())
		.then(data => (data && Array.isArray(data.dropzones)) ? data.dropzones : [])
		.catch(error => {
			console.warn('De velden zijn niet op te halen: ' + error.message);
			return [];
		});
}

/* Eén vak: een kop met de naam van het veld en daaronder de kaart. De id's gaan mee naar de
   module, want er staan er meer dan één op deze pagina. */
function pane(station) {
	var section = document.createElement('section');
	section.className = 'run';
	/* Geen eigen kop boven het vak: de naam van het veld staat al in het onderschrift over de
	   kaart, in de opmaak die het bord er ook aan geeft. Twee keer dezelfde naam boven elkaar kost
	   alleen ruimte die de kaart beter kan gebruiken. */
	section.innerHTML = '<div class="run-body">'
		+ '<div class="layer-jumprun" id="layer-' + station + '">'
		+ '<div class="jumprun-map" id="map-' + station + '"></div>'
		+ '<div class="jumprun-caption" id="caption-' + station + '"></div>'
		+ '</div></div>';
	document.getElementById(ID_RUNS).appendChild(section);
	return {
		layer: 'layer-' + station,
		map: 'map-' + station,
		caption: 'caption-' + station,
	};
}

/* Wat er in dit vak hoort te staan. Hangt er een run, dan die - en hangen er twee, dan om beurten.
   Hangt er niets, dan de luchtfoto van het veld. */
function turn(view) {
	if (view.module.active) {
		view.module.show();
		return;
	}
	view.module.empty(view.dropzone);
}

function clock() {
	var element = document.getElementById(ID_CLOCK);
	if (!element) {
		return;
	}
	var now = new Date();
	element.innerHTML = now.toLocaleDateString(document.config.locale, { weekday: 'long', day: 'numeric', month: 'long' })
		+ ' &middot; ' + now.toLocaleTimeString(document.config.locale, { hour: '2-digit', minute: '2-digit' });
}

document.config = {};
loadConfig(getURLParameter('location')).then(() => {
	applyTheme(document.config.theme);
	document.documentElement.classList.add('jumpruns');
	clock();
	setInterval(clock, CLOCK_MS);

	var wanted = stations();
	if (wanted.length === 0) {
		document.getElementById(ID_RUNS).innerHTML =
			'<p class="run-head">Dit bord heeft geen dropzones in zijn instellingen staan.</p>';
		return;
	}

	dropzones().then(all => {
		var views = wanted.map(station => {
			var dropzone = all.find(one => one.id === station) || { id: station, name: station };
			var ids = pane(station);
			return {
				station: station,
				dropzone: dropzone,
				/* De naam gaat mee: het onderschrift van de kaart hoort "Echten" te zeggen, niet
				   de naam van het veld waar dit bord toevallig hangt. */
				module: new Jumprun([station], { ids: ids, name: dropzone.name || station }),
			};
		});
		/* De module haalt zijn plannen zelf op en dat duurt even; tot die tijd staat er de
		   luchtfoto, en zodra er iets binnen is neemt de eerstvolgende beurt het over. */
		var beurt = () => views.forEach(turn);
		setTimeout(beurt, 1500);
		setInterval(beurt, TURN_MS);
	});
});
