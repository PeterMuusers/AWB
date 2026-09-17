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
 *
 * How a spot is spoken differs per dropzone, and jumprun.nl says which way with every plan.
 * Hoogeveen and Echten call out a track, an offset and a green light; Texel calls out a bearing
 * and a distance from the middle of the field, and then the run-in heading. The same jump and the
 * same sums, other words, so the board writes it down the way they say it there. Without an answer
 * it is the offset notation, which is what this board assumed before it could ask.
 */

import { computeJumprun } from '../jumprun/calc/jumprun.js';
import { profileFromAloft, windVectorAt } from '../jumprun/calc/wind.js';
import { bearing, distance } from '../jumprun/calc/geo.js';
import { NM } from '../jumprun/calc/units.js';
import { createJumprunMap } from '../jumprun/jumprun-map.js';
import {
	LANGUAGE_JUMPRUN_PLACED, LANGUAGE_JUMPRUN_BY, LANGUAGE_JUMPRUN_AT, LANGUAGE_JUMPRUN_WITH,
	LANGUAGE_JUMPRUN_SINCE, LANGUAGE_JUMPRUN_TURNED, LANGUAGE_JUMPRUN_STRONGER, LANGUAGE_JUMPRUN_WEAKER,
	LANGUAGE_JUMPRUN_AT_FT, LANGUAGE_JUMPRUN_TRACK, LANGUAGE_JUMPRUN_OFFSET, LANGUAGE_JUMPRUN_GREEN,
	LANGUAGE_JUMPRUN_SEPARATION, LANGUAGE_JUMPRUN_LARGE_GROUP, LANGUAGE_JUMPRUN_SOURCE, LANGUAGE_SOURCE,
	LANGUAGE_JUMPRUN_BEARING, LANGUAGE_JUMPRUN_DISTANCE,
} from '../language.js';

const PROXY_URL = './jumprun-proxy.php';
const ID_LAYER = 'layer-jumprun-id';
const ID_MAP = 'jumprun-map-id';
const ID_CAPTION = 'jumprun-caption-id';
/* dezelfde luchtfoto als onder de radar, zodat het niet op een ander bord lijkt */
const IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const RUN_BEFORE_M = 600;				// hoeveel lijn er vóór de eerste exit getekend wordt
const RUN_AFTER_M = 600;				// en erachter
const PAD_M = 300;						// ruimte rond alles wat er staat, zodat niets tegen de rand plakt
const PLAN_VERSION = 1;					// the shape of the plan this board understands

/* When a change since the plan is worth a word. A turn of twenty degrees moves the exit point
   noticeably at these speeds, which is tighter than the thirty the wind profile uses elsewhere for
   a different question. Five knots is about where model noise ends and weather begins. */
const TURN_DEG = 20;
const SPEED_KT = 5;
const LOW_FT = 3000;					// "below this" is the canopy ride and the circuit
const LARGE_GROUP_EXTRA_S = 2;			// AXIS-regel: zoveel seconden extra achter een grote groep
const CARDINALS = ['N', 'O', 'Z', 'W'];
/* Bij de poolnotatie wordt de peiling op vijf graden afgerond, zoals op jumprun.nl zelf: fijner
   dan dat leest niemand van een bord af, en het zou een nauwkeurigheid suggereren die de wind
   niet heeft. Ligt het groene licht vrijwel op de bak, dan is er geen peiling en staat er een
   streepje: een richting over twintig meter is geen richting. */
const POLAR_STEP_DEG = 5;
const POLAR_MIN_M = 20;

class Module {
	constructor(stations) {
		/* Meer dan één dropzone kan: het bord bij Hoogeveen kijkt ook naar Echten, en dan krijgt elk
		   om de beurt zijn eigen beurt in de lus. */
		this.stations = Array.isArray(stations) ? stations : [stations];
		/* Een jumprun wordt met de hand opgehangen, en ook met de hand even van het bord gehaald. Wie
		   dat doet staat meestal naar het scherm te kijken, dus een halve minuut is het wachten waard;
		   het antwoord komt van de proxy hiernaast en niet van jumprun.nl zelf. */
		this.refreshInterval = 30 * 1000;

		this.last_updated = null;
		this.all = {};				// station -> {notation, runs: [{entry, planned}]}
		this.turn = -1;				// welke dropzone het laatst aan de beurt was
		this.entry = null;			// wat er nu getoond wordt: plan, wind, who, when
		this.notation = 'offset';	// hoe deze dropzone de spot uitspreekt: 'offset' of 'polar'
		this.admins = 2;			// how many people can put one up; until we know, assume more than one
		this.planned = null;		// the jumprun as it was decided, computed with the plan's wind
		this.error = null;

		this.task = setInterval(this.updateData.bind(this), this.refreshInterval);
		this.updateData();
	}

