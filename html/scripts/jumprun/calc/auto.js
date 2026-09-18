/**
 * Welke koers de automatische jumprun krijgt.
 *
 * computeJumprun() kiest zonder opgegeven koers de richting tegen de gemiddelde valwind in. Dat is
 * het rekenkundige antwoord, maar niet wat er gevlogen wordt: een dropzone heeft baanrichtingen,
 * een piloot voert hele graden in, en een lage run hoort meestal dezelfde kant op te gaan als de
 * hoge. Die afwegingen stonden in het scherm waar je de jumprun maakt, en daarmee waren ze alleen
 * daar beschikbaar - terwijl ze precies de kern zijn van "wat is nu de beste run".
 *
 * Hier staan ze los van elk scherm, zodat het beheerscherm en alles wat er verder mee wil rekenen -
 * een bot die een jumprun publiceert, bijvoorbeeld - tot dezelfde uitkomst komen. Wie de regel
 * verandert, verandert hem voor allebei.
 *
 * Alles wat nodig is komt als argument binnen: geen state, geen voorkeuren uit de browser, niets
 * dat alleen in een tabblad bestaat.
 */

import { computeJumprun, funnelTracks } from './jumprun.js';
import { gridOffset as offsetOnGrid } from './offset-grid.js';
import { destination } from './geo.js';
import { NM } from './units.js';

/** Hoeveel de windrichting op de lage exithoogte mag afwijken van die op de hoge voordat de lage run
 *  zijn eigen kant op gaat. Alleen de richting telt, niet de sterkte. */
export const LOW_RUN_DIR_DIFF_DEG = 60;

const normalise = (deg) => (((deg % 360) + 360) % 360);

/** Het verschil tussen twee richtingen, 0 tot 180. */
function apart(a, b) {
	return Math.abs(normalise(a - b + 180) - 180);
}

/** De voorkeurskoers die het dichtst bij deze richting ligt. Handmatig slepen snapt niet; dit geldt
 *  alleen voor de koers die vanzelf gekozen wordt. */
export function snapToTracks(deg, tracks) {
	let best = null;
	for (const track of tracks) {
		const distance = apart(track, deg);
		if (best === null || distance < best.distance) {
			best = { track, distance };
		}
	}
	return best ? best.track : deg;
}

/**
 * De jumprun zoals hij er automatisch uitkomt.
 *
 * @param input    de invoer voor computeJumprun, met trackDeg weggelaten. Staat er wel een koers in,
 *                 dan is er niets te kiezen en wordt die gebruikt.
 * @param options.preferredTracks  baanrichtingen in ware graden; leeg als de dropzone er geen heeft
 * @param options.trackStep        afronding van de magnetische koers in graden (10, 5, of 0 = uit)
 * @param options.funnel           trechter: haaks op de drift in plaats van tegen de wind in
 * @param options.highExitAltFt    exithoogte van de hoge run; alleen nodig voor de regel hieronder
 * @param options.lowRunRule       laat een lage run de koers van de hoge volgen zolang de wind daar
 *                                 niet wezenlijk anders staat
 * @returns het resultaat van computeJumprun, met .input erbij: de invoer die deze uitkomst gaf,
 *          inclusief de koers die er werkelijk uit kwam, zodat een ander ermee verder kan rekenen
 */
export function computeAuto(input, options = {}) {
	const tracks = options.preferredTracks || [];
	const step = options.trackStep === undefined ? 10 : options.trackStep;
	const declination = input.magneticDeclinationDeg || 0;

	let result = computeJumprun(input);

	if (input.trackDeg === undefined && options.funnel) {
		/* Trechter: haaks op de totale drift, dus vaste baanrichtingen tellen hier niet. Van de twee
		   kanten die dat oplevert de koers die het dichtst bij een voorkeurskoers ligt, en anders de
		   laagste magnetische koers - een keuze die niet van de wind afhangt, zodat hij niet heen en
		   weer springt bij elke verversing. */
		const candidates = funnelTracks(result);
		let track = tracks.length
			? candidates.reduce((best, candidate) => (
				Math.min(...tracks.map((t) => apart(candidate, t)))
					< Math.min(...tracks.map((t) => apart(best, t))) ? candidate : best))
			: candidates.reduce((a, b) => (normalise(b - declination) < normalise(a - declination) ? b : a));
		if (step > 0) {
			track = normalise(Math.round(normalise(track - declination) / step) * step + declination);
		}
		result = computeJumprun({ ...input, trackDeg: track });
	} else if (input.trackDeg === undefined && tracks.length) {
		/* De dropzone heeft baanrichtingen: tegen de wind in, en dan naar de dichtstbijzijnde daarvan. */
		let snapped = snapToTracks(result.trackDeg, tracks);
		if (options.lowRunRule && options.highExitAltFt && input.exitAltFt < options.highExitAltFt) {
			/* Een lage run volgt de hoge, tenzij de wind daar echt anders staat. Twee groepen die
			   kort na elkaar uit verschillende richtingen komen is verwarrender dan een lage run die
			   niet precies tegen de wind in gaat. */
			const high = computeJumprun({
				...input,
				exitAltFt: options.highExitAltFt,
				openAltFt: Math.min(input.openAltFt, options.highExitAltFt - 500),
				trackDeg: undefined,
			});
			if (apart(result.windAtExit.fromDeg, high.windAtExit.fromDeg) <= LOW_RUN_DIR_DIFF_DEG) {
				/* De koers waarop de hoge run uitkomt, dus mét de baanrichting erbij. Zonder dat
				   afronden volgde de lage run de ruwe windkoers van de hoge en lag hij een graad of
				   twee naast de hoge run - precies wat deze regel wil voorkomen. */
				snapped = snapToTracks(high.trackDeg, tracks);
			}
		}
		if (snapped !== result.trackDeg) {
			result = computeJumprun({ ...input, trackDeg: snapped });
		}
	} else if (input.trackDeg === undefined && step > 0) {
		/* Geen baanrichtingen: tegen de wind in, afgerond zoals de piloot hem invoert. */
		const magnetic = normalise(Math.round(result.trackMagneticDeg / step) * step);
		const trueDeg = normalise(magnetic + declination);
		if (Math.abs(trueDeg - result.trackDeg) > 0.01) {
			result = computeJumprun({ ...input, trackDeg: trueDeg });
		}
	}

	/* De invoer die deze uitkomst opleverde, met de koers die er daadwerkelijk uit kwam. Wie dit
	   bewaart kan de lijn later exact zo terugtekenen, en hem naast een andere wind leggen. */
	result.input = { ...input, trackDeg: result.trackDeg, profile: undefined };
	return result;
}


