# Aviation Weather Board
Aviation Weather Board

### How to install (Raspberry Pi)

`curl -s https://raw.githubusercontent.com/eelcohn/AWB/main/rpi/install.sh | sudo bash`

That one fetches the project from GitHub, sets up a Pi in one go and installs a nightly updater. It
is the shortest way to the released board.

The updater follows wherever the installation came from, so a board installed from a fork keeps
following that fork. To install from one, point the installer at it:

`curl -s https://raw.githubusercontent.com/<you>/AWB/main/rpi/install.sh | sudo APP_SOURCE=https://github.com/<you>/AWB bash`

`APP_BRANCH` picks a branch. Run from a checkout instead of through curl and it takes the origin of
that checkout without being told.

`rpi/setup.sh` sits next to it for the cases it does not cover: installing from the checkout you are
standing in rather than from GitHub, so a fork or an unpublished branch also ends up on the board;
setting up wifi, which a board without a network cable needs before it is any use; and putting the
credentials file in place. It asks before it changes anything, every answer has a default, and
running it again is safe. It deliberately installs no updater: the one in `install.sh` pulls from
the repository it was built with, so on a fork it would quietly turn your board back into somebody
else's overnight.

### Headless, over wifi, from a Mac

No keyboard and no network cable, only an SD card and a laptop. Three commands and one program:

1. **Raspberry Pi Imager**, with the desktop version of Raspberry Pi OS (Bookworm or Trixie). Under
   the gear: hostname `awb`, a user, SSH on, and one wifi network with the country. That first
   network is the only thing that can be set before the card has ever booted, so make it one your
   laptop is on too. Writing the image is left to the Imager on purpose: it is the one step where a
   mistake costs you the wrong disk.
2. **Check the card before you eject it**, with the card still in the Mac:
   `./rpi/deploy-from-mac.sh --check-card`
   It says whether the hostname, the user, SSH, the wifi and the country are actually on there. A
   card that boots without them is a Pi you cannot reach, and without a keyboard there is no way
   back in.
3. **Boot the Pi, wait a couple of minutes, then:** `./rpi/deploy-from-mac.sh`
   It finds the Pi, offers to put your SSH key on it, copies this checkout across, hands over the
   credentials file and then runs the setup on the Pi with your answers. The wifi step is where the
   other networks go in: a phone hotspot, and the one at the club. A network does not have to be in
   range to be added, so the club's wifi can go in from your kitchen table weeks in advance.
4. **Reboot** and the board comes up on the screen by itself.

After that, every change on your own machine reaches the board with:

`./rpi/deploy-from-mac.sh --update`

which copies what changed and asks nothing.

Adding a network later is one line and needs no reinstall:

`sudo /opt/AWB/rpi/wifi.sh add "Clubwifi" 10`

The number is a priority: higher wins when two networks are in range. Give a phone hotspot a low one
and the club a high one, otherwise the board sits on mobile data next to a perfectly good access
point. `wifi.sh list` shows what it knows and what it is on.

### Setting it up for your own dropzone

Nothing in the code is tied to one club. Every place name in the source is a fallback for when the
config says nothing, so a new dropzone fills in `config.json` and `.env` rather than changing code.

Start with where you are. `location` holds the name and the coordinates of the field (the key is
spelled `lattitude`), and the sun times, the wind profile and the marker on the radar map all hang
off it. Then the things that are yours alone: `metar` and `taf` for the airfield codes you
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

A board can hold more than one field. `config-<name>.json` next to `config.json` is picked up by
`?location=<name>`, so `/?location=hilversum` runs the same board on another dropzone while the
screen in the hangar keeps to its own. `config-hilversum.json` is in the repository as a worked
example: Hilversum has no ceilometer of its own, so it measures at De Bilt eleven kilometres away,
and the panel says so under the numbers while the heading still reads the name of the field. Copy
it, change the five keys that are about your place - `location`, `luchtvaartmeteo`, `jumprun`,
`radar.forecast` - and you have a second board without touching the first.

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
The bulletin is written for pilots. Set `llfc.mode` in config.json to `ai` and it is rewritten into a few plain lines by Claude, which is asked to simplify only: add nothing, leave nothing out, keep every number as it is and give no advice about whether to jump. The model is `llfc.model`.

