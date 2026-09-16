<?php
/*
 * Proxy for the KNMI observation API behind luchtvaartmeteo.nl.
 *
 * The API needs a login (Cognito hosted UI) which a browser cannot do cross-origin,
 * so this script logs in server-side with the account from the .env file in the directory
 * above the web root (/var/www/.env on the Pi, .env in the repository root in development;
 * see .env.example), or from the environment variables LVM_EMAIL and LVM_PASSWORD.
 * That file is ignored by git and outside the web root, so it is never served to the
 * browser. The access token (valid for about 4 hours) is cached in the system temp directory. The station comes from config.json
 * (luchtvaartmeteo.station). Login flow and parameter list are ported from the
 * cloudbase project (cloudbase/auth.py, cloudbase/api.py).
 *
 * Usage:
 *   luchtvaartmeteo-proxy.php?action=observations&station=hoogeveen
 *       -> newest value per parameter for the station (cached until the next observation is due)
 *   luchtvaartmeteo-proxy.php?action=locations
 *       -> all stations known to the API (cached for 1 day)
 *   luchtvaartmeteo-proxy.php?action=status
 *       -> whether credentials are configured and a valid token is cached
 *   Add &location=<name> to read config-<name>.json instead of config.json.
 */

require __DIR__ . '/env.php';

$API_BASE = 'https://api.exons2.web.knmi.cloud';
$SITE_ORIGIN = 'https://www.luchtvaartmeteo.nl';
$CALLBACK_URL = $SITE_ORIGIN . '/auth/callback';
$USER_AGENT = 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
$CURL_TIMEOUT = 20;
$TOKEN_MARGIN = 5 * 60;			// re-login this many seconds before the token expires
$OBSERVATION_PERIOD = 10 * 60;	// the station publishes a new observation every ten minutes
$OBSERVATION_GRACE = 90;		// and it takes a moment to reach the API
$OBSERVATIONS_MIN_TTL = 60;		// never ask the API more than once a minute
$OBSERVATIONS_MAX_TTL = 15 * 60;	// ask again anyway when the station has fallen silent
$LOCATIONS_TTL = 24 * 60 * 60;	// cache the station list for 1 day
$CACHE_DIR = sys_get_temp_dir();

/* (field, parameter_id, unit): the same parameters as the station table on luchtvaartmeteo.nl */
$PARAMETERS = array(
	array('wind_kt',    'observed-wind-speed-10m-10min-mean',                            'knot'),
	array('gust_kt',    'observed-wind-gust-10m-10min-maximum',                          'knot'),
	array('wind_dir',   'observed-wind-direction-sensor-height-10min-mean',              'degree'),
	array('vis_m',      'observed-meteorological-optical-range-10min-mean',              'meter'),
	array('base1_ft',   'observed-cloud-base-altitude-ceilometer-first-layer-30min',     'foot'),
	array('base2_ft',   'observed-cloud-base-altitude-ceilometer-second-layer-30min',    'foot'),
	array('base3_ft',   'observed-cloud-base-altitude-ceilometer-third-layer-30min',     'foot'),
	array('okta1',      'observed-cloud-amount-ceilometer-first-layer-30min',            'okta'),
	array('okta2',      'observed-cloud-amount-ceilometer-second-layer-30min',           'okta'),
	array('okta3',      'observed-cloud-amount-ceilometer-third-layer-30min',            'okta'),
	array('okta_total', 'observed-cloud-cover-ceilometer-total-30min',                   'okta'),
	array('qnh_hpa',    'observed-qnh-1min-mean',                                        'hectopascal'),
	array('temp_c',     'observed-air-temperature-1p5m-1min-mean',                       'degree_celsius'),
	array('dewpoint_c', 'observed-dew-point-temperature-1p5m-1min-mean',                 'degree_celsius'),
	array('rh_pct',     'observed-relative-humidity-1p5m-1min-mean',                     'percent'),
	array('rain_mmh',   'observed-precipitation-intensity-10min-present-weather-sensor', 'millimeter_per_hour'),
	array('rain_min10', 'observed-precipitation-duration-10min-present-weather-sensor',  'second'),
);
/* The API refuses 'minute' for the duration parameter, so ask for seconds and scale */
$SCALE = array('rain_min10' => 1 / 60);
/* Fields for which the whole series is returned as well, for the chart under the radar map */
$SERIES_FIELDS = array('rain_mmh', 'wind_kt', 'gust_kt', 'base1_ft', 'base2_ft', 'base3_ft', 'okta1', 'okta2', 'okta3');
$SERIES_HOURS = 4;

