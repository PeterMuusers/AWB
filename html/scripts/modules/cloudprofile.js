/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { UNIT_FEET, UNIT_KNOTS } from '../const.js';
import { LANGUAGE_NOW, LANGUAGE_CLOUD_BASE, LANGUAGE_WIND, LANGUAGE_MEASURED_LABEL, LANGUAGE_EXPECTED_LABEL } from '../language.js';

/*
 * Cloud layers and wind over time: the past hours as measured at the station (ceilometer and
 * anemometer, through the luchtvaartmeteo module) and the coming hours as the model expects them
 * (through the wind profile module). The line marked "now" separates the two and stands still:
 * the radar map next to it is already animating, and a second moving panel makes the board restless.
 *
 * The altitude axis is deliberately not linear. The first few thousand feet are what decides
 * whether jumping is possible, so they get most of the height; everything above is compressed.
 */

const ID_CANVAS = 'cloudprofile-canvas';
const ID_HEADER = 'cloudprofile-header';

/* Gridlines of the altitude axis, evenly spaced on screen so the low altitudes get the room */
/* The altitude axis is deliberately not linear: the first few thousand feet decide whether jumping
   is possible, so they get more room than their share. Every step between two of these gets the
   same height on the chart, which makes the list itself the scale. The ground to five thousand takes
   three of the eight steps: more than its share, but not the more than half it used to take, which
   squeezed everything above it into a strip and left the tops of a shower with nowhere to go.
   Nine, twelve and fifteen thousand are on the list because they are the altitudes the aircraft
   drops from, so a layer sitting at one of them lands on a line of its own instead of somewhere
   between two. */
/* Tot 15.000 ft: dat is de hoogste hoogte waar hier uit gesprongen wordt, en een wolk boven die
   hoogte verandert niets aan de sprong. Alles daarboven wordt tegen de bovenrand getekend (zie
   altitudeFraction), dus je ziet nog steeds dát er iets hangt. */
const ALTITUDE_TICKS = [0, 1000, 3000, 5000, 7000, 9000, 12000, 15000];
const LABEL_HEIGHT = 24;				// pixels at the bottom for the times
const CHART_FONT = '11px sans-serif';	// de getallen in deze grafiek; kleiner dan dit leest niet van een meter of drie
/* De hoogteschaal is waar je als eerste naar kijkt - op welke hoogte hangt die wolk - dus die staat
   groter en in de kleur van de andere getallen op het bord, niet in het grijs van een asje. */
const AXIS_FONT = '17px sans-serif';
/* De tijdregel hoort op dezelfde lijn te eindigen als de grondrij van het windprofiel ernaast: twee
   blokken naast elkaar die onderin allebei over "nu" gaan. Hoeveel dat is wordt gemeten - zo blijft
   het kloppen als die tabel een regel meer of minder krijgt - en dit is wat het is zolang er geen
   windprofiel naast staat om naar te kijken. */
const TIME_BASELINE = 13;				// pixels above the bottom edge for the bottom of the digits
const TIME_TICK = 6;					// pixels, the little line above each time
const TOP_LABEL_HEIGHT = 15;			// pixels at the top, above the chart, for 'measured | expected'
const WIND_HEIGHT = 58;					// pixels at the bottom for the wind lines
/* De hoogteschaal krijgt precies de breedte van zijn breedste getal plus wat lucht naar de grafiek.
   Zo begint dat getal op de rand van het canvas en houdt het dus de veertien pixels van de tegel
   zelf aan de linkerkant - en het klopt nog steeds als de maat van die getallen verandert. */
const AXIS_GAP = 8;						// pixels between the altitude labels and the chart
const CLOUD_COLOUR = '143, 176, 204';	// the cloud colour of the theme, as rgb parts
const LABEL_CLEARANCE = 26;			// pixels a number needs from the line for now to sit centred on its dot
const MEASURED_BAR = 3;					// pixels, thickness of a measured layer
const OKTA_OF = '/8';					// how the eighths are written on an expected layer
const OKTA_LABEL_MIN_HEIGHT = 13;		// pixels; under this a block has no room for its number
const OKTA_LABEL_TOP = 10;				// pixels from the top of the block to the baseline of the number

