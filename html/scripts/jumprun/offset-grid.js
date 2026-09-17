// Het offset-advies op het raster van de notatie.
//
// De rekenkern geeft de offset als dwarsafstand (m) plus de kompasrichting waarin de lijn verschoven
// wordt. Een spot spreek je niet in meters uit maar in tienden van een zeemijl, en bij de kardinale
// notatie ook nog in een van vier richtingen. Dit vertaalt het ene naar het andere.
//
// Kardinaal: kies de kardinale richting die het dichtst bij de dwarsrichting ligt en schaal de afstand
// zo dat de dwárscomponent klopt (cross / cos α). Wat daardoor langs de track bijkomt, vangt het groene
// licht op — dat wordt toch los gekozen.
//
// Afronden: normaal naar de dichtstbijzijnde stap. Maar als het advies uit een voorkeurszijde komt, ligt
// het al precies op de margevloer; naar die kant toe afronden zou de marge er dan onderuit duwen. In dat
// geval wordt altijd van de voorkeurszijde af afgerond, zodat de afronding de marge alleen kan vergroten.

const CARDINALS = { N: 0, E: 90, S: 180, W: 270 };
const MAX_NM = 2;

/**
 * @param crossNm      dwarsafstand (NM, teken doet er niet toe)
 * @param bearingDeg   ware peiling waarin de lijn verschoven wordt
 * @param mode         'cardinal' (N/O/Z/W) of 'free' (vrije peiling, Texel-notatie)
 * @param awayFromDeg  ware peiling van de voorkeurszijde; null = gewoon naar de dichtstbijzijnde stap afronden
 * @returns {nm, dir}  dir is 'N'|'E'|'S'|'W' bij 'cardinal', anders een ware peiling in graden
 */
export function gridOffset(crossNm, bearingDeg, mode = 'cardinal', awayFromDeg = null) {
  const cross = Math.abs(crossNm);
  const snap = (x, offsetDirDeg) => {
    if (awayFromDeg === null || awayFromDeg === undefined) return Math.round(x * 10) / 10;
    const toward = Math.cos(((offsetDirDeg - awayFromDeg) * Math.PI) / 180) > 0;   // offset wijst naar de voorkeurszijde
    return Math.max(0, toward ? Math.floor(x * 10) : Math.ceil(x * 10)) / 10;
  };
  if (mode === 'free') {
    const dir = ((Math.round(bearingDeg) % 360) + 360) % 360;
    return { nm: Math.min(MAX_NM, snap(cross, dir)), dir };
  }
  let best = null;
  for (const [dir, deg] of Object.entries(CARDINALS)) {
    const c = Math.cos(((deg - bearingDeg) * Math.PI) / 180);
    if (best === null || c > best.c) best = { dir, c, deg };
  }
  return { nm: Math.min(MAX_NM, snap(cross / best.c, best.deg)), dir: best.dir };
}
