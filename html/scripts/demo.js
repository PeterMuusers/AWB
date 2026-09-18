/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */
/* jshint esversion: 8 */

/*
 * Mooiweerstand: het gewone bord, met de cijfers van een dag die er niet is.
 *
 * Een grap voor als het buiten giet en er niemand de lucht in gaat. Het bord blijft precies het
 * bord - dezelfde kaarten, dezelfde grafieken, dezelfde opmaak - maar de getallen die erin komen
 * zijn andere. Dat werkt doordat hier de gegevens onderweg worden aangepast in plaats van dat elke
 * module iets aparts moet kunnen: het bord haalt op wat het altijd ophaalt, en wat terugkomt is
 * onderweg mooi weer geworden.
 *
 * Geen verzonnen antwoorden dus, maar echte antwoorden met andere waarden. Dat scheelt een berg
 * nagemaakte gegevens die bij elke wijziging aan een bron weer niet meer klopt, en het houdt alles
 * overeind waar het bord op rekent: dezelfde velden, dezelfde tijden, dezelfde reeksen.
 *
 * De kaart wordt wel vervangen, want daar valt niets aan te rekenen: een luchtfoto van Palm
 * Jumeirah, opgehaald bij dezelfde Esri-dienst die het bord al voor zijn luchtfoto's gebruikt.
 */

/* Palm Jumeirah, met de dropzone van Skydive Dubai erop: die ligt op de stam van de palm, en het
   is precies de grap dat het eiland waar iedereen naar wijst zelf een dropzone is. Dezelfde bron als
   de luchtfoto onder de radarkaart, dus geen nieuwe afhankelijkheid.

   Andere plekken die van bovenaf de moeite waard zijn, mocht je willen wisselen: Bora Bora
   (-151.74, -16.51), Whitehaven Beach in de Whitsundays (148.99, -20.27), of Empuriabrava aan de
   Costa Brava (3.14, 42.26) - ook een dropzone, en een die de meesten hebben gezien. */
const PALM = {
	/* De foto staat erbij in img/, want de grap hoort meteen in beeld te staan en niet pas als een
	   trage verbinding hem heeft opgehaald. Het kaartvlak heeft altijd dezelfde vorm - het bord is
	   een vast vlak van 1920 bij 1080 dat als geheel meeschaalt - dus één uitsnede volstaat en er
	   valt niets bij te snijden.
	
	   Zo is hij gemaakt, mocht je een ander stukje wereld willen:
	   https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export
	     ?bbox=<west>,<zuid>,<oost>,<noord>&bboxSR=4326&imageSR=3857&size=1600,1692&format=jpg&f=image
	   Andere plekken die van bovenaf de moeite waard zijn: Bora Bora (-151.74, -16.51), Whitehaven
	   Beach in de Whitsundays (148.99, -20.27), of Empuriabrava (3.14, 42.26) - ook een dropzone. */
	image: 'img/dubai-palm.jpg',
	west: 55.106, south: 25.060015, east: 55.168, north: 25.119377,
	/* De dropzone zelf, uitgemeten op deze foto: het groene veld met de landingsstrook. */
	dropzone: { lon: 55.1436, lat: 25.0909 },
	label: 'Skydive Dubai \u00b7 Palm Drop Zone',
	place: 'Dubai',		// zolang de demo loopt heet het bord hiernaar
};/* Waar het naartoe moet. Alles wat het bord leest wordt hierheen gerekend, in plaats van dat er
   losse getallen worden neergezet: de grafieken hebben reeksen nodig, geen momentopnamen. */
const SUNNY = {
	windKt: 4,			// grondwind
	gustKt: 5,
	windDir: 240,
	visM: 40000,
	tempC: 26,
	dewpointC: 11,
	qnhHpa: 1023,
	freezingFt: 14500,	// ruim boven exithoogte, dus geen handschoenen
	aloftMaxKt: 12,		// de sterkste hoogtewind, hoog in het profiel
};

/* De tekst onder het bord. Geen bulletin van het KNMI maar het soort dag waar iedereen op wacht. */
const SUNNY_FORECAST = [
	'Bewolking: Onbewolkt. Het blijft de hele dag helder, met zicht tot ver voorbij de Veluwe.',
	'Grondwind: Zuidwest 3 tot 5 knopen, geen stoten. Een windzak die af en toe even nadenkt.',
	'Buien: Geen. Ook niet in de omgeving, ook niet vanavond.',
	'Zicht: Meer dan 40 kilometer. Vanaf exithoogte zie je de Waddenzee liggen.',
	'Thermiek: Rustig en gelijkmatig; onder de koepel merk je er nauwelijks iets van.',
	'Morgen: Precies zo. En de dag erna ook.',
].join('\n');

/* Een getal dat er nog een beetje uitziet als een meting: niet overal exact hetzelfde. */
function jitter(value, amount) {
	return Math.round((value + (Math.random() - 0.5) * amount) * 10) / 10;
}

