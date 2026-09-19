// Jumprun: de samenhang. Rekent vanuit een windprofiel en een handvol
// instellingen alles uit wat de kaart nodig heeft. Puur: geen DOM, geen
// kaart-API, geen netwerk.
//
// Alle interne posities zijn {east, north} in meter t.o.v. het DOEL (het
// punt waar de springers moeten landen: de dropzone plus eventuele offset).
// Aan het eind worden ze omgezet naar {lat, lng}.
//
// Kern (de klassieke spot-berekening):
//   D      = verplaatsing tijdens de vrije val (worp + wind)
//   D_c    = winddrift onder de parachute (van opening tot circuithoogte)
//   spot   = doel − D − D_c      → exit hier en je landt zonder te sturen
//                                  precies op het doel; het bereik onder de
//                                  parachute ligt dan als cirkel róndom het doel
//   exit_i = groen + (i−1)·s·t̂  → s = GS·separatie, t̂ = richting van de track
//   open_i = exit_i + D
//   cirkel_i: middelpunt open_i + D_c, straal V_canopy · T_canopy
// Groen licht wordt zo gekozen dat het midden van de exits op de spot ligt
// (langs de track); de dwarsafstand van de spot tot de track is de
// aanbevolen offset.
//
// Voorkeurszijde (preferSideDeg): sommige velden willen de springers zo veel
// mogelijk aan één kant van de baan houden, bijvoorbeeld om zweefvliegverkeer
// aan de andere kant vrij te laten. De offset die de marge maximaliseert ligt
// dan vaak aan de verkeerde kant. Omdat de marge concaaf is in de dwarsafstand,
// kun je vanaf dat optimum naar die voorkeurszijde schuiven en precies uitrekenen
// hoe ver dat kan voordat de marge onder `preferMinMarginM` zakt. Dat is bewust
// géén oordeel over of het kan: beide getallen gaan mee naar buiten (het
// verschoven advies én de maximale marge), zodat zichtbaar is wat het kost.

import { ftToM, mToFt, ktToMs, msToKt, nmToM, mToNm, normalizeDeg, degToRad } from './units.js';
import { offset, unitVector, add, scale, alongCross, vectorBearing, vectorLength, vectorBetween } from './geo.js';
import { tasFromIas } from './atmosphere.js';
import { windAt, windVectorAt } from './wind.js';
import { windTriangle, exitSeparation, separationSeconds, separationSpeed, requiredSeparationM } from './aircraft.js';
import { simulateFreefall, DEFAULT_TERMINAL_MS } from './freefall.js';
import { canopyDrift, canopyRadius } from './canopy.js';

