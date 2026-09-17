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
 *   jumprun-proxy.php?action=jumprun&station=hoogeveen
 *       -> the jumprun somebody set for this dropzone today, or nothing. Short cache: it changes
 *          when a person decides it does, not on a schedule, so the board should see it soon.
 *          Answers "nothing" as long as the hide file exists (JUMPRUN_HIDDEN_FILE in .env, by
 *          default /var/lib/awb/jumprun-hidden): the board then leaves the jumprun off the screen
 *          without anything being deleted at jumprun.nl.
 *   jumprun-proxy.php?action=jumprun_state
 *       -> whether the jumpruns are hidden, and a stamp that changes when somebody puts one up or
 *          flips that switch. Costs nothing: no cache, and jumprun.nl is never asked. The board
 *          reads this every few seconds and only fetches the plans themselves when this says
 *          something happened.
 * JUMPRUN_URL in .env overrides the default https://weer.jumprun.nl.
 */

require __DIR__ . '/env.php';

$JUMPRUN_URL = awb_env_is_set('JUMPRUN_URL') ? rtrim(awb_env('JUMPRUN_URL'), '/') : 'https://weer.jumprun.nl';
$API_KEY = awb_env_is_set('JUMPRUN_API_KEY') ? awb_env('JUMPRUN_API_KEY') : '';
$CACHE_DIR = sys_get_temp_dir();
$FORECAST_TTL = 2 * 60;
$JUMPRUN_TTL = 20;				// seconds; a jumprun is put up by hand, so the board should notice quickly
/* While this file exists the board shows no jumprun at all. Not the same as removing one: the plan
   stays at jumprun.nl and comes back the moment the file goes. */
$HIDDEN_FILE = awb_env_is_set('JUMPRUN_HIDDEN_FILE') ? awb_env('JUMPRUN_HIDDEN_FILE') : '/var/lib/awb/jumprun-hidden';
/* Wordt aangeraakt zodra er iets aan de jumpruns verandert vanaf dit bord: publiceren, verbergen,
   weer tonen. Zo hoeft het scherm niet elke paar seconden het hele plan op te halen om te merken
   dat er niets gebeurd is. */
$STAMP_FILE = awb_env_is_set('JUMPRUN_STAMP_FILE') ? awb_env('JUMPRUN_STAMP_FILE') : '/var/lib/awb/jumprun-stamp';
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

/* The jumprun that was set for this dropzone today, plus who set it. Nothing set is not an error:
   on most days there is no jumprun on the board and the board simply leaves the segment out. */
function action_jumprun() {
	global $CACHE_DIR, $JUMPRUN_TTL, $HIDDEN_FILE;
	$station = isset($_GET['station']) ? strtolower($_GET['station']) : 'hoogeveen';
	if (!preg_match('/^[a-z0-9_-]+$/', $station)) {
		fail(400, 'Invalid station.');
	}
	/* Hidden by hand: say there is nothing, and say so straight away rather than from the cache, so
	   that hiding and showing again both land on the board within a screen refresh. */
	if ($HIDDEN_FILE !== '' && file_exists($HIDDEN_FILE)) {
		header('Content-Type: application/json');
		header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');
		echo(json_encode(array('station' => $station, 'jumprun' => null, 'hidden' => true)));
		exit;
	}
	$cache_file = $CACHE_DIR . '/awb-jumprun-plan-' . $station . '.json';
	serve_cached($cache_file, $JUMPRUN_TTL, 'application/json');

	list($status, $type, $body) = jumprun_get('/api/board/jumprun?station=' . rawurlencode($station));
	if ($status != 200) {
		fail(502, 'jumprun.nl returned HTTP ' . $status);
	}
	$data = json_decode($body, true);
	if (!is_array($data) || !array_key_exists('jumprun', $data)) {
		fail(502, 'jumprun.nl returned no answer about the jumprun');
	}
	$output = json_encode($data);
	file_put_contents($cache_file, $output, LOCK_EX);
	header('Content-Type: application/json');
	header('Cache-Control: public, max-age=' . $JUMPRUN_TTL);
	header('X-Cache: MISS');
	echo($output);
}

/* De schakelaar en niets anders: verborgen of niet, en een stempel dat verandert zodra er iets aan
   de jumpruns gedaan is. Geen cache, geen jumprun.nl - dit hoort goedkoop te zijn, want het bord
   vraagt het elke paar seconden. */
function action_jumprun_state() {
	global $HIDDEN_FILE, $STAMP_FILE;
	$hidden = ($HIDDEN_FILE !== '' && file_exists($HIDDEN_FILE));
	$stamp = ($STAMP_FILE !== '' && file_exists($STAMP_FILE)) ? filemtime($STAMP_FILE) : 0;
	/* het verbergen telt zelf ook als verandering, ook als niemand het stempel bijwerkt */
	if ($hidden) {
		$stamp = max($stamp, filemtime($HIDDEN_FILE));
	}
	header('Content-Type: application/json');
	header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');
	echo(json_encode(array('hidden' => $hidden, 'stamp' => $stamp)));
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
	case 'jumprun_state' :
		action_jumprun_state();
		break;
	case 'jumprun' :
		action_jumprun();
		break;
	default :
		fail(400, 'Unknown action.');
		break;
}
?>
