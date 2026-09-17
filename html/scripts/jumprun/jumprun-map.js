// Kaartlaag: Leaflet (globaal `L`) met de PDOK-luchtfoto, noord altijd boven.
// Tekent de jumprun-scène en beheert twee sleepbare handvatten:
//  - de koerspijl (1 NM vóór het doel op de track): slepen = track draaien;
//  - het groene licht: slepen langs de track, in stappen van 0,1 NM;
//  - de witte ring (het doel): slepen langs de N-Z- of O-W-as vanaf de dropzone,
//    in stappen van 0,1 NM, en zet zo de offset;
//  - de exitbolletjes (vanaf de tweede): slepen langs de lijn zet de separatie in seconden.
// Tijdens het slepen wordt (max. één keer per frame) onTrackLive/onGreenLive
// aangeroepen zodat de scène live meebeweegt; bij loslaten onTrack/onGreen.

import { destination, bearing, vectorBetween, alongCross, offset as offsetPoint, vectorLength, unitVector, add, scale } from './calc/geo.js';
import { NM, KT } from './calc/units.js';
import { attachMapSwipe, coarsePointer } from './map-touch.js';
import { createWindParticles } from './wind-particles.js';

const PDOK_URL = 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg';
const RINGS_NM = Array.from({ length: 20 }, (_, i) => (i + 1) / 10);   // 0,1 … 2,0 NM, elke 0,1 NM
const LABEL_EVERY_NM = 0.2;                                                                 // label per 0,2 NM
const LABEL_OFFSET_M = 90;                                                                  // labels 90 m naast de jumprun-lijn
const HANDLE_MIN_M = 0.6 * NM;   // koerspijl minstens zo ver vóór het doel …
const HANDLE_AFTER_M = 350;      // … en altijd dit stuk voorbij de laatste exit, zodat de exits vrij blijven

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#fff';
const altVar = (ft) => (ft <= 1500 ? '--alt1' : ft <= 3500 ? '--alt2' : ft <= 7000 ? '--alt3' : ft <= 10500 ? '--alt4' : '--alt5');

function along(target, trackDeg, distM) {
  return distM >= 0 ? destination(target, trackDeg, distM) : destination(target, trackDeg + 180, -distM);
}

const arrowIcon = (deg, label = '') =>
  L.divIcon({
    className: 'handle handle-track',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html: `<svg viewBox="-11 -11 22 22" style="transform:rotate(${deg}deg)"><path d="M0 -8 L0 8 M-5 -3 L0 -8 L5 -3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="track-label">${label}</span>`,
  });
const pad3 = (d) => String(Math.round(((d % 360) + 360) % 360) % 360).padStart(3, '0');
const trackLabel = (result) => `${pad3(result.trackMagneticDeg ?? result.trackDeg)}°`;

/**
 * Zet het koerslabel loodrecht naast de lijn, zodat de lijn er nooit doorheen loopt.
 * Loodrecht op de track (schermcoördinaten, y omlaag): n = (cos θ, sin θ). Voorkeur voor
 * de rechterkant; bij een bijna horizontale lijn de onderkant. De afstand volgt uit de
 * labelgrootte: de dichtstbijzijnde hoek van het label blijft `margin` px van de lijn.
 */
function placeTrackLabel(iconEl, deg) {
  const lbl = iconEl && iconEl.querySelector('.track-label');
  if (!lbl) return;
  const th = (deg * Math.PI) / 180;
  let nx = Math.cos(th), ny = Math.sin(th);
  if (nx < 0 || (Math.abs(nx) < 0.3 && ny < 0)) { nx = -nx; ny = -ny; }
  const w = lbl.offsetWidth || 64, h = lbl.offsetHeight || 22;
  const margin = 26; // straal van de pijl + wat lucht
  const d = margin + (w / 2) * Math.abs(nx) + (h / 2) * Math.abs(ny);
  lbl.style.left = `${22 + nx * d}px`;
  lbl.style.top = `${22 + ny * d}px`;
}

