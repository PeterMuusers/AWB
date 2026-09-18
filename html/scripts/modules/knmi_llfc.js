/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */
/* jshint esversion: 6 */ 

import { DATE_OPTIONS_UTC, DATE_OPTIONS_LOCAL, UNIT_CELCIUS, UNIT_FEET } from '../const.js';
import { localiseTimes } from '../functions.js';
import { LANGUAGE_SOURCE, LANGUAGE_LAST_UPDATED, LANGUAGE_UPDATED_INLINE, LANGUAGE_REWRITTEN, LANGUAGE_VALID_UNTIL, LANGUAGE_VALID_FOR } from '../language.js';

const SOURCE = 'KNMI';
/* How far the forecast text may be scaled down to keep the board inside the screen, and in what
   steps. Below this the text stops being readable from across the hangar, and a bulletin that long
   is better left slightly clipped than shrunk into nothing. */
const FIT_MIN_SCALE = 0.72;
const FIT_STEP = 0.04;
/* De herschreven versie van het bulletin. Geen adres dat iets uitrekent maar een gewoon bestand:
   een timer op de Pi haalt het bulletin zelf op en zet het antwoord van Claude hier klaar. Zo is er
   geen weg van buiten naar de API, en hoeft dit bord alleen te lezen. */
const REWRITE_URL = './llfc.json';

const ID_LLFC_SOURCE_LABEL = 'llfc-source-label';
const ID_LLFC_SOURCE_DATA = 'llfc-source-data';
const ID_LLFC_LAST_UPDATED_LABEL = 'llfc-last-updated-label';
const ID_LLFC_LAST_UPDATED_SPINNER = 'llfc-last-updated-spinner';
const ID_LLFC_LAST_UPDATED_WARNING = 'llfc-last-updated-warning';
const ID_LLFC_CONTENT = 'llfc-content';
const ID_LLFC_SITUATION = 'llfc-situation-data';
const ID_LLFC_SIGNIFICANT_WEATHER = 'llfc-significant-weather-data';
const ID_LLFC_WINDS = 'llfc-winds-data';
const ID_LLFC_CLOUDS = 'llfc-clouds-data';
const ID_LLFC_THERMALS = 'llfc-thermals-data';
const ID_LLFC_FORECAST = 'llfc-forecast-data';

const ID_VALID_FROM = 'llfc-valid-from';
const ID_LAST_UPDATED = 'llfc-last-updated';

const LLFC_ITEMS = [
	'Geldig',
	'Situatie',
	'Significant weer',
	'Wind',
	'Bewolking',
	'Zicht',
	'Nulgraden niveau',
	'Hoogtewinden en temperaturen',
	'Thermiek',
	'Max. temperatuur',
	'Vooruitzichten',
	'Daglichtperiode',
];

