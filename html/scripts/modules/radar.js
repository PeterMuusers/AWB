/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { DATE_OPTIONS_LOCAL } from '../const.js';
import { createSystemMessage, sunElevation } from '../functions.js';
import { LANGUAGE_SOURCE, LANGUAGE_LAST_UPDATED, LANGUAGE_RADAR, LANGUAGE_RADAR_FORECAST } from '../language.js';

/*
 * Own radar map (Leaflet), based on the radar screen of jumprun.nl (cloudbase):
 *  - precipitation radar of the last hours: KNMI geoservices WMS (public), one image per 5 minutes
 *  - precipitation forecast for the next hours: pre-rendered frames from jumprun.nl through
 *    jumprun-proxy.php (API key and frame cache on the server), or the KNMI Data Platform WMS
 *    through knmi-wms-proxy.php (API key stays on the server) as fallback
 *  - clouds: the EUMETSAT MTG satellite image (public WMS), blended over the map; optional.
 *    During the forecast frames the newest image is shifted along with the wind at cloud level
 *    (from the upper winds module), the same estimate the radar screen of jumprun.nl makes.
 * All frames are loaded as single images for the current map view (no tiles), which keeps the
 * number of requests low on a Raspberry Pi. Settings come from config.json (radar).
 */

const SOURCE = 'KNMI / EUMETSAT';
const CORS_PROXY_URL = './cors-proxy.php';
const WMS_PROXY_URL = './knmi-wms-proxy.php';
const JUMPRUN_PROXY_URL = './jumprun-proxy.php';
const USER_AGENT = 'AviationWeatherBoard';

const RADAR_WMS = 'https://geoservices.knmi.nl/adagucserver';
const RADAR_DATASET = 'RADAR';
const RADAR_LAYER = 'RAD_NL25_PCP_CM';
const RADAR_STYLE = 'precipitation_mm_extranetten_v1';	// same palette as luchtvaartmeteo.nl
const RADAR_STEP = 5;									// minutes
const RADAR_OPACITY = 0.85;

const SAT_WMS = 'https://view.eumetsat.int/geoserver/wms';
const SAT_STEP = 10;									// minutes
/* Cloud images, all updated every 10 minutes. The RGB composites are served at about 2 km per
   pixel at our latitude; only the visible channel is sharper (about 500 m), but it is dark when
   the sun is low. 'clouds' therefore switches between the two on the sun's elevation.
   JPEG everywhere: a fraction of the size of PNG, and the black edge outside the satellite disc
   disappears in the blend anyway. */
const SAT_VISIBLE = {
	layer: 'mtg_fd:vis06_hrfi', style: '', format: 'image/jpeg', transparent: 'false',
	maxSize: 1600,				// sharp source, so worth asking for more pixels
	brightness: 0.62,			// divided by the sine of the sun's elevation, see cloudFilter()
	contrast: 2.6,
};
const SAT_GEOCOLOUR = {
	layer: 'mtg_fd:rgb_geocolour', style: '', format: 'image/jpeg', transparent: 'false',
	maxSize: 1024, brightness: 0.9, contrast: 2.4,
};
const SAT_INFRARED = {
	layer: 'mtg_fd:ir105_hrfi', style: 'mtg_fd_ir105_hrfi_grayscale', format: 'image/png', transparent: 'true',
	/* brightness and contrast together decide which greys survive: everything under about 63 goes
	   to black and everything over about 141 to pure white. The pair that was here before left a
	   window of 58 to 97, and the image measures 89 to 117 in its brightest tenth, so nearly every
	   cloud came out as flat white with no structure left in it. */
	maxSize: 1024, brightness: 1.25, contrast: 2.6, grayscale: false,
};
const SAT_LAYERS = {
	clouds: null,				// null = adaptive: visible by day, geocolour at dusk and at night
	visible: SAT_VISIBLE,
	geocolour: SAT_GEOCOLOUR,
	infrared: SAT_INFRARED,
};
/* Which image when: measured on 16 September 2026 (average of the brightest tenth of the image,
   0-255) as the sun went down. Geocolour holds up while the sun is high but fades quickly in the
   last degrees (171 at 9 degrees, 140 at 6, 111 at 3) and switches to a night rendering with city
   lights around sunset, which is useless as a cloud image. Infrared measures cloud top temperature
   and is therefore the same all day and all night (117 to 89 over the same period). Geocolour also
   starts showing city lights as the sun sets, well before it is actually dark, and those light up
   as a white blob over the Randstad, so it is not used automatically: the choice is the visible
   image by day and infrared for the rest. */
const SUN_ELEVATION_VISIBLE = 6;						// above this the sharp visible image, with a margin (see cloudSpec)
const SUN_MARGIN = 30 * 60 * 1000;						// the visible image dims quickly near that angle, so keep this much margin
const VISIBLE_MAX_GAIN = 4.0;							// cap on the brightness correction for a low sun
const GEOCOLOUR_MAX_GAIN = 2.0;							// only for layer 'geocolour', see cloudFilter()

const FORECAST_DATASET = 'radar_forecast';
const FORECAST_LAYER = 'precipitationfc';
const FORECAST_STYLE = 'precip-smooth-white-to-purple/bilinear';
const FORECAST_STEP = 5;								// minutes
const FORECAST_MAX_AGE = 20 * 60 * 1000;				// a jumprun run older than this is considered stale