set_time_limit(90);
header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');

function fail($code, $message) {
	http_response_code($code);
	echo(json_encode(array('error' => $message)));
	exit;
}

/* Read the settings from config.json (or config-<location>.json) */
function load_config() {
	$file = __DIR__ . '/config.json';
	if (isset($_GET['location']) && preg_match('/^[A-Za-z0-9_-]+$/', $_GET['location'])) {
		$file = __DIR__ . '/config-' . $_GET['location'] . '.json';
	}
	if (!is_readable($file)) {
		fail(500, 'Configuration file not found.');
	}
	$config = json_decode(file_get_contents($file), true);
	if (!is_array($config)) {
		fail(500, 'Configuration file is not valid JSON.');
	}
	return $config;
}

/* Account from the environment (LVM_EMAIL / LVM_PASSWORD) or the .env file; null when missing or still the placeholder */
function load_credentials() {
	if (!awb_env_is_set('LVM_EMAIL') || !awb_env_is_set('LVM_PASSWORD')) {
		return null;
	}
	return array('email' => awb_env('LVM_EMAIL'), 'password' => awb_env('LVM_PASSWORD'));
}

/* One HTTP request on a shared curl handle (keeps cookies), redirects are NOT followed */
function http_request($ch, $method, $url, $headers = array(), $body = null) {
	global $CURL_TIMEOUT, $USER_AGENT, $SITE_ORIGIN;
	$response_headers = array();

	curl_setopt($ch, CURLOPT_URL, $url);
	curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
	curl_setopt($ch, CURLOPT_POSTFIELDS, $body === null ? '' : $body);
	curl_setopt($ch, CURLOPT_HTTPHEADER, array_merge(array(
		'User-Agent: ' . $USER_AGENT,
		'Origin: ' . $SITE_ORIGIN,
		'Referer: ' . $SITE_ORIGIN . '/',
	), $headers));
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
	curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $CURL_TIMEOUT);
	curl_setopt($ch, CURLOPT_TIMEOUT, $CURL_TIMEOUT);
	curl_setopt($ch, CURLOPT_HEADERFUNCTION, function($ch, $line) use (&$response_headers) {
		$parts = explode(':', $line, 2);
		if (count($parts) == 2) {
			$response_headers[strtolower(trim($parts[0]))] = trim($parts[1]);
		}
		return strlen($line);
	});

	$data = curl_exec($ch);
	if (curl_errno($ch)) {
		return array('status' => 0, 'headers' => array(), 'body' => '', 'error' => curl_error($ch));
	}
	return array(
		'status' => curl_getinfo($ch, CURLINFO_HTTP_CODE),
		'headers' => $response_headers,
		'body' => $data,
		'error' => null,
	);
}

/* Resolve a (possibly relative) Location header against the request URL */
function resolve_url($base, $location) {
	if (preg_match('#^https?://#i', $location)) {
		return $location;
	}
	$parts = parse_url($base);
	$origin = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
	if (substr($location, 0, 1) === '/') {
		return $origin . $location;
	}
	$path = isset($parts['path']) ? $parts['path'] : '/';
	return $origin . rtrim(dirname($path), '/') . '/' . $location;
}

/* Read a cookie value from the curl cookie engine */
function get_cookie($ch, $name) {
	foreach (curl_getinfo($ch, CURLINFO_COOKIELIST) as $line) {
		$fields = explode("\t", $line);
		if (count($fields) >= 7 && $fields[5] === $name) {
			return $fields[6];
		}
	}
	return null;
}

/* Expiry (unix time) from the token response, falling back to the JWT exp claim */
function token_expires_at($data) {
	if (!empty($data['expires_at'])) {
		$t = strtotime($data['expires_at']);
		if ($t !== false) {
			return $t;
		}
	}
	$parts = explode('.', $data['access_token']);
	if (count($parts) >= 2) {
		$claims = json_decode(base64_decode(strtr($parts[1], '-_', '+/')), true);
		if (isset($claims['exp'])) {
			return (int)$claims['exp'];
		}
	}
	return time() + 3600;
}

