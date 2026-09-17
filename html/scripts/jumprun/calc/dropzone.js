/**
 * Wat een dropzone van zichzelf vindt.
 *
 * De velden uit dropzones.json (baanrichtingen, declinatie, exithoogtes, de kant waar de lijn heen
 * mag, de extra velden) zijn geen rekenwerk, maar wel beslissingen: ze bepalen mee welke jumprun
 * eruit komt. Ze stonden in het scherm, waar ze door elkaar liepen met de persoonlijke voorkeuren
 * van wie er achter zat. Hier staan ze los, zodat het scherm ze kan overrulen met zo'n voorkeur en
 * alles zonder scherm - de bot die een jumprun publiceert - ze gewoon volgt.
 *
 * Een dropzone is hier het record uit /api/stations; null of undefined mag ook, dan komt overal de
 * algemene standaard uit.
 */

import { DEFAULTS } from './jumprun.js';

/** Windstreken als ware peiling, met de Nederlandse O en Z erbij. */
export const DIR_DEG = Object.freeze({ N: 0, E: 90, S: 180, W: 270, O: 90, Z: 180 });

/** Exithoogte van de lage run als de dropzone er geen noemt. */
export const LOW_EXIT_ALT_FT = 5000;

/** Magnetische declinatie; zonder dropzone de 2,5° van Nederland. */
export const declinationOf = (dz) => (dz ? Number(dz.declination) || 0 : 2.5);

/** Hoe deze dropzone een spot uitspreekt: 'offset' (koers · offset · groen) of 'polar' (Texel). */
export const notationOf = (dz) => (dz && dz.notation) || 'offset';

/** Canopysnelheid (m/s) waarmee gerekend wordt of iedereen het veld haalt. */
export const canopyMsOf = (dz) =>
	(dz && Number.isFinite(dz.canopy_ms) ? dz.canopy_ms : DEFAULTS.canopyAirspeedMs);

/** Exithoogte van de hoge run. */
export const exitAltOf = (dz) =>
	(dz && Number.isFinite(dz.exit_alt_ft) ? dz.exit_alt_ft : DEFAULTS.exitAltFt);

/** Exithoogte van de lage run; geeft niets terug als die niet lager is dan de hoge. */
export function lowExitAltOf(dz) {
	const low = dz && Number.isFinite(dz.exit_alt_low_ft) ? dz.exit_alt_low_ft : LOW_EXIT_ALT_FT;
	return low < exitAltOf(dz) ? low : null;
}

/** Vaste jumprun-TAS van het vliegtuig van deze dropzone, of null (dan rekent de kern hem uit IAS). */
export const tasOf = (dz) => (dz && Number.isFinite(dz.tas_kt) ? Number(dz.tas_kt) : null);

/** De baanrichtingen als ware koersen; in dropzones.json staan ze magnetisch, zoals ze heten. */
export function tracksTrue(dz) {
	const declination = declinationOf(dz);
	const tracks = dz && Array.isArray(dz.tracks) ? dz.tracks : [];
	return tracks
		.map((m) => (((Number(m) + declination) % 360) + 360) % 360)
		.filter(Number.isFinite);
}

/** De kant waar de jumprun zo ver mogelijk heen mag (om bijvoorbeeld zwevers vrij te houden), of null. */
export function preferSideOf(dz) {
	const value = dz && dz.prefer_side;
	if (value === null || value === undefined || value === '') {
		return null;
	}
	const deg = typeof value === 'number' ? value : DIR_DEG[String(value).toUpperCase()];
	return Number.isFinite(deg) ? deg : null;
}

/** De marge die bij die verschuiving minstens overblijft. */
export function preferMinMarginOf(dz) {
	const value = dz && Number(dz.prefer_min_margin_m);
	return Number.isFinite(value) && value > 0 ? value : DEFAULTS.preferMinMarginM;
}

/** Het landingsdoel: de bak als die apart staat opgegeven, anders het referentiepunt van het veld. */
export function targetOf(dz) {
	if (!dz) {
		return null;
	}
	if (Number.isFinite(dz.target_lat) && Number.isFinite(dz.target_lon)) {
		return { lat: dz.target_lat, lng: dz.target_lon };
	}
	return Number.isFinite(dz.lat) ? { lat: dz.lat, lng: dz.lon } : null;
}

/** De overige velden die élke exit ook moet kunnen halen (Texel: B-veld en leerlingveld). */
export function extraTargetsOf(dz) {
	if (!dz || !Array.isArray(dz.targets)) {
		return [];
	}
	return dz.targets
		.filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lon))
		.map((t) => ({ lat: t.lat, lng: t.lon, name: t.name || '' }));
}

/**
 * De invoer voor de berekening, zoals deze dropzone hem zou geven.
 *
 * @param dz               het record uit /api/stations
 * @param o.profile        het windprofiel (uit profileFromAloft)
 * @param o.elevationM     veldhoogte in meters
 * @param o.exitAltFt      exithoogte; weggelaten = de hoge run van deze dropzone
 * @param o.openAltFt      openingshoogte; weggelaten = de standaard, maar nooit boven exit - 500
 * @param o.exits          aantal exits; weggelaten = de standaard
 * @param o.target         ankerpunt van de lijn (bij een offset het verschoven punt); weggelaten = de bak
 * @param o.funnel         trechter-jumprun
 * @returns de invoer voor computeJumprun/computeAuto, zonder koers: die komt uit de berekening
 */
export function planInput(dz, o = {}) {
	const landing = targetOf(dz);
	const exitAltFt = Number.isFinite(o.exitAltFt) ? o.exitAltFt : exitAltOf(dz);
	const openAltFt = Math.min(
		Number.isFinite(o.openAltFt) ? o.openAltFt : DEFAULTS.openAltFt,
		exitAltFt - 500,
	);
	return {
		target: o.target || landing,
		profile: o.profile,
		elevationM: Number.isFinite(o.elevationM) ? o.elevationM : 0,
		exitAltFt,
		openAltFt,
		exits: Number.isFinite(o.exits) ? o.exits : DEFAULTS.exits,
		magneticDeclinationDeg: declinationOf(dz),
		landing,
		canopyAirspeedMs: canopyMsOf(dz),
		extraTargets: extraTargetsOf(dz),
		tasKt: tasOf(dz),
		greenLightMode: 'margin',
		preferSideDeg: preferSideOf(dz),
		preferMinMarginM: preferMinMarginOf(dz),
		funnel: o.funnel === true,
	};
}