	/* Alles wat vandaag opgehangen is, in de volgorde van de instelling: per dropzone eerst de hoge
	   run en dan de lage. Elke run krijgt zijn eigen beurt, want het zijn eigen getallen en een eigen
	   lijn op de kaart; de exithoogte staat in de kop, dus je ziet meteen welke van de twee je hebt. */
	get waiting() {
		var out = [];
		this.stations.forEach(station => {
			var held = this.all[station];
			(held && held.runs ? held.runs : []).forEach((run, index) => {
				if (run.planned) {
					out.push({ station: station, index: index });
				}
			});
		});
		return out;
	}

	/* Is there a jumprun to show at all? */
	get active() {
		return this.waiting.length > 0;
	}

	/* Alles wat er hangt, achter elkaar: eerst de dropzone van dit bord met zijn runs van hoog naar
	   laag, dan de volgende dropzone. Zo hoort het ook gelezen te worden - wie op de hoge run zit
	   kijkt naar het eerste scherm, wie op de lage run zit wacht één schermpje - in plaats van dat
	   je een halve radarlus moet uitzitten voordat de andere hoogte langskomt.

	   Geeft terug hoeveel schermen er komen, zodat de radar weet hoe lang hij moet wachten. */
	sequence(seconds) {
		var waiting = this.waiting;
		if (waiting.length === 0 || !document.getElementById(ID_LAYER)) {
			return 0;
		}
		var step = 0;
		var next = () => {
			if (step >= waiting.length) {
				this.hide();
				return;
			}
			this.show(waiting[step]);
			step += 1;
			this.sequenceTimer = setTimeout(next, seconds * 1000);
		};
		clearTimeout(this.sequenceTimer);
		next();
		return waiting.length;
	}

	/* Take the map over for a while. The radar keeps running underneath, so its tiles are still
	   there when it gets its turn back. */
	show(which) {
		var waiting = this.waiting;
		var layer = document.getElementById(ID_LAYER);
		if (waiting.length === 0 || !layer) {
			return false;
		}
		/* zonder aanwijzing de volgende in de rij, zodat een los scherm ook blijft rouleren */
		if (!which) {
			this.turn = (this.turn + 1) % waiting.length;
			which = waiting[this.turn];
		}
		var held = this.all[which.station];
		var chosen = held && held.runs[which.index];
		if (!chosen) {
			return false;
		}
		this.entry = chosen.entry;
		this.planned = chosen.planned;
		this.notation = held.notation;
		layer.hidden = false;
		this.draw();
		return true;
	}

	hide() {
		clearTimeout(this.sequenceTimer);
		var layer = document.getElementById(ID_LAYER);
		if (layer) {
			layer.hidden = true;
		}
		/* de animatie stilzetten zolang er niemand kijkt: dit draait op een Raspberry Pi */
		if (this.jmap && this.jmap.wind) {
			this.jmap.wind.setEnabled(false);
		}
	}

	/* The map of jumprun.nl itself, so the board shows the same picture as the screen the plan was
	   made on. Made once and kept: building a Leaflet map every twenty seconds would refetch every
	   tile. Nothing here is draggable, so the callbacks do nothing. */
	ensureMap() {
		if (this.jmap) {
			return this.jmap;
		}
		var element = document.getElementById(ID_MAP);
		if (!element || typeof L === 'undefined') {
			return null;
		}
		var nothing = () => {};
		this.jmap = createJumprunMap(element, { onTrack: nothing, onGreen: nothing });
		/* Eén bronregel, niet twee. De jumprun komt van jumprun.nl en de luchtfoto noemt zichzelf;
		   als voorvoegsel staat de eerste vooraan en volgt de rest erachter, gescheiden door een
		   streepje. Als losse vermelding ernaast las het als twee keer hetzelfde zeggen. */
		this.jmap.map.attributionControl.setPrefix(LANGUAGE_SOURCE + ' ' + LANGUAGE_JUMPRUN_SOURCE);
		/* linksonder: rechtsonder staat op het bord de laatste-updateregel van de kaart eronder */
		this.jmap.map.attributionControl.setPosition('bottomleft');
		return this.jmap;
	}

