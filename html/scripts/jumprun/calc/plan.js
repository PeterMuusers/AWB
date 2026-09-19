/**
 * Van dropzone en voorkeuren naar een jumprun.
 *
 * `jumprun.js` rekent één jumprun uit en `auto.js` kiest de koers en de offset. Wat daartussen zat -
 * welke exithoogtes een dropzone aanhoudt, wanneer de lage run de hoge overneemt, welke velden
 * meetellen, wat een persoonlijke voorkeur overschrijft en welke uitkomst uiteindelijk op het scherm
 * hoort - stond in het tabblad zelf, tussen het tekenwerk. Daarmee waren die regels alleen daar
 * beschikbaar, terwijl ze net zo goed bij de berekening horen als de formules eronder.
 *
 * Hier staan ze los van elk scherm. Alles komt als argument binnen: geen state, geen localStorage,
 * geen DOM. Wat erin gaat is te schrijven als JSON, zodat een tweede implementatie dezelfde invoer
 * kan krijgen en dezelfde uitkomst moet geven.
 */

import { computeAuto, computeAutoOffset } from './auto.js';
import { destination, bearing, distance } from './geo.js';
import { profileFromAloft } from './wind.js';
import { NM } from './units.js';
import {
	DIR_DEG, LOW_EXIT_ALT_FT, canopyMsOf, declinationOf, exitAltOf, extraTargetsOf,
	notationOf, planInput, tracksTrue,
} from './dropzone.js';

/** De lage run neemt koers, offset en groen licht van de hoge over zolang élke exit élk veld haalt
 *  met minstens deze marge, het vertraagde scenario meegerekend. Eén set getallen voor de hele dag
 *  is voor iedereen eenvoudiger dan twee die een paar graden schelen. */
export const SAME_RUN_MIN_MARGIN_M = 200;

/** Afronding van de automatische koers in graden magnetisch, als niemand iets anders koos. */
export const TRACK_STEP_DEFAULT = 10;

/** Afronding van de peiling in de polaire notatie; Texel zegt hem per 10°. */
export const BRG_STEP_DEFAULT = 10;

/** Sleutel van de bak in de lijst uitgezette velden: een naam die geen veld kan hebben. */
export const BAK = '__bak__';

const normalise = (deg) => (((deg % 360) + 360) % 360);

/** Ware peiling van een offsetrichting: een windstreek of al graden. */
export const dirDeg = (d) => (typeof d === 'number' ? d : DIR_DEG[d] ?? 0);

/** De windstreek die het dichtst bij deze peiling ligt. */
export const nearestCardinal = (deg) => ['N', 'E', 'S', 'W'][Math.round(normalise(deg) / 90) % 4];

/**
 * Wat er geldt voor deze dropzone en deze gebruiker samen.
 *
 * De dropzone levert de standaard (`cloudbase/dropzones.json` via /api/stations), de persoonlijke
 * voorkeuren winnen daarvan. Voorkeuren die niet gezet zijn ontbreken; ze staan er nooit als een
 * kopie van de standaard in, anders zou een wijziging aan de dropzone niet meer doorkomen.
 *
 * @param dz     het record uit /api/stations, of null
 * @param prefs  {tracks?, notation?, trackStep?, brgStep?, funnel?, canopyMs?, exitAltFt?}
 */
export function settingsFor(dz, prefs = {}) {
	const declination = declinationOf(dz);
	const ownTracks = Array.isArray(prefs.tracks);
	const notation = prefs.notation || notationOf(dz);
	return {
		declination,
		notation,
		/** 'cardinal' = N/O/Z/W per 0,1 NM, 'free' = elke richting in hele graden (polaire notatie). */
		offsetMode: notation === 'polar' ? 'free' : 'cardinal',
		/** Voorkeurskoersen in ware graden; leeg betekent: tegen de wind in. */
		tracks: ownTracks
			? prefs.tracks.map((m) => normalise(Number(m) + declination)).filter(Number.isFinite)
			: tracksTrue(dz),
		ownTracks,
		trackStep: Number.isFinite(prefs.trackStep) ? prefs.trackStep : TRACK_STEP_DEFAULT,
		brgStep: Number.isFinite(prefs.brgStep) ? prefs.brgStep : BRG_STEP_DEFAULT,
		funnel: prefs.funnel === true,
		canopyMs: Number.isFinite(prefs.canopyMs) ? prefs.canopyMs : canopyMsOf(dz),
		/** Exithoogte van de hoge run. */
		exitAltFt: Number.isFinite(prefs.exitAltFt) ? prefs.exitAltFt : exitAltOf(dz),
	};
}

/**
 * De hoogtes waarvoor een volautomatische run wordt gemaakt: de hoge run van deze dropzone en, als
 * die lager ligt, de lage. De lage hoogte komt van de dropzone zelf en niet uit de voorkeuren: wie
 * zijn hoge run verzet, verzet daarmee niet de lage run van het veld.
 */
