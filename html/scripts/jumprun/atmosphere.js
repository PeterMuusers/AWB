// Atmosfeer: ISA-standaardatmosfeer, hypsometrische hoogte van drukniveaus,
// dichtheid, TAS uit IAS en de hoogtemeterfout.
//
// Bronnen: ICAO Doc 7488 (Manual of the ICAO Standard Atmosphere);
// hypsometrische vergelijking (Wallace & Hobbs, Atmospheric Science, §3.2).

import { G0 } from './units.js';

export const T0 = 288.15;        // K, ISA-temperatuur op zeeniveau
export const P0 = 101325;        // Pa, ISA-druk op zeeniveau
export const RHO0 = 1.225;       // kg/m³, ISA-dichtheid op zeeniveau
export const LAPSE = 0.0065;     // K/m, temperatuurgradiënt troposfeer
export const R_DRY = 287.05287;  // J/(kg·K), gasconstante droge lucht
const EXP = G0 / (R_DRY * LAPSE); // ≈ 5,2559

/** ISA-temperatuur (K) op geopotentiële hoogte h (m), troposfeer. */
export function isaTemperature(hM) {
  return T0 - LAPSE * hM;
}

/** ISA-druk (Pa) op hoogte h (m). */
export function isaPressure(hM) {
  return P0 * Math.pow(isaTemperature(hM) / T0, EXP);
}

/** ISA-dichtheid (kg/m³) op hoogte h (m). */
export function isaDensity(hM) {
  return RHO0 * Math.pow(isaTemperature(hM) / T0, EXP - 1);
}

/**
 * Dichtheid (kg/m³) op hoogte h met een temperatuurafwijking t.o.v. ISA.
 * De druk volgt ISA; alleen de temperatuur wijkt af (ideale gaswet).
 */
export function density(hM, tempDevC = 0) {
  return isaPressure(hM) / (R_DRY * (isaTemperature(hM) + tempDevC));
}

/** Drukhoogte (m) bij druk p (Pa): de inverse van isaPressure. */
export function pressureAltitude(pPa) {
  return (T0 / LAPSE) * (1 - Math.pow(pPa / P0, 1 / EXP));
}

/**
 * Hoogte van drukniveaus via de hypsometrische vergelijking, laag voor laag
 * vanaf het aardoppervlak:
 *
 *   Δz = (R_d · T̄ / g) · ln(p_onder / p_boven)
 *
 * met T̄ de gemiddelde temperatuur van de laag (K). Vochtigheid (virtuele
 * temperatuur) is verwaarloosd; dat scheelt < 0,5 %.
 *
 * @param levels  [{pressureHpa, tempC}] in willekeurige volgorde
 * @param surface {pressureHpa, heightM, tempC} van het station
 * @returns       [{pressureHpa, tempC, heightM}] gesorteerd op hoogte, AMSL
 */
export function hypsometricHeights(levels, surface) {
  const sorted = [...levels].sort((a, b) => b.pressureHpa - a.pressureHpa);
  const out = [];
  let pPrev = surface.pressureHpa;
  let tPrev = surface.tempC + 273.15;
  let zPrev = surface.heightM;
  // Niveaus onder het oppervlak (p > p_surface) krijgen een negatieve Δz;
  // de formule werkt daar ook, maar we lopen ze in dezelfde volgorde af.
  for (const lvl of sorted) {
    const t = lvl.tempC + 273.15;
    const tMean = (tPrev + t) / 2;
    const dz = ((R_DRY * tMean) / G0) * Math.log(pPrev / lvl.pressureHpa);
    const z = zPrev + dz;
    out.push({ pressureHpa: lvl.pressureHpa, tempC: lvl.tempC, heightM: z });
    pPrev = lvl.pressureHpa;
    tPrev = t;
    zPrev = z;
  }
  return out.sort((a, b) => a.heightM - b.heightM);
}

/**
 * True airspeed uit indicated airspeed: TAS = IAS · √(ρ0 / ρ).
 * Geldig voor lage snelheden (geen compressibiliteit), ruim voldoende < 200 kt.
 */
export function tasFromIas(iasMs, hM, tempDevC = 0) {
  return iasMs * Math.sqrt(RHO0 / density(hM, tempDevC));
}

/**
 * Werkelijke (geometrische) hoogte bij een hoogtemeteraflezing. Een hoogtemeter
 * die op de grond op nul staat meet drukhoogte; bij een warmere atmosfeer dan
 * ISA zit de springer werkelijk hoger:
 *
 *   h_waar ≈ h_ind · T̄_werkelijk / T̄_ISA
 *
 * met T̄ de gemiddelde temperatuur van de kolom tussen grond en h_ind.
 * (De bekende vuistregel "4 ft per 1000 ft per °C".)
 */
export function geometricFromIndicated(hIndM, tempDevC) {
  const tMeanIsa = T0 - (LAPSE * hIndM) / 2;
  return hIndM * ((tMeanIsa + tempDevC) / tMeanIsa);
}