/* ------------------------------------------------------------------ de offset

   Waar de lijn naast de bak komt te liggen. Het rekenhart geeft een advies - de verschuiving met de
   grootste marge - maar dat is een getal met alle cijfers erachter, en een dropzone spreekt zijn
   offset uit in stappen: een tiende zeemijl noord, oost, zuid of west, of bij de polaire notatie in
   graden. Daar komt de voorkeurszijde bij: sommige velden willen de lijn liever aan de ene kant van
   de bak, en dan mag hij die kant op zolang de marge het toelaat.

   Stond ook in het scherm; staat hier om dezelfde reden als de koers hierboven. */

const DIR_DEG = { N: 0, E: 90, S: 180, W: 270, O: 90, Z: 180 };
const cardinal = (deg) => ['N', 'E', 'S', 'W'][Math.round(normalise(deg) / 90) % 4];
const dirDeg = (d) => (typeof d === 'number' ? d : DIR_DEG[d] ?? 0);
const opposite = (d) => (typeof d === 'number' ? (d + 180) % 360 : cardinal(dirDeg(d) + 180));
const shownMargin = (r) => Math.min(r.canopy.tightest ? r.canopy.tightest.marginM : Infinity, r.greenLight.marginM);

/**
 * De offset zoals de dropzone hem uitspreekt.
 *
 * @param result    een berekening zonder offset, om het advies uit te lezen
 * @param options.landing    de bak, om vanaf te verschuiven
 * @param options.notation   'offset' (N/O/Z/W per tiende zeemijl) of 'polar' (vrije richting)
 * @param options.compute    (punt) => berekening; alleen nodig als er een voorkeurszijde is, om te
 *                           controleren of de verschuiving daarheen nog voor iedereen uitkomt
 * @returns {nm, dir} met dir als windstreek of als graden, afhankelijk van de notatie
 */
export function computeAutoOffset(result, options = {}) {
	const mode = options.notation === 'polar' ? 'free' : 'cardinal';
	const advice = result.greenLight.offsetAdvice && result.greenLight.offsetAdvice.preferSide;
	const away = advice && advice.feasible ? advice.deg : null;
	let off = offsetOnGrid(result.greenLight.suggestedOffsetNm, result.greenLight.suggestedOffsetBearingDeg, mode, away);
	if (away === null || !options.compute || !options.landing) {
		return off;
	}
	/* Naar de voorkeurszijde toe zolang het kan: per tiende zeemijl kijken of iedereen het veld nog
	   haalt, en anders een stap terug. Drie stappen is genoeg; verder opschuiven levert niets meer op
	   dan een lijn die voor niemand meer uitkomt. */
	for (let step = 0; step < 3; step++) {
		const point = off.nm > 0 ? destination(options.landing, dirDeg(off.dir), off.nm * NM) : options.landing;
		const got = options.compute(point);
		if (got.canopy.allReachTarget && shownMargin(got) >= advice.floorM) {
			break;
		}
		const closer = Math.cos((dirDeg(off.dir) - away) * Math.PI / 180) > 0 ? -0.1 : 0.1;
		const nm = Math.round((off.nm + closer) * 10) / 10;
		off = nm < 0 ? { nm: Math.abs(nm), dir: opposite(off.dir) } : { ...off, nm };
	}
	return off;
}
