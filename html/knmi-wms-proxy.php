<?php
/*
 * Proxy for the KNMI Data Platform WMS (api.dataplatform.knmi.nl), which needs an API key.
 * The key comes from KNMI_WMS_KEY (or KNMI_OPEN_DATA_KEY) in the .env file above the web root,
 * see .env.example, and is added server-side so it never reaches the browser.
 * Only GetMap and GetCapabilities for a few datasets are allowed; responses are cached briefly.
 * Used by html/scripts/modules/radar.js for the precipitation forecast when jumprun.nl is not
 * available.
 *
 * Usage: knmi-wms-proxy.php?DATASET=radar_forecast&SERVICE=WMS&REQUEST=GetMap&... (normal WMS query)
 */

require __DIR__ . '/env.php';

$WMS_URL = 'https://api.dataplatform.knmi.nl/wms/adaguc-server';
$ALLOWED_DATASETS = array('radar_forecast', 'radar_reflectivity_composites', 'uwcw_extra_lv_ha43_nl_2km');
$CACHE_TTL = array('GETMAP' => 5 * 60, 'GETCAPABILITIES' => 2 * 60);
$CACHE_DIR = sys_get_temp_dir();
$CURL_TIMEOUT = 30;

function fail($code, $message) {
	http_response_code($code);
	header('Content-Type: application/json');
	header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');
	echo(json_encode(array('error' => $message)));
	exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	fail(405, 'Method not allowed.');
}

/* WMS parameter names are case-insensitive; normalise them */
$params = array();
foreach ($_GET as $key => $value) {
	$params[strtoupper($key)] = $value;
}
if (!isset($params['DATASET']) || !in_array($params['DATASET'], $ALLOWED_DATASETS, true)) {
	fail(400, 'Unknown or missing DATASET.');
}
$request = isset($params['REQUEST']) ? strtoupper($params['REQUEST']) : '';
if (!isset($CACHE_TTL[$request])) {
	fail(400, 'Only GetMap and GetCapabilities are allowed.');
}

$key = awb_env_is_set('KNMI_WMS_KEY') ? awb_env('KNMI_WMS_KEY') : (awb_env_is_set('KNMI_OPEN_DATA_KEY') ? awb_env('KNMI_OPEN_DATA_KEY') : '');
if ($key === '') {
	fail(503, 'KNMI_WMS_KEY not set. Please copy .env.example to .env (next to the html directory) and fill in the key.');
}

$query = http_build_query($params);
$ttl = $CACHE_TTL[$request];
$cache_file = $CACHE_DIR . '/awb-knmi-wms-' . md5($query);

/* Serve from cache */
if (is_readable($cache_file) && is_readable($cache_file . '.type') && (time() - filemtime($cache_file)) < $ttl) {
	header('Content-Type: ' . file_get_contents($cache_file . '.type'));
	header('Cache-Control: public, max-age=' . ($ttl - (time() - filemtime($cache_file))));
	header('X-Cache: HIT');
	readfile($cache_file);
	exit;
}

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $WMS_URL . '?' . $query);
curl_setopt($ch, CURLOPT_HTTPHEADER, array('Authorization: ' . $key, 'User-Agent: AviationWeatherBoard'));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $CURL_TIMEOUT);
curl_setopt($ch, CURLOPT_TIMEOUT, $CURL_TIMEOUT);
$data = curl_exec($ch);
if (curl_errno($ch)) {
	$error = curl_error($ch);
	curl_close($ch);
	fail(502, 'KNMI WMS not reachable: ' . $error);
}
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
curl_close($ch);

if ($status != 200) {
	fail(502, 'KNMI WMS returned HTTP ' . $status);
}
if ($type === null || $type === '') {
	$type = ($request === 'GETMAP') ? 'image/png' : 'text/xml';
}
/* A WMS error comes back as XML with status 200; do not cache those */
if ($request === 'GETMAP' && strpos($type, 'image/') !== 0) {
	http_response_code(502);
	header('Content-Type: ' . $type);
	header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');
	echo($data);
	exit;
}
file_put_contents($cache_file, $data, LOCK_EX);
file_put_contents($cache_file . '.type', $type, LOCK_EX);
chmod($cache_file, 0600);
chmod($cache_file . '.type', 0600);

header('Content-Type: ' . $type);
header('Cache-Control: public, max-age=' . $ttl);
header('X-Cache: MISS');
echo($data);
?>
