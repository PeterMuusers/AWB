# Aviation Weather Board
Aviation Weather Board

### How to install (Raspberry Pi)

`curl -s https://raw.githubusercontent.com/eelcohn/AWB/main/rpi/install.sh | sudo bash`

### Setting it up for your own dropzone

Nothing in the code is tied to one club. Every place name in the source is a fallback for when the
config says nothing, so a new dropzone fills in `config.json` and `.env` rather than changing code.

Start with where you are. `location` holds the name and the coordinates of the field (the key is
spelled `lattitude`), and the sun times, the wind profile and the marker on the radar map all hang
off it. Then the things that are yours alone: `luchtvaartmeteo.jumpLimit` and `jumpLimitText` for
your own wind limit and the warning that goes with it, `metar` and `taf` for the airfield codes you
want to read, and `airplanes` for the ICAO hex of your own jump plane. `radar.bounds` covers the
whole country as it stands, which works anywhere in the Netherlands; narrow it if you would rather
look closer. `locale` sets the language and the clock format, and `theme` picks the palette:
`navy`, the night blue the board runs, `dark` or `light` for a screen in a bright room.

The measuring station is the one thing worth settling before you start. The metrics panel and the
cloud chart come from a single station of luchtvaartmeteo.nl, named in `luchtvaartmeteo.station`,
and not every airfield has one. Ask the proxy for the list with
`luchtvaartmeteo-proxy.php?action=locations` and pick the nearest. Then write down how far away it
actually is in `luchtvaartmeteo.stationName` and `note`, which is printed under the panel: at four
kilometres that is a detail, at twenty it is the difference between the wind on the screen and the
wind above your head, and a jumper should be able to see which one they are reading.

The keys go in `.env` next to the `html` directory, never in `config.json`, because that file is
served to the browser. Copy `.env.example` and fill in what you need: an account at
luchtvaartmeteo.nl for the measurements, two free KNMI Data Platform keys for the precipitation
forecast on the map, a Claude key if you want the bulletin rewritten in plain language, and
optionally a jumprun.nl key for its forecast frames. Each one is independent. Leave the Claude key
out and the board shows the bulletin as the KNMI writes it; leave the jumprun key out and the map
falls back to the KNMI layer.

The rest needs nothing. The low level forecast is one bulletin for the whole country, the wind
profile is fetched for your own coordinates, and radar and satellite are national layers.

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
The bulletin is written for pilots. Set `llfc.mode` in config.json to `ai` and it is rewritten into a few plain lines by `llfc-rewrite.php`, which asks Claude to simplify only: add nothing, leave nothing out, keep every number as it is and give no advice about whether to jump. That needs `ANTHROPIC_API_KEY` in `.env` (see `.env.example`); the model is `llfc.model`. The answer is cached under a hash of the bulletin, so the model is asked about four times a day however many screens are running. Anything that goes wrong, a missing key included, leaves the bulletin itself on screen. `raw` shows the bulletin as the KNMI writes it.
#### Luchtvaartmeteo (KNMI observations)
https://www.luchtvaartmeteo.nl/
You'll need a (free) luchtvaartmeteo.nl account to use this module. Copy `.env.example` to `.env` next to the `html` directory (`/var/www/.env` on the Raspberry Pi) and fill in `LVM_EMAIL` and `LVM_PASSWORD`; that file is ignored by git and lives outside the web root, so it is never served to the browser. The login is done server-side by `luchtvaartmeteo-proxy.php`.

This module fills the metrics panel: the cloud layers of the ceilometer, wind and gusts, visibility, precipitation, temperature, dew point and QNH, all measured at a real station rather than modelled. The summary line, the weather icon and the sunrise and sunset times are derived from those same measurements and from the position of the sun, so no second weather source is needed. Settings in config.json under `luchtvaartmeteo`: `station` (the id in the API), `stationName` and `note` (shown under the panel, so it is clear where the measurements come from), `windUnit` (`ms` or `kt`), and `jumpLimit` with `jumpLimitText` for a warning when the wind or the gusts reach that limit.
#### Cloud and wind chart
No source of its own: it draws what the luchtvaartmeteo and Open-Meteo modules already fetched. The hours behind the line marked "now" are the cloud layers of the ceilometer and the wind measured at the station, the hours after it are what the model expects. The altitude axis is deliberately not linear, because the first few thousand feet decide whether jumping is possible. Settings in config.json under `cloudProfile`: `hoursBack` and `hoursAhead`; remove the block to leave the chart out.
#### NOAA METAR
https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/
#### Open-Meteo (wind profile)
https://open-meteo.com/en/docs
Free and without a key, and it allows cross origin requests, so the board asks for it directly. The module reads wind and the geopotential height of a set of pressure levels per hour and interpolates the wind as a vector to the altitudes in `upperwinds`, which is more honest than reading a fixed table: the model does not publish values at 3.000 ft, it publishes them at pressure levels. It also reports the freezing level and the cloud layers the model expects. Settings in config.json under `aloft`: `model` and `hoursAhead` for the number of forecast columns, `exitAltitude` with `coldText` for the height the aircraft drops from and the rule that applies when the freezing level sits under it (12.000 ft and a line about gloves by default), and `windLimit` with `windLimitBelow` for the wind that makes the spot and the circuit awkward (25 kt at every level up to 5.000 ft by default; the ground row keeps to its gusts). All four are optional; leave them out and the defaults apply. The board uses `knmi_seamless`, the KNMI blend of HARMONIE for the short range and ECMWF beyond it, and so does jumprun.nl, so the two screens never disagree about the wind for reasons that are only the model. That matters: measured over Hoogeveen the blend and `icon_d2` (DWD, 2 km) differed by eleven knots as vectors at five thousand feet on one ordinary morning, which is enough to look like weather when it is not. HARMONIE itself cannot be used: Open-Meteo accepts the model name but returns no values on pressure levels, and a wind profile needs those. Not every model reports a freezing level, so the module works it out from the temperature profile it already has. The wind at the bottom of the table is not modelled but measured, from the luchtvaartmeteo module.
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
