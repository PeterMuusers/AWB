// Geografie op een bolvormige aarde.
// Voor afstanden tot enkele zeemijlen is een bol met de gemiddelde straal
// ruim nauwkeurig genoeg (fout < 0,3 % t.o.v. WGS84).
//
// Twee representaties:
//  - {lat, lng} in graden (kaart)
//  - {east, north} in meter t.o.v. een referentiepunt (rekenen)
// Het lokale vlak is een equirectangulaire projectie rond het referentiepunt.

import { degToRad, radToDeg, normalizeDeg } from './units.js';

export const EARTH_RADIUS = 6371008.8; // gemiddelde straal (IUGG), meter

/**
 * Bestemming vanaf `start` op `bearingDeg` (kompaskoers) na `distanceM` meter
 * langs een grootcirkel.
 */
export function destination(start, bearingDeg, distanceM) {
  const lat1 = degToRad(start.lat);
  const lng1 = degToRad(start.lng);
  const brg = degToRad(bearingDeg);
  const delta = distanceM / EARTH_RADIUS;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(brg),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: radToDeg(lat2), lng: radToDeg(lng2) };
}

/** Grootcirkelafstand (haversine) in meter. */
export function distance(a, b) {
  const lat1 = degToRad(a.lat);
  const lat2 = degToRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = degToRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

/** Beginkoers (kompas, 0–360) van a naar b. */
export function bearing(a, b) {
  const lat1 = degToRad(a.lat);
  const lat2 = degToRad(b.lat);
  const dLng = degToRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeDeg(radToDeg(Math.atan2(y, x)));
}

/** Verplaatst `point` over {east, north} meter in het lokale vlak. */
export function offset(point, vec) {
  const lat = point.lat + radToDeg(vec.north / EARTH_RADIUS);
  const lng =
    point.lng + radToDeg(vec.east / (EARTH_RADIUS * Math.cos(degToRad(point.lat))));
  return { lat, lng };
}

/** Vector {east, north} in meter van `from` naar `to` (equirectangulair). */
export function vectorBetween(from, to) {
  const meanLat = degToRad((from.lat + to.lat) / 2);
  return {
    east: EARTH_RADIUS * Math.cos(meanLat) * degToRad(to.lng - from.lng),
    north: EARTH_RADIUS * degToRad(to.lat - from.lat),
  };
}

/** Eenheidsvector {east, north} van een kompaskoers. */
export function unitVector(bearingDeg) {
  const b = degToRad(bearingDeg);
  return { east: Math.sin(b), north: Math.cos(b) };
}

/** Kompaskoers (0–360) van een vector {east, north}. */
export function vectorBearing(vec) {
  return normalizeDeg(radToDeg(Math.atan2(vec.east, vec.north)));
}

export function vectorLength(vec) {
  return Math.hypot(vec.east, vec.north);
}

export function add(a, b) {
  return { east: a.east + b.east, north: a.north + b.north };
}

export function scale(vec, factor) {
  return { east: vec.east * factor, north: vec.north * factor };
}

/**
 * Ontbindt een vector langs een koers: `along` in de vliegrichting,
 * `cross` naar rechts (stuurboord) daarvan.
 */
export function alongCross(vec, trackDeg) {
  const t = unitVector(trackDeg);
  return {
    along: vec.east * t.east + vec.north * t.north,
    cross: vec.east * t.north - vec.north * t.east,
  };
}