/* Base maps: 'imagery' = satellite photo (dark green land, like the Weather & Radar widget), 'topo' = topographic map */
const BASEMAPS = {
	imagery: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
	topo: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
};
/* Country borders (Natural Earth, clipped) and a handful of place names, drawn on top of the base map and the satellite image */
const BORDERS_URL = './data/borders.geojson';
const PLACES = [
	['Groningen', 53.219, 6.568], ['Leeuwarden', 53.201, 5.799], ['Zwolle', 52.516, 6.083], ['Enschede', 52.221, 6.894],
	['Amsterdam', 52.373, 4.893], ['Rotterdam', 51.922, 4.479], ['Utrecht', 52.091, 5.121], ['Eindhoven', 51.441, 5.470],
	['Middelburg', 51.499, 3.611], ['Antwerpen', 51.220, 4.402], ['Brussel', 50.847, 4.352],
	['Bremen', 53.079, 8.802], ['Osnabrück', 52.280, 8.047], ['Münster', 51.961, 7.626], ['Dortmund', 51.514, 7.466], ['Düsseldorf', 51.226, 6.782],
];
const KNOTS_TO_MS = 0.514444;
const METERS_PER_DEGREE = 111320;
const CLOUDS_MARGIN = 0.25;								// extra area around the map on every side
const CLOUDS_SHIFT_STEP = 0.25;							// degrees; the upwind margin grows in steps this size
/* The further the clouds are shifted ahead, the fainter they get, as a reminder that it is an
   estimate. Gently: at 0.45 the last frame came out at little over half strength, which does not
   read as a guess but as the sky clearing up, and a thinning overcast is a statement about the
   weather that nobody made. */
const CLOUDS_FADE = 0.15;

/* Precipitation chart under the map: measured at the station (luchtvaartmeteo) up to now,
   forecast from the KNMI radar forecast at the dropzone (jumprun.nl) after that. The cursor
   marks the frame that is on the map, so the chart doubles as the time bar of the loop. */
const CHART_LABEL_HEIGHT = 13;							// pixels at the bottom for the times
const CHART_ALPHA_MEASURED = 0.95;
const CHART_ALPHA_FORECAST = 0.55;						// gemeten en verwacht blijven uit elkaar te houden
/* De kleur van een balkje is die van de neerslag zelf, in dezelfde trant als de radarkaart erboven:
   blauw voor motregen, groen voor een gewone bui, geel en oranje als het serieus wordt, rood voor
   een plensbui. De hoogte zegt hetzelfde, maar die schaalt mee met de natste bui van het moment -
   op een rustige dag is een hoog balkje 1 mm/u en op een natte dag 20. De kleur ligt vast en is
   daarmee het enige wat je er van een afstand absoluut aan kunt aflezen. */
const CHART_RAIN_COLOURS = [
	[0.1, 126, 203, 255],	// lichtblauw: motregen
	[1, 60, 150, 245],		// blauw: lichte regen
	[2.5, 40, 200, 170],	// groenblauw
	[5, 90, 215, 80],		// groen: gewone bui
	[10, 240, 220, 70],		// geel
	[20, 245, 150, 50],		// oranje
	[50, 235, 60, 60],		// rood: plensbui
	[100, 190, 70, 200],	// paars: uitzonderlijk
];
const CHART_SCALES = [1, 2, 5, 10, 20, 50];				// mm/h, the first one the data fits in
const MAX_IMAGE_SIZE = 2048;							// pixels, cap for the WMS images (after scaling for the screen)

const ID_MAP = 'radar-map';
const ID_TIMELABEL = 'radar-timelabel';
const ID_CHART = 'radar-chart';
const ID_IMAGES_SOURCE_LABEL = 'images-source-label';
const ID_IMAGES_SOURCE_DATA = 'images-source-data';
const ID_IMAGES_LAST_UPDATED_LABEL = 'images-last-updated-label';
const ID_IMAGES_LAST_UPDATED_SPINNER = 'images-last-updated-spinner';
const ID_IMAGES_LAST_UPDATED_WARNING = 'images-last-updated-warning';
const ID_IMAGES_LAST_UPDATED = 'images-last-updated';

const CLOUDS_PANE = 'radar-clouds-pane';
const Z_SATELLITE_PANE = 250;							// between the map tiles (200) and the overlays (400)
const Z_SATELLITE = 10;
const Z_BORDERS = 20;
const Z_RADAR = 30;
const Z_MARKER = 40;

/* Fetch a URL through cors-proxy.php (for JSON and XML; images do not need it) */
function fetchViaProxy(url) {
	return fetch(
		CORS_PROXY_URL,
		{
			headers: {
				'X-Request-URL': url,
				'X-User-Agent': USER_AGENT,
			},
		}
	).then(response => {
		if (response.ok === true) {
			return response.text();
		}
		throw new Error(url + ' returned HTTP ' + response.status);
	});
}

