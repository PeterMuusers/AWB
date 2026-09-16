/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { loadConfig } from './config.js';
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

const ID_DATETIME = 'datetime-data';
const ID_LAYER_MAP = 'layer-map-id';
const ID_IMG_LAYER_MAP = 'img-layer-map-id';
const ID_IMG_LAYER_CLOUD = 'img-layer-cloud-id';
const ID_IMG_LAYER_RAIN = 'img-layer-rain-id';
const ID_IFRAME_RAIN = 'img-layer-rain-id';
const ID_UPPERWINDS_TABLE = 'uppper-winds-content-data';
const ID_WEATHER_ALERT = 'weather-alert';
const ID_COMPASS = 'compass';
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
var location = getURLParameter('location');
document.config = {};
loadConfig(location).then(response => {
    /* Check if a custom location is given */
    
    /* Enable/disable compass rose */
	if (document.config.compass === true) {
		document.getElementById(ID_COMPASS).style.display = 'block';
	} else {
		document.getElementById(ID_COMPASS).style.display = 'none';
	}

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

	/* Set up ADS-B module(s) */
	var airplanes = new OpenSkyNetwork(document.config.airplanes);

	document.modules = {};
	//document.modules.knmi = new KNMI(ID_IMG_LAYER_RAIN);
	document.modules.knmi_llfc = new KNMI_LLFC();
	//document.modules.sat24 = new Sat24(ID_IMG_LAYER_CLOUD);
	if (document.config.radar) {
		document.modules.radar = new Radar(ID_LAYER_MAP);
	} else {
		document.modules.weatherandradar = new WeatherAndRadar(ID_LAYER_MAP);
	}
	//document.modules.openweathermap = new OpenWeatherMap();
	document.modules.luchtvaartmeteo = new LuchtvaartMeteo(location);
	//weerslag = new WeerSlag(ID_IMG_LAYER_MAP);
	document.modules.aloft = new Aloft();

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