export const DEFAULTS = Object.freeze({
  exitAltFt: 12000,
  openAltFt: 3000,
  iasKt: 85,               // jumprun-snelheid (IAS) van het vliegtuig
  tasKt: null,             // vaste TAS op jumprun (bijv. 110 kt voor de C208 van Hoogeveen); null = uit IAS via ISA
  separationRounding: 'nearest', // 'nearest' zoals de separatietabel van Hoogeveen, of 'ceil'
  tempDevC: 0,             // temperatuurafwijking t.o.v. ISA
  exits: 6,
  groupSizes: null,        // aantal springers per exit, bijv. [4, 4, 2, 1, 1, 1]; null = allemaal 1
  extraTargets: [],          // extra landingsdoelen [{lat, lng, name}] die élke exit ook moet kunnen halen (bijv. Texel: B-veld, leerlingveld)
  landing: null,             // het echte landingsdoel als `target` een verschoven ankerpunt is (offset); null = target zelf
  landingName: null,         // naam van dat landingsdoel in de uitvoer (null = 'de bak')
  separationTargetM: 300,  // minimale afstand tussen exits (≈ 1.000 ft)
  separationMode: 'safe',  // 'ground', 'air' of 'safe' (kleinste van beide), zie aircraft.js
  largeGroupMin: 6,        // vanaf deze groepsgrootte telt de AXIS-regel: extra seconden
  largeGroupExtraS: 2,     // AXIS/Skydive Arizona: +2 s als een van beide groepen > 5 springers
  vtSeaLevelMs: DEFAULT_TERMINAL_MS,
  canopyAirspeedMs: 9,     // voorwaartse luchtsnelheid onder de parachute (m/s); 9 = studentencanopy in volle vlucht (midden van 8-10), 11 = sport
  canopyAirspeedKt: null,  // oude invoer in knopen; wordt alleen gebruikt als canopyAirspeedMs ontbreekt
  canopyDescentFtMin: 1000,
  patternAltFt: 1000,      // circuithoogte: daaronder wordt niet meer "teruggevlogen"
  exitDelayS: 2,           // groen-licht-voorstel: elke exit mag zoveel seconden langer duren dan gepland (cumulatief) zonder dat de marge wegvalt
  greenLightMode: 'margin', // 'margin': grootste kleinste marge; 'nearest': zo dicht mogelijk bij de bak met minstens minMarginM marge (Texel-notatie: laagste NM)
  funnel: false,           // trechter: jumprun haaks op de drift, lijn bovenwinds van de bak; iedereen vliegt dezelfde kant op naar de bak
  funnelMarginM: 150,      // hoeveel verder bovenwinds de lijn ligt dan de spot (extra dwarsoffset), zodat élk bereikmiddelpunt bovenwinds ligt
  preferSideDeg: null,     // ware peiling van de kant waar de jumprun zo ver mogelijk heen mag (0 = noord, 180 = zuid); null = geen voorkeur
  preferMinMarginM: 200,   // ondergrens voor de marge bij die verschuiving: zo ver naar die kant als kan, zolang de marge hierboven blijft
  parachuteAreaNm: 2,      // straal van het valschermgebied rond de bak; daarbuiten hoort de sprong niet te komen
  minMarginM: 200,         // absolute ondergrens voor de marge bij greenLightMode 'nearest' (incl. het vertraagde scenario)
  nearestMarginFrac: 0.7,  // … én minstens dit deel van de best haalbare marge, zodat 'dichtstbij' niet op de rand gaat zitten
  magneticDeclinationDeg: 0, // oost positief; NL 2026 ≈ +2,5°
  elevationM: 0,
});

/**
 * Aanbevolen track: tegen de gemiddelde wind tijdens de vrije val in, zodat
 * de springers tijdens de val terug over de lijn drijven. (Zonder worp
 * berekend; de worp ligt per definitie langs de track.)
 */
export function suggestTrack(profile, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ff = simulateFreefall({
    exitAltM: ftToM(o.exitAltFt),
    openAltM: ftToM(o.openAltFt),
    profile,
    vtSeaLevelMs: o.vtSeaLevelMs,
    elevationM: o.elevationM,
    tempDevC: o.tempDevC,
  });
  const d = ff.displacement;
  if (vectorLength(d) < 1) return windAt(profile, ftToM(o.exitAltFt)).fromDeg;
  return vectorBearing(scale(d, -1));
}

/**
 * @param input.target        {lat, lng} ankerpunt van de jumprun: de lijn loopt hier overheen en groen
 *                            licht wordt hiervandaan gemeten (het landingsdoel plus eventuele offset)
 * @param input.landing       {lat, lng} het echte landingsdoel (de bak); weggelaten = target. Spot, bereik
 *                            en marge worden hier tegen gerekend, óók als de lijn met een offset verschoven is
 * @param input.profile       windprofiel AGL (zie wind.js)
 * @param input.trackDeg      grondkoers van de jumprun; weggelaten = suggestTrack
 * @param input.separationS   seconden tussen exits; weggelaten = voorstel
 * @param input.greenLightNm  groen licht t.o.v. doel langs de track (negatief
 *                            = vóór het doel); weggelaten = voorstel
 * plus de velden uit DEFAULTS.
 */
/** Trechter-koers: haaks op de totale drift (vrije val + canopy) van een berekening; twee kandidaten (±90°). */
export function funnelTracks(result) {
  const drift = add(result.freefall.displacementM, result.canopy.driftM);
  const b = vectorBearing(drift);
  return [normalizeDeg(b + 90), normalizeDeg(b - 90)];
}

