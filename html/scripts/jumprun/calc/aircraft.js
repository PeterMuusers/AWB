// Vliegtuig: winddriehoek en exit-separatie.

import { radToDeg, normalizeDeg } from './units.js';
import { unitVector, add, scale, alongCross, vectorLength } from './geo.js';

/**
 * Winddriehoek. De piloot vliegt een grondkoers (`trackDeg`, de jumprun-lijn
 * op de kaart) en verdraait de neus tegen de wind in (crab). Gegeven TAS en
 * windvector volgt de grondsnelheid en de neusrichting:
 *
 *   w_c = dwarswindcomponent (positief van links naar rechts over de track)
 *   w_t = wind mee langs de track (positief = staartwind)
 *   GS  = √(TAS² − w_c²) + w_t
 *   WCA = −asin(w_c / TAS)          (heading = track + WCA; positief = neus
 *                                    rechts van de track, dus tegen wind van rechts in)
 *
 * Als |w_c| > TAS is de track niet te houden; `feasible` is dan false.
 */
export function windTriangle(tasMs, trackDeg, windVec) {
  const { along: wt, cross: wc } = alongCross(windVec, trackDeg);
  if (Math.abs(wc) > tasMs) {
    return { feasible: false, tasMs, trackDeg, groundSpeedMs: NaN, headingDeg: NaN, wcaDeg: NaN };
  }
  const wcaDeg = -radToDeg(Math.asin(wc / tasMs));
  const headingDeg = normalizeDeg(trackDeg + wcaDeg);
  const groundSpeedMs = Math.sqrt(tasMs * tasMs - wc * wc) + wt;
  const airVelocity = scale(unitVector(headingDeg), tasMs); // t.o.v. de lucht
  const groundVelocity = add(airVelocity, windVec);           // t.o.v. de grond
  return { feasible: true, tasMs, trackDeg, groundSpeedMs, headingDeg, wcaDeg, airVelocity, groundVelocity };
}

/**
 * Afstand tussen twee opeenvolgende exits na `seconds` seconden:
 *  - `groundM`: over de grond (GS · t), de gangbare vuistregel;
 *  - `airM`: t.o.v. de lucht op openingshoogte (|V_grond − W_opening| · t).
 *    Dat is de afstand die er onder de parachute werkelijk toe doet, omdat
 *    beide springers hetzelfde windprofiel doorlopen en hun onderlinge
 *    verplaatsing gelijk blijft aan die bij de exit, gemeten in het
 *    luchtstelsel waarin ze straks vliegen (Kallend).
 */
export function exitSeparation(groundVelocity, windAtOpeningVec, seconds) {
  const rel = add(groundVelocity, scale(windAtOpeningVec, -1));
  return {
    groundM: vectorLength(groundVelocity) * seconds,
    airM: vectorLength(rel) * seconds,
  };
}

/**
 * Snelheid waarmee opeenvolgende groepen uit elkaar lopen, in m/s.
 *  - 'ground': grondsnelheid van het vliegtuig (de gangbare vuistregel);
 *  - 'air':    t.o.v. de lucht op openingshoogte, |V_grond − W_opening| (Kallend, Geens);
 *  - 'safe':   de kleinste van de twee. Kallend: de grondsnelheidsmethode werkt
 *              "tenzij de onderwind tegengesteld is aan de bovenwind"; dan is de
 *              relatieve snelheid kleiner en is extra tijd nodig. Met 'safe' geldt
 *              altijd het ongunstigste geval.
 */
export function separationSpeed(groundVelocity, windAtOpeningVec, mode = 'safe') {
  const ground = vectorLength(groundVelocity);
  const air = vectorLength(add(groundVelocity, scale(windAtOpeningVec, -1)));
  return mode === 'air' ? air : mode === 'ground' ? ground : Math.min(ground, air);
}

/**
 * Benodigde seconden tussen exits voor een gewenste afstand. `rounding`:
 * 'nearest' (zoals de separatietabel van Hoogeveen), 'ceil' (altijd naar boven).
 */
export function separationSeconds(targetM, groundVelocity, windAtOpeningVec, mode = 'safe', rounding = 'nearest') {
  const v = separationSpeed(groundVelocity, windAtOpeningVec, mode);
  if (v <= 0) return Infinity;
  const t = targetM / v;
  return rounding === 'ceil' ? Math.ceil(t) : Math.floor(t + 0.5);
}

// ---- groepsgrootte ----
// Geometrie van Kallend (2000) en Geens (APF Instructor A thesis "Exit Separation"):
// twee openende parachutes moeten minstens REACTION_S × 2 × CANOPY_MS uit elkaar liggen
// (3 s herkennen en reageren, beide met 13 m/s op elkaar af: 78 m). Een groep van n
// springers die gelijkmatig wegtrackt, heeft daarvoor een trackafstand
// D(n) = 39 / cos(90° − 180°/n) nodig; bij de opening beslaat de groep een cirkel met
// straal D(n) + 39 m. Twee opeenvolgende groepen moeten dus minstens
// D(n1) + D(n2) + 78 m uit elkaar liggen. Getallen uit Geens' tabel: D(2)=39, D(4)=55,
// D(8)=102, D(10)=126 m. Kallend komt in voet op hetzelfde uit (150 ft i.p.v. 78 m).
export const CANOPY_REACTION_S = 3;
export const CANOPY_SPEED_MS = 13;
const HALF_GAP_M = CANOPY_REACTION_S * CANOPY_SPEED_MS; // 39 m

/** Trackafstand (m) die elke springer in een groep van n nodig heeft. */
export function trackingDistanceM(n) {
  if (!(n > 1)) return 0;
  return HALF_GAP_M / Math.cos(Math.PI / 2 - Math.PI / n);
}

/** Straal (m) van de ruimte die een groep van n bij de opening inneemt. */
export function groupRadiusM(n) {
  return trackingDistanceM(n) + HALF_GAP_M;
}

/**
 * Minimale afstand (m) tussen de exits van twee opeenvolgende groepen: de som van
 * hun stralen, met een ondergrens `minM` (standaard 300 m ≈ 1.000 ft, de gangbare
 * minimumnorm: AXIS/Skydive Arizona, Spaceland, USPA).
 */
export function requiredSeparationM(n1, n2, minM = 300) {
  return Math.max(minM, groupRadiusM(n1) + groupRadiusM(n2));
}