/* De meting van het station. Het linkerkaartje en de wolkenbasisgrafiek komen hiervandaan, dus de
   reeksen moeten mee: een heldere hemel nu en een bewolkte reeks erachter leest als een storing. */
function sunnyObservations(data) {
	var clear = observation => {
		if (!observation) {
			return observation;
		}
		observation.wind_kt = jitter(SUNNY.windKt, 1.5);
		observation.gust_kt = jitter(SUNNY.gustKt, 2);
		observation.wind_dir = jitter(SUNNY.windDir, 12);
		observation.vis_m = SUNNY.visM;
		observation.temp_c = jitter(SUNNY.tempC, 1);
		observation.dewpoint_c = jitter(SUNNY.dewpointC, 1);
		observation.qnh_hpa = jitter(SUNNY.qnhHpa, 1);
		observation.rain_mmh = 0;
		observation.rain_min10 = 0;
		observation.rh_pct = 38;
		/* geen enkele wolkenlaag: de ceilometer ziet niets, en dat is precies het punt */
		[1, 2, 3].forEach(layer => {
			observation['base' + layer + '_ft'] = null;
			observation['okta' + layer] = 0;
		});
		observation.okta_total = 0;
		return observation;
	};

	clear(data.observation);
	/* De reeks van de afgelopen uren, waar de grafieken op staan: paren van [tijd, waarde].
	   Die moeten mee, anders staat de wolkenbasisgrafiek vol met de echte bewolking terwijl
	   het kaartje ernaast zegt dat het onbewolkt is. */
	if (data.series && typeof data.series === 'object') {
		Object.keys(data.series).forEach(field => {
			var points = data.series[field];
			if (!Array.isArray(points)) {
				return;
			}
			var waarde = () => {
				if (field.indexOf('rain') === 0) { return 0; }
				if (field.indexOf('base') === 0) { return null; }
				if (field.indexOf('okta') === 0) { return 0; }
				if (field.indexOf('gust') === 0) { return jitter(SUNNY.gustKt, 2); }
				if (field.indexOf('wind') === 0) { return jitter(SUNNY.windKt, 2); }
				if (field.indexOf('vis') === 0) { return SUNNY.visM; }
				if (field.indexOf('temp') === 0) { return jitter(SUNNY.tempC, 2); }
				return null;
			};
			data.series[field] = points.map(point => {
				/* [tijd, waarde]; de tijd blijft staan, want de grafiek zet hem op de as */
				if (Array.isArray(point)) {
					return [point[0], waarde()];
				}
				if (point && typeof point === 'object' && 'value' in point) {
					point.value = waarde();
				}
				return point;
			});
		});
	}
	return data;
}

/* Het model: de hoogtewinden, het nulgradenniveau en de wolkenlagen van de vooruitzichten. De
   windsnelheden worden niet op nul gezet maar teruggeschaald - een windprofiel van louter nullen
   ziet eruit als een defect, en een jumprun heeft wat wind nodig om ergens op te slaan. */
function sunnyAloft(data) {
	var hourly = data.hourly;
	if (!hourly) {
		return data;
	}
	var levels = Object.keys(hourly).filter(key => key.indexOf('wind_speed_') === 0).length || 1;
	Object.keys(hourly).forEach(field => {
		var values = hourly[field];
		if (!Array.isArray(values)) {
			return;
		}
		if (field.indexOf('wind_speed_') === 0) {
			/* hoger is harder, maar nergens meer dan een aangename bries */
			var height = Number((field.match(/(\d+)hPa/) || [0, 1000])[1]);
			var share = Math.max(0.35, Math.min(1, (1000 - height) / 800));
			hourly[field] = values.map(() => jitter(SUNNY.aloftMaxKt * share * 1.852, 2));
		} else if (field.indexOf('wind_gusts') === 0) {
			hourly[field] = values.map(() => jitter(SUNNY.gustKt * 1.852, 2));
		} else if (field.indexOf('wind_direction') === 0) {
			hourly[field] = values.map(() => jitter(SUNNY.windDir, 14));
		} else if (field.indexOf('cloud_cover') === 0) {
			hourly[field] = values.map(() => 0);
		} else if (field.indexOf('precipitation') === 0 || field.indexOf('rain') === 0) {
			hourly[field] = values.map(() => 0);
		} else if (field === 'freezing_level_height') {
			hourly[field] = values.map(() => Math.round(SUNNY.freezingFt * 0.3048));
		} else if (field.indexOf('temperature_2m') === 0) {
			hourly[field] = values.map(() => jitter(SUNNY.tempC, 2));
		}
	});
	return data;
}

/* De gegevens onderweg omzetten. Het antwoord van de server blijft de baas over de vorm; hier
   veranderen alleen de waarden erin. */
function rewrite(response, change) {
	return response.json().then(data => {
		var body = JSON.stringify(change(data));
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: { 'Content-Type': 'application/json' },
		});
	}).catch(() => response);
}

