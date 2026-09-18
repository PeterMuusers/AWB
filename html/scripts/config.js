/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { createSystemMessage } from './functions.js';

const CONFIG_URL = './config.json';
const THEME_ELEMENT = 'theme-stylesheet';
const THEME_DEFAULT = 'navy';
/* De thema's die met het bord meekomen; iets anders in de config wordt genegeerd in plaats van tot
   een pad gemaakt, zodat een typefout geen stylesheet van een onverwachte plek kan ophalen.

   De eerste drie horen bij de tegelindeling. De vijf daarachter zijn de oorspronkelijke thema's;
   die hoorden bij de oude indeling en waren een tijdlang onbereikbaar, want applyTheme plakte er
   "jumprun-" voor. Ze werken op classic.html. */
const THEMES = ['dark', 'light', 'navy'];
const CLASSIC_THEMES = ['blue-blue', 'dark-blue', 'dark-grey', 'light-blue', 'light-grey'];

/* Swaps the palette the board draws itself in. The name comes from the config; the layout sheet
   that follows it is the same for every theme, so only the colours change. */
function applyTheme(name) {
	var element = document.getElementById(THEME_ELEMENT);
	if (!element) {
		return;
	}
	if (typeof name === 'string' && CLASSIC_THEMES.indexOf(name) !== -1) {
		/* een van de oorspronkelijke thema's: die staan onder hun eigen naam en zonder voorvoegsel */
		element.href = 'css/' + name + '.css';
		return;
	}
	var theme = (typeof name === 'string' && THEMES.indexOf(name) !== -1) ? name : THEME_DEFAULT;
	if (theme !== name && name !== undefined) {
		console.warn('Unknown theme "' + name + '", falling back to ' + THEME_DEFAULT + '.');
	}
	element.href = 'css/jumprun-' + theme + '.css';
}

async function loadConfig(location) {
    if (location === null) {
        var url = CONFIG_URL;
    } else {
        var url = './config-' + location + '.json';
    }
	/* Fetch data from the API. Nooit uit de cache: dit bestand bevat de instellingen van dit bord, en
	   wie er iets in verandert verwacht dat na een herstart te zien - niet pas nadat de browser zijn
	   eigen kopie vergeten is. */
	document.config = await fetch(
		url,
		{
			cache: 'no-store',
			headers: {
				Accept: 'application/json',
			},
		}
	).then(response => {
		if (response.ok === true) {
			return response.json();
		} else {
			console.warn('Returned HTTP error ' + response.status + ' (' + response.statusText + ')');
			return null;
		}
	}).then(data => {
		if (data === null) {
			createSystemMessage('Configuration file not found.');
		}
		return data;
	}).catch((error) => {
		console.error(error);
		createSystemMessage('Could not load configuration file.');
	});
}

export { applyTheme, loadConfig };