export function runAltitudes(dz, settings) {
	const high = settings.exitAltFt;
	const low = Number.isFinite(dz && dz.exit_alt_low_ft) ? dz.exit_alt_low_ft : LOW_EXIT_ALT_FT;
	const runs = [{ label: 'Hoog', alt: high }];
	if (low < high) {
		runs.push({ label: 'Laag', alt: low });
	}
	return runs;
}

/**
 * Welke landingsvelden meetellen.
 *
 * Een dropzone kan meer velden hebben dan de bak (Texel heeft er drie). Die zijn per stuk uit te
 * zetten, en de bak zelf ook - dan schuift het eerste aangevinkte veld op naar de rol van
 * landingsdoel, want ergens moet tegen gerekend worden.
 *
 * @param dz          het record uit /api/stations
 * @param bak         {lat, lng} het referentiepunt van het veld
 * @param targetsOff  namen van uitgezette velden, plus BAK voor de bak zelf
 */
export function fieldsFor(dz, bak, targetsOff = []) {
	const off = new Set(targetsOff);
	const all = extraTargetsOf(dz).map((t) => ({ ...t, enabled: !off.has(t.name) }));
	const bakEnabled = !off.has(BAK);
	let landing = { lat: bak && bak.lat, lng: bak && bak.lng, name: null };
	if (!bakEnabled && bak) {
		const first = all.find((t) => t.enabled);
		if (first) {
			landing = { lat: first.lat, lng: first.lng, name: first.name };
		}
	}
	const extra = all
		.filter((t) => t.enabled && !(landing.name && t.name === landing.name))
		.map(({ lat, lng, name }) => ({ lat, lng, name }));
	return { all, bakEnabled, landing, extra };
}

/**
 * Eén berekening voor een gegeven ankerpunt van de lijn.
 *
 * @param o.dz          het record uit /api/stations
 * @param o.settings    uit settingsFor()
 * @param o.fields      uit fieldsFor()
 * @param o.levels      [{ft, kt, dir}] van het gekozen uur, met eventuele handmatige wind erin
 * @param o.target      ankerpunt van de lijn (de bak plus de offset)
 * @param o.over        velden die de invoer overschrijven (een auto-run zet hier zijn eigen hoogte
 *                      en wist koers, separatie en groen licht)
 * @param o.lowRunRule  mag een lage run de koers van de hoge volgen
 */
export function computeRun(o) {
	const { dz, settings, fields, levels, target, over = {}, lowRunRule = true } = o;
	const input = {
		...planInput(dz, {
			profile: profileFromAloft(levels),
			elevationM: o.elevationM,
			exitAltFt: o.exitAltFt,
			openAltFt: o.openAltFt,
			exits: o.exits,
			target,
			funnel: settings.funnel,
		}),
		groupSizes: o.groupSizes || [],
		trackDeg: o.trackDeg ?? undefined,
		separationS: o.separationS ?? undefined,
		greenLightNm: o.greenLightNm ?? undefined,
		// bereik en marge worden altijd tegen de bak gerekend (of tegen het veld dat die rol overnam)
		landing: { lat: fields.landing.lat, lng: fields.landing.lng },
		landingName: fields.landing.name,
		canopyAirspeedMs: settings.canopyMs,
		extraTargets: fields.extra,
	};
	Object.assign(input, over);
	return computeAuto(input, {
		preferredTracks: settings.tracks,
		trackStep: settings.trackStep,
		funnel: settings.funnel,
		highExitAltFt: settings.exitAltFt,
		lowRunRule,
	});
}

/** Het offsetadvies in het raster van deze notatie; zie computeAutoOffset in auto.js. */
export function adviceOffset(result, settings, bak, compute) {
	return computeAutoOffset(result, { landing: bak, notation: settings.notation, compute });
}

/**
 * De volautomatische run voor één exithoogte: koers, offset, groen licht en separatie allemaal auto.
 *
 * Met `higher` (de al berekende hoge run) wordt eerst geprobeerd of dezelfde koers, offset en
 * hetzelfde groene licht ook op deze hoogte voor iedereen uitkomen. Lukt dat met de marge uit
 * SAME_RUN_MIN_MARGIN_M, dan houdt de dag één set getallen.
 */
