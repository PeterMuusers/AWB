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
const ALTITUDE_TICKS = [0, 1000, 2000, 3500, 5000, 9000, 12000, 20000];
const LABEL_HEIGHT = 14;				// pixels at the bottom for the times
const TOP_LABEL_HEIGHT = 15;			// pixels at the top, above the chart, for 'measured | expected'
const WIND_HEIGHT = 58;					// pixels at the bottom for the wind lines
const AXIS_WIDTH = 34;					// pixels on the left for the altitude labels
const CLOUD_COLOUR = '143, 176, 204';	// the cloud colour of the theme, as rgb parts
const LABEL_CLEARANCE = 26;			// pixels a number needs from the line for now to be drawn
const MEASURED_BAR = 3;					// pixels, thickness of a measured layer

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
		document.getElementById(ID_HEADER).innerHTML = '<span>' + LANGUAGE_CLOUD_BASE + ' &middot; ' + UNIT_FEET + '</span>';

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
		if (canvas.width !== Math.round(width * ratio)) {
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
		}
		var context = canvas.getContext('2d');
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);

		var now = Date.now();
		var start = now - this.hoursBack * 3600 * 1000;
		var end = now + this.hoursAhead * 3600 * 1000;
		var x = time => AXIS_WIDTH + (time - start) / (end - start) * (width - AXIS_WIDTH);
		var cloudBottom = height - LABEL_HEIGHT - WIND_HEIGHT;
		var y = feet => cloudBottom - this.altitudeFraction(feet) * (cloudBottom - TOP_LABEL_HEIGHT - 2);

		var style = getComputedStyle(document.documentElement);
		var muted = style.getPropertyValue('--metadata-textcolor').trim() || '#8a96a3';
		var border = style.getPropertyValue('--block-border-color').trim() || 'rgba(127,127,127,0.2)';
		var windColour = style.getPropertyValue('--wind-color').trim() || '#2a78d6';
		var gustColour = style.getPropertyValue('--gust-color').trim() || '#eb6834';

		context.font = '9px sans-serif';
		context.textBaseline = 'middle';

		/* Altitude gridlines and their labels */
		context.textAlign = 'right';
		ALTITUDE_TICKS.forEach(feet => {
			var line = y(feet);
			context.strokeStyle = border;
			context.lineWidth = 1;
			context.beginPath();
			context.moveTo(AXIS_WIDTH, line + 0.5);
			context.lineTo(width, line + 0.5);
			context.stroke();
			context.fillStyle = muted;
			context.fillText(feet >= 1000 ? (feet / 1000) + 'k' : String(feet), AXIS_WIDTH - 5, line);
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
				context.fillStyle = 'rgba(' + CLOUD_COLOUR + ', ' + (0.15 + 0.6 * (layer.okta / 8)).toFixed(2) + ')';
				context.fillRect(left, top, right - left, y(layer.base) - top);
			});
		});

		/* Measured layers: a short bar at the base, the more eighths the brighter */
		var step = (layers.length > 1) ? Math.abs(x(layers[1].time.getTime()) - x(layers[0].time.getTime())) : 6;
		layers.forEach(moment => {
			moment.layers.forEach(layer => {
				context.fillStyle = 'rgba(' + CLOUD_COLOUR + ', ' + (0.45 + 0.55 * (layer.okta / 8)).toFixed(2) + ')';
				context.fillRect(x(moment.time.getTime()) - step / 2, y(layer.base) - MEASURED_BAR / 2, Math.max(3, step - 1), MEASURED_BAR);
			});
		});

		/* The freezing level of the model, as a dashed line */
		var freezing = ahead.length > 0 ? ahead[0].freezing : null;
		if (freezing !== null && freezing < ALTITUDE_TICKS[ALTITUDE_TICKS.length - 1]) {
			context.strokeStyle = muted;
			context.setLineDash([4, 3]);
			context.beginPath();
			context.moveTo(AXIS_WIDTH, y(freezing) + 0.5);
			context.lineTo(width, y(freezing) + 0.5);
			context.stroke();
			context.setLineDash([]);
			context.fillStyle = muted;
			context.textAlign = 'left';
			context.fillText('0 ' + String.fromCharCode(176) + 'C', AXIS_WIDTH + 4, y(freezing) - 6);
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

		/* A dot on a value, with the number next to it: above the line for gusts, below it for wind */
		var drawMarker = (point, colour, label, above, align) => {
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
				context.fillText(label, left + (align === 'left' ? 4 : 0), top + (above ? -8 : 9));
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
		/* The first expected hour can be only minutes after now, and then its number would sit on
		   top of the measured one: draw the dot, leave the number off. */
		var roomForLabel = point => Math.abs(x(point.time.getTime()) - x(now)) > LABEL_CLEARANCE;
		visibleOnly(aheadWind).filter(point => point !== nowWind).forEach(point => {
			drawMarker(point, windColour, roomForLabel(point) ? Math.round(point.value) + ' ' + UNIT_KNOTS : null, false);
		});
		visibleOnly(aheadGust).filter(point => point !== nowGust).forEach(point => {
			drawMarker(point, gustColour, roomForLabel(point) ? 'G' + Math.round(point.value) : null, true);
		});

		context.fillStyle = muted;
		context.textAlign = 'right';
		context.fillText(Math.round(peak) + ' ' + UNIT_KNOTS, AXIS_WIDTH - 5, windTop + 4);
		context.textAlign = 'left';
		context.fillText(LANGUAGE_WIND.toUpperCase(), AXIS_WIDTH + 4, windTop + 4);

		/* Hour marks and the line for now */
		context.textAlign = 'center';
		var hour = new Date(start);
		hour.setMinutes(0, 0, 0);
		hour.setHours(hour.getHours() + 1);
		while (hour.getTime() <= end) {
			/* skip an hour that would collide with the label for now */
			if (Math.abs(x(hour.getTime()) - x(now)) > 20) {
				context.fillStyle = muted;
				context.fillText(hour.toLocaleTimeString(document.config.locale, { hour: '2-digit', minute: '2-digit' }), x(hour.getTime()), height - LABEL_HEIGHT / 2);
			}
			hour.setHours(hour.getHours() + 1);
		}
		context.fillStyle = style.getPropertyValue('--textcolor').trim() || '#ffffff';
		context.textAlign = 'center';
		context.fillText(LANGUAGE_NOW, x(now), height - LABEL_HEIGHT / 2);

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