/* End of the time dimension of a WMS layer from a GetCapabilities document */
function timeDimensionEnd(xml, layer) {
	var match = new RegExp('<Name>' + layer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</Name>[\\s\\S]*?<Dimension name="time"[^>]*>([^<]*)</Dimension>').exec(xml);
	if (match === null) {
		throw new Error('No time dimension for ' + layer);
	}
	var values = match[1].trim().split(',');
	var last = values[values.length - 1].split('/');
	var end = new Date(last.length > 1 ? last[1] : last[0]);
	if (isNaN(end.getTime())) {
		throw new Error('Invalid time dimension for ' + layer);
	}
	return end;
}

function isoMinutes(date) {
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* De kleur bij een neerslagintensiteit in mm/u, vloeiend tussen de stappen van CHART_RAIN_COLOURS.
   Tussen twee stappen wordt logaritmisch gewogen: van 1 naar 2,5 mm/u is gevoelsmatig een even grote
   sprong als van 10 naar 25, en lineair interpoleren zou het lage bereik plat maken. */
function rainColour(mm, alpha) {
	var stops = CHART_RAIN_COLOURS;
	var rgba = (c, f, d) => 'rgba(' + Math.round(c[1] + ((d ? d[1] - c[1] : 0) * f)) + ', '
		+ Math.round(c[2] + ((d ? d[2] - c[2] : 0) * f)) + ', '
		+ Math.round(c[3] + ((d ? d[3] - c[3] : 0) * f)) + ', ' + alpha + ')';
	if (mm <= stops[0][0]) {
		return rgba(stops[0], 0, null);
	}
	for (var i = 1; i < stops.length; i++) {
		if (mm <= stops[i][0] || i === stops.length - 1) {
			var low = stops[i - 1];
			var high = stops[i];
			var f = Math.min(1, (Math.log(mm) - Math.log(low[0])) / (Math.log(high[0]) - Math.log(low[0])));
			return rgba(low, f, high);
		}
	}
	return rgba(stops[stops.length - 1], 0, null);
}

/* jumprun run id 'YYYYMMDDHHMM' to Date */
function runToDate(run) {
	return new Date(Date.UTC(Number(run.substr(0, 4)), Number(run.substr(4, 2)) - 1, Number(run.substr(6, 2)), Number(run.substr(8, 2)), Number(run.substr(10, 2))));
}

class Module {
	constructor(container_id) {
		this.config = document.config.radar;
		this.refreshInterval = 5 * 60 * 1000; // Refresh interval is 5 minutes
		this.hoursBack = this.config.hoursBack || 2;
		this.hoursAhead = this.config.hoursAhead || 2;
		this.frameInterval = this.config.frameInterval || 250;
		this.pauseAtEnd = this.config.pauseAtEnd || 2000;
		this.pauseAtNow = this.config.pauseAtNow || 1000;
		/* satellite: true/false, or {enabled, layer, opacity} */
		var satellite = this.config.satellite;
		if (satellite === true || satellite === undefined) {
			satellite = {};
		} else if (satellite === false) {
			satellite = { enabled: false };
		}
		this.satellite = (satellite.enabled !== false);
		this.satelliteLayer = (satellite.layer && SAT_LAYERS[satellite.layer] !== undefined) ? SAT_LAYERS[satellite.layer] : null;
		this.satelliteBlend = (satellite.blend !== false);
		this.satelliteOpacity = (satellite.opacity !== undefined) ? satellite.opacity : 1;
		this.satelliteAdvect = (satellite.advect !== false);
		this.satelliteAltitude = satellite.altitude || 5000;		// feet, wind at this level moves the clouds
		this.rainChart = (this.config.rainChart !== false);
		this.satBounds = null;
		this.forecast = this.config.forecast || {};
		/* how often the jumprun gets the map, and for how long; without the setting it never does */
		var jumprun = document.config.jumprun || {};
		this.jumprunAfterRuns = jumprun.afterRuns || 0;
		this.jumprunSeconds = jumprun.seconds || 20;
		this.jumprunTimer = null;
		this.runs = 0;

		this.last_updated = null;
		this.rainMeasured = [];		// [{time: Date, value: mm/h}] up to now, from luchtvaartmeteo
		this.rainForecast = [];		// [{time: Date, value: mm/h}] ahead, from jumprun.nl
		this.frames = [];			// [{time: Date, kind: 'radar'|'forecast', key: String}]
		this.index = 0;
		this.timer = null;
		this.radarOverlays = {};	// iso time -> L.ImageOverlay
		this.satOverlays = {};		// iso time -> L.ImageOverlay
		this.satTimes = [];			// sorted iso times
		this.satSpec = null;		// the cloud image in use, one for the whole loop
		this.forecastOverlays = {};	// key -> L.ImageOverlay
		this.forecastSource = null;
		this.visible = [];			// overlays shown for the current frame

		/* Set language specific stuff */
		document.getElementById(ID_IMAGES_SOURCE_LABEL).innerHTML = LANGUAGE_SOURCE;
		document.getElementById(ID_IMAGES_SOURCE_DATA).innerHTML = SOURCE;
		document.getElementById(ID_IMAGES_LAST_UPDATED_LABEL).innerHTML = LANGUAGE_LAST_UPDATED;

		/* Build the map container and the time bar */
		var container = document.getElementById(container_id);
		container.innerHTML = '<div class="radar-map" id="' + ID_MAP + '"></div>'
			+ '<div class="radar-timebar">'
			+ '<span class="radar-timelabel" id="' + ID_TIMELABEL + '"></span>'
			+ '<canvas class="radar-chart" id="' + ID_CHART + '"></canvas>'
			+ '</div>';

		if (typeof L === 'undefined') {
			createSystemMessage('Leaflet library not loaded, radar map unavailable.');
			return;
		}

		this.map = L.map(ID_MAP, {
			zoomControl: false,
			attributionControl: false,
			dragging: false,
			scrollWheelZoom: false,
			doubleClickZoom: false,
			boxZoom: false,
			keyboard: false,
			touchZoom: false,
			zoomSnap: 0.25,
		});
		this.bounds = L.latLngBounds(this.config.bounds || [[50.72, 3.25], [53.58, 7.25]]);
		this.map.fitBounds(this.bounds, { padding: [2, 2] });
		/* detectRetina: fetch tiles one zoom level deeper on HiDPI screens, keeps the map sharp */
		/* Own pane for the clouds: the blend mode sits on the pane, the filter on the image inside it
		   (a filter on the image itself would break the blending) */
		this.map.createPane(CLOUDS_PANE);
		this.map.getPane(CLOUDS_PANE).style.zIndex = Z_SATELLITE_PANE;
		var basemap = BASEMAPS[this.config.basemap] || BASEMAPS.imagery;
		L.tileLayer(basemap, { maxZoom: 16, detectRetina: true, className: 'radar-basemap' }).addTo(this.map);
		if (this.config.borders !== false) {
			this.addBorders();
		}
		(this.config.places || PLACES).forEach(place => {
			L.marker([place[1], place[2]], {
				icon: L.divIcon({ className: 'radar-place', html: '<span class="radar-place-dot"></span><span class="radar-place-name">' + place[0] + '</span>', iconSize: null, iconAnchor: [4, 4] }),
				interactive: false, keyboard: false, pane: 'markerPane',
			}).addTo(this.map);
		});
		/* The dropzone: red dot with the name from config.json (location.name) */
		L.marker([document.config.location.lattitude, document.config.location.longitude], {
			icon: L.divIcon({ className: 'radar-place radar-dropzone', html: '<span class="radar-place-dot"></span><span class="radar-place-name">' + (document.config.location.name || '') + '</span>', iconSize: null, iconAnchor: [6, 6] }),
			interactive: false, keyboard: false, pane: 'markerPane', zIndexOffset: 1000,
		}).addTo(this.map);

		/* The single-image overlays depend on the view: rebuild them when the size changes */
		this.map.on('resize', () => {
			this.map.fitBounds(this.bounds, { padding: [2, 2] });
			this.satBounds = null;
			this.clearOverlays();
			this.updateData();
		});

		/* Schedule update of document content */
		this.task = setInterval(
			this.updateData.bind(this),
			this.refreshInterval
		);

		/* Initial fill of document content */
		this.updateData();
	}

	/* Which cloud image to use at this moment: the sharp visible image while the sun is high enough,
	   infrared for the rest. Chosen once per update for the whole loop, see syncSatellite(). */
	cloudSpec(time) {
		if (this.satelliteLayer !== null) {
			return this.satelliteLayer;
		}
		/* Only use the visible image when the sun is also high enough half an hour before and after:
		   in the last half hour before the switch it darkens too quickly. That makes the switch half
		   an hour earlier in the evening and half an hour later in the morning, in every season. */
		if (Math.min(this.sunAt(time, -SUN_MARGIN), this.sunAt(time, SUN_MARGIN)) >= SUN_ELEVATION_VISIBLE) {
			return SAT_VISIBLE;
		}
		return SAT_INFRARED;
	}

	/* Elevation of the sun above the dropzone, at the given time plus an offset in milliseconds */
	sunAt(time, offset) {
		return sunElevation(new Date(time.getTime() + (offset || 0)), document.config.location.lattitude, document.config.location.longitude);
	}

	/* CSS filter that leaves the clouds and crushes land and sea to black, so the 'screen' blend of
	   the pane only adds the clouds. The visible image darkens with the sun, so its brightness is
	   divided by the sine of the sun's elevation. */
	cloudFilter(spec, time) {
		var brightness = spec.brightness;
		var elevation = this.sunAt(time, 0);
		if (spec === SAT_VISIBLE) {
			/* Reflected sunlight, so it darkens with the sine of the sun's elevation */
			brightness = Math.min(VISIBLE_MAX_GAIN, brightness / Math.sin(Math.max(elevation, 1) * Math.PI / 180));
		} else if (spec === SAT_GEOCOLOUR) {
			/* Correction fitted to the measurements above, so the clouds keep the same brightness
			   during the last hour before sunset instead of fading away */
			brightness = Math.min(GEOCOLOUR_MAX_GAIN, brightness * (1 + 2.2 * Math.exp(-Math.max(elevation, 0) / 3.5)));
		}
		return (spec.grayscale === false ? '' : 'grayscale(1) ') + 'brightness(' + brightness.toFixed(2) + ') contrast(' + spec.contrast + ')';
	}

	/* Wind at cloud level as {east, north} in m/s, from the wind profile module; null when unknown.
	   Takes the forecast hour closest to the moment being drawn, and within it the altitude closest
	   to the level the clouds are assumed to drift at. */
	windAtCloudLevel(time) {
		var aloft = (document.modules || {}).aloft;
		if (!aloft || !aloft.hours || aloft.hours.length === 0) {
			return null;
		}
		var hour = aloft.hours.reduce((closest, candidate) =>
			Math.abs(candidate.time.getTime() - time.getTime()) < Math.abs(closest.time.getTime() - time.getTime()) ? candidate : closest);
		var best = null;
		Object.keys(hour.levels).forEach(altitude => {
			if (best === null || Math.abs(Number(altitude) - this.satelliteAltitude) < Math.abs(best - this.satelliteAltitude)) {
				best = Number(altitude);
			}
		});
		if (best === null) {
			return null;
		}
		var speed = Number(hour.levels[best].kt) * KNOTS_TO_MS;
		var radians = Number(hour.levels[best].dir) * Math.PI / 180;
		if (isNaN(speed) || isNaN(radians)) {
			return null;
		}
		/* Wind direction is the direction the wind comes FROM, the clouds move the other way */
		return { east: -speed * Math.sin(radians), north: -speed * Math.cos(radians) };
	}

	/* The area to ask the cloud images for. They are shifted along with the wind, so the side the
	   clouds come from has to reach far enough past the map to still cover it at the end of the
	   loop. A quarter of the map width used to be it, which a wind of twenty-five knots eats
	   through in an hour, and from there the straight edge of the image walked into view.
	
	   The margin is worked out from what will actually be drawn, not from the wind of this
	   moment. Two things make the real shift bigger than that: the wind two hours from now can
	   be stronger than the wind now, and the image being shifted can be older than one time
	   step when a newer one failed to load. Both were enough to bring the edge back into view.
	
	   Only the upwind side is stretched. Making the whole square bigger would spend the same
	   number of pixels on more sky, and the sharpness of the image is the reason to show it. The
	   amount is rounded up to a quarter of a degree, so the images are not all fetched again every
	   time the wind turns a little. */
	cloudArea() {
		var bounds = this.map.getBounds().pad(CLOUDS_MARGIN);
		if (!this.satelliteAdvect) {
			return bounds;
		}
		var now = Date.now();
		/* het beeld dat straks verschoven wordt: dat van nu, of een ouder als dat niet laadde */
		var usable = this.satelliteFor(new Date(now));
		var imageTime = usable !== null ? new Date(usable).getTime() : now - SAT_STEP * 60 * 1000;
		var middle = (bounds.getSouth() + bounds.getNorth()) / 2;
		var south = 0, north = 0, west = 0, east = 0;
		/* langs de hele lus kijken, want de verste verschuiving hoeft niet die van het laatste
		   frame te zijn: de wind kan onderweg draaien */
		for (var minutes = 0; minutes <= this.hoursAhead * 60; minutes += SAT_STEP) {
			var frameTime = new Date(now + minutes * 60 * 1000);
			var wind = this.windAtCloudLevel(frameTime);
			if (wind === null) {
				continue;
			}
			var seconds = (frameTime.getTime() - imageTime) / 1000;
			var up = wind.north * seconds / METERS_PER_DEGREE;
			var right = wind.east * seconds / (METERS_PER_DEGREE * Math.cos(middle * Math.PI / 180));
			south = Math.max(south, up);
			north = Math.min(north, up);
			west = Math.max(west, right);
			east = Math.min(east, right);
		}
		var step = amount => Math.ceil(Math.abs(amount) / CLOUDS_SHIFT_STEP) * CLOUDS_SHIFT_STEP;
		return L.latLngBounds(
			[bounds.getSouth() - step(south), bounds.getWest() - step(west)],
			[bounds.getNorth() + step(north), bounds.getEast() + step(east)]
		);
	}

	/* Bounds of the cloud image, shifted along with the wind for the time between image and frame */
	cloudBounds(frameTime, imageTime) {
		var bounds = this.satBounds;
		var seconds = (frameTime.getTime() - imageTime.getTime()) / 1000;
		var wind = this.satelliteAdvect ? this.windAtCloudLevel(frameTime) : null;
		if (wind === null || seconds <= 0) {
			return bounds;
		}
		var latitude = wind.north * seconds / METERS_PER_DEGREE;
		var middle = (bounds.getSouth() + bounds.getNorth()) / 2;
		var longitude = wind.east * seconds / (METERS_PER_DEGREE * Math.cos(middle * Math.PI / 180));
		return L.latLngBounds(
			[bounds.getSouth() + latitude, bounds.getWest() + longitude],
			[bounds.getNorth() + latitude, bounds.getEast() + longitude]
		);
	}

	/* Country borders: black line with a light halo, like the Weather & Radar map */
	addBorders() {
		fetch(BORDERS_URL).then(response => response.json()).then(geojson => {
			L.geoJSON(geojson, { style: { color: '#ffffff', weight: 4, opacity: 0.5, interactive: false }, pane: 'overlayPane' }).addTo(this.map);
			L.geoJSON(geojson, { style: { color: '#111111', weight: 1.5, opacity: 0.9, interactive: false }, pane: 'overlayPane' }).addTo(this.map);
		}).catch(error => {
			console.warn('Country borders not loaded: ' + error.message);
		});
	}

	/* WMS GetMap URL for the current view, one image */
	getMapUrl(base, params, bounds, maxSize) {
		/* Request the images at screen resolution (Retina/HiDPI), capped */
		var size = this.map.getSize();
		var scale = Math.min(window.devicePixelRatio || 1, (maxSize || MAX_IMAGE_SIZE) / Math.max(size.x, size.y));
		bounds = bounds || this.map.getBounds();
		var sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
		var ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
		var query = Object.assign({
			SERVICE: 'WMS',
			VERSION: '1.3.0',
			REQUEST: 'GetMap',
			CRS: 'EPSG:3857',
			BBOX: [sw.x, sw.y, ne.x, ne.y].join(','),
			WIDTH: Math.round(size.x * scale),
			HEIGHT: Math.round(size.y * scale),
			FORMAT: 'image/png',
			TRANSPARENT: 'true',
		}, params);
		return base + '?' + Object.keys(query).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&');
	}

	clearOverlays() {
		[this.radarOverlays, this.satOverlays, this.forecastOverlays].forEach(set => {
			for (var key in set) {
				set[key].remove();
			}
		});
		this.radarOverlays = {};
		this.satOverlays = {};
		this.satTimes = [];
		this.forecastOverlays = {};
		this.forecastSource = null;
		this.satFailed = {};	// beelden die EUMETSAT wel aankondigde maar niet leverde
	}

	/* Times of the last hoursBack hours of radar images */
	fetchRadarTimes() {
		return fetchViaProxy(RADAR_WMS + '?DATASET=' + RADAR_DATASET + '&SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0').then(xml => {
			var end = timeDimensionEnd(xml, RADAR_LAYER);
			var times = [];
			for (var k = this.hoursBack * 60 / RADAR_STEP; k >= 0; k--) {
				times.push(new Date(end.getTime() - k * RADAR_STEP * 60 * 1000));
			}
			return times;
		});
	}

	/* Times of the satellite images covering the same period */
	fetchSatTimes() {
		return fetchViaProxy(SAT_WMS + '?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0').then(xml => {
			var end = timeDimensionEnd(xml, SAT_GEOCOLOUR.layer);	// same instrument, same 10 minute steps
			var times = [];
			for (var k = this.hoursBack * 60 / SAT_STEP; k >= 0; k--) {
				times.push(new Date(end.getTime() - k * SAT_STEP * 60 * 1000));
			}
			return times;
		}).catch(error => {
			console.warn('Cloud images unavailable: ' + error.message);
			return [];
		});
	}

	/* Forecast frames from jumprun.nl through the proxy: {source, run, bounds, frames: [{time, url}]} */
	fetchForecastJumprun() {
		var url = JUMPRUN_PROXY_URL + '?action=radar_forecast&station=' + encodeURIComponent(this.forecast.station || 'hoogeveen');
		return fetch(url, { headers: { Accept: 'application/json' } }).then(response => {
			return response.json().then(data => {
				if (response.ok === true) {
					return data;
				}
				throw new Error(data && data.error ? data.error : ('HTTP ' + response.status));
			});
		}).then(data => {
			if (!data.run || !data.bounds || !Array.isArray(data.frames) || data.frames.length === 0) {
				throw new Error('jumprun.nl returned no forecast frames');
			}
			var age = Date.now() - runToDate(data.run).getTime();
			if (age > FORECAST_MAX_AGE) {
				throw new Error('jumprun.nl forecast run ' + data.run + ' is stale (' + Math.round(age / 60000) + ' min old)');
			}
			return {
				source: 'jumprun',
				run: data.run,
				bounds: L.latLngBounds(data.bounds),
				frames: data.frames.map(frame => ({ time: new Date(frame.time), url: frame.url })),
				/* Precipitation at the dropzone per frame, for the chart under the map */
				rain: Array.isArray(data.point) ? data.point.map(point => ({ time: new Date(point.time), value: Number(point.mmh) })) : [],
			};
		});
	}

	/* Forecast frames from the KNMI WMS through the key proxy: {source, run, frames: [{time, url}]} */
	fetchForecastWms() {
		return fetch(WMS_PROXY_URL + '?DATASET=' + FORECAST_DATASET + '&SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0').then(response => {
			if (response.ok === true) {
				return response.text();
			}
			return response.json().then(data => { throw new Error(data.error || ('HTTP ' + response.status)); });
		}).then(xml => {
			var end = timeDimensionEnd(xml, FORECAST_LAYER);
			var match = /<Dimension name="reference_time"[^>]*default="([^"]+)"/.exec(xml);
			var run = match ? new Date(match[1]) : new Date(end.getTime() - 120 * 60 * 1000);
			var frames = [];
			for (var t = run.getTime() + FORECAST_STEP * 60 * 1000; t <= end.getTime(); t += FORECAST_STEP * 60 * 1000) {
				var time = new Date(t);
				frames.push({
					time: time,
					url: this.getMapUrl(WMS_PROXY_URL, { DATASET: FORECAST_DATASET, LAYERS: FORECAST_LAYER, STYLES: FORECAST_STYLE, TIME: isoMinutes(time) }),
				});
			}
			return { source: 'wms', run: isoMinutes(run), bounds: null, frames: frames, rain: [] };
		});
	}

	/* Measured precipitation at the station for the past hours (same proxy as the metrics module) */
	fetchRainMeasured() {
		if (!document.config.luchtvaartmeteo) {
			return Promise.resolve([]);
		}
		var url = './luchtvaartmeteo-proxy.php?action=observations&station=' + encodeURIComponent(document.config.luchtvaartmeteo.station || 'hoogeveen');
		return fetch(url, { headers: { Accept: 'application/json' } }).then(response => {
			return response.ok ? response.json() : null;
		}).then(data => {
			if (data === null || !data.series || !data.series.rain_mmh) {
				return [];
			}
			return data.series.rain_mmh.map(point => ({ time: new Date(point[0]), value: Number(point[1]) }));
		}).catch(error => {
			console.warn('Measured precipitation unavailable: ' + error.message);
			return [];
		});
	}

	fetchForecast() {
		var source = this.forecast.source || 'jumprun';
		var fallback = this.forecast.fallback || 'none';
		var primary = (source === 'wms') ? this.fetchForecastWms() : this.fetchForecastJumprun();
		return primary.catch(error => {
			console.warn('Forecast from ' + source + ' failed: ' + error.message);
			if (fallback === 'wms' && source !== 'wms') {
				return this.fetchForecastWms();
			}
			if (fallback === 'jumprun' && source !== 'jumprun') {
				return this.fetchForecastJumprun();
			}
			throw error;
		}).catch(error => {
			console.warn('No precipitation forecast: ' + error.message);
			return null;
		});
	}

	updateData() {
		if (!this.map) {
			return;
		}
		/* Disable warning icon */
		document.getElementById(ID_IMAGES_LAST_UPDATED_WARNING).style.display = 'none';

		/* Enable spinner icon */
		document.getElementById(ID_IMAGES_LAST_UPDATED_SPINNER).style.display = 'block';

		Promise.all([
			this.fetchRadarTimes(),
			this.satellite ? this.fetchSatTimes() : Promise.resolve([]),
			this.fetchForecast(),
			this.rainChart ? this.fetchRainMeasured() : Promise.resolve([]),
		]).then(([radarTimes, satTimes, forecast, rainMeasured]) => {
			this.syncRadar(radarTimes);
			this.syncSatellite(satTimes);
			this.syncForecast(forecast, radarTimes[radarTimes.length - 1]);
			this.buildFrames(radarTimes, forecast);
			this.rainMeasured = rainMeasured;
			this.rainForecast = (forecast && forecast.rain) ? forecast.rain : [];

			this.last_updated = new Date();
			document.getElementById(ID_IMAGES_SOURCE_DATA).innerHTML = SOURCE + ((forecast && forecast.source === 'jumprun') ? ' / jumprun.nl' : '');
			document.getElementById(ID_IMAGES_LAST_UPDATED).innerHTML = this.last_updated.toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL);
			document.getElementById(ID_IMAGES_LAST_UPDATED_SPINNER).style.display = 'none';

			if (this.timer === null) {
				this.index = 0;
				this.showFrame();
			}
		}).catch(error => {
			document.getElementById(ID_IMAGES_LAST_UPDATED_SPINNER).style.display = 'none';
			document.getElementById(ID_IMAGES_LAST_UPDATED_WARNING).style.display = 'block';
			console.error(error);
		});
	}

	/* Keep one hidden overlay per radar time; the images preload while hidden */
	syncRadar(times) {
		var wanted = {};
		times.forEach(time => {
			var key = isoMinutes(time);
			wanted[key] = true;
			if (!this.radarOverlays[key]) {
				var url = this.getMapUrl(RADAR_WMS, { DATASET: RADAR_DATASET, LAYERS: RADAR_LAYER, STYLES: RADAR_STYLE, TIME: key });
				this.radarOverlays[key] = L.imageOverlay(url, this.map.getBounds(), { opacity: 0, zIndex: Z_RADAR, className: 'radar-frame' }).addTo(this.map);
			}
		});
		for (var key in this.radarOverlays) {
			if (!wanted[key]) {
				this.radarOverlays[key].remove();
				delete this.radarOverlays[key];
			}
		}
	}

	syncSatellite(times) {
		var wanted = {};
		var area = (times.length > 0) ? this.cloudArea() : this.satBounds;
		var moved = (this.satBounds === null) || (area !== null && !this.satBounds.equals(area));
		if (moved) {
			this.satBounds = area;
		}
		/* One source for the whole loop: switching from the visible image to infrared halfway
		   through the animation gives a jump. The newest image decides, so the switch happens
		   between two updates instead of inside one loop. */
		var spec = (times.length > 0) ? this.cloudSpec(times[times.length - 1]) : this.satSpec;
		if (spec !== this.satSpec || moved) {
			for (var old in this.satOverlays) {
				this.satOverlays[old].remove();
			}
			this.satOverlays = {};
			this.satSpec = spec;
		}
		times.forEach(time => {
			var key = isoMinutes(time);
			wanted[key] = true;
			if (!this.satOverlays[key]) {
				var url = this.getMapUrl(SAT_WMS, {
					LAYERS: spec.layer,
					STYLES: spec.style,
					TIME: key,
					FORMAT: spec.format,
					TRANSPARENT: spec.transparent,
				}, this.satBounds, spec.maxSize);
				var overlay = L.imageOverlay(url, this.satBounds, {
					opacity: 0,
					zIndex: Z_SATELLITE,
					pane: this.satelliteBlend ? CLOUDS_PANE : 'overlayPane',
				}).addTo(this.map);
				/* EUMETSAT noemt een tijd in zijn GetCapabilities een paar minuten voordat het beeld
				   er echt is; die levert dan een 502. Dat ene lege frame is tot daaraan toe, maar de
				   vooruitzichten worden allemáál uit het nieuwste beeld gemaakt, dus dan is de hele
				   tweede helft van de lus wolkenloos. Onthouden dus, zodat er teruggevallen wordt. */
				overlay.on('error', () => {
					if (this.satFailed[key]) {
						return;
					}
					this.satFailed[key] = true;
					console.warn('Cloud image ' + key + ' did not load; using the one before it');
					/* en weg ermee, zodat de volgende ronde het opnieuw probeert: over vijf minuten is
					   het beeld er wel, en dan hoort het gewoon in beeld te komen */
					overlay.remove();
					delete this.satOverlays[key];
				});
				if (this.satelliteBlend && overlay.getElement()) {
					overlay.getElement().style.filter = this.cloudFilter(spec, time);
				}
				delete this.satFailed[key];
				this.satOverlays[key] = overlay;
			}
		});
		for (var key in this.satOverlays) {
			if (!wanted[key]) {
				this.satOverlays[key].remove();
				delete this.satOverlays[key];
			}
		}
		this.satTimes = Object.keys(this.satOverlays).sort();
	}

	/* After so many complete runs of the loop, the jumprun of today takes the map over for a while.
	   Returns whether it did, so the loop knows to wait longer before the next frame. It hides
	   itself again on a timer of its own rather than by counting frames, because the radar keeps
	   running underneath and should simply reappear when the time is up. */
	jumprunTurn() {
		var jumprun = (document.modules || {}).jumprun;
		if (!jumprun || !jumprun.active || !this.jumprunAfterRuns) {
			return false;
		}
		this.runs = (this.runs || 0) + 1;
		if (this.runs < this.jumprunAfterRuns) {
			return false;
		}
		this.runs = 0;
		if (!jumprun.show()) {
			return false;
		}
		clearTimeout(this.jumprunTimer);
		this.jumprunTimer = setTimeout(() => jumprun.hide(), this.jumprunSeconds * 1000);
		return true;
	}

	/* Replace the forecast overlays when the run (or the source) changes */
	syncForecast(forecast, radarEnd) {
		var run = forecast ? (forecast.source + ':' + forecast.run) : null;
		if (run === this.forecastSource) {
			return;
		}
		for (var key in this.forecastOverlays) {
			this.forecastOverlays[key].remove();
		}
		this.forecastOverlays = {};
		this.forecastSource = run;
		if (forecast === null) {
			return;
		}
		var bounds = forecast.bounds || this.map.getBounds();
		forecast.frames.forEach(frame => {
			if (frame.time.getTime() > radarEnd.getTime() && frame.time.getTime() <= radarEnd.getTime() + this.hoursAhead * 60 * 60 * 1000) {
				var key = isoMinutes(frame.time);
				this.forecastOverlays[key] = L.imageOverlay(frame.url, bounds, { opacity: 0, zIndex: Z_RADAR, className: 'radar-frame' }).addTo(this.map);
			}
		});
	}

	buildFrames(radarTimes, forecast) {
		var frames = radarTimes.map(time => ({ time: time, kind: 'radar', key: isoMinutes(time) }));
		Object.keys(this.forecastOverlays).sort().forEach(key => {
			frames.push({ time: new Date(key), kind: 'forecast', key: key });
		});
		this.frames = frames;
		this.now = radarTimes[radarTimes.length - 1];
		if (this.index >= frames.length) {
			this.index = 0;
		}
	}

	/* The precipitation chart, redrawn per frame: bars plus a cursor at the frame on the map */
	drawChart(frameTime) {
		var canvas = document.getElementById(ID_CHART);
		if (!canvas || !canvas.getContext || this.frames.length < 2) {
			return;
		}
		var ratio = window.devicePixelRatio || 1;
		var width = canvas.clientWidth;
		var height = canvas.clientHeight;
		if (width === 0 || height === 0) {
			return;
		}
		if (canvas.width !== Math.round(width * ratio)) {
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
		}
		var context = canvas.getContext('2d');
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);

		var start = this.frames[0].time.getTime();
		var end = this.frames[this.frames.length - 1].time.getTime();
		var span = Math.max(1, end - start);
		var now = this.now ? this.now.getTime() : end;
		var bottom = height - CHART_LABEL_HEIGHT;
		var x = time => (time - start) / span * width;

		/* Background over the whole chart so the times stay readable over a bright map,
		   with the forecast half a shade lighter */
		context.fillStyle = 'rgba(0, 0, 0, 0.72)';
		context.fillRect(0, 0, width, height);
		context.fillStyle = 'rgba(255, 255, 255, 0.09)';
		context.fillRect(x(now), 0, width - x(now), bottom);
		context.fillStyle = 'rgba(255, 255, 255, 0.25)';
		context.fillRect(0, bottom, width, 1);

		/* Bars */
		var all = this.rainMeasured.concat(this.rainForecast);
		var peak = all.reduce((most, point) => Math.max(most, point.value || 0), 0);
		var scale = CHART_SCALES.find(step => peak <= step) || peak || 1;
		var draw = (points, alpha, minutes) => {
			var barWidth = Math.max(2, minutes * 60 * 1000 / span * width - 1);
			points.forEach(point => {
				if (!(point.value > 0) || point.time.getTime() < start || point.time.getTime() > end) {
					return;
				}
				context.fillStyle = rainColour(point.value, alpha);
				var barHeight = Math.max(1, (point.value / scale) * (bottom - 3));
				context.fillRect(x(point.time.getTime()) - barWidth / 2, bottom - barHeight, barWidth, barHeight);
			});
		};
		draw(this.rainMeasured, CHART_ALPHA_MEASURED, 10);
		draw(this.rainForecast, CHART_ALPHA_FORECAST, 5);

		/* Scale and hour marks */
		context.fillStyle = 'rgba(255, 255, 255, 0.8)';
		context.font = '10px sans-serif';
		context.textBaseline = 'top';
		context.textAlign = 'left';
		context.fillText(scale + ' mm/h', 4, 2);
		context.textAlign = 'center';
		var hour = new Date(start);
		hour.setMinutes(0, 0, 0);
		hour.setHours(hour.getHours() + 1);
		while (hour.getTime() <= end) {
			var position = x(hour.getTime());
			context.fillStyle = 'rgba(255, 255, 255, 0.22)';
			context.fillRect(position, 0, 1, bottom);
			context.fillStyle = 'rgba(255, 255, 255, 0.8)';
			context.fillText(hour.toLocaleTimeString(document.config.locale, { hour: '2-digit', minute: '2-digit' }), position, bottom + 1);
			hour.setHours(hour.getHours() + 1);
		}

		/* Cursor on the frame that is on the map */
		var cursor = x(frameTime.getTime());
		context.fillStyle = 'rgba(0, 0, 0, 0.6)';
		context.fillRect(cursor - 2, 0, 5, bottom);
		context.fillStyle = '#ffffff';
		context.fillRect(cursor - 1, 0, 2, bottom);
	}

	/* Satellite image closest before (or at) the given time */
	/* Het nieuwste beeld op of vóór dit moment dat ook werkelijk geladen is. Een aangekondigd
	   maar onleverbaar beeld overslaan is het verschil tussen één leeg frame en een lus die
	   vanaf 'nu' geen wolken meer laat zien. */
	satelliteFor(time) {
		var key = isoMinutes(time);
		var best = null;
		for (var i = 0; i < this.satTimes.length; i++) {
			if (this.satTimes[i] <= key && !this.satFailed[this.satTimes[i]]) {
				best = this.satTimes[i];
			}
		}
		if (best !== null) {
			return best;
		}
		/* niets bruikbaars ervoor: dan maar het eerste dat wél geladen is */
		for (var j = 0; j < this.satTimes.length; j++) {
			if (!this.satFailed[this.satTimes[j]]) {
				return this.satTimes[j];
			}
		}
		return null;
	}

	showFrame() {
		this.timer = null;
		if (this.frames.length === 0) {
			return;
		}
		var frame = this.frames[this.index];

		/* Hide previous frame */
		this.visible.forEach(overlay => overlay.setOpacity(0));
		this.visible = [];

		/* Show this frame */
		var overlay = (frame.kind === 'radar') ? this.radarOverlays[frame.key] : this.forecastOverlays[frame.key];
		if (overlay) {
			overlay.setOpacity(RADAR_OPACITY);
			this.visible.push(overlay);
		}
		var satKey = this.satelliteFor(frame.time);
		if (satKey !== null && this.satOverlays[satKey]) {
			/* The clouds of a forecast frame are the newest image shifted along with the wind, so the
			   further ahead, the more of an estimate it is: let them fade as the estimate gets older */
			var age = Math.max(0, frame.time.getTime() - new Date(satKey).getTime());
			var fade = Math.min(1, age / (this.hoursAhead * 60 * 60 * 1000));
			this.satOverlays[satKey].setBounds(this.cloudBounds(frame.time, new Date(satKey)));
			this.satOverlays[satKey].setOpacity(this.satelliteOpacity * (1 - CLOUDS_FADE * fade));
			this.visible.push(this.satOverlays[satKey]);
		}

		/* Time bar */
		document.getElementById(ID_TIMELABEL).innerHTML = ((frame.kind === 'radar') ? LANGUAGE_RADAR : LANGUAGE_RADAR_FORECAST) + ' ' + frame.time.toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL);
		document.getElementById(ID_TIMELABEL).className = 'radar-timelabel radar-timelabel-' + frame.kind;
		if (this.rainChart) {
			this.drawChart(frame.time);
		}

		/* Next frame: pause at the end of the loop and at the transition from radar to forecast */
		var delay = this.frameInterval;
		if (this.index === this.frames.length - 1) {
			delay = this.pauseAtEnd;
		} else if (frame.kind === 'radar' && this.frames[this.index + 1].kind === 'forecast') {
			delay = this.pauseAtNow;
		}
		var last = (this.index === this.frames.length - 1);
		this.index = (this.index + 1) % this.frames.length;
		if (last && this.jumprunTurn()) {
			/* the jumprun takes the map over for a while; the loop picks up where it left off */
			delay += this.jumprunSeconds * 1000;
		}
		this.timer = setTimeout(this.showFrame.bind(this), delay);
	}
}

export { Module };