That rewriting is not something the board asks for over HTTP. `rpi/llfc-rewrite.php` is a command, run every five minutes by `awb-llfc.timer` (installed by `rpi/setup.sh`): it fetches the bulletin itself, and only when there is a new one does it ask Claude and write the answer to `/var/lib/awb/llfc.json`, which lighttpd serves as `/llfc.json`. The board reads that file and nothing more. There is deliberately no address anyone can post text to — an endpoint that spends an API key is reachable by everyone on the same network, and the board hangs on a club network. For the same reason the key lives in `/etc/awb/anthropic-key`, readable by root alone, rather than in `.env`, which the web server reads. In development, without that file, the script falls back to `ANTHROPIC_API_KEY` in `.env` (see `.env.example`) and you run it by hand:

    php rpi/llfc-rewrite.php --out html/llfc.json --state /tmp/llfc-state.json

Anything that goes wrong, a missing key included, leaves the bulletin itself on screen: the rewrite is only shown when it belongs to the bulletin the board fetched, so a board without the timer shows the bulletin as the KNMI writes it. That is also what `raw` does.
#### Luchtvaartmeteo (KNMI observations)
https://www.luchtvaartmeteo.nl/
You'll need a (free) luchtvaartmeteo.nl account to use this module. Copy `.env.example` to `.env` next to the `html` directory (`/var/www/.env` on the Raspberry Pi) and fill in `LVM_EMAIL` and `LVM_PASSWORD`; that file is ignored by git and lives outside the web root, so it is never served to the browser. The login is done server-side by `luchtvaartmeteo-proxy.php`.

This module fills the metrics panel: the cloud layers of the ceilometer, wind and gusts, visibility, precipitation, temperature, dew point and QNH, all measured at a real station rather than modelled. The summary line, the weather icon and the sunrise and sunset times are derived from those same measurements and from the position of the sun, so no second weather source is needed. Settings in config.json under `luchtvaartmeteo`: `station` (the id in the API), `stationName` and `note` (shown under the panel, so it is clear where the measurements come from), and `windUnit` (`ms` or `kt`). The panel states what is measured and nothing more: whether that wind is jumpable, and for whom, is a call for the jump master and not for a screen.
#### Cloud and wind chart
No source of its own: it draws what the luchtvaartmeteo and Open-Meteo modules already fetched. The hours behind the line marked "now" are the cloud layers of the ceilometer and the wind measured at the station, the hours after it are what the model expects. The altitude axis is deliberately not linear, because the first few thousand feet decide whether jumping is possible. Settings in config.json under `cloudProfile`: `hoursBack` and `hoursAhead`; remove the block to leave the chart out.
#### NOAA METAR
https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/
#### Open-Meteo (wind profile)
https://open-meteo.com/en/docs
Free and without a key, and it allows cross origin requests, so the board asks for it directly. The module reads wind and the geopotential height of a set of pressure levels per hour and interpolates the wind as a vector to the altitudes in `upperwinds`, which is more honest than reading a fixed table: the model does not publish values at 3.000 ft, it publishes them at pressure levels. It also reports the freezing level and the cloud layers the model expects. Settings in config.json under `aloft`: `model` and `hoursAhead` for the number of forecast columns, `exitAltitude` with `coldText` for the height the aircraft drops from and the rule that applies when the freezing level sits under it (12.000 ft and a line about gloves by default), and `windLimit` with `windLimitBelow` and `windLimitHigh` for the wind that makes the spot and the circuit awkward (25 kt at every level up to 5.000 ft, and 45 kt above it, by default; the ground row keeps to its gusts). The two limits are about different things: below five thousand feet it is the canopy ride, above it the run-in and the space between the groups, which is why the number is so much higher there. All five are optional; leave them out and the defaults apply. The board uses `knmi_seamless`, the KNMI blend of HARMONIE for the short range and ECMWF beyond it, and so does jumprun.nl, so the two screens never disagree about the wind for reasons that are only the model. That matters: measured over Hoogeveen the blend and `icon_d2` (DWD, 2 km) differed by eleven knots as vectors at five thousand feet on one ordinary morning, which is enough to look like weather when it is not. HARMONIE itself cannot be used: Open-Meteo accepts the model name but returns no values on pressure levels, and a wind profile needs those. Not every model reports a freezing level, so the module works it out from the temperature profile it already has. The wind at the bottom of the table is not modelled but measured, from the luchtvaartmeteo module.
#### Open Sky Network
https://opensky-network.org/aircraft-profile
#### Open Weather Map
https://openweathermap.org/
#### Sat24
https://www.sat24.com/
#### Radar map (KNMI / EUMETSAT / jumprun.nl)
Own radar map (Leaflet) instead of the Weather and radar iframe, based on the radar screen of https://weer.jumprun.nl/: KNMI precipitation radar for the last hours, precipitation forecast for the next hours and the EUMETSAT satellite image as background. Enabled by the `radar` block in config.json (remove it to get the Weather and radar iframe back). The forecast frames come from jumprun.nl through `jumprun-proxy.php` (server-side, with an optional API key `JUMPRUN_API_KEY` in `.env` and a frame cache); as fallback (`forecast.fallback`) or as source (`forecast.source`) the KNMI Data Platform WMS can be used, which needs a free API key in `.env` (`KNMI_WMS_KEY`, see `.env.example`), added server-side by `knmi-wms-proxy.php`.
#### Wind map (Windy)
When the wind aloft goes over its limit, the map tile shows Windy's wind field for a while, the same way the jumpruns take it over. Which altitudes are shown is decided by the upper winds module: at most two, one from the low range and one from the high one. Low is the lowest marked level, because that is where the canopy ride starts, unless another marked level in that range is five knots or more stronger — then that one says more. High is simply the strongest marked level. Above the map stands the number from the table with the altitude it belongs to, and nothing else: what it means for the jump is the business of the people running it.

