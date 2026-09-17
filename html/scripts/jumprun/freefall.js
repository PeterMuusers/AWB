// Vrije val met kwadratische luchtweerstand.
//
// Model: de springer ondervindt zwaartekracht en een weerstandskracht
// evenredig met het kwadraat van zijn snelheid t.o.v. de lucht:
//
//   dv_lucht/dt = g·ẑ − k(h) · |v_lucht| · v_lucht
//   k(h) = g / v_t0² · ρ(h) / ρ0
//
// v_t0 is de eindsnelheid bij zeeniveau-dichtheid. Omdat k met de dichtheid
// schaalt, is de eindsnelheid op hoogte v_t0·√(ρ0/ρ(h)): op 12.000 ft zo'n
// 20 % hoger dan aan de grond. Hetzelfde model geeft vanzelf:
//  - de acceleratiefase na de exit (de "eerste 1000 ft duurt ~10 s");
//  - de voorwaartse worp: de horizontale snelheid van het vliegtuig dooft
//    uit onder dezelfde weerstand, niet met een losse tijdconstante.
// Grondsnelheid = luchtsnelheid + wind op de actuele hoogte.
//
// Integratie: klassieke Runge-Kutta 4 met vaste stap (standaard 0,1 s).

import { G0 } from './units.js';
import { density, RHO0 } from './atmosphere.js';
import { windVectorAt } from './wind.js';

export const DEFAULT_TERMINAL_MS = 48; // ≈ 173 km/h / 93 kt buikligging bij ρ0; geeft ~55 s voor 12.000→3.000 ft

/**
 * @param p.exitAltM      exit-hoogte AGL (m)
 * @param p.openAltM      openingshoogte AGL (m)
 * @param p.profile       windprofiel (AGL)
 * @param p.exitVelocity  {east, north} m/s: snelheid van het vliegtuig t.o.v. de lucht
 * @param p.vtSeaLevelMs  eindsnelheid bij ρ0 (m/s)
 * @param p.elevationM    hoogte dropzone AMSL (voor de dichtheid)
 * @param p.tempDevC      temperatuurafwijking t.o.v. ISA (°C)
 * @param p.dt            integratiestap (s)
 * @param p.sampleEvery   hoe vaak (s) een punt in `path` komt
 * @returns {path, displacement, timeS, verticalSpeedAtOpeningMs}
 *   path: [{t, hM, east, north}] t.o.v. het exitpunt; displacement: laatste punt.
 */
export function simulateFreefall(p) {
  const {
    exitAltM,
    openAltM,
    profile,
    exitVelocity = { east: 0, north: 0 },
    vtSeaLevelMs = DEFAULT_TERMINAL_MS,
    elevationM = 0,
    tempDevC = 0,
    dt = 0.1,
    sampleEvery = 1,
  } = p;
  if (exitAltM <= openAltM) throw new Error('exit-hoogte moet boven openingshoogte liggen');

  const k0 = G0 / (vtSeaLevelMs * vtSeaLevelMs);

  // toestand: [h, x, y, u, v, w]  (w = daalsnelheid, positief omlaag)
  const deriv = (s) => {
    const [h, , , u, v, w] = s;
    const k = (k0 * density(h + elevationM, tempDevC)) / RHO0;
    const speed = Math.sqrt(u * u + v * v + w * w);
    const wind = windVectorAt(profile, Math.max(h, 0));
    return [-w, u + wind.east, v + wind.north, -k * speed * u, -k * speed * v, G0 - k * speed * w];
  };
  const rk4 = (s, step) => {
    const a = deriv(s);
    const b = deriv(s.map((x, i) => x + 0.5 * step * a[i]));
    const c = deriv(s.map((x, i) => x + 0.5 * step * b[i]));
    const d = deriv(s.map((x, i) => x + step * c[i]));
    return s.map((x, i) => x + (step / 6) * (a[i] + 2 * b[i] + 2 * c[i] + d[i]));
  };

  let s = [exitAltM, 0, 0, exitVelocity.east, exitVelocity.north, 0];
  let t = 0;
  const path = [{ t: 0, hM: exitAltM, east: 0, north: 0 }];
  let nextSample = sampleEvery;

  for (let guard = 0; guard < 100000; guard++) {
    const next = rk4(s, dt);
    const tNext = t + dt;
    if (next[0] <= openAltM) {
      // lineair terug naar precies de openingshoogte
      const f = (s[0] - openAltM) / (s[0] - next[0]);
      s = s.map((x, i) => x + f * (next[i] - x));
      t += f * dt;
      break;
    }
    s = next;
    t = tNext;
    if (t + 1e-9 >= nextSample) {
      path.push({ t, hM: s[0], east: s[1], north: s[2] });
      nextSample += sampleEvery;
    }
  }
  path.push({ t, hM: s[0], east: s[1], north: s[2] });

  return {
    path,
    displacement: { east: s[1], north: s[2] },
    timeS: t,
    verticalSpeedAtOpeningMs: s[5],
  };
}