	draw() {
		var jmap = this.ensureMap();
		var r = this.planned;
		if (!jmap || !r) {
			return;
		}
		var plan = this.entry.plan;
		var landing = plan.landing || plan.target;
		/* eerst opnieuw meten: de kaart is gemaakt terwijl de laag verborgen was, dus Leaflet denkt
		   dat hij nul bij nul is en past dan op een verkeerd uitsnede */
		jmap.map.invalidateSize();
		/* Het bereik dat op de kaart hoort te staan is dat van nu, niet dat van het moment waarop
		   het plan gemaakt is: wie ernaar kijkt wil weten waar hij vandaag kan komen. De lijn, de
		   exits en het groene licht zijn wél die van het plan, want dat is wat er gevlogen wordt. */
		var current = this.resulting();
		var shown = current || r;
		jmap.setTarget(plan.target, landing, landing, plan.extraTargets || [], true);
		jmap.render(shown);
		jmap.fit(shown);
		/* De driftbanen onder de koepel, van de grond tot de openingshoogte: dat stuk vliegt een
		   springer zelf en daar wil je de wind zien staan. Met hetzelfde profiel als waarmee de lens
		   getekend is, anders wijst het ene het ene op en het andere iets anders. */
		var wind = current ? this.currentWind() : this.entry.wind;
		var profile = this.profileOf(wind);
		if (jmap.wind && profile) {
			jmap.wind.setWind(metres => windVectorAt(profile, metres), 0, plan.openAltFt * 0.3048);
			jmap.wind.setEnabled(true);
		}
		this.caption();
	}

	/* What is under the picture: who put this up and when, what it was worked out with, and only
	   when it matters what the wind has done since. */
	caption() {
		var element = document.getElementById(ID_CAPTION);
		if (!element) {
			return;
		}
		var r = this.planned;
		var entry = this.entry;
		var clock = when => when.toLocaleTimeString(document.config.locale, { hour: '2-digit', minute: '2-digit' });
		var wind = degrees(r.windAtExit.fromDeg) + ' ' + Math.round(r.windAtExit.speedKt) + ' kt';

		/* Waar dit over gaat, en dat is niet vanzelfsprekend: dit bord kan bij Echten hangen en dan
		   staat er een andere jumprun. Boven alles, want het is het eerste wat je wilt weten. */
		/* De naam van de dropzone waar dit plan voor geldt, en dat is niet altijd die van het bord:
		   hier kunnen er twee langskomen. Het eigen veld draagt de naam uit de instelling, de rest
		   die van het station zelf. */
		var own = document.config.location || {};
		var where = (this.stations[0] === entry.station && own.name)
			? own.name
			: entry.station.charAt(0).toUpperCase() + entry.station.slice(1);
		/* De exithoogte hoort bij de naam: er kunnen twee runs van dezelfde dropzone langskomen en
		   dan is dit het enige wat ze uit elkaar houdt. Iets kleiner dan de naam, zodat je eerst het
		   veld leest en dan de hoogte. De koers en de rest staan groot onder de kop, dus een
		   ondertitel die dat herhaalt kan weg; het aantal exits staat genummerd op de lijn zelf. */
		where += ' <span class="jumprun-alt">'
			+ Number(entry.plan.exitAltFt).toLocaleString(document.config.locale) + ' ft</span>';
		/* De datum laten we weg: wat er staat geldt altijd vandaag. En de naam alleen als er meer
		   mensen zijn die een jumprun kunnen ophangen; bij één iemand zegt hij niets en kost hij
		   alleen ruimte in een regel die je in twintig seconden moet lezen. */
		var by = (this.admins > 1 && entry.set_by) ? ' ' + LANGUAGE_JUMPRUN_BY + ' ' + entry.set_by : '';
		var who = LANGUAGE_JUMPRUN_PLACED + by + ' ' + LANGUAGE_JUMPRUN_AT + ' '
			+ clock(new Date(entry.set_at)) + ', ' + LANGUAGE_JUMPRUN_WITH + ' ' + wind;

		var changes = this.drift();
		var reaches = this.stillReaches();
		var drift = '';
		if (changes.length > 0) {
			var words = changes.map(change => {
				var parts = [];
				if (Math.abs(change.turn) >= TURN_DEG) {
					parts.push(Math.abs(change.turn) + '&deg; ' + LANGUAGE_JUMPRUN_TURNED);
				}
				if (Math.abs(change.speed) >= SPEED_KT) {
					parts.push(Math.abs(change.speed) + ' kt ' + (change.speed > 0 ? LANGUAGE_JUMPRUN_STRONGER : LANGUAGE_JUMPRUN_WEAKER));
				}
				return LANGUAGE_JUMPRUN_AT_FT + ' ' + Number(change.where).toLocaleString(document.config.locale)
					+ ' ft ' + parts.join(', ');
			});
			drift = '<span class="jumprun-drift' + (reaches === false ? ' jumprun-drift-alert' : '') + '">'
				+ LANGUAGE_JUMPRUN_SINCE + ' ' + words.join(' &middot; ') + '</span>';
		}
		element.innerHTML = '<span class="jumprun-where">' + where + '</span>'
			+ '<span class="jumprun-who">' + who + '</span>' + drift + this.numbers();
	}