/* Full login flow: signin_url -> Cognito authorize -> login form -> exchange code for a token */
function login($email, $password) {
	global $API_BASE, $CALLBACK_URL;

	$ch = curl_init();
	curl_setopt($ch, CURLOPT_COOKIEFILE, '');	// enable in-memory cookie jar

	/* 1. signin_url (the PKCE challenge is created server-side by the API) */
	$state = base64_encode('state:/');
	$r = http_request($ch, 'GET', $API_BASE . '/auth/cognito/signin_url?' . http_build_query(array('callback_url' => $CALLBACK_URL, 'state' => $state)), array('Accept: application/json'));
	if ($r['status'] != 200) {
		curl_close($ch);
		return array(null, 'signin_url returned HTTP ' . $r['status'] . ($r['error'] ? ' (' . $r['error'] . ')' : ''));
	}
	$json = json_decode($r['body'], true);
	if (!isset($json['url'])) {
		curl_close($ch);
		return array(null, 'signin_url returned no url');
	}
	$authorize_url = $json['url'];

	/* 2. authorize -> redirect to the hosted UI login page (sets the XSRF-TOKEN cookie) */
	$r = http_request($ch, 'GET', $authorize_url, array('Accept: text/html'));
	if (!in_array($r['status'], array(301, 302, 303)) || !isset($r['headers']['location'])) {
		curl_close($ch);
		return array(null, 'Cognito authorize returned HTTP ' . $r['status'] . ', no redirect');
	}
	$login_url = resolve_url($authorize_url, $r['headers']['location']);
	$r = http_request($ch, 'GET', $login_url, array('Accept: text/html'));
	if ($r['status'] != 200) {
		curl_close($ch);
		return array(null, 'Cognito login page returned HTTP ' . $r['status']);
	}
	if (preg_match('/name="_csrf"\s+value="([^"]+)"/', $r['body'], $m)) {
		$csrf = $m[1];
	} else {
		$csrf = get_cookie($ch, 'XSRF-TOKEN');
	}
	if (!$csrf) {
		curl_close($ch);
		return array(null, 'No CSRF token found on the Cognito login page');
	}

	/* 3. post the login form -> redirect to the callback with ?code= */
	$form = http_build_query(array(
		'_csrf' => $csrf,
		'username' => $email,
		'password' => $password,
		'cognitoAsfData' => '',
		'signInSubmitButton' => 'Sign in',
	));
	$r = http_request($ch, 'POST', $login_url, array('Accept: text/html', 'Content-Type: application/x-www-form-urlencoded', 'Referer: ' . $login_url), $form);
	if (!in_array($r['status'], array(301, 302, 303))) {
		curl_close($ch);
		return array(null, 'Cognito login returned HTTP ' . $r['status'] . ' instead of a redirect' . ($r['status'] == 200 ? ' (wrong e-mail address or password?)' : ''));
	}
	$redirect = isset($r['headers']['location']) ? $r['headers']['location'] : '';
	if (parse_url($redirect, PHP_URL_HOST) === parse_url($login_url, PHP_URL_HOST)) {
		curl_close($ch);
		return array(null, 'Cognito did not accept the credentials (check LVM_EMAIL and LVM_PASSWORD in .env)');
	}
	parse_str((string)parse_url($redirect, PHP_URL_QUERY), $query);
	if (empty($query['code'])) {
		curl_close($ch);
		return array(null, 'No authorization code in redirect');
	}

	/* 4. exchange the code for an access token */
	$r = http_request($ch, 'POST', $API_BASE . '/auth/cognito/authorize', array('Accept: application/json', 'Content-Type: application/json'), json_encode(array('authorization_code' => $query['code'], 'callback_url' => $CALLBACK_URL)));
	curl_close($ch);
	if ($r['status'] != 200) {
		return array(null, 'Token exchange returned HTTP ' . $r['status']);
	}
	$data = json_decode($r['body'], true);
	if (!isset($data['access_token'])) {
		return array(null, 'Unexpected token response');
	}
	return array(array('access_token' => $data['access_token'], 'expires_at' => token_expires_at($data)), null);
}

function token_cache_file($email) {
	global $CACHE_DIR;
	return $CACHE_DIR . '/awb-luchtvaartmeteo-token-' . md5($email) . '.json';
}

function load_cached_token($email) {
	global $TOKEN_MARGIN;
	$file = token_cache_file($email);
	if (!is_readable($file)) {
		return null;
	}
	$token = json_decode(file_get_contents($file), true);
	if (!isset($token['access_token']) || !isset($token['expires_at']) || time() >= $token['expires_at'] - $TOKEN_MARGIN) {
		return null;
	}
	return $token;
}

function save_cached_token($email, $token) {
	$file = token_cache_file($email);
	file_put_contents($file, json_encode($token), LOCK_EX);
	chmod($file, 0600);
}