const UPPERCASES = {
//	'few/sct': 'FEW/SCT',
//	'sct/bkn': 'SCT/BKN',
//	'bkn/ovc': 'BKN/OVC',
	'cavok': 'CAVOK',
	'utc': 'UTC',
	'vfr': 'VFR',
	' nm': ' NM',
	' fir': ' FIR',
//	' few': ' FEW',
//	' sct': ' SCT',
//	' bkn': ' BKN',
//	' ovc': ' OVC',
//	'Few': 'FEW',
//	'Sct': 'SCT',
//	'Bkn': 'BKN',
//	'Ovc': 'OVC',
	' fl0': ' FL0',
	' fl1': ' FL1',
	' Fl0': ' FL0',
	' Fl1': ' FL1',
	'-fl0': '-FL0',
	'-fl1': '-FL1',
	'-Fl0': '-FL0',
	'-Fl1': '-FL1',
	'celcius': 'Celcius',
	'geisoleerde': 'geïsoleerde',
	'georienteerd': 'georiënteerd',
	'orientatie': 'oriëntatie',
	'groningen': 'Groningen',
	'friesland': 'Friesland',
	'drenthe': 'Drenthe',
	'overijssel': 'Overijssel',
	'gelderland': 'Gelderland',
	'flevoland': 'Flevoland',
	'noord holland': 'Noord Holland',
	'zuid holland': 'Zuid Holland',
	'holland': 'Holland',
	'zeeland': 'Zeeland',
	'noord brabant': 'Noord Brabant',
	'brabant': 'Brabant',
	'limburg': 'Limburg',
	'texel': 'Texel',
	'vlieland': 'Vlieland',
	'terschelling': 'Terschelling',
	'ameland': 'Ameland',
	'schiermonnikoog': 'Schiermonnikoog',
	'achterhoek': 'Achterhoek',
	'alpen': 'Alpen',
	'arnhem': 'Arnhem',
	'atlantische oceaan': 'Atlantische Oceaan',
	'atlantisch': 'Atlantisch',
	'azoren': 'Azoren',
	'baltische staten': 'Baltische Staten',
	'baltische': 'Baltische',
	'belgie': 'België',
	'benelux': 'Benelux',
	'bretagne': 'Bretagne',
	'britse eilanden': 'Britse Eilanden',
	'britse': 'Britse',
	'centraal europa': 'Centraal Europa',
	'centraal-europa': 'Centraal-Europa',
	'de kooij': 'De Kooij',
	'den haag': 'Den Haag',
	'denemarken': 'Denemarken',
	'duitsland': 'Duitsland',
	'duitse bocht': 'Duitse Bocht',
	'duitse': 'Duitse',
	'eindhoven': 'Eindhoven',
	'engeland': 'Engeland',
	'engelse': 'Engelse',
	'europa': 'Europa',
	'finland': 'Finland',
	'frankrijk': 'Frankrijk',
	'groot-brittannie': 'Groot-Brittannië',
	'golf van biscaje': 'Golf van Biscaje',
	'golf van biskaje': 'Golf van Biskaje',
	'ierland': 'Ierland',
	'ierse': 'Ierse',
	'ijsland': 'IJsland',
	'ijsselmeer': 'IJsselmeer',
	'leeuwarden': 'Leeuwarden',
	'lille': 'Lille',
	'nederland': 'Nederland',
	'noorse': 'Noorse',
	'noordzee': 'Noordzee',
	'noorwegen': 'Noorwegen',
	'normandie': 'Normandië',
	'oostenrijk': 'Oostenrijk',
	'oostzee': 'Oostzee',
	'polen': 'Polen',
	'rusland': 'Rusland',
	'scandinavie': 'Scandinavië',
	'schotland': 'Schotland',
	'shetlandeilanden': 'Shetlandeilanden',
	'skagerrak': 'Skagerrak',
	'tilburg': 'Tilburg',
	'tsjechie': 'Tsjechië',
	'twente': 'Twente',
	'veluwe': 'Veluwe',
	'verenigd koninkrijk': 'Verenigd Koninkrijk',
	'waddeneilanden': 'Waddeneilanden',
	'waddengebied': 'Waddengebied',
	'waddenzee': 'Waddenzee',
	'wadden': 'Wadden',
	'wales': 'Wales',
	'zweden': 'Zweden',
	' noord-': ' Noord-',
	' oost-': ' Oost-',
	' west-': ' West-',
	' zuid-': ' Zuid-',
	' noordoost-': ' Noordoost-',
	' noordwest-': ' Noordwest-',
	' zuidoost-': ' Zuidoost-',
	' zuidwest-': ' Zuidwest-',
	' ehad': ' EHAD',
	' ehal': ' EHAL',
	' eham': ' EHAM',
	' ehbd': ' EHBD',
	' ehbk': ' EHBK',
	' ehdb': ' EHDB',
	' ehdl': ' EHDL',
	' ehdp': ' EHDP',
	' ehdr': ' EHDR',
	' ehds': ' EHDS',
	' ehdv': ' EHDV',
	' eheh': ' EHEH',
	' ehfs': ' EHFS',
	' ehgg': ' EHGG',
	' ehgr': ' EHGR',
	' ehha': ' EHHA',
	' ehho': ' EHHO',
	' ehhv': ' EHHV',
	' ehkd': ' EHKD',
	' ehle': ' EHLE',
	' ehlw': ' EHLW',
	' ehmc': ' EHMC',
	' ehmm': ' EHMM',
	' ehmz': ' EHMZ',
	' ehmm': ' EHMM',
	' ehnd': ' EHND',
	' ehnp': ' EHNP',
	' ehnr': ' EHNR',
	' ehow': ' EHOW',
	' ehrd': ' EHRD',
	' ehsb': ' EHSB',
	' ehse': ' EHSE',
	' ehst': ' EHST',
	' ehte': ' EHTE',
	' ehtL': ' EHTL',
	' ehts': ' EHTS',
	' ehtw': ' EHTW',
	' ehtx': ' EHTX',
	' ehvb': ' EHVB',
	' ehve': ' EHVE',
	' ehvk': ' EHVK',
	' ehvl': ' EHVL',
	' ehwo': ' EHWO',
	'-ehal': '-EHAL',
	'-eham': '-EHAM',
	'-ehbd': '-EHBD',
	'-ehbk': '-EHBK',
	'-ehdb': '-EHDB',
	'-ehdl': '-EHDL',
	'-ehdp': '-EHDP',
	'-ehdr': '-EHDR',
	'-ehds': '-EHDS',
	'-eheh': '-EHEH',
	'-ehfs': '-EHFS',
	'-ehgg': '-EHGG',
	'-ehgr': '-EHGR',
	'-ehho': '-EHHO',
	'-ehhv': '-EHHV',
	'-ehkd': '-EHKD',
	'-ehle': '-EHLE',
	'-ehlw': '-EHLW',
	'-ehmc': '-EHMC',
	'-ehmm': '-EHMM',
	'-ehmz': '-EHMZ',
	'-ehmm': '-EHMM',
	'-ehnd': '-EHND',
	'-ehnp': '-EHNP',
	'-ehow': '-EHOW',
	'-ehrd': '-EHRD',
	'-ehsb': '-EHSB',
	'-ehse': '-EHSE',
	'-ehst': '-EHST',
	'-ehte': '-EHTE',
	'-ehtL': '-EHTL',
	'-ehts': '-EHTS',
	'-ehtw': '-EHTW',
	'-ehtx': '-EHTX',
	'-ehvb': '-EHVB',
	'-ehve': '-EHVE',
	'-ehvk': '-EHVK',
	'-ehvl': '-EHVL',
	'-ehwo': '-EHWO',
	'nnw-zzo': 'NNW-ZZO',
	'wnw-ozo': 'WNW-OZO',
	'nno-zzw': 'NNO-ZZW',
	'ono-wzw': 'ONO-WZW',
	'ozo-wnw': 'OZO-WNW',
	'zzo-nnw': 'ZZO-NNW',
	'wnw-ono': 'WNW-ONO',
	'wzw-ono': 'WZW-ONO',
	'zzw-nno': 'ZZW-NNO',
	'nw-zo': 'NW-ZO',
	'no-zw': 'NO-ZW',
	'zw-no': 'ZW-NO',
	'zo-nw': 'ZO-NW',
	'n-z': 'N-Z',
	'z-n': 'Z-N',
	'w-o': 'W-O',
	'o-w': 'O-W',
	' nw ': ' NW ',
	' no ': ' NO ',
	' zw ': ' ZW ',
	' zo ': ' ZO ',
	' nw-': ' NW-',
	' no-': ' NO-',
	' zw-': ' ZW-',
	' zo-': ' ZO-',
	'ono': 'ONO',
	'ozo': 'OZO',
	'wnw': 'WNW',
	'wzw': 'WZW',
	'zzo': 'ZZO',
	'zzw': 'ZZW',
	' ac ': ' AC ',
	' as ': ' AS ',
	' cb ': ' CB ',
	' cu ': ' CU ',
	' ns ': ' NS ',
	' nsc ': ' NSC ',
	' sc ': ' SC ',
	' st ': ' ST ',
	' tcu ': ' TCU ',
	' ac-': ' AC-',
	' as-': ' AS-',
	' cb-': ' CB-',
	' cu-': ' CU-',
	' ns-': ' NS-',
	' nsc- ': ' NSC- ',
	' sc-': ' SC-',
	' st-': ' ST-',
	' tcu-': ' TCU-',
	' ac,': ' AC,',
	' as,': ' AS,',
	' cb,': ' CB,',
	' (cb),': ' (CB),',
	' cu,': ' CU,',
	' ns,': ' NS,',
	' nsc, ': ' NSC, ',
	' sc,': ' SC,',
	' st,': ' ST,',
	' tcu,': ' TCU,',
	' ac.': ' AC.',
	' as.': ' AS.',
	' cb.': ' CB.',
	' cu.': ' CU.',
	' ns.': ' NS.',
	' nsc. ': ' NSC. ',
	' sc.': ' SC.',
	' st.': ' ST.',
	' tcu.': ' TCU.',
	' cb\'': ' CB\'',
	'ac/as': 'AC/AS',
	'ac/sc': 'AC/SC',
	'ac/sc/ns': 'AC/SC/NS',
	'as/ac': 'AS/AC',
	'as/ns': 'AS/NS',
	'as/sc': 'AS/SC',
	'cb/tcu': 'CB/TCU',
	'cu/ac': 'CU/AC',
	'cu/sc': 'CU/SC',
	'ns/sc': 'NS/SC',
	'ns/st': 'NS/ST',
	'sc/ac': 'SC/AC',
	'sc/as': 'SC/AS',
	'sc/cu': 'SC/CU',
	'sc/ns': 'SC/NS',
	'sc/st': 'SC/ST',
	'st/ns': 'ST/NS',
	'st/sc': 'ST/SC',
	'tcu/cb': 'TCU/CB',
};

