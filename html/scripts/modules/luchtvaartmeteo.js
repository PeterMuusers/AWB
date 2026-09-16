/* eslint no-tabs: ["error", { allowIndentationTabs: true }] */

import { createSystemMessage } from '../functions.js';

/*
 * KNMI observations from the API behind luchtvaartmeteo.nl (login required).
 * The login (account in the .env file next to the html directory on the server) and the API
 * calls are done server-side by luchtvaartmeteo-proxy.php; this module only fetches
 * the merged result and keeps the newest observation
 * in this.observation (wind_kt, gust_kt, wind_dir, vis_m, base1_ft..base3_ft,
 * okta1..okta3, okta_total, qnh_hpa, temp_c, dewpoint_c, rh_pct, rain_mmh, rain_min10).
 */

const SOURCE = 'luchtvaartmeteo.nl';
const PROXY_URL = './luchtvaartmeteo-proxy.php';
const HTTP_SERVICE_UNAVAILABLE = 503; // the proxy has no (valid) credentials file

class Module {
	constructor(location) {
		this.location = location;
		this.station = document.config.luchtvaartmeteo.station || 'hoogeveen';
		this.refreshInterval = 10 * 60 * 1000; // Refresh interval is 10 minutes

		this.last_updated = null;
		this.observed_at = null;
		this.observation = null;
		this.units = null;

		/* Schedule update of document content */
		this.task = setInterval(
			this.updateData.bind(this),
			this.refreshInterval
		);

		/* Initial fill of document content */
		this.updateData();
	}

	updateData() {
		var url = PROXY_URL + '?action=observations&station=' + encodeURIComponent(this.station);
		if (this.location) {
			url += '&location=' + encodeURIComponent(this.location);
		}

		/* Fetch data from the proxy */
		fetch(
			url,
			{
				keepalive: true,
				headers: {
					Accept: 'application/json',
				},
			}
		).then(response => {
			return response.json().then(data => {
				if (response.ok === true) {
					return data;
				}
				if (response.status === HTTP_SERVICE_UNAVAILABLE) {
					/* Credentials not set on the server: report once and stop polling */
					createSystemMessage(data && data.error ? data.error : 'luchtvaartmeteo.nl credentials not set.');
					clearInterval(this.task);
				}
				console.warn(SOURCE + ': returned HTTP error ' + response.status + ' (' + (data && data.error ? data.error : response.statusText) + ')');
				return null;
			});
		}).then(data => {
			if (data !== null && data.observation) {
				this.last_updated = new Date();
				this.observed_at = data.time ? new Date(data.time) : null;
				this.observation = data.observation;
				this.units = data.units;
				console.log(SOURCE + ' ' + this.station + ' (' + data.time + '):', this.observation);
			}
		}).catch((error) => {
			console.error(error);
		});
	}
}

export { Module };