/* Cached token if still valid, otherwise log in again */
function get_token($credentials, $force = false) {
	$email = $credentials['email'];
	if (!$force) {
		$token = load_cached_token($email);
		if ($token !== null) {
			return $token;
		}
	}
	list($token, $error) = login($email, $credentials['password']);
	if ($token === null) {
		fail(502, 'Login at luchtvaartmeteo.nl failed: ' . $error);
	}
	save_cached_token($email, $token);
	return $token;
}

/* Several GET requests on the API in parallel; returns array(path => array(status, body)) */
function api_get_multi($token, $paths) {
	global $API_BASE, $CURL_TIMEOUT, $USER_AGENT, $SITE_ORIGIN;
	$mh = curl_multi_init();
	$handles = array();
	foreach ($paths as $key => $path) {
		$ch = curl_init();
		curl_setopt($ch, CURLOPT_URL, $API_BASE . $path);
		curl_setopt($ch, CURLOPT_HTTPHEADER, array(
			'User-Agent: ' . $USER_AGENT,
			'Origin: ' . $SITE_ORIGIN,
			'Referer: ' . $SITE_ORIGIN . '/',
			'Accept: application/json',
			'Authorization: Bearer ' . $token['access_token'],
		));
		curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
		curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $CURL_TIMEOUT);
		curl_setopt($ch, CURLOPT_TIMEOUT, $CURL_TIMEOUT);
		curl_multi_add_handle($mh, $ch);
		$handles[$key] = $ch;
	}
	do {
		$status = curl_multi_exec($mh, $running);
		if ($running) {
			curl_multi_select($mh, 1.0);
		}
	} while ($running && $status == CURLM_OK);

	$results = array();
	foreach ($handles as $key => $ch) {
		$results[$key] = array(
			'status' => curl_getinfo($ch, CURLINFO_HTTP_CODE),
			'body' => curl_multi_getcontent($ch),
		);
		curl_multi_remove_handle($mh, $ch);
		curl_close($ch);
	}
	curl_multi_close($mh);
	return $results;
}

/* Same, but logs in again once when the token is rejected */
function api_get_multi_retry($credentials, $paths) {
	$token = get_token($credentials);
	$results = api_get_multi($token, $paths);
	foreach ($results as $r) {
		if ($r['status'] == 401) {
			$token = get_token($credentials, true);
			return api_get_multi($token, $paths);
		}
	}
	return $results;
}

/* Whether the answer on disk is still the newest one that can exist. The station publishes on the
   ten minute mark, so until the next observation is due there is nothing to fetch and the file is
   served as it is. After that we go and look, but never more often than once a minute, so a station
   that falls silent cannot turn the board into a stream of requests. Returns the body, or null when
   it is time to ask the API again. */
function read_observations_cache($file) {
	global $OBSERVATION_PERIOD, $OBSERVATION_GRACE, $OBSERVATIONS_MIN_TTL, $OBSERVATIONS_MAX_TTL;
	if (!is_readable($file)) {
		return null;
	}
	$age = time() - filemtime($file);
	if ($age < $OBSERVATIONS_MIN_TTL) {
		return file_get_contents($file);
	}
	if ($age >= $OBSERVATIONS_MAX_TTL) {
		return null;
	}
	$body = file_get_contents($file);
	$data = json_decode($body, true);
	if (!isset($data['time'])) {
		return null;
	}
	$observed = strtotime($data['time']);
	if ($observed === false) {
		return null;
	}
	return (time() < ($observed + $OBSERVATION_PERIOD + $OBSERVATION_GRACE)) ? $body : null;
}

function read_cache($file, $ttl) {
	if (is_readable($file) && (time() - filemtime($file)) < $ttl) {
		return file_get_contents($file);
	}
	return null;
}

function write_cache($file, $data) {
	file_put_contents($file, $data, LOCK_EX);
	chmod($file, 0600);
}