	updateData() {
		this.stations.forEach(station => this.fetchOne(station));
	}

	fetchOne(station) {
		var url = PROXY_URL + '?action=jumprun&station=' + encodeURIComponent(station);
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
			/* hoeveel mensen hier iets kunnen ophangen; ontbreekt het, dan zetten we de naam er
			   liever wel bij dan ten onrechte niet */
			this.admins = (typeof data.admins === 'number') ? data.admins : 2;
			/* jumpruns: één per exithoogte, hoog eerst. Een ouder jumprun.nl stuurt alleen `jumprun`. */
			var runs = Array.isArray(data.jumpruns) ? data.jumpruns : (data.jumprun ? [data.jumprun] : []);
			this.adopt(station, runs, data.notation);
		}).catch(error => {
			/* jumprun.nl out of reach is not a reason to drop a plan that is already on screen */
			this.error = error.message;
			console.warn('Jumprun for ' + station + ' not available: ' + error.message);
		});
	}

	/* Take over the plans of a dropzone and work out the line each of them stands for. */
	adopt(station, entries, notation) {
		var usable = (entries || []).filter(entry => {
			if (entry && entry.version === PLAN_VERSION) {
				return true;
			}
			console.warn('Jumprun plan version ' + (entry && entry.version)
				+ ' needs a newer board (this one reads ' + PLAN_VERSION + ')');
			return false;
		});
		if (usable.length === 0) {
			delete this.all[station];
			return;
		}
		this.all[station] = {
			/* de notatie is die van de dropzone, niet die van wie het plan ophing: het bord hangt op
			   het veld en hoort de taal van dat veld te spreken */
			notation: (notation === 'polar') ? 'polar' : 'offset',
			runs: usable.map(entry => ({
				entry: entry,
				planned: this.compute(entry.plan, this.profileOf(entry.wind)),
			})),
		};
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

	/* Dezelfde sprong, maar met de wind van nu onder de koepel.

	   De koers, het groene licht en de separatie staan vast: dat is wat het vliegtuig vliegt en
	   waar de mensen dus uitstappen. Alleen wat er ná de exit gebeurt hangt van de wind af, en juist
	   dat is waar het bereik uit volgt. Zo staat er op de kaart waar je vandaag kunt komen vanaf de
	   plek die in het plan is afgesproken.

	   Null als er niets noemenswaardigs veranderd is: dan is dit hetzelfde als het plan. */
	resulting() {
		if (this.drift().length === 0) {
			return null;
		}
		var wind = this.currentWind();
		var profile = wind ? this.profileOf(wind) : null;
		if (profile === null) {
			return null;
		}
		return this.compute({
			...this.entry.plan,
			trackDeg: this.planned.trackDeg,
			greenLightNm: this.planned.greenLight.nm,
			separationS: this.planned.separation.seconds,
		}, profile);
	}

	/* De twee dingen waar een springer op het bord naar zoekt: hoe de spot hier uitgesproken wordt,
	   en hoeveel tijd er tussen de exits zit. Groter dan de rest, want dit is wat je onthoudt.
	   De separatie staat er in elke notatie hetzelfde bij; de spot ervoor is per dropzone anders. */
	numbers() {
		var r = this.planned;
		var plan = this.entry.plan;
		var spot = (this.notation === 'polar') ? this.polarCells(r, plan) : this.offsetCells(r, plan);
		var normal = Math.round(r.separation.seconds);
		var extra = (plan.largeGroupExtraS !== undefined) ? plan.largeGroupExtraS : LARGE_GROUP_EXTRA_S;
		return '<span class="jumprun-numbers">' + spot
			+ cell(normal + ' s', LANGUAGE_JUMPRUN_SEPARATION)
			+ (extra > 0 ? cell((normal + extra) + ' s', LANGUAGE_JUMPRUN_LARGE_GROUP) : '')
			+ '</span>';
	}

	/* Hoogeveen en Echten: koers, offset en groen licht. De offset staat niet als getal in het plan
	   maar volgt uit waar het aanvliegpunt ligt ten opzichte van de bak. */
	offsetCells(r, plan) {
		var landing = plan.landing || plan.target;
		var offsetM = distance(landing, plan.target);
		/* zonder NM erachter: onder dit getal staat het woord offset en die wordt nergens anders in
		   uitgedrukt, dus de eenheid voegt alleen ruis toe */
		var offset = (offsetM / NM).toFixed(1);
		if (offsetM > 0.05 * NM) {
			offset += ' ' + CARDINALS[Math.round(bearing(landing, plan.target) / 90) % 4];
		}
		var green = (r.greenLight.nm >= 0 ? '+' : '\u2212') + Math.abs(r.greenLight.nm).toFixed(1) + ' NM';
		return cell(degrees(r.trackMagneticDeg), LANGUAGE_JUMPRUN_TRACK)
			+ cell(offset, LANGUAGE_JUMPRUN_OFFSET)
			+ cell(green, LANGUAGE_JUMPRUN_GREEN);
	}

	/* Texel: waar het groene licht ligt gezien vanaf het midden van het veld, als peiling en afstand,
	   en daarna de richting waarin de lijn gevlogen wordt. Het groene licht in NM ten opzichte van
	   de bak komt er niet bij te staan: dat is hetzelfde punt nog eens, in andere woorden.
	   Magnetisch, want dat is wat er in het vliegtuig op de GPS staat, en met de declinatie die het
	   plan zelf meedraagt, zodat het bord er geen eigen waarde naast zet. */
	polarCells(r, plan) {
		var middle = plan.landing || plan.target;
		var metres = distance(middle, r.greenLight.point);
		var declination = Number(plan.magneticDeclinationDeg) || 0;
		var brg = Math.round((bearing(middle, r.greenLight.point) - declination) / POLAR_STEP_DEG) * POLAR_STEP_DEG;
		var pointing = (metres < POLAR_MIN_M) ? '&mdash;' : degrees(brg);
		return cell(pointing, LANGUAGE_JUMPRUN_BEARING)
			+ cell((metres / NM).toFixed(1) + ' NM', LANGUAGE_JUMPRUN_DISTANCE)
			+ cell(degrees(r.trackMagneticDeg), LANGUAGE_JUMPRUN_TRACK);
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
		var current = this.resulting();
		if (current === null || !current.canopy) {
			return null;
		}
		return current.canopy.allReachTarget === true;
	}
}

/* Eén getal met zijn woord eronder: dit is het blok dat van de andere kant van de ruimte leesbaar
   moet zijn. */
/* Een richting zoals ze hardop gezegd wordt: noord is 360 en niet 0. Op dit bord staan koersen,
   peilingen en windrichtingen door elkaar en ze horen alle drie hetzelfde te lezen. Verschillen
   gaan hier niet doorheen: twintig graden gedraaid is twintig, niet driehonderdtachtig. */
function degrees(value) {
	var whole = ((Math.round(value) % 360) + 360) % 360;
	return (whole === 0 ? 360 : whole) + '&deg;';
}

function cell(value, label) {
	return '<span class="jumprun-cell"><b>' + value + '</b>'
		+ '<span class="jumprun-cell-label">' + label + '</span></span>';
}

function style(name) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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
