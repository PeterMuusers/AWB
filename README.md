# Aviation Weather Board
Aviation Weather Board

### How to install (Raspberry Pi)

`curl -s https://raw.githubusercontent.com/eelcohn/AWB/main/rpi/install.sh | sudo bash`

### Keyboard shortcuts

| Key | Description |
|-----|-------------|
|  I  | Show IP address |
|  R  | Force a refresh of weather data |

### Modules

#### KNMI
https://www.knmi.nl/
#### KNMI GAFOR (Weerbulletin voor de kleine luchtvaart)
https://www.knmi.nl/nederland-nu/luchtvaart/weerbulletin-kleine-luchtvaart
#### Luchtvaartmeteo (KNMI observations)
https://www.luchtvaartmeteo.nl/
You'll need a (free) luchtvaartmeteo.nl account to use this module. Copy `.env.example` to `.env` next to the `html` directory (`/var/www/.env` on the Raspberry Pi) and fill in `LVM_EMAIL` and `LVM_PASSWORD`; that file is ignored by git and lives outside the web root, so it is never served to the browser. The login is done server-side by `luchtvaartmeteo-proxy.php`.

This module fills the metrics panel: the cloud layers of the ceilometer, wind and gusts, visibility, precipitation, temperature, dew point and QNH, all measured at a real station rather than modelled. The summary line, the weather icon and the sunrise and sunset times are derived from those same measurements and from the position of the sun, so no second weather source is needed. Settings in config.json under `luchtvaartmeteo`: `station` (the id in the API), `stationName` and `note` (shown under the panel, so it is clear where the measurements come from), `windUnit` (`ms` or `kt`), and `jumpLimit` with `jumpLimitText` for a warning when the wind or the gusts reach that limit.
#### NOAA METAR
https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/
#### Open-Meteo (wind profile)
https://open-meteo.com/en/docs
Free and without a key, and it allows cross origin requests, so the board asks for it directly. The module reads wind and the geopotential height of a set of pressure levels per hour and interpolates the wind as a vector to the altitudes in `upperwinds`, which is more honest than reading a fixed table: the model does not publish values at 3.000 ft, it publishes them at pressure levels. It also reports the freezing level and the cloud layers the model expects. Settings in config.json under `aloft`: `model` (default `icon_d2`, which covers the Netherlands at 2 km) and `hoursAhead` for the number of forecast columns. The wind at the bottom of the table is not modelled but measured, from the luchtvaartmeteo module.
#### Open Sky Network
https://opensky-network.org/aircraft-profile
#### Open Weather Map
https://openweathermap.org/
#### Sat24
https://www.sat24.com/
#### Radar map (KNMI / EUMETSAT / jumprun.nl)
Own radar map (Leaflet) instead of the Weather and radar iframe, based on the radar screen of https://weer.jumprun.nl/: KNMI precipitation radar for the last hours, precipitation forecast for the next hours and the EUMETSAT satellite image as background. Enabled by the `radar` block in config.json (remove it to get the Weather and radar iframe back). The forecast frames come from jumprun.nl through `jumprun-proxy.php` (server-side, with an optional API key `JUMPRUN_API_KEY` in `.env` and a frame cache); as fallback (`forecast.fallback`) or as source (`forecast.source`) the KNMI Data Platform WMS can be used, which needs a free API key in `.env` (`KNMI_WMS_KEY`, see `.env.example`), added server-side by `knmi-wms-proxy.php`.
#### Weather and radar
https://www.weatherandradar.com/
#### Weerlive
https://www.weerlive.nl/
You'll need an API key to use this module, see https://weerlive.nl/delen.php
Not started by default any more: the metrics panel is filled by the luchtvaartmeteo module, which measures at a station instead of interpolating, and has no daily request limit. Add it back in `scripts/main.js` if you prefer Weerlive.
#### Weerplaza
https://www.weerplaza.nl/
#### Weerslag
https://www.weerslag.nl/
#### Windsaloft
https://www.windsaloft.us/
Not started by default any more: the wind profile comes from Open-Meteo, which gives hourly columns and needs no scraping.
