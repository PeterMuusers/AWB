/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */
/* jshint esversion: 8 */

/*
 * The jumprun somebody put on this board from jumprun.nl, drawn here and checked against the wind
 * of the moment.
 *
 * Two sums, not one. The first uses the wind the plan was made with, and that is what gets drawn:
 * it is the line the jump organiser decided on, and the board has no business quietly showing a
 * different one. The second uses the wind of right now, and only decides how loudly the caption
 * speaks. If the plan no longer reaches the landing area with the current wind, the line about the
 * wind gets the attention colour; the words stay about the wind either way.
 *
 * That is deliberate. This screen hangs where everyone walks past, students included, and "not
 * every exit makes the field" is a conclusion about where you personally are going to land. That
 * belongs in a briefing from a person. The board names the cause: the wind turned, or it picked up.
 *
 * The calculation itself is the one from jumprun.nl, copied into scripts/jumprun; see the README
 * there. The plan carries a version, and a plan from a newer version is not drawn at all.
 */

import { computeJumprun } from '../jumprun/jumprun.js';
import { profileFromAloft } from '../jumprun/wind.js';
import { LANGUAGE_SOURCE, LANGUAGE_LAST_UPDATED } from '../language.js';

const PROXY_URL = './jumprun-proxy.php';
const PLAN_VERSION = 1;					// the shape of the plan this board understands

/* When a change since the plan is worth a word. A turn of twenty degrees moves the exit point
   noticeably at these speeds, which is tighter than the thirty the wind profile uses elsewhere for
   a different question. Five knots is about where model noise ends and weather begins. */
const TURN_DEG = 20;
const SPEED_KT = 5;
const LOW_FT = 3000;					// "below this" is the canopy ride and the circuit

class Module {
	constructor(station) {
		this.station = station;
		this.refreshInterval = 2 * 60 * 1000;	// a jumprun is put up by hand, so notice it quickly

		this.last_updated = null;
		this.entry = null;			// what jumprun.nl handed over: plan, wind, who, when
		this.planned = null;		// the jumprun as it was decided, computed with the plan's wind
		this.error = null;

		this.task = setInterval(this.updateData.bind(this), this.refreshInterval);
		this.updateData();
	}

	/* Is there a jumprun to show at all? */
	get active() {
		return this.planned !== null;
	}

	updateData() {
		var url = PROXY_URL + '?action=jumprun&station=' + encodeURIComponent(this.station);
		fetch(url, { headers: { Accept: 'application/json' } }).then(response => {
			return response.json().then(data => {
				if (response.ok === true) {
					return data;
				}
				throw new Error(data && data.error ? data.error : ('HTTP ' + response.status));
			});
		}).then(data => {
			this.last_updated = new Date();
			this.error = null;
			this.adopt(data.jumprun || null);
		}).catch(error => {
			/* jumprun.nl out of reach is not a reason to drop a plan that is already on screen */
			this.error = error.message;
			console.warn('Jumprun not available: ' + error.message);
		});
	}

	/* Take over a plan and work out the line it stands for. */
	adopt(entry) {
		if (entry === null) {
			this.entry = null;
			this.planned = null;
			return;
		}
		if (entry.version !== PLAN_VERSION) {
			this.entry = null;
			this.planned = null;
			console.warn('Jumprun plan version ' + entry.version + ' needs a newer board (this one reads ' + PLAN_VERSION + ')');
			return;
		}
		this.entry = entry;
		this.planned = this.compute(entry.plan, this.profileOf(entry.wind));
	}

	/* The wind as the calculation wants it. The plan carries levels; so does this board. */
	profileOf(wind) {
		var levels = (wind && Array.isArray(wind.levels)) ? wind.levels : [];
		return levels.length > 1 ? profileFromAloft(levels) : null;
	}

	/* The wind this board measures and models right now, in the same shape as the plan's. */
	currentWind() {
		var aloft = (document.modules || {}).aloft;
		if (!aloft || !aloft.hours || aloft.hours.length === 0) {
			return null;
		}
		var now = Date.now();
		var hour = aloft.hours.reduce((closest, candidate) =>
			Math.abs(candidate.time.getTime() - now) < Math.abs(closest.time.getTime() - now) ? candidate : closest);
		var levels = Object.keys(hour.levels).map(feet => ({
			ft: Number(feet),
			kt: hour.levels[feet].kt,
			dir: hour.levels[feet].dir,
		})).filter(level => level.kt !== null && level.dir !== null).sort((a, b) => a.ft - b.ft);
		return levels.length > 1 ? { at: hour.time.toISOString(), levels } : null;
	}

	compute(plan, profile) {
		if (!plan || profile === null) {
			return null;
		}
		try {
			return computeJumprun({ ...plan, profile });
		} catch (error) {
			console.warn('Jumprun cannot be computed: ' + error.message);
			return null;
		}
	}

	/* What the wind did since the plan was made, per group of levels that mean different things.
	   Returns [{where, turn, speed}] for the groups that moved enough to say something about. */
	drift() {
		var then = this.entry ? this.entry.wind : null;
		var now = this.currentWind();
		if (!then || !now || !Array.isArray(then.levels)) {
			return [];
		}
		var exitFeet = this.entry.plan.exitAltFt;
		var groups = [
			{ where: exitFeet, pick: level => Math.abs(level.ft - exitFeet) < 600 },
			{ where: LOW_FT, pick: level => level.ft > 0 && level.ft <= LOW_FT },
		];
		var changes = [];
		groups.forEach(group => {
			var before = average(then.levels.filter(group.pick));
			var after = average(now.levels.filter(group.pick));
			if (before === null || after === null) {
				return;
			}
			var turn = Math.round(turned(before.dir, after.dir));
			var speed = Math.round(after.kt - before.kt);
			if (Math.abs(turn) >= TURN_DEG || Math.abs(speed) >= SPEED_KT) {
				changes.push({ where: group.where, turn: turn, speed: speed, to: after });
			}
		});
		return changes;
	}

	/* Does the plan still put everybody on the field with the wind of right now? Null when there is
	   no current wind to judge by: silence is better than a verdict nobody can check. */
	stillReaches() {
		var now = this.currentWind();
		var current = now ? this.compute(this.entry.plan, this.profileOf(now)) : null;
		if (current === null || !current.canopy) {
			return null;
		}
		return current.canopy.allReachTarget === true;
	}
}

/* Mean wind over a set of levels, as a vector: averaging degrees straight across gives nonsense
   around north. */
function average(levels) {
	if (!levels || levels.length === 0) {
		return null;
	}
	var east = 0, north = 0;
	levels.forEach(level => {
		var radians = Number(level.dir) * Math.PI / 180;
		east += -Number(level.kt) * Math.sin(radians);
		north += -Number(level.kt) * Math.cos(radians);
	});
	east /= levels.length;
	north /= levels.length;
	var speed = Math.sqrt(east * east + north * north);
	var from = (Math.atan2(-east, -north) * 180 / Math.PI + 360) % 360;
	return { kt: speed, dir: from };
}

/* Signed turn from one direction to the other, -180 to 180, positive is clockwise. */
function turned(from, to) {
	return ((to - from + 540) % 360) - 180;
}

export { Module, TURN_DEG, SPEED_KT };
