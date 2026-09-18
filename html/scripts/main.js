/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { applyTheme, loadConfig } from './config.js';
import { createSystemMessage, removeSystemMessage } from './functions.js';
import { LANGUAGE_INTERNET_DOWN, LANGUAGE_INTERNET_RESTORED } from './language.js';
import { Module as KNMI } from './modules/knmi.js';
import { Module as KNMI_LLFC } from './modules/knmi_llfc.js';
import { Module as LuchtvaartMeteo } from './modules/luchtvaartmeteo.js';
import { Module as NOAAMETAR } from './modules/noaa_metar.js';
import { Module as OpenSkyNetwork } from './modules/openskynetwork.js';
import { Module as OpenWeatherMap } from './modules/openweathermap.js';
import { Module as Radar } from './modules/radar.js';
import { Module as Sat24 } from './modules/sat24.js';
import { Module as WeatherAndRadar } from './modules/weatherandradar.js';
import { Module as WeerSlag } from './modules/weerslag.js';
import { Module as Aloft } from './modules/aloft.js';
import { Module as CloudProfile } from './modules/cloudprofile.js';
import { Module as Jumprun } from './modules/jumprun.js';
import { Module as Windy } from './modules/windy.js';
import { installDemo, showDemoMap } from './demo.js';

const ID_DATETIME = 'datetime-data';
const ID_LAYER_MAP = 'layer-map-id';
const ID_IMG_LAYER_MAP = 'img-layer-map-id';
const ID_IMG_LAYER_CLOUD = 'img-layer-cloud-id';
const ID_IMG_LAYER_RAIN = 'img-layer-rain-id';
const ID_IFRAME_RAIN = 'img-layer-rain-id';
const ID_UPPERWINDS_TABLE = 'uppper-winds-content-data';
const ID_WEATHER_ALERT = 'weather-alert';
const ID_METAR = 'metar';

var ip;
var showip_counter = 0;



class ShowCurrentDateTime {
	constructor(id) {
		this.id = id;
		this.refreshInterval = 1000; // Refresh interval is 1 second

		/* Schedule update of document content */
		this.task = setInterval(
			this.updateData.bind(this),
			this.refreshInterval
		);

		/* Initial fill of document content */
		this.updateData();
	}

	updateData() {
		var element = document.getElementById(ID_DATETIME);
		var x = new Date();

		if (showip_counter == 0) {
			element.innerHTML = x.toLocaleString(document.config.locale, document.config.options);
		} else {
			element.innerHTML = ip;
			showip_counter--;
		}
	}
}

class OnlineStatus {
	constructor() {
		this.count = 0;
		this.refreshInterval = 5000; // Refresh interval is 5 second

		/* Schedule update of document content */
		this.task = setInterval(
			this.updateStatus.bind(this),
			this.refreshInterval
		);

		/* Initial fill of document content */
		this.updateStatus();
	}

	updateStatus() {
		if (window.navigator.onLine === false) {
			this.count++;
			if (this.count === 3) {
				createSystemMessage(LANGUAGE_INTERNET_DOWN);
				console.warn(LANGUAGE_INTERNET_DOWN);
			}
		} else {
			if (this.count !== 0) {
				removeSystemMessage();
				console.info(LANGUAGE_INTERNET_RESTORED);
				this.count = 0;
			}
		}
	}
}

/* Het bord kan tijdelijk een verzonnen mooie dag tonen, gezet via de Discord-bot. Het bord vraagt
   er zelf naar in plaats van dat iemand de browser omschakelt: dan is er geen zwart scherm, en komt
   het vanzelf weer bij de werkelijkheid uit zodra de tijd om is. */
const DEMO_POLL_MS = 15000;
/* Mooiweerstand: staat als eindtijd in de URL, zodat hij al werkt voordat er iets opgehaald is.
   Een vraag aan de server zou te laat komen - de modules zijn dan al begonnen. */
function demoUntil() {
	var until = Number(getURLParameter('demo')) || 0;
	return (until * 1000 > Date.now()) ? until : 0;
}