/* Newest value per parameter for one station */
function action_observations($config, $credentials) {
	global $PARAMETERS, $SCALE, $SERIES_FIELDS, $SERIES_HOURS, $CACHE_DIR;

	$station = isset($_GET['station']) ? $_GET['station'] : (isset($config['luchtvaartmeteo']['station']) ? $config['luchtvaartmeteo']['station'] : 'hoogeveen');
	if (!preg_match('/^[A-Za-z0-9_-]+$/', $station)) {
		fail(400, 'Invalid station.');
	}
	$station = strtolower($station);

	$cache_file = $CACHE_DIR . '/awb-luchtvaartmeteo-observations-' . $station . '.json';
	$cached = read_observations_cache($cache_file);
	if ($cached !== null) {
		header('X-Cache: HIT');
		echo($cached);
		return;
	}

	$paths = array();
	foreach ($PARAMETERS as $p) {
		list($field, $parameter_id, $unit) = $p;
		$paths[$field] = '/parameters/observed/parameters/' . rawurlencode($parameter_id) . '/locations/' . rawurlencode($station) . '/time_series?unit=' . rawurlencode($unit);
	}
	$results = api_get_multi_retry($credentials, $paths);

	$observation = array();
	$series = array();
	$observed_at = array();
	$units = array();
	$errors = array();
	$newest = null;
	foreach ($PARAMETERS as $p) {
		list($field, $parameter_id, $unit) = $p;
		$r = $results[$field];
		if ($r['status'] != 200) {
			$errors[$field] = 'HTTP ' . $r['status'];
			$observation[$field] = null;
			continue;
		}
		$json = json_decode($r['body'], true);
		$value = null;
		$time = null;
		$want_series = in_array($field, $SERIES_FIELDS, true);
		$since = gmdate('Y-m-d\TH:i:s\Z', time() - $SERIES_HOURS * 3600);
		if ($want_series) {
			$series[$field] = array();
		}
		if (isset($json['data']['datapoints'])) {
			foreach ($json['data']['datapoints'] as $point) {
				if ($point['value'] !== null && ($time === null || $point['timestamp'] > $time)) {
					$time = $point['timestamp'];
					$value = $point['value'];
				}
				if ($want_series && $point['value'] !== null && $point['timestamp'] >= $since) {
					$scaled = isset($SCALE[$field]) ? $point['value'] * $SCALE[$field] : $point['value'];
					$series[$field][] = array($point['timestamp'], $scaled);
				}
			}
		}
		if ($value !== null && isset($SCALE[$field])) {
			$value = $value * $SCALE[$field];
		}
		$observation[$field] = $value;
		$observed_at[$field] = $time;
		$units[$field] = ($field === 'rain_min10') ? 'minute' : $unit;
		if ($time !== null && ($newest === null || $time > $newest)) {
			$newest = $time;
		}
	}
	if (count($errors) == count($PARAMETERS)) {
		fail(502, 'No data received from the luchtvaartmeteo.nl API: ' . reset($errors));
	}

	$output = json_encode(array(
		'source' => 'luchtvaartmeteo.nl',
		'station' => $station,
		'time' => $newest,
		'observation' => $observation,
		'observed_at' => $observed_at,
		'series' => (object)$series,
		'units' => $units,
		'errors' => (object)$errors,
	));
	write_cache($cache_file, $output);
	header('X-Cache: MISS');
	echo($output);
}

/* All stations known to the API */
function action_locations($credentials) {
	global $CACHE_DIR, $LOCATIONS_TTL;
	$cache_file = $CACHE_DIR . '/awb-luchtvaartmeteo-locations.json';
	$cached = read_cache($cache_file, $LOCATIONS_TTL);
	if ($cached !== null) {
		header('X-Cache: HIT');
		echo($cached);
		return;
	}
	$results = api_get_multi_retry($credentials, array('locations' => '/parameters/locations'));
	if ($results['locations']['status'] != 200) {
		fail(502, 'Station list returned HTTP ' . $results['locations']['status']);
	}
	write_cache($cache_file, $results['locations']['body']);
	header('X-Cache: MISS');
	echo($results['locations']['body']);
}

function action_status($config, $credentials) {
	$token = ($credentials !== null) ? load_cached_token($credentials['email']) : null;
	echo(json_encode(array(
		'configured' => ($credentials !== null),
		'station' => isset($config['luchtvaartmeteo']['station']) ? $config['luchtvaartmeteo']['station'] : null,
		'token_cached' => ($token !== null),
		'token_expires_at' => ($token !== null) ? gmdate('c', $token['expires_at']) : null,
	)));
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	fail(405, 'Method not allowed.');
}
$config = load_config();
$credentials = load_credentials();
$action = isset($_GET['action']) ? $_GET['action'] : 'observations';
if ($action === 'status') {
	action_status($config, $credentials);
	exit;
}
if ($credentials === null) {
	fail(503, 'luchtvaartmeteo.nl credentials not set. Please copy .env.example to .env (next to the html directory) and fill in LVM_EMAIL and LVM_PASSWORD.');
}
switch ($action) {
	case 'observations' :
		action_observations($config, $credentials);
		break;
	case 'locations' :
		action_locations($credentials);
		break;
	default :
		fail(400, 'Unknown action.');
		break;
}
?>