const ALERTWORDS= [
    'ijsaanzetting',
    'onweersbuien',
    'onweer',
];

class Module {
	constructor() {
		this.url = 'https://www.knmi.nl/nederland-nu/luchtvaart/weerbulletin-kleine-luchtvaart';
		this.user_agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0';
		this.cors_proxy_url = 'cors-proxy.php';
		/* Vaker kijken kost niets meer sinds de vraag voorwaardelijk is: onveranderd is 304 en nul
		   bytes. Het KNMI zet er zelf twee minuten cache op, dus vijf minuten is netjes en betekent
		   dat een nieuw bulletin binnen vijf minuten op het bord staat. */
		this.refreshInterval = 5 * 60 * 1000;
		this.etag = null;

		this.llfc = null;
		this.llfc_items = {};
		this.rewrite = ((document.config.llfc || {}).mode === 'ai');
		this.valid_from = null;
		this.last_updated = null;

		/* Set language specific stuff */
		document.getElementById(ID_LLFC_SOURCE_LABEL).innerHTML = LANGUAGE_SOURCE;
		document.getElementById(ID_LLFC_SOURCE_DATA).innerHTML = SOURCE;
		/* Deze module draait op allebei de pagina's. In de tegelindeling staat dit achter de bron in
		   de kopbalk, op de oorspronkelijke pagina onder het paneel - en daar hoort het te blijven
		   staan zoals het stond. */
		document.getElementById(ID_LLFC_LAST_UPDATED_LABEL).innerHTML = document.querySelector('.sources')
			? LANGUAGE_UPDATED_INLINE : LANGUAGE_LAST_UPDATED;

		/* Schedule update of document content */
		this.task = setInterval(
			this.updateData.bind(this),
			this.refreshInterval
		);

		/* A different screen means a different amount of room for the same text. The web fonts
		   arrive after the first paint as well, and they change how much space the text takes. */
		window.addEventListener('resize', this.fit.bind(this));
		if (document.fonts && document.fonts.ready) {
			document.fonts.ready.then(this.fit.bind(this));
		}
		/* And the cards above this one grow when their own sources come in, long after the forecast
		   was laid out: a line about gloves under the freezing level takes room away from here. */
		this.watchCardsAbove();

		/* Initial fill of document content */
		this.updateData();
	}