/** Hoeveel van de voorkeurszijde langs de dwarsas moet liggen voordat verschuiven zin heeft (cos ≈ 78°). */
const PREFER_SIDE_MIN_COMPONENT = 0.2;

export function computeJumprun(input) {
  const o = { ...DEFAULTS, ...input };
  if (!o.target) throw new Error('target ontbreekt');
  if (!o.profile || o.profile.length === 0) throw new Error('profile ontbreekt');

  const exitAltM = ftToM(o.exitAltFt);
  const openAltM = ftToM(o.openAltFt);
  const trackDeg = o.trackDeg ?? suggestTrack(o.profile, o);
  const trackUnit = unitVector(trackDeg);

  // Vliegtuig
  const tasMs = o.tasKt ? ktToMs(o.tasKt) : tasFromIas(ktToMs(o.iasKt), exitAltM + o.elevationM, o.tempDevC);
  const windExit = windAt(o.profile, exitAltM);
  const tri = windTriangle(tasMs, trackDeg, windVectorAt(o.profile, exitAltM));
  if (!tri.feasible) throw new Error('dwarswind groter dan TAS: track niet te vliegen');

  // Vrije val
  const ff = simulateFreefall({
    exitAltM,
    openAltM,
    profile: o.profile,
    exitVelocity: tri.airVelocity,
    vtSeaLevelMs: o.vtSeaLevelMs,
    elevationM: o.elevationM,
    tempDevC: o.tempDevC,
  });
  const D = ff.displacement;

  // Parachute
  const descentMs = ftToM(o.canopyDescentFtMin) / 60;
  const canopyAirMs = o.canopyAirspeedMs ?? ktToMs(o.canopyAirspeedKt ?? 15.5);
  const patternAltM = ftToM(o.patternAltFt);
  /* De drift telt door tot de grond: tijdens het landingscircuit waait het gewoon door. Het bereik
     houdt wél op circuithoogte op - die laatste duizend voet heb je nodig om downwind, base en final
     te vliegen en leveren geen afstand op. Daarom staat het middelpunt van elk bereik verder
     benedenwinds dan het openingspunt, en moet de spot dus verder bovenwinds liggen. */
  const Dc = canopyDrift(o.profile, openAltM, descentMs, 1, 0);

  // Landingsdoelen als vectoren t.o.v. het doel: het doel zelf (oorsprong) plus eventuele extra velden
  // Alle posities zijn t.o.v. het ankerpunt `target`; het landingsdoel (de bak) ligt daar `p0` vandaan
  // (nul zonder offset). Bereik en marge worden altijd tegen de bak en de extra velden gerekend.
  const p0 = o.landing ? vectorBetween(o.target, o.landing) : { east: 0, north: 0 };
  const targetPts = [
    { name: o.landingName || null, v: p0 },
    ...(o.extraTargets || []).map((t) => ({ name: t.name || null, v: vectorBetween(o.target, t) })),
  ];
  // één bereikstraal voor alle velden: elke canopy (dus de langzaamste) moet elk landingsdoel kunnen halen
  const radiusM = canopyRadius(openAltM, descentMs, canopyAirMs, patternAltM);
  for (const p of targetPts) p.r = radiusM;

  // Spot
  const spot = add(p0, scale(add(D, Dc), -1));   // exit hier → landing precies op de bak
  const spotAC = alongCross(spot, trackDeg);

  // Separatie, per tussenruimte: hangt af van de grootte van de twee groepen
  const windOpen = windVectorAt(o.profile, openAltM);
  const sizes = Array.from({ length: o.exits }, (_, i) => Math.max(1, Math.round((o.groupSizes && o.groupSizes[i]) || 1)));
  const gaps = [];
  for (let i = 0; i < o.exits - 1; i++) {
    const targetM = requiredSeparationM(sizes[i], sizes[i + 1], o.separationTargetM);
    const large = sizes[i] >= o.largeGroupMin || sizes[i + 1] >= o.largeGroupMin;
    const suggested = separationSeconds(targetM, tri.groundVelocity, windOpen, o.separationMode, o.separationRounding) + (large ? o.largeGroupExtraS : 0);
    const seconds = o.separationS ?? suggested;
    const sep = exitSeparation(tri.groundVelocity, windOpen, seconds);
    gaps.push({ from: i + 1, to: i + 2, sizes: [sizes[i], sizes[i + 1]], targetM, large, suggestedSeconds: suggested, seconds, groundM: sep.groundM, airM: sep.airM });
  }
  const suggestedSeparationS = gaps.length ? Math.max(...gaps.map((g) => g.suggestedSeconds)) : separationSeconds(o.separationTargetM, tri.groundVelocity, windOpen, o.separationMode, o.separationRounding);
  const separationS = o.separationS ?? suggestedSeparationS;
  const totalM = gaps.reduce((a, g) => a + g.groundM, 0);
  const cumM = [0];
  for (const g of gaps) cumM.push(cumM[cumM.length - 1] + g.groundM);

  // Groen licht: zoveel mogelijk marge voor élke exit en élk landingsdoel. De marge van exit i bij groen g
  // is r − |g·t̂ + c_i − p| met c_i = cum_i·t̂ + D + D_c en p een landingsdoel; dat is concaaf in g, dus het
  // minimum over alle exits en doelen heeft één maximum. Daarnaast telt een vertraagd scenario mee waarin
  // elke exit `exitDelayS` seconden langer duurt dan gepland (cumulatief, dus exit i ligt i·GS·Δt verder):
  // het voorstel is het punt waarop het kleinste van beide scenario's het grootst is, zodat ook de laatste
  // exits nog ruimte hebben als het langer duurt. Afgerond op 0,1 NM (de beste van de twee buren).
  const centeredGreenM = spotAC.along - totalM / 2;
  let funnel = { requested: !!o.funnel, feasible: false };
  let maxExits = o.exits;   // bij het voorstel: tot hoeveel exits iedereen alle velden haalt (incl. vertraging)
  const delayM = tri.groundSpeedMs * Math.max(0, o.exitDelayS || 0);
  const crossUnit = unitVector(trackDeg + 90);   // rechts van de track
  // marge bij groen licht g (m langs de track) en een zijwaartse verschuiving van de lijn `cross` (m, rechts positief)
  const marginAt = (g, nExits = o.exits, cross = 0) => {
    let m = Infinity;
    for (let i = 0; i < nExits; i++) {
      for (const extra of delayM > 0 ? [0, delayM * i] : [0]) {
        const c = add(add(add(scale(trackUnit, g + cumM[i] + extra), scale(crossUnit, cross)), D), Dc);
        for (const p of targetPts) m = Math.min(m, p.r - vectorLength(add(c, scale(p.v, -1))));
      }
    }
    return m;
  };
  // gulden-snedezoektocht (unimodaal) in een ruim venster rond het midden: het groene licht met de grootste
  // kleinste marge voor de eerste n exits, daarna op 0,1 NM (de beste van de twee buren)
  const step = nmToM(0.1);
  const golden = (a, b, f, iters = 60) => {
    const phi = (Math.sqrt(5) - 1) / 2;
    let x1 = b - phi * (b - a);
    let x2 = a + phi * (b - a);
    let f1 = f(x1);
    let f2 = f(x2);
    for (let k = 0; k < iters; k++) {
      if (f1 < f2) { a = x1; x1 = x2; f1 = f2; x2 = a + phi * (b - a); f2 = f(x2); }
      else { b = x2; x2 = x1; f2 = f1; x1 = b - phi * (b - a); f1 = f(x1); }
    }
    return (a + b) / 2;
  };
  const bestGreenFor = (n, cross = 0) => {
    const center = spotAC.along - (n > 1 ? cumM[n - 1] : 0) / 2;
    const best = golden(center - nmToM(3), center + nmToM(3), (g) => marginAt(g, n, cross));
    const lo = Math.floor(best / step) * step;
    const hi = lo + step;
    return marginAt(hi, n, cross) > marginAt(lo, n, cross) ? hi : lo;
  };
  // Offset-advies: de zijwaartse verschuiving van de lijn. Met één doel is dat de dwarsafstand van de spot
  // (dan ligt de spot op de lijn). Met meerdere velden zoeken we de verschuiving waarbij, mét het beste groene
  // licht erlangs, de kleinste marge over alle exits en velden het grootst is (concaaf in beide richtingen).
  let maxMarginCrossM = spotAC.cross;
  if (targetPts.length > 1) {
    maxMarginCrossM = golden(spotAC.cross - nmToM(3), spotAC.cross + nmToM(3), (c) => marginAt(bestGreenFor(o.exits, c), o.exits, c), 40);
  }
  let suggestedCrossM = maxMarginCrossM;
  // Voorkeurszijde: vanaf het margeoptimum zo ver mogelijk die kant op, zolang de kleinste marge
  // (incl. het vertraagde scenario, en met het beste groene licht erlangs) boven de vloer blijft.
  // De marge is concaaf in de dwarsafstand, dus voorbij het optimum daalt hij monotoon: bisectie.
  const crossMargin = (c) => marginAt(bestGreenFor(o.exits, c), o.exits, c);
  let preferSide = null;
  if (o.preferSideDeg !== null && o.preferSideDeg !== undefined && !o.funnel) {
    const toward = Math.cos(degToRad(o.preferSideDeg - (trackDeg + 90)));   // component van die kant langs de dwarsas
    const maxMarginM = crossMargin(maxMarginCrossM);
    const floorM = o.preferMinMarginM;
    // Ligt de voorkeurszijde vrijwel langs de track, dan levert dwars verschuiven er nauwelijks iets op
    // (bij 0,05 zou je 1.100 m opzij moeten om 55 m die kant op te komen) en kost het alleen marge: niet doen.
    if (Math.abs(toward) < PREFER_SIDE_MIN_COMPONENT || maxMarginM < floorM) {
      // de voorkeurszijde ligt (bijna) langs de track, of zelfs het optimum haalt de vloer al niet
      preferSide = { deg: o.preferSideDeg, floorM, feasible: false, shiftM: 0, marginM: maxMarginM, maxMarginM };
    } else {
      let lo = maxMarginCrossM;                                     // haalt de vloer
      let hi = maxMarginCrossM + Math.sign(toward) * nmToM(4);      // ver voorbij alles wat nog haalbaar is
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (crossMargin(mid) >= floorM) lo = mid;
        else hi = mid;
      }
      suggestedCrossM = lo;
      preferSide = { deg: o.preferSideDeg, floorM, feasible: true, shiftM: Math.abs(lo - maxMarginCrossM), marginM: crossMargin(lo), maxMarginM };
    }
  }
  let suggestedGreenM = centeredGreenM;
  {
    suggestedGreenM = bestGreenFor(o.exits);
    const best = suggestedGreenM;
    if (o.greenLightMode === 'nearest') {
      // Texel-notatie (peiling · NM vanuit het midden): het groene licht zo dicht mogelijk bij de bak, op het
      // 0,1 NM-raster, zolang de kleinste marge (incl. vertraging) minstens minMarginM én nearestMarginFrac
      // van de best haalbare marge blijft (anders kiest 'dichtstbij' het punt dat nog nét voldoet)
      const floor = Math.max(o.minMarginM, o.nearestMarginFrac * marginAt(suggestedGreenM));
      let nearest = null;
      for (let g = best - nmToM(3); g <= best + nmToM(3); g += step) {
        const gg = Math.round(g / step) * step;
        if (marginAt(gg) < floor) continue;
        const d = vectorLength(add(scale(trackUnit, gg), scale(p0, -1)));
        if (nearest === null || d < nearest.d) nearest = { g: gg, d };
      }
      if (nearest) suggestedGreenM = nearest.g;   // anders: terugval op de maximale marge
    }
    // Trechter: de aanroeper legt de track haaks op de drift (zie suggestFunnelTrack) en past het offset-advies
    // toe; dat advies is hier de dwarsafstand van de spot plus funnelMarginM extra bovenwinds. De exits liggen
    // dan gecentreerd op de lijn, zijwaarts gespreid, en élk bereikmiddelpunt ligt funnelMarginM bovenwinds van
    // de bak: iedereen vliegt met de wind mee naar de bak en draait vanuit dezelfde kant het circuit in.
    if (o.funnel) funnel = { requested: true, feasible: marginAt(suggestedGreenM) >= 0 };
    // tot hoeveel exits haalt iedereen het wél, elk met zijn eigen beste groene licht? Handig om een load te splitsen.
    if (marginAt(suggestedGreenM) < 0) {
      maxExits = 0;
      for (let n = o.exits - 1; n >= 1; n--) { if (marginAt(bestGreenFor(n), n) >= 0) { maxExits = n; break; } }
    }
    if (o.funnel) funnel.maxExits = maxExits;
  }
  const greenM = o.greenLightNm !== undefined && o.greenLightNm !== null ? nmToM(o.greenLightNm) : suggestedGreenM;
  const greenPoint = scale(trackUnit, greenM);

  const toLatLng = (v) => offset(o.target, v);

  const exits = [];
  for (let i = 1; i <= o.exits; i++) {
    const exitPoint = add(greenPoint, scale(trackUnit, cumM[i - 1]));
    const openingPoint = add(exitPoint, D);
    const center = add(openingPoint, Dc);
    // per landingsdoel: afstand van het bereikmiddelpunt tot het doel en de marge tot de rand van het bereik
    const targets = targetPts.map((p) => {
      const d = vectorLength(add(center, scale(p.v, -1)));
      return { name: p.name, distanceM: d, marginM: p.r - d, radiusM: p.r };
    });
    const tight = targets.reduce((a, b) => (b.marginM < a.marginM ? b : a));
    exits.push({
      n: i,
      size: sizes[i - 1],
      exitPoint: toLatLng(exitPoint),
      openingPoint: toLatLng(openingPoint),
      path: ff.path.map((pt) => ({ t: pt.t, altFt: mToFt(pt.hM), ...toLatLng(add(exitPoint, pt)) })),
      canopy: {
        center: toLatLng(center),
        radiusM,
        reachesTarget: tight.marginM >= 0,          // haalt álle landingsdoelen
        distanceToTargetM: targets[0].distanceM,    // het hoofddoel
        marginM: tight.marginM,                     // krapste doel; positief = speling tot de rand van het bereik
        tightTarget: tight.name,                    // naam van het krapste doel (null = het hoofddoel)
        targets,
      },
    });
  }

  /* Past de sprong binnen het valschermgebied? Dat is de cirkel rond de bak waarbinnen gesprongen
     wordt (standaard 2 NM). Exits en openingspunten horen daar allebei in te liggen: daar hangt of
     valt iemand. Ligt er iets buiten, dan is dat geen rekenfout maar wel iets om te zeggen. */
  const areaRadiusM = nmToM(o.parachuteAreaNm);
  let areaMaxM = 0;
  let areaWorst = null;
  for (const e of exits) {
    for (const [wat, ll] of [['exit', e.exitPoint], ['opening', e.openingPoint]]) {
      const d = vectorLength(add(vectorBetween(o.target, ll), scale(p0, -1)));
      if (d > areaMaxM) { areaMaxM = d; areaWorst = { n: e.n, wat }; }
    }
  }

  return {
    trackDeg,
    headingDeg: tri.headingDeg,                                   // waar
    headingMagneticDeg: normalizeDeg(tri.headingDeg - o.magneticDeclinationDeg),
    trackMagneticDeg: normalizeDeg(trackDeg - o.magneticDeclinationDeg),       // wat de piloot op de GPS zet
    wcaDeg: tri.wcaDeg,
    tasKt: msToKt(tasMs),
    groundSpeedKt: msToKt(tri.groundSpeedMs),
    windAtExit: { speedKt: msToKt(windExit.speedMs), fromDeg: windExit.fromDeg, tempC: windExit.tempC },
    freefall: {
      timeS: ff.timeS,
      displacementM: D,
      distanceM: vectorLength(D),
      bearingDeg: vectorBearing(D),
      verticalSpeedAtOpeningKt: msToKt(ff.verticalSpeedAtOpeningMs),
    },
    spot: { ...toLatLng(spot), alongTrackNm: mToNm(spotAC.along), crossTrackNm: mToNm(spotAC.cross) },
    separation: {
      seconds: separationS,                       // handmatig, of het grootste voorstel
      suggestedSeconds: suggestedSeparationS,
      minSeconds: gaps.length ? Math.min(...gaps.map((g) => g.seconds)) : separationS,
      maxSeconds: gaps.length ? Math.max(...gaps.map((g) => g.seconds)) : separationS,
      groundM: gaps.length ? gaps[0].groundM : 0,  // eerste tussenruimte
      airM: gaps.length ? gaps[0].airM : 0,
      speedMs: separationSpeed(tri.groundVelocity, windOpen, o.separationMode),
      mode: o.separationMode,
      gaps,
      sizes,
    },
    greenLight: {
      nm: mToNm(greenM),
      suggestedNm: mToNm(suggestedGreenM),
      centeredNm: mToNm(centeredGreenM),            // het midden van de exits op de spot (maximale marge)
      exitDelayS: o.exitDelayS,
      suggestedMarginM: marginAt(suggestedGreenM),  // kleinste marge (incl. vertraagd scenario) bij het voorstel
      funnel,                                       // {requested, feasible, maxExits}: trechter gevraagd en of die past
      maxExits,                                     // tot hoeveel exits het voorstel wél past (= exits als alles past)
      marginM: marginAt(greenM),                    // idem bij het gebruikte groene licht (handmatig of voorstel)
      // positief = rechts van de track; bij de trechter komt funnelMarginM erbij, zodat de lijn verder bovenwinds ligt
      suggestedOffsetNm: mToNm(suggestedCrossM + (o.funnel ? Math.sign(suggestedCrossM || 1) * o.funnelMarginM : 0)),
      suggestedOffsetBearingDeg: normalizeDeg(trackDeg + (suggestedCrossM >= 0 ? 90 : -90)), // kompasrichting van de verschuiving
      offsetAdvice: {
        // het offsetadvies zónder voorkeurszijde: de grootst mogelijke marge. Blijft naast het advies
        // staan, zodat te zien is wat de verschuiving naar de voorkeurszijde aan marge kost.
        maxMarginNm: mToNm(maxMarginCrossM),
        maxMarginBearingDeg: normalizeDeg(trackDeg + (maxMarginCrossM >= 0 ? 90 : -90)),
        preferSide,   // null = geen voorkeurszijde; anders {deg, floorM, feasible, shiftM, marginM, maxMarginM}
      },
      point: toLatLng(greenPoint),
    },
    area: {
      radiusNm: o.parachuteAreaNm,
      maxDistanceNm: mToNm(areaMaxM),
      fits: areaMaxM <= areaRadiusM,
      worst: areaWorst,                          // welke exit er het verst buiten ligt, en of dat de exit of de opening is
    },
    canopy: {
      driftM: Dc,
      radiusM,
      timeS: Math.max(0, openAltM - patternAltM) / descentMs,
      delayPerExitM: delayM,   // hoeveel verder exit i ligt per exit vertraging (GS · exitDelayS); voor de reservecontour op de kaart
      allReachTarget: exits.every((e) => e.canopy.reachesTarget),
      // krapste exit: kleinste marge (negatief = haalt de bak niet)
      tightest: exits.reduce((t, e) => (t === null || e.canopy.marginM < t.marginM ? { n: e.n, marginM: e.canopy.marginM, target: e.canopy.tightTarget } : t), null),
    },
    exits,
  };
}
