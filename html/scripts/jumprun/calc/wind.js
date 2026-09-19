// Wind: vectoren, interpolatie en windprofielen.
//
// Conventie: windrichting is waar de wind VANDAAN komt (meteorologisch),
// in graden t.o.v. het (ware) noorden. De windvector wijst waar de wind
// NAARTOE waait.
//
// Een profiel is een gesorteerde lijst {heightM, speedMs, fromDeg, tempC?}
// met heightM boven de dropzone (AGL).

import { degToRad, radToDeg, normalizeDeg, angleDiffDeg, ktToMs, ftToM } from './units.js';
import { hypsometricHeights } from './atmosphere.js';

/** Windvector {east, north} (m/s) uit snelheid en richting-vandaan. */
export function windToVector(speedMs, fromDeg) {
  const r = degToRad(fromDeg);
  return { east: -speedMs * Math.sin(r), north: -speedMs * Math.cos(r) };
}

/** Snelheid en richting-vandaan uit een windvector. */
export function vectorToWind(vec) {
  const speedMs = Math.hypot(vec.east, vec.north);
  if (speedMs === 0) return { speedMs: 0, fromDeg: 0 };
  return { speedMs, fromDeg: normalizeDeg(radToDeg(Math.atan2(-vec.east, -vec.north))) };
}

/** Interpoleert twee richtingen langs de kortste boog; t ∈ [0, 1]. (Voor weergave; de wind zelf wordt als vector geïnterpoleerd.) */
export function interpolateDirection(fromA, fromB, t) {
  return normalizeDeg(fromA + t * angleDiffDeg(fromA, fromB));
}

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Maakt een bruikbaar profiel: niveaus zonder geldige hoogte, snelheid of
 * richting worden weggelaten (Open-Meteo levert `null` voor niveaus die het
 * model niet kent), de rest wordt op hoogte gesorteerd.
 */
export function normalizeProfile(levels) {
  return levels
    .filter((l) => isNum(l.heightM) && isNum(l.speedMs) && isNum(l.fromDeg))
    .map((l) => ({ ...l, tempC: isNum(l.tempC) ? l.tempC : null }))
    .sort((a, b) => a.heightM - b.heightM);
}

/**
 * Wind op hoogte h: de windVECTOR wordt lineair in hoogte geïnterpoleerd
 * tussen de omliggende niveaus (u en v apart), zoals cloudbase dat ook doet
 * bij het maken van het profiel per 1.000 ft. Daarmee is het profiel tussen
 * de niveaus consistent met de bron. Bij een draaiende wind ligt de
 * snelheid halverwege iets onder het gemiddelde van beide niveaus; met
 * niveaus op 1.000 ft afstand is dat verschil verwaarloosbaar.
 * Buiten het bereik geldt het dichtstbijzijnde niveau.
 */
export function windAt(profile, hM) {
  if (!profile || profile.length === 0) throw new Error('leeg windprofiel');
  if (hM <= profile[0].heightM) return pick(profile[0], hM);
  const top = profile[profile.length - 1];
  if (hM >= top.heightM) return pick(top, hM);

  let i = 1;
  while (profile[i].heightM < hM) i++;
  const lo = profile[i - 1];
  const hi = profile[i];
  const t = (hM - lo.heightM) / (hi.heightM - lo.heightM);
  const a = windToVector(lo.speedMs, lo.fromDeg);
  const b = windToVector(hi.speedMs, hi.fromDeg);
  const { speedMs, fromDeg } = vectorToWind({
    east: a.east + t * (b.east - a.east),
    north: a.north + t * (b.north - a.north),
  });
  const tempC =
    lo.tempC !== null && hi.tempC !== null ? lo.tempC + t * (hi.tempC - lo.tempC) : null;
  return { heightM: hM, speedMs, fromDeg, tempC };
}

function pick(level, hM) {
  return { heightM: hM, speedMs: level.speedMs, fromDeg: level.fromDeg, tempC: level.tempC };
}