const greenIcon = () =>
  L.divIcon({ className: 'handle handle-green', iconSize: [30, 30], iconAnchor: [15, 15], html: '<span></span>' });
const exitIcon = (size = 1, miss = false) =>
  L.divIcon({ className: `handle handle-exit${miss ? ' miss' : ''}`, iconSize: [18, 18], iconAnchor: [9, 9], html: `<span>${size > 1 ? size : ''}</span>` });

/**
 * Gemeenschappelijk bereik: de doorsnede van de bereikcirkels van alle exits. De
 * middelpunten liggen op één lijn en de stralen zijn gelijk, dus dat is de lens
 * tussen de eerste en de laatste cirkel. Geeft een lijst {east, north} (m) of null
 * als er geen gemeenschappelijk gebied is.
 */
// Ook los bruikbaar: het weerbord tekent er een tweede lens mee, die van de wind van nu.
export function commonReachPolygon(a, b, r, steps = 36) {
  const dx = b.east - a.east, dy = b.north - a.north;
  const d = Math.hypot(dx, dy);
  const pts = [];
  if (d < 1e-6) {
    for (let i = 0; i < steps * 2; i++) { const t = (i / (steps * 2)) * 2 * Math.PI; pts.push({ east: a.east + r * Math.cos(t), north: a.north + r * Math.sin(t) }); }
    return pts;
  }
  if (d >= 2 * r) return null;
  const alpha = Math.acos(d / (2 * r));
  const thA = Math.atan2(dy, dx);          // richting van a naar b
  const thB = thA + Math.PI;                // richting van b naar a
  for (let i = 0; i <= steps; i++) { const t = thA - alpha + (2 * alpha * i) / steps; pts.push({ east: a.east + r * Math.cos(t), north: a.north + r * Math.sin(t) }); }
  for (let i = 0; i <= steps; i++) { const t = thB - alpha + (2 * alpha * i) / steps; pts.push({ east: b.east + r * Math.cos(t), north: b.north + r * Math.sin(t) }); }
  return pts;
}
const targetIcon = () =>
  L.divIcon({ className: 'handle handle-target', iconSize: [26, 26], iconAnchor: [13, 13], html: '<span></span>' });

