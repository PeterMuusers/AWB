#!/usr/bin/env node
/*
 * De jumprun uitrekenen zoals jumprun.nl hem zou voorstellen, en hem op het bord zetten.
 *
 * Dit is dezelfde som als op het scherm waar de springleiding zijn jumprun maakt: dezelfde
 * rekenkern (html/scripts/jumprun/calc, overgenomen uit Jumprun), dezelfde instellingen van de
 * dropzone, dezelfde keuze van koers en offset. Wat hier gebeurt is alleen: de wind ophalen, het
 * uur pakken waar je op springt, en de uitkomst desgewenst publiceren.
 *
 * Niets wordt gepubliceerd zonder --post. Zonder die vlag rekent hij en schrijft hij op wat eruit
 * komt, zodat je het eerst kunt nakijken.
 *
 *   rpi/jumprun-auto.mjs                          Hoogeveen, het eerstvolgende hele uur
 *   rpi/jumprun-auto.mjs --station echten         een andere dropzone
 *   rpi/jumprun-auto.mjs --exit 5000              de lage run
 *   rpi/jumprun-auto.mjs --uur 15:00              een ander uur van vandaag
 *   rpi/jumprun-auto.mjs --post                   en zet hem op het bord
 *   rpi/jumprun-auto.mjs --json                   de uitkomst als JSON (voor de bot)
 *
 * Wat je zelf invult wint van het advies; de rest wordt eromheen uitgerekend:
 *
 *   --koers 270        koers in graden magnetisch, zoals de piloot hem invoert
 *   --offset 0.6 --richting Z     de offset; bij de polaire notatie mag richting ook in graden
 *   --groen 0.8        groen licht in NM ten opzichte van de bak (− = ervoor)
 *
 * Publiceren vraagt een token van jumprun.nl; dat wordt aangemaakt op de server met
 * `cloudbase --token <naam>`. De naam van het token komt bij de jumprun op het bord te staan: wie
 * hem ophing hoort zichtbaar te zijn.
 *
 * Dat token staat in /etc/awb/jumprun-token, alleen leesbaar voor root, en niet in .env: dat bestand
 * wordt ook door de webserver gelezen (voor de sleutels van de weerbronnen), en met dit token kan
 * iemand een jumprun op het bord zetten. Staat het er niet, dan wordt .env alsnog gelezen - dan
 * werkt een oudere installatie gewoon door.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { profileFromAloft } from '../html/scripts/jumprun/calc/wind.js';
import { computeAuto, computeAutoOffset } from '../html/scripts/jumprun/calc/auto.js';
import {
	DIR_DEG, declinationOf, notationOf, exitAltOf, tracksTrue, targetOf, planInput,
} from '../html/scripts/jumprun/calc/dropzone.js';
import { destination, distance, bearing } from '../html/scripts/jumprun/calc/geo.js';
import { NM } from '../html/scripts/jumprun/calc/units.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEFAULT_URL = 'https://weer.jumprun.nl';
const TOKEN_FILE = '/etc/awb/jumprun-token';
const TRACK_STEP_DEG = 10;          // zoals de piloot hem invoert; dezelfde standaard als op het scherm
const TIMEOUT_MS = 25000;

/* ---------------------------------------------------------------- instellingen */

