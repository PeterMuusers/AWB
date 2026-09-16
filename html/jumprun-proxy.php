<?php
/*
 * Proxy for the precipitation forecast of jumprun.nl (cloudbase), used by
 * html/scripts/modules/radar.js. Runs server-side so the browser needs no CORS access to
 * jumprun.nl, sends the optional API key from .env (JUMPRUN_API_KEY, header X-Api-Key) so
 * jumprun.nl can restrict access later, and caches the frames on disk: several screens on
 * one board fetch every frame only once.
 *
 * Usage:
 *   jumprun-proxy.php?action=radar_forecast&station=hoogeveen
 *       -> run, bounds and frames (time + url of the frame through this proxy), cached 2 minutes
 *   jumprun-proxy.php?action=frame&run=YYYYMMDDHHMM&i=N
 *       -> one frame PNG, cached 1 hour
 * JUMPRUN_URL in .env overrides the default https://weer.jumprun.nl.
 */

require __DIR__ . '/env.php';

$JUMPRUN_URL = awb_env_is_set('JUMPRUN_URL') ? rtrim(awb_env('JUMPRUN_URL'), '/') : 'https://weer.jumprun.nl';
$API_KEY = awb_env_is_set('JUMPRUN_API_KEY') ? awb_env('JUMPRUN_API_KEY') : '';
$CACHE_DIR = sys_get_temp_dir();
$FORECAST_TTL = 2 * 60;
$FRAME_TTL = 60 * 60;
$CURL_TIMEOUT = 20;

function fail($code, $message) {
	http_response_code($code);
	header('Content-Type: application/json');
	header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');
	echo(json_encode(array('error' => $message)));
	exit;
}

/* GET on jumprun.nl with the API key; returns array(status, content-type, body) */
function jumprun_get($path) {
	global $JUMPRUN_URL, $API_KEY, $CURL_TIMEOUT;
	$headers = array('User-Agent: AviationWeatherBoard', 'Accept: application/json, image/png');
	if ($API_KEY !== '') {
		$headers[] = 'X-Api-Key: ' . $API_KEY;
	}
	$ch = curl_init();
	curl_setopt($ch, CURLOPT_URL, $JUMPRUN_URL . $path);
	curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $CURL_TIMEOUT);
	curl_setopt($ch, CURLOPT_TIMEOUT, $CURL_TIMEOUT);
	$body = curl_exec($ch);
	if (curl_errno($ch)) {
		$error = curl_error($ch);
		curl_close($ch);
		fail(502, 'jumprun.nl not reachable: ' . $error);
	}
	$result = array(curl_getinfo($ch, CURLINFO_HTTP_CODE), curl_getinfo($ch, CURLINFO_CONTENT_TYPE), $body);
	curl_close($ch);
	return $result;
}

function serve_cached($file, $ttl, $type) {
	if (is_readable($file) && (time() - filemtime($file)) < $ttl) {
		header('Content-Type: ' . $type);
		header('Cache-Control: public, max-age=' . ($ttl - (time() - filemtime($file))));
		header('X-Cache: HIT');
		readfile($file);
		exit;
	}
}

function action_radar_forecast() {
	global $CACHE_DIR, $FORECAST_TTL;
	$station = isset($_GET['station']) ? strtolower($_GET['station']) : 'hoogeveen';
	if (!preg_match('/^[a-z0-9_-]+$/', $station)) {
		fail(400, 'Invalid station.');
	}
	$cache_file = $CACHE_DIR . '/awb-jumprun-forecast-' . $station . '.json';
	serve_cached($cache_file, $FORECAST_TTL, 'application/json');

	list($status, $type, $body) = jumprun_get('/api/radar_forecast?station=' . rawurlencode($station));
	if ($status == 401 || $status == 403) {
		fail(502, 'jumprun.nl refused the request (HTTP ' . $status . '): check JUMPRUN_API_KEY in .env');
	}
	if ($status != 200) {
		fail(502, 'jumprun.nl returned HTTP ' . $status);
	}
	$data = json_decode($body, true);
	if (!is_array($data) || empty($data['run']) || empty($data['frames']) || !preg_match('/^\d{12}$/', $data['run'])) {
		fail(502, 'jumprun.nl returned no forecast');
	}
	/* Point the frame urls at this proxy */
	foreach ($data['frames'] as $i => $frame) {
		$data['frames'][$i]['url'] = 'jumprun-proxy.php?action=frame&run=' . $data['run'] . '&i=' . $i;
	}
	$data['source'] = 'jumprun.nl';
	$output = json_encode($data);
	file_put_contents($cache_file, $output, LOCK_EX);
	header('Content-Type: application/json');
	header('Cache-Control: public, max-age=' . $FORECAST_TTL);
	header('X-Cache: MISS');
	echo($output);
}

function action_frame() {
	global $CACHE_DIR, $FRAME_TTL;
	$run = isset($_GET['run']) ? $_GET['run'] : '';
	$i = isset($_GET['i']) ? $_GET['i'] : '';
	if (!preg_match('/^\d{12}$/', $run) || !preg_match('/^\d{1,3}$/', $i)) {
		fail(400, 'Invalid frame.');
	}
	$cache_file = $CACHE_DIR . '/awb-jumprun-frame-' . $run . '-' . (int)$i . '.png';
	serve_cached($cache_file, $FRAME_TTL, 'image/png');

	list($status, $type, $body) = jumprun_get('/api/radar_forecast/frame/' . $run . '/' . (int)$i . '.png');
	if ($status != 200 || strpos((string)$type, 'image/') !== 0) {
		fail(($status == 404) ? 404 : 502, 'jumprun.nl frame not available (HTTP ' . $status . ')');
	}
	file_put_contents($cache_file, $body, LOCK_EX);
	/* Remove frames of older runs */
	foreach (glob($CACHE_DIR . '/awb-jumprun-frame-*.png') as $old) {
		if (time() - filemtime($old) > $FRAME_TTL) {
			@unlink($old);
		}
	}
	header('Content-Type: image/png');
	header('Cache-Control: public, max-age=' . $FRAME_TTL);
	header('X-Cache: MISS');
	echo($body);
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	fail(405, 'Method not allowed.');
}
switch (isset($_GET['action']) ? $_GET['action'] : '') {
	case 'radar_forecast' :
		action_radar_forecast();
		break;
	case 'frame' :
		action_frame();
		break;
	default :
		fail(400, 'Unknown action.');
		break;
}
?>