class Module {
	constructor(container_id) {
		this.config = document.config.cloudProfile || {};
		this.hoursBack = this.config.hoursBack || 2;
		this.hoursAhead = this.config.hoursAhead || 2;
		this.refreshInterval = 20 * 1000; // Redraw often: it only draws, the sources do the fetching
		this.drawn = false;

		var container = document.getElementById(container_id);
		container.innerHTML = '<div class="cloudprofile-header" id="' + ID_HEADER + '"></div>'
			+ '<canvas class="cloudprofile-canvas" id="' + ID_CANVAS + '"></canvas>';
		/* The time axis and the line for now already show what is measured and what is expected,
		   so the header stays short: this card is narrow. */
		/* De naam apart, zodat hij dezelfde witte kop krijgt als "Windprofiel" ernaast; de eenheid
		   erachter blijft gedempt, net als daar. */
		document.getElementById(ID_HEADER).innerHTML = '<span><span class="header-name">' + LANGUAGE_CLOUD_BASE
			+ '</span> &middot; ' + UNIT_FEET + '</span>';

		/* Schedule update of document content */
		this.task = setInterval(
			this.updateData.bind(this),
			this.refreshInterval
		);

		/* The chart has no source of its own, so at start up it waits for the other modules. Look
		   every second until there is something to draw, instead of leaving the card empty for a
		   whole interval. */
		this.warmup = setInterval(() => {
			if (this.drawn) {
				clearInterval(this.warmup);
				return;
			}
			this.updateData();
		}, 1000);

		/* Initial fill of document content */
		this.updateData();
	}

	/* The measured series, as [{time, value}] */
	measured(field) {
		var module = (document.modules || {}).luchtvaartmeteo;
		var series = (module && module.series) ? module.series[field] : null;
		if (!series) {
			return [];
		}
		return series.map(point => ({ time: new Date(point[0]), value: Number(point[1]) }));
	}

	/* Hoeveel ruimte er onder de cijfers van de tijdregel blijft, zodat hun onderkant gelijk ligt met
	   de grondrij van het windprofiel ernaast. Gemeten in plaats van vastgezet: die tabel krijgt er
	   een regel bij als het 0 °C-niveau een eigen rij heeft, en dan schuift die grondrij mee. */
	timeBaseline(canvas) {
		var row = document.querySelector('.upper-winds-content tr.ground-row');
		if (!row || !canvas) {
			return TIME_BASELINE;
		}
		var box = canvas.getBoundingClientRect();
		var scale = box.height / canvas.clientHeight;      /* het bord wordt als geheel geschaald */
		if (!(scale > 0)) {
			return TIME_BASELINE;
		}
		var offset = (box.bottom - row.getBoundingClientRect().bottom) / scale;
		/* binnen de strook blijven: een windprofiel dat er raar bij staat mag de tijd niet wegdrukken */
		return Math.min(LABEL_HEIGHT - 9, Math.max(3, Math.round(offset)));
	}

	/* The measured cloud layers per moment: the three ceilometer layers merged by timestamp */
	measuredLayers() {
		var byTime = {};
		[1, 2, 3].forEach(number => {
			var bases = this.measured('base' + number + '_ft');
			var oktas = this.measured('okta' + number);
			bases.forEach(base => {
				var okta = oktas.find(point => point.time.getTime() === base.time.getTime());
				if (!okta || !(okta.value >= 1) || !(base.value > 0)) {
					return;
				}
				var key = base.time.getTime();
				byTime[key] = byTime[key] || { time: base.time, layers: [] };
				byTime[key].layers.push({ base: base.value, okta: okta.value });
			});
		});
		return Object.keys(byTime).sort().map(key => byTime[key]);
	}