/** Windvector {east, north} op hoogte h. */
export function windVectorAt(profile, hM) {
  const w = windAt(profile, hM);
  return windToVector(w.speedMs, w.fromDeg);
}

/**
 * Profiel uit een Open-Meteo `hourly`-antwoord voor uur-index `index`.
 * Hoogtes komen bij voorkeur uit `geopotential_height_<p>hPa` (het model
 * weet zelf waar zijn drukvlakken liggen). Ontbreekt dat, dan wordt de
 * hypsometrische vergelijking gebruikt met `surface` = {pressureHpa,
 * heightM, tempC}. Niveaus die het model niet levert (null) vallen weg.
 *
 * @param opts.levelsHpa  te gebruiken drukniveaus
 * @param opts.elevationM hoogte van de dropzone AMSL; profiel wordt AGL
 * @param opts.windUnit   'kn' (default, zoals de app opvraagt) of 'ms'
 */
export function profileFromOpenMeteo(hourly, index, opts) {
  const { levelsHpa, elevationM = 0, windUnit = 'kn', surface = null } = opts;
  const toMs = windUnit === 'kn' ? ktToMs : (x) => x;
  const at = (key) => (hourly[key] ? hourly[key][index] : null);

  const raw = levelsHpa.map((p) => ({
    pressureHpa: p,
    speedMs: isNum(at(`wind_speed_${p}hPa`)) ? toMs(at(`wind_speed_${p}hPa`)) : null,
    fromDeg: at(`wind_direction_${p}hPa`),
    tempC: at(`temperature_${p}hPa`),
    geopotentialM: at(`geopotential_height_${p}hPa`),
  }));

  const valid = raw.filter((l) => isNum(l.speedMs) && isNum(l.fromDeg) && isNum(l.tempC));
  const allGeo = valid.length > 0 && valid.every((l) => isNum(l.geopotentialM));

  let withHeight;
  if (allGeo) {
    withHeight = valid.map((l) => ({ ...l, heightM: l.geopotentialM }));
  } else {
    if (!surface) throw new Error('geen geopotentiële hoogtes en geen surface opgegeven');
    const hyps = hypsometricHeights(valid, surface);
    withHeight = valid.map((l) => ({
      ...l,
      heightM: hyps.find((h) => h.pressureHpa === l.pressureHpa).heightM,
    }));
  }

  return normalizeProfile(
    withHeight.map((l) => ({
      heightM: l.heightM - elevationM,
      speedMs: l.speedMs,
      fromDeg: l.fromDeg,
      tempC: l.tempC,
      pressureHpa: l.pressureHpa,
    })),
  );
}

/** Hoogte waarop de grondwind gemeten wordt: tien meter, zoals elk weerstation. */
export const GROUND_FT = 33;

/**
 * Profiel uit het cloudbase-endpoint /api/aloft: een object of lijst met
 * per niveau {ft, kt, dir}. Deze hoogtes zijn al AGL/QFE-achtig per 1.000 ft.
 *
 * Het model begint op 500 ft. Daaronder remt de grond de wind af - vanavond op
 * Hoogeveen 13 kt aan de grond tegen 23 kt op 500 ft - en zonder onderste
 * niveau houdt `windAt` die 500-voetswind vast tot aan de grond. Daarom mag de
 * gemeten grondwind (`ground`, op tien meter) er als onderste niveau bij: dan
 * loopt de laatste vijfhonderd voet naar een gemeten getal toe in plaats van
 * naar een doorgetrokken lijn. Dat telt mee in de drift onder de parachute, en
 * dus in de spot.
 */
export function profileFromAloft(levels, ground = null) {
  const alle = isNum(ground && ground.kt) && isNum(ground && ground.dir)
    ? [{ ft: GROUND_FT, kt: ground.kt, dir: ground.dir }, ...levels]
    : levels;
  return normalizeProfile(
    alle.map((l) => ({
      heightM: ftToM(l.ft),
      speedMs: ktToMs(l.kt),
      fromDeg: l.dir,
      tempC: isNum(l.tempC) ? l.tempC : null,
    })),
  );
}