/** .env lezen zoals de PHP-kant het doet: KEY=waarde, # is commentaar, aanhalingstekens eraf. */
function readEnv() {
	const env = {};
	let text = '';
	try {
		text = readFileSync(join(ROOT, '.env'), 'utf8');
	} catch {
		return env;
	}
	for (const line of text.split('\n')) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (!match || line.trimStart().startsWith('#')) {
			continue;
		}
		env[match[1]] = match[2].trim().replace(/^["'](.*)["']$/, '$1');
	}
	return env;
}

/** Het token om te publiceren: eerst het bestand dat alleen root kan lezen, anders .env. */
function readToken(env) {
	try {
		const token = readFileSync(TOKEN_FILE, 'utf8').trim();
		if (token) {
			return token;
		}
	} catch {
		/* niet aanwezig of niet leesbaar: dan .env */
	}
	return (env.JUMPRUN_TOKEN || '').trim();
}

function args(argv) {
	const out = { station: 'hoogeveen', post: false, json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--post') out.post = true;
		else if (arg === '--json') out.json = true;
		else if (arg === '--station' || arg === '-s') out.station = String(argv[++i] || '').toLowerCase();
		else if (arg === '--exit') out.exitAltFt = Number(argv[++i]);
		else if (arg === '--uur' || arg === '--hour') out.hour = String(argv[++i] || '');
		else if (arg === '--dag' || arg === '--date') out.date = String(argv[++i] || '');
		else if (arg === '--url') out.url = String(argv[++i] || '');
		else if (arg === '--koers' || arg === '--track') out.trackMagneticDeg = Number(argv[++i]);
		else if (arg === '--offset') out.offsetNm = Number(argv[++i]);
		else if (arg === '--richting' || arg === '--dir') out.offsetDir = String(argv[++i] || '').toUpperCase();
		else if (arg === '--groen' || arg === '--green') out.greenLightNm = Number(argv[++i]);
		else throw new Error(`onbekende optie: ${arg}`);
	}
	return out;
}

/* ---------------------------------------------------------------- ophalen */

async function get(url, path) {
	const response = await fetch(url + path, {
		headers: { Accept: 'application/json', 'User-Agent': 'AviationWeatherBoard' },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`${path}: ${response.status} ${response.statusText}`);
	}
	return response.json();
}

/** Het uur waarop gesprongen wordt: het opgegeven uur, anders het eerstvolgende hele uur. */
function pickHour(hours, wanted) {
	if (!hours.length) {
		throw new Error('geen hoogtewinden beschikbaar');
	}
	if (wanted) {
		const found = hours.find((h) => h.label === wanted || h.label.startsWith(wanted));
		if (!found) {
			throw new Error(`uur ${wanted} zit er niet bij; beschikbaar: ${hours.map((h) => h.label).join(' ')}`);
		}
		return found;
	}
	const now = Date.now();
	const ahead = hours.filter((h) => h.time.getTime() >= now);
	return ahead.length ? ahead[0] : hours[hours.length - 1];
}

/* ---------------------------------------------------------------- opschrijven */

const nl1 = (value) => value.toFixed(1).replace('.', ',');
const pad3 = (deg) => String(Math.round(((deg % 360) + 360) % 360) % 360).padStart(3, '0');
const dirDeg = (d) => (typeof d === 'number' ? d : DIR_DEG[d] ?? 0);
const dirLabel = (d, declination) => (typeof d === 'number' ? `${pad3(d - declination)}°` : { N: 'N', E: 'O', S: 'Z', W: 'W' }[d] || String(d));

/** De spot zoals deze dropzone hem uitspreekt. */
function spot(result, off, dz) {
	const declination = declinationOf(dz);
	if (notationOf(dz) === 'polar') {
		const metres = distance(targetOf(dz), result.greenLight.point);
		const brg = metres < 20 ? null : Math.round((bearing(targetOf(dz), result.greenLight.point) - declination) / 5) * 5;
		return `groen op ${brg === null ? '—' : `${pad3(brg)}°`} · ${nl1(metres / NM)} NM · koers ${pad3(result.trackMagneticDeg)}° magnetisch`;
	}
	const offset = off.nm > 0.05 ? `${nl1(off.nm)} NM ${dirLabel(off.dir, declination)}` : '0,0 NM';
	const green = result.greenLight.nm;
	return `koers ${pad3(result.trackMagneticDeg)}° magnetisch · offset ${offset} · groen ${green >= 0 ? '+' : '−'}${nl1(Math.abs(green))} NM`;
}

/* ---------------------------------------------------------------- de som */

async function main() {
	const options = args(process.argv.slice(2));
	const env = readEnv();
	const url = (options.url || env.JUMPRUN_URL || DEFAULT_URL).replace(/\/$/, '');

	const stations = await get(url, '/api/stations');
	const dz = (stations.dropzones || []).find(
		(d) => d.id === options.station || (d.aliases || []).includes(options.station),
	);
	if (!dz) {
		throw new Error(`onbekende dropzone: ${options.station}`);
	}

	const aloft = await get(url, `/api/aloft?station=${encodeURIComponent(dz.id)}`);
	const latest = await get(url, `/api/latest?station=${encodeURIComponent(dz.id)}`).catch(() => null);
	const observations = (latest && latest.observations) || [];
	const last = observations.length ? observations[observations.length - 1] : null;
	const ground = last ? { kt: last.wind_kt, dir: last.wind_dir, gust: last.gust_kt, time: last.time } : null;

	/* Dezelfde hoogtes als op het scherm: 500 ft plus elke 1.000 ft, van laag naar hoog. */
	const levelsFt = [500, ...Array.from({ length: 15 }, (_, i) => (i + 1) * 1000)];
	const hours = (aloft.hours || []).map((h) => ({
		time: new Date(h.time),
		label: new Date(h.time).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }),
		levels: Object.entries(h.levels)
			.map(([ft, v]) => ({ ft: Number(ft), kt: v.kt, dir: v.dir }))
			.filter((l) => levelsFt.includes(l.ft))
			.sort((a, b) => a.ft - b.ft),
	})).filter((h) => h.levels.length >= 2);
	const hour = pickHour(hours, options.hour);

	const exitAltFt = Number.isFinite(options.exitAltFt) ? options.exitAltFt : exitAltOf(dz);
	const landing = targetOf(dz);
	const base = {
		profile: profileFromAloft(hour.levels),
		elevationM: aloft.elevation_m ?? 0,
		exitAltFt,
		openAltFt: 3500,
	};
	const auto = {
		preferredTracks: tracksTrue(dz),
		trackStep: TRACK_STEP_DEG,
		highExitAltFt: exitAltOf(dz),
		lowRunRule: true,
	};
	/* Een ingevulde koers of groen licht gaat als invoer mee: dan valt er voor de berekening niets
	   meer te kiezen en rekent zij de rest eromheen uit. */
	const byHand = {};
	if (Number.isFinite(options.trackMagneticDeg)) {
		byHand.trackDeg = (((options.trackMagneticDeg + declinationOf(dz)) % 360) + 360) % 360;
	}
	if (Number.isFinite(options.greenLightNm)) {
		byHand.greenLightNm = options.greenLightNm;
	}
	const at = (target) => computeAuto({ ...planInput(dz, { ...base, target }), ...byHand }, auto);

	/* Eerst de run over de bak zelf: die geeft het offsetadvies. Daarna de lijn op de plek waar
	   hij komt te liggen, want daar hangt het groene licht van af. */
	const overTheTarget = at(landing);
	const advised = computeAutoOffset(overTheTarget, { landing, notation: notationOf(dz), compute: at });
	const own = Number.isFinite(options.offsetNm);
	const off = own
		? { nm: options.offsetNm, dir: /^-?\d+$/.test(options.offsetDir || '') ? Number(options.offsetDir) : (options.offsetDir || advised.dir) }
		: advised;
	const result = off.nm > 0 ? at(destination(landing, dirDeg(off.dir), off.nm * NM)) : overTheTarget;

	const payload = {
		station: dz.id,
		plan: result.input,
		wind: {
			at: hour.time.toISOString(),
			model: aloft.model || '',
			elevation_m: aloft.elevation_m ?? 0,
			levels: hour.levels,
			ground,
		},
	};
	if (options.date) {
		payload.date = options.date;
	}

	if (options.json && !options.post) {
		console.log(JSON.stringify({ ...payload, spot: spot(result, off, dz) }, null, 1));
		return;
	}

	const name = dz.name || dz.id;
	console.log(`${name} · exit ${Math.round(exitAltFt).toLocaleString('nl-NL')} ft · wind van ${hour.label}`);
	console.log(`  ${spot(result, off, dz)}`);
	const handmatig = [
		Number.isFinite(options.trackMagneticDeg) ? 'koers' : null,
		own ? 'offset' : null,
		Number.isFinite(options.greenLightNm) ? 'groen licht' : null,
	].filter(Boolean);
	if (handmatig.length) {
		const opsomming = handmatig.length > 1
			? `${handmatig.slice(0, -1).join(', ')} en ${handmatig[handmatig.length - 1]}`
			: handmatig[0];
		console.log(`  ${opsomming} met de hand gezet, de rest eromheen gerekend`);
	}
	console.log(`  ${result.exits.length} exits, ${Math.round(result.separation.seconds)} s ertussen`);
	console.log(`  wind op exit ${Math.round(result.windAtExit.speedKt)} kt uit ${pad3(result.windAtExit.fromDeg)}°`
		+ (ground && ground.kt != null ? `, grond ${Math.round(ground.kt)} kt uit ${pad3(ground.dir)}°` : ''));
	if (!result.canopy.allReachTarget) {
		console.log('  let op: niet elke exit haalt het veld met deze lijn');
	}

	if (!options.post) {
		console.log('  (niet gepubliceerd; met --post komt hij op het bord)');
		return;
	}

	const token = readToken(env);
	if (!token) {
		throw new Error('geen token gevonden in /etc/awb/jumprun-token of .env;'
			+ ' maak er een op de server met `cloudbase --token <naam>`');
	}
	const response = await fetch(`${url}/api/board/jumprun`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
			'User-Agent': 'AviationWeatherBoard',
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const answer = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(`publiceren mislukt: ${response.status} ${answer.error || response.statusText}`);
	}
	console.log(`  op het bord gezet voor ${answer.jumprun ? answer.jumprun.date : 'vandaag'}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
