/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { createSystemMessage } from './functions.js';

const CONFIG_URL = './config.json';
const THEME_ELEMENT = 'theme-stylesheet';
const THEME_DEFAULT = 'dark';
/* the themes that ship with the board; anything else in the config is ignored rather than turned
   into a path, so a typo cannot pull in a stylesheet from somewhere unexpected */
const THEMES = ['dark', 'light', 'navy'];

/* Swaps the palette the board draws itself in. The name comes from the config; the layout sheet
   that follows it is the same for every theme, so only the colours change. */
function applyTheme(name) {
	var element = document.getElementById(THEME_ELEMENT);
	if (!element) {
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
	/* Fetch data from the API */
	document.config = await fetch(
		url,
		{
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