	/* What the header says after the moment the bulletin was issued. The KNMI writes the GELDIG
	   line in two forms: a pair of UTC stamps on a bulletin that runs for a set number of hours,
	   and a sentence naming a daylight period on the one issued in the evening for the next day.
	   The first becomes a closing time in local time; the second keeps the words of the bulletin,
	   because a daylight period has no single hour to put there. */
	validityText() {
		var validity = this.validity();
		if (validity !== null) {
			var clock = when => when.toLocaleTimeString(document.config.locale, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
			return LANGUAGE_VALID_UNTIL + ' ' + clock(validity.until);
		}
		var item = this.llfc_items ? this.llfc_items['GELDIG'] : null;
		if (item === null || item === undefined) {
			return null;
		}
		/* "Voor: de daglichtperiode van donderdag 17 september 2026." leaves the period itself; the
		   year says nothing on a board that only ever shows today and tomorrow */
		var text = String(item).replace(/^\s*voor:?\s*/i, '').replace(/\s*\.\s*$/, '').replace(/\s+\d{4}$/, '').trim();
		return (text === '') ? null : LANGUAGE_VALID_FOR + ' ' + text;
	}

	/* When this bulletin was issued: the six digits after EHDB, day-hour-minute in UTC. The same
	   string the rewrite carries, and the only thing the two have to agree on. */
	issued() {
		var match = this.llfc ? /EHDB (\d{6})/.exec(this.llfc) : null;
		return (match === null) ? null : match[1];
	}

	/* The period the bulletin applies to, from the GELDIG line: DDHHMM/DDHHMM in UTC. Converted
	   here rather than by the model, because this is arithmetic and the board shows local time. */
	validity() {
		var item = this.llfc_items ? this.llfc_items['GELDIG'] : null;
		var match = item ? /(\d{2})(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})/.exec(item) : null;
		if (match === null) {
			return null;
		}
		var now = new Date();
		var moment = (day, hour, minute) => {
			var when = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Number(day), Number(hour), Number(minute)));
			/* a day number far in the past belongs to the next month */
			if (when.getTime() - now.getTime() < -20 * 24 * 3600 * 1000) {
				when.setUTCMonth(when.getUTCMonth() + 1);
			}
			return when;
		};
		return { from: moment(match[1], match[2], match[3]), until: moment(match[4], match[5], match[6]) };
	}

	/* The forecast takes whatever the cards above it leave over, so it has to be laid out again
	   when one of them changes height. Watching them is cheaper and steadier than measuring on a
	   timer, and setting this card's own height does not resize them, so it cannot feed back. */
	watchCardsAbove() {
		var content = document.getElementById(ID_LLFC_CONTENT);
		var card = content ? content.closest('.llfc') : null;
		if (!card || !card.parentElement || typeof ResizeObserver === 'undefined') {
			return;
		}
		var observer = new ResizeObserver(() => this.fit());
		Array.prototype.forEach.call(card.parentElement.children, sibling => {
			if (sibling !== card) {
				observer.observe(sibling);
			}
		});
	}

	/* The board hangs on a 16:9 screen that nobody scrolls, so the forecast has to end above the
	   bottom edge. The tiles already flow into columns, which is enough for almost every bulletin;
	   on a long one the text of this card is scaled down a step at a time until the page is no
	   taller than the screen. Only this card scales: the measurements and the wind profile are
	   numbers you read at a glance and they keep their size. */
	fit() {
		var content = document.getElementById(ID_LLFC_CONTENT);
		var card = content ? content.closest('.llfc') : null;
		if (!card) {
			return;
		}
		/* measure against the natural height of the tiles, so let the card find its own size first */
		card.style.height = '';
		content.style.removeProperty('--llfc-scale');

		var available = this.room(content, card);
		var scale = 1;
		while (content.getBoundingClientRect().height > available && scale > FIT_MIN_SCALE) {
			scale -= FIT_STEP;
			content.style.setProperty('--llfc-scale', scale.toFixed(2));
		}
		if (content.getBoundingClientRect().height > available) {
			console.warn('Forecast does not fit at ' + Math.round(scale * 100) + '% and is cut off at the bottom.');
		}

		/* and then down to the bottom edge of the screen, so the card fills its half */
		var style = window.getComputedStyle(card);
		var height = window.innerHeight - card.getBoundingClientRect().top
			- parseFloat(style.marginBottom) - this.pageMargin();
		card.style.height = Math.max(height, 0) + 'px';
	}

	/* The height the tiles may take: from where they start down to the bottom edge of the screen,
	   less the room the card needs underneath them for its border and its padding. Where the source
	   and the update time used to sit there is now nothing: those moved to the header, so this card
	   keeps that space. */
	room(content, card) {
		var style = window.getComputedStyle(card);
		var below = parseFloat(style.paddingBottom)
			+ parseFloat(style.borderBottomWidth) + parseFloat(style.marginBottom);
		return window.innerHeight - content.getBoundingClientRect().top - below - this.pageMargin();
	}

	/* What the page keeps free below the cards */
	pageMargin() {
		var style = window.getComputedStyle(document.body);
		return (parseFloat(style.marginBottom) || 0) + (parseFloat(style.paddingBottom) || 0);
	}

	/* The subjects of the bulletin to show, in the order of the config. The key used to be called
	   knmi_gafor while this module has always read knmi_llfc, which left the card empty and threw
	   on every update. The old name is still accepted, because a config file that is already on a
	   board is not replaced by pulling a new version of the code. */
	subjects() {
		var configured = document.config.knmi_llfc || document.config.knmi_gafor;
		return Array.isArray(configured) ? configured : [];
	}

	/* The bulletin as the KNMI writes it, item by item */
	showBulletin() {
		var content = '';
		var subjects = this.subjects();
		/* De geldigheid staat al in de kop van de tegel, achter het tijdstip van uitgifte. Hem hier
		   ook als blok tonen is dezelfde zin twee keer, en in de ruwe vorm ("181500/182100 UTC")
		   bovendien de minst leesbare van de twee. */
		var inHeader = (this.validityText() !== null);
		for (var i = 0; i < subjects.length; i++) {
			if (inHeader && subjects[i].toUpperCase() === 'GELDIG') {
				continue;
			}
			var item = this.llfc_items[subjects[i].toUpperCase()];
			if (item !== null && item !== undefined) {
				content += '<div class=llfc-item><span class="llfc-item-header">' + subjects[i] + '</span><span class="llfc-item-text">' + item + '</span></div>';
			}
		}
		document.getElementById(ID_LLFC_CONTENT).innerHTML = content;
		document.getElementById(ID_LLFC_SOURCE_DATA).innerHTML = SOURCE;
		this.fit();
	}

	/* The same bulletin in plain language, rewritten on the Pi itself. The bulletin stays on
	   screen until the rewrite arrives, and stays there if it never does - so a Pi without the
	   timer, or without a key, simply shows the bulletin as the KNMI writes it.

	   Het antwoord hoort bij een bepaald bulletin, en dat van de timer kan een paar minuten voor of
	   achter lopen op wat dit bord net ophaalde. Daarom draagt het het uitgiftemoment (de zes
	   cijfers achter EHDB); komt dat niet overeen, dan blijft het bulletin zelf staan tot de
	   volgende ronde. */
	showRewrite() {
		fetch(REWRITE_URL, { cache: 'no-store' }).then(response => {
			if (response.ok !== true) {
				throw new Error('HTTP ' + response.status);
			}
			return response.json();
		}).then(data => {
			if (data.issued && this.issued() !== null && data.issued !== this.issued()) {
				throw new Error('rewrite is van bulletin ' + data.issued + ', dit is ' + this.issued());
			}
			/* the model keeps the UTC times of the bulletin; the board turns them into local time */
			var lines = localiseTimes(data.text, this.valid_from).split('\n').map(line => line.trim()).filter(line => line.length > 0);
			var content = '';
			lines.forEach(line => {
				var colon = line.indexOf(':');
				if (colon > 0 && colon < 30) {
					content += '<div class=llfc-item><span class="llfc-item-header">' + line.slice(0, colon) + '</span><span class="llfc-item-text">' + line.slice(colon + 1).trim() + '</span></div>';
				} else {
					content += '<div class=llfc-item><span class="llfc-item-text">' + line + '</span></div>';
				}
			});
			if (content !== '') {
				document.getElementById(ID_LLFC_CONTENT).innerHTML = content;
				document.getElementById(ID_LLFC_SOURCE_DATA).innerHTML = SOURCE + ' ' + LANGUAGE_REWRITTEN;
				this.fit();
			}
		}).catch(error => {
			/* the bulletin itself is already on screen, so there is nothing to put right */
			console.warn('Rewritten forecast unavailable: ' + error.message);
		});
	}

	updateData() {
		var i, start;

		/* Disable warning icon */
		document.getElementById(ID_LLFC_LAST_UPDATED_WARNING).style.display = 'none';

		/* Enable spinner icon */
		document.getElementById(ID_LLFC_LAST_UPDATED_SPINNER).style.display = 'block';

		/* Update KNMI LLFC data. Met de etag van de vorige keer erbij: is het bulletin niet
		   veranderd, dan antwoordt het KNMI met 304 en nul bytes, en dat kost bijna niets. Zo kan
		   het bord vaker kijken zonder de bron vaker lastig te vallen. */
		var conditional = { 'X-Request-Url': this.url, 'X-User-Agent': this.user_agent };
		if (this.etag) {
			conditional['If-None-Match'] = this.etag;
		}
		fetch(
			this.cors_proxy_url,
			{
				headers: conditional,
				keepalive: true,
				method: 'GET',
				referrerPolicy: 'no-referrer',
			}
		).then(response => {
			if (response.status == 304) {
				/* niets veranderd sinds de vorige keer: het bulletin op het scherm klopt nog */
				this.last_updated = new Date();
				return undefined;
			}
			if (response.status == 200) {
				this.etag = response.headers.get('ETag') || null;
				return response.text();
			}
			console.warn('Returned HTTP error ' + response.status + ' (' + response.statusText + ')');
			return null;
		}).then(data => {
			if (data === undefined) {
				/* Niets veranderd bij het KNMI. Het bulletin op het scherm klopt dus nog, maar de
				   herschreven versie kan er intussen wél bij gekomen zijn: die wordt door een timer op
				   de Pi gemaakt en is een minuut of wat later klaar dan het bulletin zelf. Zonder deze
				   poging blijft het bord tot het volgende bulletin op de ruwe tekst staan. */
				document.getElementById(ID_LLFC_LAST_UPDATED_SPINNER).style.display = 'none';
				document.getElementById(ID_LAST_UPDATED).innerHTML =
					this.last_updated.toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL);
				if (this.rewrite) {
					this.showRewrite();
				}
				return;
			}
			/* Disable spinner icon */
			document.getElementById(ID_LLFC_LAST_UPDATED_SPINNER).style.display = 'none';

			if (data != null) {
				this.last_updated = new Date();

				/* Get contents from the result from allorigins.win and get the LLFC bulletin by slicing off any HTML content*/
				this.llfc = data.slice(data.indexOf('ZCZC'), data.indexOf('</pre>'));

				/* Check if there's a valid LLFC bulletin in the document */
				if (this.llfc.length > 0) {

					/* Get day & time when this bulletin was published */
					this.valid_from = new Date();
					start = this.llfc.indexOf('EHDB ') + 5;
					this.valid_from.setDate(
						Number(this.llfc.slice(start, start + 2))
					);
					this.valid_from.setHours(
						Number(this.llfc.slice(start + 2, start + 4)) - (new Date().getTimezoneOffset() / 60),
						Number(this.llfc.slice(start + 4, start + 6)),
						0
					);

					/* De-compose LLFC */
					this.llfc_items = {};
					start = this.llfc.indexOf('GELDIG ');
					this.llfc_items['GELDIG'] = this.llfc.slice(start + 7, this.llfc.indexOf('\n', start));
					for (i = 0; i < LLFC_ITEMS.length; i++) {
						this.llfc_items[LLFC_ITEMS[i].toUpperCase()] = this.llfc_decompose(LLFC_ITEMS[i].toUpperCase());
					}

					/* Fill document contents, either the bulletin itself or a rewrite of it */
					this.showBulletin();
					if (this.rewrite) {
						this.showRewrite();
					}
					/* issued at, and how long it applies */
					var validity = this.validityText();
					document.getElementById(ID_VALID_FROM).innerHTML = this.valid_from.toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL)
						+ (validity === null ? '' : '<span class="llfc-validity">' + validity + '</span>');
					document.getElementById(ID_LAST_UPDATED).innerHTML = this.last_updated.toLocaleString(document.config.locale, DATE_OPTIONS_LOCAL);
				} else {
					document.getElementById(ID_LLFC_LAST_UPDATED_WARNING).style.display = 'block';
				}
			} else {
				document.getElementById(ID_LLFC_LAST_UPDATED_WARNING).style.display = 'block';
			}

		}).catch((error) => {
			/* Disable spinner icon */
			document.getElementById(ID_LLFC_LAST_UPDATED_SPINNER).style.display = 'none';

			/* Enable warning icon */
			document.getElementById(ID_LLFC_LAST_UPDATED_WARNING).style.display = 'block';

			console.error(error);
		});
	}

	llfc_decompose(component) {
		var i, start, data, sentences, key, result = null;

		start = this.llfc.indexOf('.\n' + component);
		if (start !== -1) {
			/* The 'GELDIG' component doesn't have a ':', so set the start variable to a fixed value of 7 */
			if (component === 'GELDIG') {
				start = this.llfc.indexOf(' ', start) + 1;
			} else {
				start = this.llfc.indexOf(': ', start) + 2;
			}

            /*  */
            data = this.llfc.slice(start, this.llfc.indexOf('\n.\n', start)).toLowerCase().replaceAll('\n', ' ');

            /* Highlight specific words that need extra attention */
			for (key in ALERTWORDS) {
				data = data.replaceAll(ALERTWORDS[key], '<span class="llfc-item-text-alert">' + ALERTWORDS[key] + '</span>');
			}

			/* Make some METAR- and language-specific uppercase changes */
			for (key in UPPERCASES) {
				data = data.replaceAll(key, UPPERCASES[key]);
			}

			/* Start each sentence with an uppercase letter */
			sentences = data.split(". ");
			for (i = 0; i < sentences.length; i++) {
				/* Always make first letter uppercase for the component */
				sentences[0]= sentences[0][0].toUpperCase() + sentences[0].slice(1);
				/* Only transform first letter of sentence to uppercase when it's not preceded by an abbreviation */
				if ((i !== 0) && (sentences[i - 1][sentences[i - 1].length - 2] !== '.')) {
					sentences[i] = sentences[i][0].toUpperCase() + sentences[i].slice(1);
				}
			}

			/* Combine the seperated sentences to one string again */
			result = sentences.join('. ');
		}
		return result;
	}
}

export { Module };
