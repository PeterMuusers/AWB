// Windanimatie op de jumprun-kaart, à la Windy maar ingetogen: deeltjes op een canvas boven de kaart. Het
// windveld hangt hier alleen van de hoogte af, niet van de plek. Elk deeltje daalt vanaf de openingshoogte
// met de daalsnelheid van een parachute en volgt op elk moment de wind van zijn actuele hoogte: het spoor is
// dus de driftbaan van een dalende canopy, en de bocht erin is de winddraaiing tussen opening en grond.
// Hoog = helderder, laag = zwakker. Korte vervagende sporen; uit bij 'prefers-reduced-motion' en als de
// pagina niet zichtbaar is.

const DENSITY_PX2 = 9000;      // één deeltje per zoveel px²
const SPEEDUP = 40;            // tijdversnelling: 10 m/s ≈ 400 m/s op de kaart, anders zie je niets
const DESCENT_MS = 5.08;       // daalsnelheid (1.000 ft/min): de daling van opening tot grond duurt zo ~200 s echt, 5 s op de kaart
const TRAIL_FADE = 0.06;       // hoeveel het spoor per frame vervaagt

export function createWindParticles(map) {
  const container = map.getContainer();
  const canvas = document.createElement('canvas');
  canvas.className = 'wind-particles';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let windAt = null;            // (altM) -> {east, north} m/s
  let altMin = 0;
  let altMax = 1000;
  let enabled = true;
  let particles = [];
  let raf = 0;
  let last = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function size() {
    const r = container.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((r.width * r.height) / DENSITY_PX2);
    particles = Array.from({ length: n }, () => spawn(r.width, r.height, true));
    ctx.clearRect(0, 0, r.width, r.height);
  }

  function spawn(w, h, anyAlt = false) {
    // nieuw deeltje begint op de openingshoogte; bij de start van de animatie overal in de daling, anders zakt alles in koor
    const f = anyAlt ? Math.random() : 1;                    // 0 = grond, 1 = openingshoogte
    return { x: Math.random() * w, y: Math.random() * h, f };
  }

  function metersPerPixel() {
    const lat = map.getCenter().lat;
    return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
  }

  function active() {
    return enabled && windAt && !reduced.matches && !document.hidden && container.offsetWidth > 0;
  }

  function frame(t, schedule = true) {
    raf = 0;
    if (!active() && schedule) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const mpp = metersPerPixel();
    // spoor laten vervagen
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${TRAIL_FADE})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    const fallPerSec = (DESCENT_MS * SPEEDUP) / Math.max(1, altMax - altMin);   // fractie van de daling per seconde (kaarttijd)
    for (const p of particles) {
      const alt = altMin + p.f * (altMax - altMin);
      const v = windAt(alt);                                // m/s, east/north, op de actuele hoogte van het deeltje
      const dx = (v.east * SPEEDUP * dt) / mpp;
      const dy = (-v.north * SPEEDUP * dt) / mpp;           // schermcoördinaat: y naar beneden
      const nx = p.x + dx;
      const ny = p.y + dy;
      ctx.strokeStyle = `rgba(255,255,255,${0.18 + 0.45 * p.f})`;
      ctx.lineWidth = 0.8 + 1.2 * p.f;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      p.x = nx; p.y = ny; p.f -= fallPerSec * dt;           // dalen
      if (p.f <= 0 || nx < -10 || ny < -10 || nx > w + 10 || ny > h + 10) Object.assign(p, spawn(w, h));
    }
    if (schedule) raf = requestAnimationFrame(frame);
  }

  function kick() { if (!raf && active()) { last = 0; raf = requestAnimationFrame(frame); } }

  map.on('resize', size);
  map.on('zoomend', () => { size(); kick(); });
  document.addEventListener('visibilitychange', kick);
  reduced.addEventListener?.('change', kick);
  size();

  return {
    /** windAt(altM) -> {east, north} in m/s; hoogtes AGL in meter */
    setWind(fn, minM, maxM) { windAt = fn; altMin = minM; altMax = Math.max(minM + 1, maxM); kick(); },
    setEnabled(on) { enabled = !!on; canvas.style.display = on ? '' : 'none'; if (on) kick(); },
    isEnabled: () => enabled,
    resize: () => { size(); kick(); },
    kick,
    /** één frame tekenen zonder rAF (voor tests in een verborgen tab) */
    step: (dtMs = 16) => { const t = (last || 0) + dtMs; frame(t, false); },
  };
}