export function adviseRun(o) {
	const { dz, settings, fields, levels, bak, alt, higher = null } = o;
	const openAltFt = Math.min(o.openAltFt, alt - 500);
	const base = { dz, settings, fields, levels, elevationM: o.elevationM, exits: o.exits, groupSizes: o.groupSizes };

	if (higher && alt < higher.alt) {
		const same = {
			exitAltFt: alt,
			openAltFt,
			trackDeg: higher.r.trackDeg,
			greenLightNm: higher.r.greenLight.nm,
			separationS: undefined,
		};
		const anchor = higher.offsetNm > 0
			? destination(bak, dirDeg(higher.offsetDir), higher.offsetNm * NM)
			: bak;
		const r = computeRun({ ...base, target: anchor, exitAltFt: alt, openAltFt, over: same, lowRunRule: false });
		if (r.canopy.allReachTarget && r.greenLight.marginM >= SAME_RUN_MIN_MARGIN_M) {
			return { r, offsetNm: higher.offsetNm, offsetDir: higher.offsetDir, same: true };
		}
	}

	const over = { exitAltFt: alt, openAltFt, trackDeg: undefined, separationS: undefined, greenLightNm: undefined };
	const run = (target) => computeRun({ ...base, target, exitAltFt: alt, openAltFt, over });
	const r0 = run(bak);
	const off = adviceOffset(r0, settings, bak, run);
	const r = off.nm > 0 ? run(destination(bak, dirDeg(off.dir), off.nm * NM)) : r0;
	return { r, offsetNm: off.nm, offsetDir: off.dir };
}

/**
 * De hele jumprun van dit scherm: de automatische runs plus de uitkomst die getoond wordt.
 *
 * Staat alles op automatisch en kijk je naar een hoogte waarvoor al een auto-run is uitgerekend,
 * dan is de getoonde uitkomst exact die run - anders zou de regel bovenin een ander getal geven dan
 * de lijn op de kaart. In alle andere gevallen wordt er apart gerekend met wat er handmatig staat.
 *
 * @param o.dz, o.prefs, o.bak, o.levels, o.elevationM
 * @param o.exitAltFt, o.openAltFt, o.exits, o.groupSizes
 * @param o.targetsOff    namen van uitgezette velden
 * @param o.trackDeg      handmatige koers, of null
 * @param o.separationS   handmatige separatie, of null
 * @param o.greenLightNm  handmatig groen licht, of null
 * @param o.offset        {nm, dir} handmatige offset, of null = het advies volgen
 * @returns {settings, fields, runs, result, offset, offsetSuggested, snapped, auto}
 */
export function computePlan(o) {
	const settings = settingsFor(o.dz, o.prefs || {});
	const fields = fieldsFor(o.dz, o.bak, o.targetsOff || []);
	const base = {
		dz: o.dz, settings, fields, levels: o.levels, elevationM: o.elevationM,
		exits: o.exits, groupSizes: o.groupSizes, openAltFt: o.openAltFt, bak: o.bak,
	};

	const auto = o.trackDeg === null && o.greenLightNm === null && o.separationS === null && !o.offset;
	const runs = [];
	for (const run of runAltitudes(o.dz, settings)) {
		runs.push({ ...run, ...adviseRun({ ...base, alt: run.alt, higher: runs[0] || null }) });
	}

	const onRun = auto ? runs.find((x) => x.alt === o.exitAltFt) : null;
	if (onRun) {
		return {
			settings, fields, runs, result: onRun.r,
			offset: { nm: onRun.offsetNm, dir: onRun.offsetDir },
			offsetSuggested: { nm: onRun.offsetNm, dir: onRun.offsetDir },
			snapped: !settings.funnel && settings.tracks.length > 0,
			auto,
		};
	}

	/* Een handmatige offset in graden hoort niet thuis in een notatie die alleen windstreken kent;
	   dat gebeurt als iemand van notatie wisselt terwijl er een vrije offset staat. */
	let offset = o.offset;
	if (offset && settings.offsetMode === 'cardinal' && typeof offset.dir === 'number') {
		offset = { ...offset, dir: nearestCardinal(offset.dir) };
	}

	const manual = {
		...base,
		exitAltFt: o.exitAltFt,
		trackDeg: o.trackDeg, separationS: o.separationS, greenLightNm: o.greenLightNm,
	};
	const run = (target) => computeRun({ ...manual, target });
	const r0 = run(o.bak);
	const offsetSuggested = adviceOffset(r0, settings, o.bak, run);
	const used = offset || offsetSuggested;
	const result = used.nm > 0 ? run(destination(o.bak, dirDeg(used.dir), used.nm * NM)) : r0;
	return {
		settings, fields, runs, result,
		offset: used,
		offsetSuggested,
		snapped: o.trackDeg === null && settings.tracks.length > 0,
		auto,
	};
}

/**
 * De offset van een bewaard plan. De lijn loopt over `target` en de bak is `landing`; de offset zelf
 * wordt niet apart bewaard maar is uit die twee punten terug te rekenen.
 */
export function offsetOfPlan(plan, offsetMode = 'cardinal') {
	if (!plan || !plan.landing || !plan.target) {
		return { nm: 0, dir: 'N' };
	}
	const m = distance(plan.landing, plan.target);
	if (m < 1) {
		return { nm: 0, dir: 'N' };
	}
	const b = bearing(plan.landing, plan.target);
	return {
		nm: Math.round((m / NM) * 10) / 10,
		dir: offsetMode === 'free' ? Math.round(b) : nearestCardinal(b),
	};
}