function watchDemo() {
	/* Zitten we er al in, dan niets doen. Zonder deze regel navigeert het bord elke vijftien
	   seconden opnieuw naar zichzelf, en dat is een pagina die zichzelf eindeloos herlaadt. */
	if (demoUntil() > 0) {
		return;
	}
	var check = () => fetch('demo.php', { cache: 'no-store' })
		.then(response => response.json())
		.then(state => {
			if (state.active && state.until) {
				/* window ervoor, want main.js heeft zelf een 'location': de dropzone uit de URL.
				   Zonder dat voorvoegsel zet je een eigenschap op die variabele en gebeurt er
				   niets, zonder foutmelding. */
				window.location.href = window.location.pathname + '?demo=' + state.until;
			}
		})
		.catch(() => {});
	check();
	setInterval(check, DEMO_POLL_MS);
}

/* Het bord op het venster passen: dezelfde indeling, alleen groter of kleiner, en gecentreerd zodat
   de overgebleven rand gelijk verdeeld is. Bij precies 1920 bij 1080 is de factor 1.

   Schalen in plaats van opnieuw indelen, omdat de verhoudingen op één 16:9-scherm zijn afgestemd:
   lettergroottes, kolombreedtes, hoeveel er in een kaartje past. Bij een smaller venster opnieuw
   verdelen levert afgekapte getallen op - "245" wordt "24" en dat ziet eruit als een geldige
   windrichting - in plaats van een kleiner bord. De kaart merkt er niets van: transform raakt de
   opmaak niet, dus Leaflet blijft rekenen met het vlak van 1920 bij 1080. */
/* De muisaanwijzer laten zien zolang er een muis beweegt, en hem daarna weer laten verdwijnen.
   Op de machine van waaraf je meekijkt is hij er zodra je hem nodig hebt.

   Behalve op de kiosk zelf. Daar hangt geen muis aan, maar wie van afstand meekijkt stuurt er wel
   een: het scherm van de Pi is hetzelfde scherm als de televisie in de kantine, dus een beweging
   op jouw bureau zette daar een pijltje in beeld. De kiosk start met ?kiosk=1 en laat de aanwijzer
   daarom met rust. */
const POINTER_IDLE_MS = 3000;
var pointerTimer = null;
function watchPointer() {
	if (getURLParameter('kiosk')) {
		return;
	}
	window.addEventListener('mousemove', () => {
		document.body.classList.add('pointer-moving');
		clearTimeout(pointerTimer);
		pointerTimer = setTimeout(() => document.body.classList.remove('pointer-moving'), POINTER_IDLE_MS);
	});
}

/* Het windprofiel bepaalt hoe hoog de drie blokken naast elkaar worden.

   Dat is het blok met de vaste vorm: een regel per hoogte, met hoogstens een regel erbij als het
   0 °C-niveau er tussenin valt. De andere twee - het meetblok en de wolkenbasis - passen zich aan:
   hun inhoud verdeelt zich over de hoogte die daaruit komt. Zonder dit zou een blok dat toevallig
   een regel langer wordt de rij hoger maken, en dan schuift de verwachting eronder weg.

   De hoogte wordt berekend uit wat er in het windprofiel staat en niet uit hoe hoog het blok nu is:
   in een rij van gelijke hoogtes weet je anders niet meer wie wie hoog maakte. offsetHeight in
   plaats van getBoundingClientRect, want het bord als geheel wordt geschaald en dat zou de maat
   meeschalen. */
function watchTiles() {
	var wind = document.getElementById('upper-winds');
	var column = document.querySelector('.text');
	if (!wind || !column) {
		return;
	}
	var measure = function () {
		/* Alleen wat er ín het blok staat: max-height gaat over de inhoud, en de drie blokken hebben
		   dezelfde rand en dezelfde padding, dus daarmee komen ze aan de buitenkant even hoog uit. */
		var needed = 0;
		Array.prototype.forEach.call(wind.children, function (child) {
			needed += child.offsetHeight;
		});
		if (needed > 0) {
			column.style.setProperty('--tile-height', Math.round(needed) + 'px');
		}
	};
	measure();
	if (window.ResizeObserver) {
		var observer = new ResizeObserver(measure);
		Array.prototype.forEach.call(wind.children, function (child) {
			observer.observe(child);
		});
	}
	window.addEventListener('resize', measure);
}