/* De kaart vervangen door een luchtfoto. Aan een radarbeeld van Dubai valt niets te beleven, en dit
   is het beeld waar het om begonnen is. */
/* Mercator in graden: de projectie waarin de luchtfoto staat. Nodig om de dropzone op zijn plek
   te zetten - noord-zuid loopt daarin niet gelijkmatig. */
function mercator(lat) {
	return (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
}


export function showDemoMap(mapId) {
	var element = (typeof mapId === 'string') ? document.getElementById(mapId) : mapId;
	if (!element) {
		return;
	}

	var marker = document.createElement('div');
	marker.style.cssText = 'position:absolute;z-index:600;transform:translate(-50%,-50%);'
		+ 'display:flex;align-items:center;gap:8px;pointer-events:none;';
	marker.innerHTML = '<span style="width:13px;height:13px;border-radius:50%;background:#e23b2e;'
		+ 'box-shadow:0 0 0 3px rgba(255,255,255,0.9), 0 2px 8px rgba(0,0,0,0.5);"></span>'
		+ '<span style="color:#fff;font-family:var(--font-condensed, sans-serif);font-size:15pt;'
		+ 'letter-spacing:0.04em;text-shadow:0 1px 8px rgba(0,0,0,0.75);">' + PALM.label + '</span>';

	var teken = () => {
		element.style.backgroundImage = 'url("' + PALM.image + '")';
		element.style.backgroundSize = '100% 100%';
		/* De foto past precies in het vlak, dus graden zijn hier rechtstreeks percentages. */
		marker.style.left = (((PALM.dropzone.lon - PALM.west) / (PALM.east - PALM.west)) * 100) + '%';
		marker.style.top = (((mercator(PALM.north) - mercator(PALM.dropzone.lat))
			/ (mercator(PALM.north) - mercator(PALM.south))) * 100) + '%';
	};

	element.innerHTML = '';
	element.appendChild(marker);
	teken();
	window.addEventListener('resize', teken);

	var caption = document.createElement('div');
	caption.textContent = 'Geen neerslag \u00b7 geen bewolking \u00b7 4 kt';
	caption.style.cssText = 'position:absolute;left:14px;bottom:12px;z-index:600;color:#fff;'
		+ 'font-family:var(--font-condensed, sans-serif);font-size:16pt;letter-spacing:0.05em;'
		+ 'text-shadow:0 1px 8px rgba(0,0,0,0.6);';
	element.appendChild(caption);
}

/**
 * De mooiweerstand aanzetten. Moet gebeuren voordat de modules hun gegevens ophalen, dus vroeg in
 * main.js en op grond van de URL - een vraag aan de server zou te laat komen.
 *
 * @param until  einde in seconden sinds 1970; daarna keert het bord vanzelf terug
 */
export function installDemo(until) {
	var original = window.fetch.bind(window);
	window.fetch = function (input, init) {
		var url = (typeof input === 'string') ? input : ((input && input.url) || '');
		return original(input, init).then(response => {
			if (!response.ok) {
				return response;
			}
			if (url.indexOf('luchtvaartmeteo-proxy.php') !== -1 && url.indexOf('observations') !== -1) {
				return rewrite(response, sunnyObservations);
			}
			if (url.indexOf('api.open-meteo.com') !== -1) {
				return rewrite(response, sunnyAloft);
			}
			if (url.indexOf('config.json') !== -1) {
				/* Zolang de demo loopt heet het bord naar de plek op de kaart. */
				return rewrite(response, data => {
					if (data && data.location) {
						data.location.name = PALM.place;
					}
					if (data && data.luchtvaartmeteo) {
						/* Alleen de naam van de plek; geen regel die zegt dat het verzonnen is. Dat is
						   het hele punt van deze stand: iedereen die een palmeiland op de radar ziet
						   weet dat het een grap is. */
						data.luchtvaartmeteo.stationName = PALM.place;
						data.luchtvaartmeteo.note = '';
					}
					return data;
				});
			}
			if (url.indexOf('llfc.json') !== -1) {
				return rewrite(response, data => {
					data.text = SUNNY_FORECAST;
					return data;
				});
			}
			return response;
		});
	};


	/* Terug naar de werkelijkheid. Twee wegen, want allebei komen voor: de tijd loopt af, of
	   iemand zet hem eerder uit. Zonder die tweede blijft het bord in de grap hangen tot de
	   oorspronkelijke eindtijd, ook al is de markering al weg - en dan klopt er niets van de
	   belofte dat je hem meteen kunt stoppen. */
	var terug = () => { window.location.href = window.location.pathname; };
	setTimeout(terug, Math.max(1000, (until * 1000) - Date.now()));
	setInterval(() => {
		fetch('demo.php', { cache: 'no-store' })
			.then(response => response.json())
			.then(state => { if (!state.active) { terug(); } })
			.catch(() => {});
	}, 8000);
	console.log('Mooiweerstand aan tot ' + new Date(until * 1000).toLocaleTimeString());
}
