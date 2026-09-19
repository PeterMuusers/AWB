// Parachute: bereikbaar gebied vanaf het openingspunt.
//
// Onder een parachute met constante luchtsnelheid V en daalsnelheid D is de
// vliegtijd van de opening tot de circuithoogte T = (h_open − h_circuit) / D.
// Het bereikbare gebied is een cirkel met straal V·T rond het punt waar de
// springer zou uitkomen als hij alleen met de wind mee zou drijven.
//
// Twee hoogtes doen dus verschillend mee, en dat is met opzet:
//
//  - het BEREIK houdt op circuithoogte op. De laatste ~1.000 ft zijn voor het
//    landingscircuit en leveren geen extra afstand op: die heb je nodig om
//    downwind, base en final te vliegen.
//  - de DRIFT loopt door tot de grond. Tijdens dat circuit waait het gewoon
//    door, en dat is precies waarom je op circuithoogte bovenwinds moet zitten:
//    anders waait je circuit van het veld af. De kant waarop het circuit
//    gevlogen wordt doet er niet toe - in het luchtstelsel kan een canopy alle
//    kanten op met dezelfde snelheid, dus de vorm van het circuit verandert
//    niets aan wat bereikbaar is. Wat je niet kunt vermijden is de wind.
//
// Draaien kost in dit model niets; dat maakt de cirkel een kleine
// overschatting aan de randen.

import { windVectorAt } from './wind.js';
import { add, scale, vectorLength } from './geo.js';

/** Winddrift {east, north} (m) tijdens de daling van openAltM naar patternAltM. */
export function canopyDrift(profile, openAltM, descentRateMs, dt = 1, patternAltM = 0) {
  let h = openAltM;
  let drift = { east: 0, north: 0 };
  while (h > patternAltM) {
    const step = Math.min(dt, (h - patternAltM) / descentRateMs);
    // middelpuntsregel: wind halverwege de stap
    const w = windVectorAt(profile, h - (descentRateMs * step) / 2);
    drift = add(drift, scale(w, step));
    h -= descentRateMs * step;
  }
  return drift;
}

/** Straal (m) van het bereik: luchtsnelheid × vliegtijd tot circuithoogte. */
export function canopyRadius(openAltM, descentRateMs, airspeedMs, patternAltM = 0) {
  return (airspeedMs * Math.max(0, openAltM - patternAltM)) / descentRateMs;
}

/**
 * Bereikcirkel voor een springer die op `openingPoint` ({east, north} m
 * t.o.v. het doel) opent. De drift loopt tot `driftToM` (standaard de grond),
 * het bereik tot `patternAltM`.
 */
export function reachCircle(openingPoint, profile, { openAltM, descentRateMs, airspeedMs, patternAltM = 0, driftToM = 0 }) {
  return {
    center: add(openingPoint, canopyDrift(profile, openAltM, descentRateMs, 1, driftToM)),
    radiusM: canopyRadius(openAltM, descentRateMs, airspeedMs, patternAltM),
  };
}

/** Ligt `point` binnen de cirkel? Standaard het doel (de oorsprong). */
export function canReach(circle, point = { east: 0, north: 0 }) {
  return vectorLength(add(circle.center, scale(point, -1))) <= circle.radiusM;
}
