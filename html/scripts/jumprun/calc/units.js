// Eenheden en constanten. Intern rekent de module in SI: meter, seconde, m/s.
// Voet, knopen en zeemijl komen alleen voor aan de randen (invoer/uitvoer).

export const FT = 0.3048;          // meter per voet (exact)
export const NM = 1852;            // meter per zeemijl (exact)
export const KT = NM / 3600;       // m/s per knoop (0,5144…)
export const G0 = 9.80665;         // standaard valversnelling (m/s²)

export const ftToM = (ft) => ft * FT;
export const mToFt = (m) => m / FT;
export const ktToMs = (kt) => kt * KT;
export const msToKt = (ms) => ms / KT;
export const nmToM = (nm) => nm * NM;
export const mToNm = (m) => m / NM;
export const degToRad = (deg) => (deg * Math.PI) / 180;
export const radToDeg = (rad) => (rad * 180) / Math.PI;

/** Normaliseert een koers naar het bereik [0, 360). */
export function normalizeDeg(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Kleinste verschil tussen twee koersen, in (-180, 180]. */
export function angleDiffDeg(from, to) {
  let d = normalizeDeg(to) - normalizeDeg(from);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