export function createJumprunMap(el, { onTrack, onGreen, onOffset = null, onSeparation = null, onTrackLive = null, onGreenLive = null, onOffsetLive = null, onSeparationLive = null }) {
  // hele zoomstappen: bij tussenliggende zoomniveaus worden de tegels geschaald en zie je naden als grid
  // op touch: één vinger = handvat of pagina, twee vingers = kaart (zie map-touch.js)
  const map = L.map(el, { zoomControl: false, attributionControl: true, zoomSnap: 1, zoomDelta: 1, dragging: !coarsePointer(), touchZoom: true, tap: false });
  map.attributionControl.setPrefix('');
  attachMapSwipe(map.getContainer());
  const wind = createWindParticles(map);
  const legend = L.DomUtil.create('div', 'jr-legend', map.getContainer());
  legend.hidden = true;
  L.tileLayer(PDOK_URL, {
    maxZoom: 21,
    maxNativeZoom: 19,
    attribution: 'Luchtfoto: PDOK / Beeldmateriaal Nederland, CC BY 4.0',
  }).addTo(map);

  // Als de container van formaat verandert (brede opmaak, tab in beeld, venster) moet Leaflet
  // opnieuw meten, anders schuiven lijnen en markers t.o.v. de tegels zodra je de kaart sleept.
  if ('ResizeObserver' in window) {
    let last = { w: 0, h: 0 };
    new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w && h && (w !== last.w || h !== last.h)) { last = { w, h }; map.invalidateSize({ pan: false }); }
    }).observe(el);
  }

  // extra zekerheid: vlak voor een sleep-/tikactie nog één keer meten (no-op als er niets veranderde)
  el.addEventListener('pointerdown', () => map.invalidateSize({ pan: false }), { capture: true, passive: true });

  const staticLayer = L.layerGroup().addTo(map);
  const sceneLayer = L.layerGroup().addTo(map);
  let target = null;
  let base = null;       // dropzone zonder offset: de ring beweegt langs de assen vanaf dit punt
  let trackDeg = 0;
  let handleDistM = HANDLE_MIN_M;  // afstand van de koerspijl tot het doel langs de track
  let trackHandle = null;
  let greenHandle = null;
  let targetHandle = null;
  let exitHandles = [];
  let draggingExit = -1;
  let lastResult = null;
  let showGlide = false;
  let dragging = false;

  /** @param t ankerpunt van de lijn (bak met offset), @param ref referentiepunt van het veld (niet getekend), @param b de bak */
  function setTarget(t, ref, b = t, extra = [], bakOn = true) {
    target = t;
    base = b;
    staticLayer.clearLayers();
    for (const nm of RINGS_NM) {
      // donkere schaduwlijn onder de witte ring: leesbaar op lichte én donkere ondergrond;
      // de halve mijlen iets zwaarder dan de tienden
      const major = Math.abs((nm * 10) % 5) < 1e-6;
      L.circle(t, { radius: nm * NM, color: '#000', weight: major ? 3 : 2, opacity: major ? 0.35 : 0.22, fill: false, interactive: false }).addTo(staticLayer);
      L.circle(t, { radius: nm * NM, color: '#fff', weight: major ? 1.2 : 0.8, opacity: major ? 0.6 : 0.4, fill: false, interactive: false }).addTo(staticLayer);
    }
    // extra landingsdoelen (bijv. B-veld en leerlingveld op Texel): kleine ring met naam
    for (const x of extra) {
      const on = x.enabled !== false;   // uitgevinkte velden: gedimd, tellen niet mee
      L.circleMarker(x, { radius: 5, color: '#fff', weight: 1.5, opacity: on ? 1 : 0.4, fillOpacity: 0, dashArray: on ? null : '2 3', interactive: false }).addTo(staticLayer);
      if (x.name) L.marker(x, { interactive: false, icon: L.divIcon({ className: `target-label${on ? '' : ' off'}`, iconSize: [0, 0], iconAnchor: [-8, 6], html: `<span>${x.name}</span>` }) }).addTo(staticLayer);
    }
    // de bak: duidelijk herkenbaar doelsymbool (ring met stip); het referentiepunt van het veld tekenen we niet
    if (base) {
      const op = bakOn ? 1 : 0.4;   // uitgevinkte bak: gedimd, telt niet mee
      L.circleMarker(base, { radius: 9, color: '#111', weight: 3, opacity: 0.45 * op, fillOpacity: 0, interactive: false }).addTo(staticLayer);
      L.circleMarker(base, { radius: 9, color: '#fff', weight: 1.5, opacity: op, fillOpacity: 0, dashArray: bakOn ? null : '2 3', interactive: false }).addTo(staticLayer);
      L.circleMarker(base, { radius: 2.5, color: '#fff', weight: 1, opacity: op, fillColor: '#fff', fillOpacity: op, interactive: false }).addTo(staticLayer);
    }
    if (base && (base.lat !== t.lat || base.lng !== t.lng)) {
      L.polyline([base, t], { color: '#000', weight: 3, opacity: 0.35, interactive: false }).addTo(staticLayer);
      L.polyline([base, t], { color: '#fff', weight: 1.2, opacity: 0.85, dashArray: '3 4', interactive: false }).addTo(staticLayer);
    }
    ensureTargetHandle();
    if (!dragging) targetHandle.setLatLng(t);
  }

  const DIRS = { N: 0, E: 90, S: 180, W: 270 };
  let offsetMode = 'cardinal';   // 'cardinal': N/O/Z/W per 0,1 NM; 'free': elke richting (hele graden) per 0,1 NM
  function setOffsetMode(mode) {
    offsetMode = mode;
    if (targetHandle) targetHandle.options.title = mode === 'free' ? 'Sleep het doel in elke richting voor de offset' : 'Sleep het doel noord/oost/zuid/west voor de offset';
  }
  function ensureTargetHandle() {
    if (targetHandle) return;
    targetHandle = L.marker(target, { icon: targetIcon(), draggable: true, autoPan: true, autoPanPadding: L.point(60, 60), autoPanSpeed: 12, zIndexOffset: 800, title: 'Sleep het doel noord/oost/zuid/west voor de offset' }).addTo(map);
    let liveRaf = 0;
    const snap = () => {
      const v = vectorBetween(base, targetHandle.getLatLng());
      if (offsetMode === 'free') {
        const dist = Math.min(2.0, Math.round((vectorLength(v) / NM) * 10) / 10);
        const dir = dist > 0 ? Math.round(bearing(base, targetHandle.getLatLng())) % 360 : 0;
        targetHandle.setLatLng(dist > 0 ? destination(base, dir, dist * NM) : base);
        return { nm: dist, dir };
      }
      const alongEW = Math.abs(v.east) > Math.abs(v.north);
      const dist = Math.min(2.0, Math.round((Math.abs(alongEW ? v.east : v.north) / NM) * 10) / 10);
      const dir = alongEW ? (v.east >= 0 ? 'E' : 'W') : (v.north >= 0 ? 'N' : 'S');
      targetHandle.setLatLng(dist > 0 ? destination(base, DIRS[dir], dist * NM) : base);
      return { nm: dist, dir };
    };
    targetHandle.on('dragstart', () => { dragging = true; });
    targetHandle.on('drag', () => { const o = snap(); if (onOffsetLive) { cancelAnimationFrame(liveRaf); liveRaf = requestAnimationFrame(() => onOffsetLive(o)); } });
    targetHandle.on('dragend', () => { cancelAnimationFrame(liveRaf); dragging = false; const o = snap(); if (onOffset) onOffset(o); });
  }

  /** Zoomt in op wat ertoe doet: doel, exits, openingspunten, groen licht en de koerspijl.
   *  De bereikcirkels mogen buiten beeld vallen; die zijn groot en zeggen op de rand weinig. */
  function sceneBounds(result = null) {
    const pts = [destination(target, 225, 0.35 * NM), destination(target, 45, 0.35 * NM)];
    if (result) {
      pts.push(result.greenLight.point, destination(target, trackDeg, handleDistM));
      for (const e of result.exits) pts.push(e.exitPoint, e.openingPoint, e.canopy.center);
    }
    return L.latLngBounds(pts);
  }

  function fit(result = null) {
    if (!target) return;
    map.fitBounds(sceneBounds(result), { padding: [24, 24] });
  }

  /** Vliegt (geanimeerd) naar de scène als die niet meer helemaal in beeld is. Niet tijdens slepen. */
  function ensureVisible(result) {
    if (!target || !result || dragging) return;
    const b = sceneBounds(result);
    const view = map.getBounds().pad(-0.04);   // kleine marge: iets over de rand telt al als "past niet"
    if (!view.contains(b)) map.flyToBounds(b, { padding: [24, 24], duration: 0.7, easeLinearity: 0.3 });
  }

  function ensureHandles() {
    if (trackHandle) return;
    // autoPan: sleep je een handvat tot bij de rand, dan schuift de kaart mee
    const dragOpts = { draggable: true, autoPan: true, autoPanPadding: L.point(60, 60), autoPanSpeed: 12 };
    trackHandle = L.marker(target, { ...dragOpts, icon: arrowIcon(0), zIndexOffset: 1000, title: 'Sleep om de koers te draaien' }).addTo(map);
    trackHandle.on('dragstart', () => { dragging = true; });
    let liveRaf = 0;
    const live = (fn, v) => { if (!fn) return; cancelAnimationFrame(liveRaf); liveRaf = requestAnimationFrame(() => fn(v)); };
    trackHandle.on('drag', () => {
      const brg = bearing(target, trackHandle.getLatLng());
      trackHandle.setLatLng(destination(target, brg, handleDistM));
      const svg = trackHandle.getElement()?.querySelector('svg');
      if (svg) svg.style.transform = `rotate(${brg}deg)`;
      placeTrackLabel(trackHandle.getElement(), brg);
      live(onTrackLive, Math.round(brg) % 360);
    });
    trackHandle.on('dragend', () => {
      cancelAnimationFrame(liveRaf);
      dragging = false;
      onTrack(Math.round(bearing(target, trackHandle.getLatLng())) % 360);
    });

    greenHandle = L.marker(target, { ...dragOpts, icon: greenIcon(), zIndexOffset: 900, title: 'Sleep het groene licht langs de track' }).addTo(map);
    greenHandle.on('dragstart', () => { dragging = true; });
    const snap = () => {
      const v = vectorBetween(target, greenHandle.getLatLng());
      const nm = Math.round((alongCross(v, trackDeg).along / NM) * 10) / 10;
      greenHandle.setLatLng(along(target, trackDeg, nm * NM));
      return nm;
    };
    greenHandle.on('drag', () => live(onGreenLive, snap()));
    greenHandle.on('dragend', () => { cancelAnimationFrame(liveRaf); dragging = false; onGreen(snap()); });
  }

  /** Eén sleepbaar bolletje per exit; slepen langs de lijn zet de separatie (seconden). */
  function syncExitHandles(result) {
    while (exitHandles.length < result.exits.length) {
      const i = exitHandles.length;
      const h = L.marker(result.exits[i].exitPoint, { icon: exitIcon(), draggable: i > 0, autoPan: true, autoPanPadding: L.point(60, 60), autoPanSpeed: 12, zIndexOffset: 700, title: i > 0 ? 'Sleep langs de lijn voor de separatie' : 'Eerste exit (groen licht)' });
      let liveRaf = 0;
      const snap = () => {
        const r = lastResult;
        const gsMs = r.groundSpeedKt * KT;
        const dist = alongCross(vectorBetween(r.greenLight.point, h.getLatLng()), r.trackDeg).along;
        const seconds = Math.max(1, Math.min(20, Math.round(dist / i / gsMs)));
        h.setLatLng(along(r.greenLight.point, r.trackDeg, seconds * gsMs * i));
        return seconds;
      };
      h.on('dragstart', () => { dragging = true; draggingExit = i; });
      h.on('drag', () => { const sec = snap(); if (onSeparationLive) { cancelAnimationFrame(liveRaf); liveRaf = requestAnimationFrame(() => onSeparationLive(sec)); } });
      h.on('dragend', () => { cancelAnimationFrame(liveRaf); dragging = false; draggingExit = -1; const sec = snap(); if (onSeparation) onSeparation(sec); });
      exitHandles.push(h);
    }
    exitHandles.forEach((h, i) => {
      if (i < result.exits.length) {
        if (!h._map) h.addTo(map);
        if (i !== draggingExit) { h.setLatLng(result.exits[i].exitPoint); const key = `${result.exits[i].size}/${result.exits[i].canopy.reachesTarget}`; if (h._jrKey !== key) { h._jrKey = key; h.setIcon(exitIcon(result.exits[i].size, !result.exits[i].canopy.reachesTarget)); } }
      } else if (h._map) h.remove();
    });
  }

  /** Tekent het resultaat van computeJumprun. */
  function render(result) {
    if (!target) return;
    trackDeg = result.trackDeg;
    // de pijl staat altijd voorbij de laatste exit (en minstens HANDLE_MIN_M vóór het doel)
    if (!dragging) {
      const last = result.exits.length ? result.exits[result.exits.length - 1].exitPoint : null;
      const lastAlong = last ? alongCross(vectorBetween(target, last), trackDeg).along : 0;
      handleDistM = Math.max(HANDLE_MIN_M, lastAlong + HANDLE_AFTER_M);
    }
    sceneLayer.clearLayers();

    // track door het doel
    const trackPts = [along(target, trackDeg, -2.6 * NM), along(target, trackDeg, 2.6 * NM)];
    L.polyline(trackPts, { color: '#000', weight: 4, opacity: 0.35, interactive: false }).addTo(sceneLayer);          // schaduw
    L.polyline(trackPts, { color: '#fff', weight: 2, opacity: 0.85, dashArray: '3 7', interactive: false }).addTo(sceneLayer);
    // gevlogen deel: van groen licht tot laatste exit
    if (result.exits.length) {
      const flown = [result.greenLight.point, result.exits[result.exits.length - 1].exitPoint];
      L.polyline(flown, { color: '#000', weight: 7, opacity: 0.35, interactive: false }).addTo(sceneLayer);           // schaduw
      L.polyline(flown, { color: '#fff', weight: 4, opacity: 0.9, interactive: false }).addTo(sceneLayer);
    }

    // afstandslabels bij de ringen: op een lijn evenwijdig aan de jumprun, vóór het doel in de
    // vliegrichting, met een vaste offset (LABEL_OFFSET_M) aan de kant waar de drift níet heen gaat
    const driftCross = alongCross(result.freefall.displacementM, trackDeg).cross;   // > 0: drift naar rechts
    const tUnit = unitVector(trackDeg);
    const perp = scale(unitVector(trackDeg + 90), driftCross > 0 ? -LABEL_OFFSET_M : LABEL_OFFSET_M);
    for (const nm of RINGS_NM) {
      if (Math.abs((nm / LABEL_EVERY_NM) - Math.round(nm / LABEL_EVERY_NM)) > 1e-6) continue;
      L.marker(offsetPoint(target, add(scale(tUnit, nm * NM), perp)), {
        interactive: false,
        icon: L.divIcon({ className: 'ring-label', iconSize: [0, 0], html: `<span>${nm.toFixed(1)} NM</span>` }),
      }).addTo(sceneLayer);
    }

    // gemeenschappelijk bereik onder de parachute: één lens i.p.v. een cirkel per exit
    const good = cssVar('--good');
    const crit = cssVar('--crit');
    const ok = result.canopy.allReachTarget;
    if (result.exits.length) {
      const first = result.exits[0].canopy, last = result.exits[result.exits.length - 1].canopy;
      const tUnit = unitVector(trackDeg);
      const firstC = vectorBetween(target, first.center);
      const lastC = vectorBetween(target, last.center);
      const col = ok ? good : crit;
      const delayM = (result.canopy.delayPerExitM || 0) * (result.exits.length - 1);
      const delayS = Math.round(result.greenLight.exitDelayS || 0);
      const okDelayed = ok && (result.greenLight.marginM ?? 0) >= 0;
      const poly = commonReachPolygon(firstC, lastC, first.radiusM);
      // rand met donkere schaduw eronder, zodat de lens ook op groene weilanden leesbaar is
      if (poly) {
        const ll = poly.map((v) => offsetPoint(target, v));
        L.polygon(ll, { color: '#000', weight: 6, opacity: 0.45, fill: false, interactive: false }).addTo(sceneLayer);
        L.polygon(ll, { color: col, weight: 2.5, opacity: 1, dashArray: ok ? null : '8 6', fill: false, interactive: false }).addTo(sceneLayer);
      }
      // reservecontour: het bereik als élke exit `exitDelayS` langer duurt (laatste exit het verst verschoven).
      // Ligt binnen de lens; wat daarbinnen valt haalt iedereen óók als het langer duurt.
      if (poly && delayM > 0) {
        const inner = commonReachPolygon(firstC, add(lastC, scale(tUnit, delayM)), first.radiusM);
        if (inner) {
          const ill = inner.map((v) => offsetPoint(target, v));
          L.polygon(ill, { color: '#000', weight: 4, opacity: 0.35, fill: false, interactive: false }).addTo(sceneLayer);
          L.polygon(ill, { color: okDelayed ? good : crit, weight: okDelayed ? 1.5 : 2, opacity: 0.95, dashArray: '5 6', fill: false, interactive: false }).addTo(sceneLayer);
        }
      }
      // legenda linksonder: altijd in beeld, ook als de lens buiten de kaart valt
      legend.innerHTML = `<span class="ln" style="--c:${col}"></span>${ok ? 'bereik van alle exits' : 'niet iedereen haalt het'}` +
        (delayM > 0 && poly ? `<span class="ln dash" style="--c:${okDelayed ? good : crit}"></span>${okDelayed ? '' : 'tekort '}bij ${delayS} s vertraging per exit` : '');
      legend.hidden = false;
    }

    // optioneel: glide-lijn van de krapste exit naar de bak
    if (showGlide && result.canopy.tightest) {
      const e = result.exits[result.canopy.tightest.n - 1];
      const bak = base || target;                                 // het echte landingsdoel, niet het ankerpunt met offset
      const c = vectorBetween(bak, e.canopy.center);             // middelpunt van zijn bereik t.o.v. de bak
      const dist = vectorLength(c);
      const reach = dist <= e.canopy.radiusM ? { east: 0, north: 0 } : { east: c.east * (1 - e.canopy.radiusM / dist), north: c.north * (1 - e.canopy.radiusM / dist) }; // dichtstbijzijnde haalbare punt
      const reachLL = offsetPoint(bak, reach);
      L.polyline([e.openingPoint, reachLL], { color: ok ? good : crit, weight: 3, opacity: 0.95, interactive: false }).addTo(sceneLayer);
      if (dist > e.canopy.radiusM) L.polyline([reachLL, bak], { color: crit, weight: 2, opacity: 0.9, dashArray: '4 6', interactive: false }).addTo(sceneLayer);
      const mid = offsetPoint(bak, { east: (vectorBetween(bak, e.openingPoint).east + reach.east) / 2, north: (vectorBetween(bak, e.openingPoint).north + reach.north) / 2 });
      const min = Math.round(result.canopy.timeS / 60);
      const m = Math.round(Math.abs(e.canopy.marginM));
      L.marker(mid, { interactive: false, icon: L.divIcon({ className: 'glide-label', iconSize: [0, 0], html: `<span>exit ${e.n} · ${min} min · ${e.canopy.marginM >= 0 ? `${m} m over` : `mist ${m} m`}</span>` }) }).addTo(sceneLayer);
    }

    // vrijevalbanen, gekleurd per hoogteband (paars: donkerder = hoger)
    for (const e of result.exits) {
      let seg = [];
      let band = null;
      const flush = () => {
        if (seg.length > 1 && band) L.polyline(seg, { color: cssVar(band), weight: 2.5, opacity: 0.95, interactive: false }).addTo(sceneLayer);
      };
      for (const p of e.path) {
        const b = altVar(p.altFt);
        if (band && b !== band) { flush(); seg = [seg[seg.length - 1]]; }
        band = b;
        seg.push([p.lat, p.lng]);
      }
      flush();
      L.circleMarker(e.openingPoint, { radius: 3.5, color: cssVar('--alt2'), weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(sceneLayer);
    }
    lastResult = result;
    syncExitHandles(result);


    ensureHandles();
    if (!dragging) {
      trackHandle.setLatLng(destination(target, trackDeg, handleDistM));
      trackHandle.setIcon(arrowIcon(trackDeg, trackLabel(result)));
      placeTrackLabel(trackHandle.getElement(), trackDeg);
      greenHandle.setLatLng(result.greenLight.point);
    } else {
      // tijdens het slepen alleen de tekst van het label bijwerken (setIcon zou de sleepactie onderbreken)
      const lbl = trackHandle.getElement()?.querySelector('.track-label');
      if (lbl) lbl.textContent = trackLabel(result);
    }
  }

  function setGlide(on) { showGlide = !!on; if (lastResult) render(lastResult); }

  return { map, setTarget, setOffsetMode, render, fit, ensureVisible, setGlide, wind };
}