function fit() {
	var style = getComputedStyle(document.documentElement);
	var width = parseFloat(style.getPropertyValue('--board-width')) || 1920;
	var height = parseFloat(style.getPropertyValue('--board-height')) || 1080;
	var scale = Math.min(window.innerWidth / width, window.innerHeight / height);
	var left = Math.round((window.innerWidth - width * scale) / 2);
	var top = Math.round((window.innerHeight - height * scale) / 2);
	document.body.style.transform = 'translate(' + left + 'px, ' + top + 'px) scale(' + scale + ')';
}

const NIGHTLY_RELOAD_HOUR = 4;		// local time, when nobody is looking at the screen
const NIGHTLY_RELOAD_MINUTE = 0;

/* The board runs all day on a screen with no keyboard and no mouse, so it has to get itself out of
   trouble. Every module records the moment it last brought data in. When not one of them has
   managed that for half an hour, twice the slowest interval on the board, while the machine says it
   is online, it is the page that is stuck rather than the sources that are down, and loading it
   again is the only cure left. A source that is genuinely unreachable keeps its own warning on its
   own card and does not trigger this, because the other modules keep succeeding.

   It also loads the page once a night, when nobody is looking. A board that has been up for a day
   starts clean, and it is the moment a new version of the board reaches the screen, because the
   page, the stylesheets and the config are only read when it loads. */
class Watchdog {
	constructor() {
		this.started = Date.now();
		this.refreshInterval = 60 * 1000; // Check once a minute
		this.staleAfter = 30 * 60 * 1000;
		this.nextNightly = this.nightlyAfter(new Date());

		/* Schedule the check */
		this.task = setInterval(
			this.check.bind(this),
			this.refreshInterval
		);
	}

	/* The next time the clock passes the nightly hour, always in the future. A page that reloaded
	   at two in the morning therefore waits for the next night instead of reloading again for the
	   rest of that minute. Built from the parts rather than by adding a day, so the hour stays put
	   when the clocks go forward or back. */
	nightlyAfter(now) {
		var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), NIGHTLY_RELOAD_HOUR, NIGHTLY_RELOAD_MINUTE, 0, 0);
		if (next <= now) {
			next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, NIGHTLY_RELOAD_HOUR, NIGHTLY_RELOAD_MINUTE, 0, 0);
		}
		return next;
	}

	/* The moment any module last brought data in, or null when none of them ever did */
	newest() {
		var newest = null;
		for (var name in document.modules) {
			var updated = document.modules[name].last_updated;
			if (updated instanceof Date && (newest === null || updated > newest)) {
				newest = updated;
			}
		}
		return newest;
	}

	check() {
		/* Once a night, whatever the state of the board: it has then been running for a day, and a
		   fresh page is also how a new version of the board reaches the screen. */
		if (Date.now() >= this.nextNightly.getTime()) {
			console.log('Nightly reload of the board.');
			window.location.reload();
			return;
		}
		if (window.navigator.onLine === false) {
			/* nothing to fetch, so reloading would only empty the screen */
			return;
		}
		var newest = this.newest();
		/* before the first answer arrives there is nothing to measure against but the page itself */
		var since = (newest === null) ? this.started : newest.getTime();
		var stale = Date.now() - since;
		if (stale < this.staleAfter) {
			return;
		}
		console.warn('No data for ' + Math.round(stale / 60000) + ' minutes while online; reloading the board.');
		window.location.reload();
	}
}

/* Get a URL parameter */
function getURLParameter(variable) {
      var query = window.location.search.substring(1);
      var vars = query.split("&");
      for (var i=0; i<vars.length; i++) {
            var pair = vars[i].split("=");
            if (pair[0] == variable) {
                  return pair[1];
            }
      }
    return null;
}



/* Automatically add timestamps to console.log */
var originalLog = console.log;
console.log = function () {
	var args = [].slice.call(arguments);
	originalLog.apply(console.log,[new Date().toISOString() + ' ::'].concat(args));
};

/* Make config available for all modules */
/* Vóór alles wat gegevens ophaalt, want vanaf hier worden de antwoorden onderweg mooi weer. */
if (demoUntil() > 0) {
	installDemo(demoUntil());
}

