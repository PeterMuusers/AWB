// Parachute: bereikbaar gebied vanaf het openingspunt.
//
// Onder een parachute met constante luchtsnelheid V en daalsnelheid D is de
// vliegtijd van de opening tot de circuithoogte T = (h_open − h_circuit) / D.
// Het bereikbare gebied is een cirkel met straal V·T rond het punt waar de
// springer zou uitkomen als hij in die tijd alleen met de wind mee zou
// drijven (∫ wind(h) dt). De laatste ~1.000 ft zijn voor het landingscircuit
// en tellen niet mee als "terugvliegen": de springer moet op circuithoogte
// al bij het doel zijn. Draaien kost in dit model niets; dat maakt de cirkel
// een kleine overschatting aan de randen.

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
 * t.o.v. het doel) opent.
 */
export function reachCircle(openingPoint, profile, { openAltM, descentRateMs, airspeedMs, patternAltM = 0 }) {
  return {
    center: add(openingPoint, canopyDrift(profile, openAltM, descentRateMs, 1, patternAltM)),
    radiusM: canopyRadius(openAltM, descentRateMs, airspeedMs, patternAltM),
  };
}

/** Ligt `point` binnen de cirkel? Standaard het doel (de oorsprong). */
export function canReach(circle, point = { east: 0, north: 0 }) {
  return vectorLength(add(circle.center, scale(point, -1))) <= circle.radiusM;
}
