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
You'll need a (free) luchtvaartmeteo.nl account to use this module. Copy `.env.example` to `.env` next to the `html` directory (`/var/www/.env` on the Raspberry Pi) and fill in `LVM_EMAIL` and `LVM_PASSWORD`; that file is ignored by git and lives outside the web root, so it is never served to the browser. The login is done server-side by `luchtvaartmeteo-proxy.php`. The station is set in config.json under `luchtvaartmeteo.station`.
#### NOAA METAR
https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/
#### Open-Meteo
https://open-meteo.com/en/docs
#### Open Sky Network
https://opensky-network.org/aircraft-profile
#### Open Weather Map
https://openweathermap.org/
#### Sat24
https://www.sat24.com/
#### Weather and radar
https://www.weatherandradar.com/
#### Weerlive
https://www.weerlive.nl/
You'll need an API key to use this module, see https://weerlive.nl/delen.php
#### Weerplaza
https://www.weerplaza.nl/
#### Weerslag
https://www.weerslag.nl/
#### Windsaloft
https://www.windsaloft.us/