var location = getURLParameter('location');
document.config = {};
loadConfig(location).then(response => {
    /* Check if a custom location is given */

	/* The palette comes first, so the board never paints itself twice */
	applyTheme(document.config ? document.config.theme : undefined);


	/* Enable/disable METAR & TAF */
	if (document.config.metar) {
		if (document.config.metar.length == 0) {
			document.getElementById(ID_METAR).style.display = 'none';
		} else {
			document.getElementById(ID_METAR).style.display = 'block';
			var metar = {};
			for (var i = 0; i < document.config.metar.length; i++) {
				metar[document.config.metar[i]] = new NOAAMETAR(document.config.metar[i]);
			}
		}
	}

	/* Set up realtime clock */
	var mod_datetime = new ShowCurrentDateTime(ID_DATETIME);

	/* Set up online/offline status monitor */
	var online_status = new OnlineStatus();

	/* Het bord is één vast vlak dat als geheel meeschaalt met het venster. De verhoudingen zijn op
	   een 16:9-scherm afgestemd; opnieuw indelen bij een andere maat levert afgekapte getallen op
	   in plaats van een kleiner bord. Zo is elk scherm dezelfde indeling, en is een browservenster
	   een getrouwe verkleining van wat er straks op de televisie staat.
	
	   De kaart wordt hier niet door van slag gebracht: transform raakt de opmaak niet, dus Leaflet
	   blijft rekenen met het vlak van 1920 bij 1080 en het beeld wordt alleen visueel verkleind. */
	fit();
	window.addEventListener('resize', fit);
	watchTiles();
	watchPointer();
	watchDemo();
	
	/* Nobody is going to press a key on this screen, so the board watches itself. It hangs off the
	   document like the modules do, so a check can be triggered by hand over a remote console. */
	document.watchdog = new Watchdog();

	/* Set up ADS-B module(s) */
	var airplanes = new OpenSkyNetwork(document.config.airplanes);

	document.modules = {};
	//document.modules.knmi = new KNMI(ID_IMG_LAYER_RAIN);
	document.modules.knmi_llfc = new KNMI_LLFC();
	//document.modules.sat24 = new Sat24(ID_IMG_LAYER_CLOUD);
	/* In de mooiweerstand geen radar en geen jumpruns: op de kaart staat een luchtfoto van
	   Palm Jumeirah, en een echte jumprun van vandaag hoort niet naast verzonnen weer. */
	if (demoUntil() > 0) {
		showDemoMap(ID_LAYER_MAP);
	} else if (document.config.radar) {
		document.modules.radar = new Radar(ID_LAYER_MAP);
	} else {
		document.modules.weatherandradar = new WeatherAndRadar(ID_LAYER_MAP);
	}
	//document.modules.openweathermap = new OpenWeatherMap();
	document.modules.luchtvaartmeteo = new LuchtvaartMeteo(location);
	//weerslag = new WeerSlag(ID_IMG_LAYER_MAP);
	document.modules.aloft = new Aloft();
	/* The jumprun somebody put on this board from jumprun.nl; without the setting nothing is asked */
	if (document.config.jumprun && demoUntil() === 0) {
		var dropzones = document.config.jumprun.stations
			|| [document.config.jumprun.station || document.config.radar?.forecast?.station || 'hoogeveen'];
		document.modules.jumprun = new Jumprun(dropzones);
	}
	/* De windkaart hoort achter de hoogtewinden aan: die bepalen of er iets te tonen is. */
	if (document.config.windy && demoUntil() === 0) {
		document.modules.windy = new Windy();
	}
	if (document.config.cloudProfile) {
		document.modules.cloudprofile = new CloudProfile('cloudprofile');
	}

	// Add event listener for key-down events
	document.addEventListener('keydown', (e) => {
		/* Key 'R' for manual refresh */
		if (e.code === "KeyR") {
			console.log('Manual refresh triggered');
			for (var module in document.modules) {
				document.modules[module].updateData();
			}
		}

		/* Key 'I' to show local IP address */
		if (e.code === "KeyI") {
			console.log('Show IP address triggered');

			/* Fetch local IP */
			fetch(
				'localip.php'
			).then(response => {
				if (response.ok === true) {
					return response.text();
				} else {
					console.warn('Returned HTTP error ' + response.status + ' (' + response.statusText + ')');
					return null;
				}
			}).then(data => {
				if (data === null) {
					createSystemMessage('Local IP file not found.');
				}
				console.log(data);
				ip = data;
				showip_counter = 10;
			}).catch((error) => {
				console.error(error);
			});
		}
	});
})