Enabled by the `windy` block in config.json — leave the block out and nothing is embedded: `seconds` how long each altitude stays up (30 by default: Windy loads its wind data after the map, and on a Raspberry Pi a shorter turn can be over before the field is painted), `afterRuns` how many complete radar loops go by first, `product` the model Windy draws (`ecmwf` by default) and `zoom` how much of the country is in view. It uses Windy's public embed, which needs no key. Windy has its own colours and its own furniture; the logo, the legend and the buttons fall outside the frame because the iframe is larger than the window it sits in, and how much is cut away is `--windy-crop-x` and `--windy-crop-y` in the stylesheet. The iframe only has an address while it is on screen: Windy keeps a WebGL map running as long as it is loaded, and that is exactly the time the Raspberry Pi needs for the radar.

#### Jumprun (jumprun.nl)
The jumprun somebody set on https://weer.jumprun.nl/ for today, drawn on the same map and on the same aerial photograph as the radar, in between a couple of runs of the loop. Only an administrator of jumprun.nl can put one up, with a passkey, and only for the day itself: a plan disappears from the board by itself the next morning. Enabled by the `jumprun` block in config.json: `stations` names the dropzones the board looks at (a board can watch more than one, and they take turns, so Hoogeveen also shows what is set for Echten), `afterRuns` how many complete radar loops go by first and `seconds` how long it stays up. The plan comes in through `jumprun-proxy.php`, like the forecast frames.

The board draws two sums. The line, the exits and the green light are the ones the jump organiser decided on; the reach under the canopy is worked out again with the wind of the moment, because that is what a jumper wants to know now. When the wind has turned or picked up enough to matter, the caption says so in as many words - "20 degrees turned at 3.000 ft" - and never what that means for where you personally land. That conclusion belongs to an instructor, not to a screen in the hallway.

How the spot is spoken is the dropzone's own business, and jumprun.nl says which way with every plan. Hoogeveen and Echten call out a track, an offset and a green light. Texel calls out a bearing and a distance from the middle of the field and then the run-in heading, which says the same thing in one pair of numbers instead of two. The board writes down whichever one belongs to the dropzone; a field that says nothing gets the offset notation. Nothing needs to be set on this side for that: change the notation on jumprun.nl and the board follows.

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