	/* Position of an altitude on the axis, 0 at the bottom and 1 at the top */
	/* Hoe een hoogte op de as heet: 9.000 ft is "9k", de grond is "0". */
	altitudeLabel(feet) {
		return feet >= 1000 ? (feet / 1000) + 'k' : String(feet);
	}

	altitudeFraction(feet) {
		var ticks = ALTITUDE_TICKS;
		if (feet <= ticks[0]) {
			return 0;
		}
		for (var i = 0; i < ticks.length - 1; i++) {
			if (feet <= ticks[i + 1]) {
				var within = (feet - ticks[i]) / (ticks[i + 1] - ticks[i]);
				return (i + within) / (ticks.length - 1);
			}
		}
		return 1;
	}

	updateData() {
		/* The cloud colour lifted towards white with how much sky is covered. Squared, so only the
		   last eighths really lighten: a layer of two eighths is cloud, eight eighths is a ceiling. */
		var towardsWhite = okta => {
			var share = Math.pow(Math.min(Math.max(okta, 0), 8) / 8, 2);
			return CLOUD_COLOUR.split(',').map(part => Math.round(Number(part) + (255 - Number(part)) * share)).join(', ');
		};
		var canvas = document.getElementById(ID_CANVAS);
		var aloft = (document.modules || {}).aloft;
		var hours = (aloft && aloft.hours) ? aloft.hours : [];
		var layers = this.measuredLayers();
		if (!canvas || !canvas.getContext || (layers.length === 0 && hours.length === 0)) {
			return;
		}

		var ratio = window.devicePixelRatio || 1;
		var width = canvas.clientWidth;
		var height = canvas.clientHeight;
		if (width === 0 || height === 0) {
			return;
		}
		/* Ook op de hoogte letten: alleen de breedte vergelijken liet een canvas dat hoger werd zijn
		   oude tekening uitrekken in plaats van hem opnieuw te tekenen. */
		if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
		}
		var context = canvas.getContext('2d');
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);

		var now = Date.now();
		var start = now - this.hoursBack * 3600 * 1000;
		var end = now + this.hoursAhead * 3600 * 1000;
		context.font = AXIS_FONT;
		var axis = Math.ceil(ALTITUDE_TICKS.reduce((widest, feet) =>
			Math.max(widest, context.measureText(this.altitudeLabel(feet)).width), 0)) + AXIS_GAP;
		var x = time => axis + (time - start) / (end - start) * (width - axis);
		var cloudBottom = height - LABEL_HEIGHT - WIND_HEIGHT;
		var y = feet => cloudBottom - this.altitudeFraction(feet) * (cloudBottom - TOP_LABEL_HEIGHT - 2);

		var style = getComputedStyle(document.documentElement);
		var muted = style.getPropertyValue('--metadata-textcolor').trim() || '#8a96a3';
		var border = style.getPropertyValue('--block-border-color').trim() || 'rgba(127,127,127,0.2)';
		var windColour = style.getPropertyValue('--wind-color').trim() || '#2a78d6';
		var gustColour = style.getPropertyValue('--gust-color').trim() || '#eb6834';
		var background = style.getPropertyValue('--block-background-color').trim() || '#151d27';
		var cloudInk = 'rgba(' + CLOUD_COLOUR + ', 0.95)';

		context.font = CHART_FONT;
		context.textBaseline = 'middle';

		/* Altitude gridlines and their labels */
		context.textAlign = 'right';
		var ink = style.getPropertyValue('--textcolor-2').trim() || style.getPropertyValue('--textcolor').trim() || '#ffffff';
		ALTITUDE_TICKS.forEach(feet => {
			var line = y(feet);
			context.strokeStyle = border;
			context.lineWidth = 1;
			context.beginPath();
			context.moveTo(axis, line + 0.5);
			context.lineTo(width, line + 0.5);
			context.stroke();
			context.font = AXIS_FONT;
			context.fillStyle = ink;
			context.fillText(this.altitudeLabel(feet), axis - AXIS_GAP, line);
			context.font = CHART_FONT;
		});

		/* The part ahead gets a slightly lighter background */
		context.fillStyle = 'rgba(' + CLOUD_COLOUR + ', 0.06)';
		context.fillRect(x(now), TOP_LABEL_HEIGHT, width - x(now), cloudBottom - TOP_LABEL_HEIGHT);

		/* Expected layers: a block from base to top, the more eighths the more solid */
		var ahead = hours.filter(hour => hour.time.getTime() >= now - 1800000 && hour.time.getTime() <= end);
		var hourWidth = ((ahead.length > 1) ? Math.abs(x(ahead[1].time.getTime()) - x(ahead[0].time.getTime())) : 40) * 0.62;
		ahead.forEach(hour => {
			/* a block is centred on the hour it is valid for, but it must not reach back over the
			   line for now: that half would sit in the measured part of the chart */
			var centre = x(hour.time.getTime());
			var left = Math.max(x(now), centre - hourWidth / 2) + 1;
			var right = centre + hourWidth / 2 - 1;
			if (right <= left) {
				return;
			}
			hour.layers.forEach(layer => {
				var top = y(Math.max(layer.top, layer.base + 200));
				var height = y(layer.base) - top;
				context.fillStyle = 'rgba(' + CLOUD_COLOUR + ', ' + (0.15 + 0.6 * (layer.okta / 8)).toFixed(2) + ')';
				context.fillRect(left, top, right - left, height);
				/* How many eighths, in the block itself. The shade of the block says the same thing,
				   but only next to another block: alone it is a tone without a scale to read it by.
				   Dark ink on a solid block, light on a thin one, because the block is what it sits
				   on. A block too small for the number keeps its shade and nothing else. */
				var label = layer.okta + OKTA_OF;
				if (height >= OKTA_LABEL_MIN_HEIGHT && (right - left) >= context.measureText(label).width + 4) {
					context.fillStyle = (layer.okta >= 5) ? background : cloudInk;
					context.textAlign = 'center';
					context.fillText(label, (left + right) / 2, top + OKTA_LABEL_TOP);
				}
			});
		});

		/* Measured layers: a short bar at the base, the more eighths the brighter. A thin layer keeps
		   the blue-grey of cloud; a closed sky runs all the way to white, so the difference between
		   nearly and completely covered is one you can see from across the hangar rather than a
		   shade you have to compare with the bar next to it. */
		var step = (layers.length > 1) ? Math.abs(x(layers[1].time.getTime()) - x(layers[0].time.getTime())) : 6;
		/* Binnen de grafiek blijven. De metingen gaan verder terug dan de uren die hier getoond
		   worden, en zonder afkappen tekent x() die netjes links van de as - dwars door de
		   hoogteschaal heen. Een blokje dat de rand raakt wordt afgesneden in plaats van
		   weggelaten, zodat je ziet dat de reeks doorloopt. */
		context.save();
		context.beginPath();
		context.rect(axis, TOP_LABEL_HEIGHT, width - axis, cloudBottom - TOP_LABEL_HEIGHT);
		context.clip();
		layers.forEach(moment => {
			moment.layers.forEach(layer => {
				context.fillStyle = 'rgba(' + towardsWhite(layer.okta) + ', ' + (0.45 + 0.55 * (layer.okta / 8)).toFixed(2) + ')';
				context.fillRect(x(moment.time.getTime()) - step / 2, y(layer.base) - MEASURED_BAR / 2, Math.max(3, step - 1), MEASURED_BAR);
			});
		});
		context.restore();

		/* The freezing level of the model, as a dashed line */
		var freezing = ahead.length > 0 ? ahead[0].freezing : null;
		if (freezing !== null && freezing < ALTITUDE_TICKS[ALTITUDE_TICKS.length - 1]) {
			context.strokeStyle = muted;
			context.setLineDash([4, 3]);
			context.beginPath();
			context.moveTo(axis, y(freezing) + 0.5);
			context.lineTo(width, y(freezing) + 0.5);
			context.stroke();
			context.setLineDash([]);
			context.fillStyle = muted;
			context.textAlign = 'left';
			context.fillText('0 ' + String.fromCharCode(176) + 'C', axis + 4, y(freezing) - 6);
		}

		/* The line for now, drawn before the wind section so the lines and their numbers sit on top
		   of it instead of disappearing behind it */
		var windBottomEdge = height - LABEL_HEIGHT;
		context.strokeStyle = style.getPropertyValue('--textcolor').trim() || '#ffffff';
		context.lineWidth = 1.5;
		context.beginPath();
		context.moveTo(x(now), TOP_LABEL_HEIGHT);
		context.lineTo(x(now), windBottomEdge);
		context.stroke();

		/* Wind and gusts below it: measured solid, expected dashed */
		var windTop = cloudBottom + 10;
		var windBottom = height - LABEL_HEIGHT;
		var winds = this.measured('wind_kt');
		var gusts = this.measured('gust_kt');
		var peak = Math.max(10, ...winds.map(point => point.value), ...gusts.map(point => point.value), ...ahead.map(hour => hour.ground.gust || 0));
		var windY = knots => windBottom - (knots / peak) * (windBottom - windTop);
		var visibleOnly = points => points.filter(point => point.time.getTime() >= start && point.time.getTime() <= end);
		var drawLine = (points, colour, dashed) => {
			var visible = visibleOnly(points);
			if (visible.length < 2) {
				return;
			}
			context.strokeStyle = colour;
			context.lineWidth = 1.5;
			context.setLineDash(dashed ? [4, 3] : []);
			context.beginPath();
			visible.forEach((point, index) => {
				var position = [x(point.time.getTime()), windY(point.value)];
				if (index === 0) {
					context.moveTo(position[0], position[1]);
				} else {
					context.lineTo(position[0], position[1]);
				}
			});
			context.stroke();
			context.setLineDash([]);
		};

		/* A dot on a value, with the number next to it: above the line for gusts, below it for wind.
		   A number placed to the right of its dot never starts before `from`, so it cannot run into
		   the number that is already standing there. */
		var drawMarker = (point, colour, label, above, align, from) => {
			if (!point) {
				return;
			}
			var left = x(point.time.getTime());
			var top = windY(point.value);
			context.fillStyle = colour;
			context.beginPath();
			context.arc(left, top, 2.5, 0, 2 * Math.PI);
			context.fill();
			if (label) {
				context.textAlign = align || 'center';
				var at = (align === 'left') ? Math.max(left + 4, from || 0) : left;
				context.fillText(label, at, top + (above ? -8 : 9));
			}
		};

		var firstOf = points => {
			var visible = visibleOnly(points);
			return visible.length > 0 ? visible[0] : null;
		};

		var lastOf = points => {
			var visible = visibleOnly(points);
			return visible.length > 0 ? visible[visible.length - 1] : null;
		};
		/* The expected line starts where the measured one stops, so the two do not run over each
		   other: the model also has an hour that began before now. */
		var nowWind = lastOf(winds);
		var nowGust = lastOf(gusts);
		var future = ahead.filter(hour => hour.time.getTime() >= (nowWind ? nowWind.time.getTime() : now));
		var aheadWind = future.map(hour => ({ time: hour.time, value: hour.ground.kt }));
		var aheadGust = future.map(hour => ({ time: hour.time, value: hour.ground.gust }));
		if (nowWind) {
			aheadWind.unshift(nowWind);
		}
		if (nowGust) {
			aheadGust.unshift(nowGust);
		}

		drawLine(winds, windColour, false);
		drawLine(gusts, gustColour, false);
		drawLine(aheadWind, windColour, true);
		drawLine(aheadGust, gustColour, true);

		/* Numbers where they matter: where the two hours behind us start, what it is now, and every
		   expected hour after that. Gusts above the line, wind below it, so the two never collide. */
		var firstWind = firstOf(winds);
		var firstGust = firstOf(gusts);
		drawMarker(firstWind, windColour, firstWind ? Math.round(firstWind.value) + ' ' + UNIT_KNOTS : null, false, 'left');
		drawMarker(firstGust, gustColour, firstGust ? 'G' + Math.round(firstGust.value) : null, true, 'left');
		drawMarker(nowWind, windColour, nowWind ? Math.round(nowWind.value) + ' ' + UNIT_KNOTS : null, false);
		drawMarker(nowGust, gustColour, nowGust ? 'G' + Math.round(nowGust.value) : null, true);
		/* The first expected hour can be only minutes after now, and a number centred on that dot
		   would land on top of the measured one. It moves to the right of its dot instead of being
		   left off: a dot without a number reads as a value the board failed to fetch. */
		var placement = point => (Math.abs(x(point.time.getTime()) - x(now)) > LABEL_CLEARANCE) ? 'center' : 'left';
		/* where a number pushed to the right has to start, clear of the one that says 'now' */
		var clearOf = label => x(now) + (label ? context.measureText(label).width / 2 : 0) + 6;
		var windFrom = clearOf(nowWind ? Math.round(nowWind.value) + ' ' + UNIT_KNOTS : null);
		var gustFrom = clearOf(nowGust ? 'G' + Math.round(nowGust.value) : null);
		visibleOnly(aheadWind).filter(point => point !== nowWind).forEach(point => {
			drawMarker(point, windColour, Math.round(point.value) + ' ' + UNIT_KNOTS, false, placement(point), windFrom);
		});
		visibleOnly(aheadGust).filter(point => point !== nowGust).forEach(point => {
			drawMarker(point, gustColour, 'G' + Math.round(point.value), true, placement(point), gustFrom);
		});

		context.fillStyle = muted;
		context.textAlign = 'right';
		context.fillText(Math.round(peak) + ' ' + UNIT_KNOTS, axis - 5, windTop + 4);
		context.textAlign = 'left';
		context.fillText(LANGUAGE_WIND.toUpperCase(), axis + 4, windTop + 4);

		/* Hour marks and the line for now. De cijfers staan op hun eigen voet in plaats van gecentreerd
		   in de strook, zodat hun onderkant op de grondrij van het windprofiel ernaast uitkomt, en elk
		   uur krijgt een streepje boven zijn getal - anders zweeft de tijd los onder de grafiek. */
		var baseline = height - this.timeBaseline(canvas);
		context.textAlign = 'center';
		context.textBaseline = 'alphabetic';
		var hour = new Date(start);
		hour.setMinutes(0, 0, 0);
		hour.setHours(hour.getHours() + 1);
		while (hour.getTime() <= end) {
			/* skip an hour that would collide with the label for now */
			if (Math.abs(x(hour.getTime()) - x(now)) > 24) {
				context.fillStyle = muted;
				context.fillText(hour.toLocaleTimeString(document.config.locale, { hour: '2-digit', minute: '2-digit' }), x(hour.getTime()), baseline);
				context.strokeStyle = muted;
				context.lineWidth = 1;
				context.beginPath();
				context.moveTo(Math.round(x(hour.getTime())) + 0.5, height - LABEL_HEIGHT);
				context.lineTo(Math.round(x(hour.getTime())) + 0.5, height - LABEL_HEIGHT + TIME_TICK);
				context.stroke();
			}
			hour.setHours(hour.getHours() + 1);
		}
		context.fillStyle = style.getPropertyValue('--textcolor').trim() || '#ffffff';
		context.textAlign = 'center';
		context.fillText(LANGUAGE_NOW, x(now), baseline);
		context.textBaseline = 'middle';

		/* what the line divides, said once in the strip above the chart itself */
		context.fillStyle = muted;
		context.textAlign = 'right';
		context.fillText(LANGUAGE_MEASURED_LABEL.toUpperCase(), x(now) - 6, TOP_LABEL_HEIGHT / 2 - 1);
		context.textAlign = 'left';
		context.fillText(LANGUAGE_EXPECTED_LABEL.toUpperCase(), x(now) + 6, TOP_LABEL_HEIGHT / 2 - 1);

		this.drawn = true;
	}
}

export { Module };
