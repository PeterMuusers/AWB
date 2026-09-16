<?php
/*
 * Rewrites the KNMI low level forecast into plain language, through the Claude API.
 *
 * The bulletin is written for pilots: abbreviations, altitudes in flight levels, telegram style.
 * This turns it into a few readable lines for the people standing at the boarding area, without
 * changing what it says. The model is told to simplify only: no advice, nothing added, nothing
 * left out, every number kept as it is.
 *
 * The board POSTs the bulletin text it already fetched; the answer is cached under a hash of that
 * text, so the model is asked once per bulletin (about four times a day) and every screen after
 * that reads the cache. The API key lives in .env above the web root and never reaches the browser.
 *
 * Raw HTTP on purpose: this project ships plain PHP files that the Raspberry Pi installer copies
 * into place. There is no composer and no vendor directory to install an SDK into.
 */

require __DIR__ . '/env.php';

$API_URL = 'https://api.anthropic.com/v1/messages';
$API_VERSION = '2023-06-01';
$FALLBACK_BETA = 'server-side-fallback-2026-07-01';
$DEFAULT_MODEL = 'claude-haiku-4-5';
$MAX_TOKENS = 1500;
$CACHE_TTL = 24 * 60 * 60;		// the cache key is the bulletin itself, so this only sweeps up old ones
$CACHE_DIR = sys_get_temp_dir();
$CURL_TIMEOUT = 60;
$MIN_BULLETIN = 200;			// characters; anything shorter is not a bulletin
$MAX_BULLETIN = 20000;

/* What the model is asked to do. Kept here rather than in the browser so it cannot be edited
   from the outside, and so every screen gets the same wording. */
$SYSTEM_PROMPT = <<<'PROMPT'
Je herschrijft het weerbulletin voor de kleine luchtvaart van het KNMI voor parachutisten op een
dropzone. Het bulletin is geschreven voor vliegers: afkortingen, telegramstijl, hoogtes in voeten
en vliegniveaus.

Regels, in deze volgorde van belang:
1. Voeg niets toe en laat niets weg. Alles wat je schrijft moet in het bulletin staan.
2. Neem elk getal exact over: hoogtes, windsnelheden, tijden, richtingen. Reken niets om.
3. Onzekerheid blijft onzekerheid. Staat er "lokaal" of "kans op", schrijf dat dan ook.
4. Geef geen advies en zeg niet of er gesprongen kan worden. Dat bepaalt de springleiding.
5. Schrijf in gewoon Nederlands, korte zinnen, geen afkortingen behalve UTC en gangbare
   luchtvaarttermen die je uitlegt bij eerste gebruik.

Vorm van je antwoord: maximaal vijf regels. Elke regel begint met een onderwerp van een of twee
woorden, dan een dubbele punt, dan de tekst. Geen opsommingstekens, geen markdown, geen inleiding
en geen afsluiting. Kies zelf de onderwerpen die er in dit bulletin toe doen, bijvoorbeeld wind,
bewolking, zicht, buien of thermiek.
PROMPT;

set_time_limit(90);
header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');

function fail($code, $message) {
	http_response_code($code);
	echo(json_encode(array('error' => $message)));
	exit;
}

/* The model to use, from config.json so it can be changed without touching code */
function configured_model() {
	global $DEFAULT_MODEL;
	$file = __DIR__ . '/config.json';
	if (isset($_GET['location']) && preg_match('/^[A-Za-z0-9_-]+$/', $_GET['location'])) {
		$file = __DIR__ . '/config-' . $_GET['location'] . '.json';
	}
	if (is_readable($file)) {
		$config = json_decode(file_get_contents($file), true);
		if (isset($config['llfc']['model']) && preg_match('/^[a-z0-9.\[\]-]+$/', $config['llfc']['model'])) {
			return $config['llfc']['model'];
		}
	}
	return $DEFAULT_MODEL;
}

/* The small and older models have no effort setting and reject one; the larger ones think before
   they answer unless told to keep it short, which this job does not need. */
function takes_effort($model) {
	return (strpos($model, 'haiku') === false && strpos($model, '-4-5') === false);
}

/* One call to the API. Returns array(status, body). */
function ask_claude($key, $model, $bulletin, $with_fallback) {
	global $API_URL, $API_VERSION, $FALLBACK_BETA, $MAX_TOKENS, $SYSTEM_PROMPT, $CURL_TIMEOUT;

	$body = array(
		'model' => $model,
		'max_tokens' => $MAX_TOKENS,
		'system' => $SYSTEM_PROMPT,
		'messages' => array(
			array('role' => 'user', 'content' => $bulletin),
		),
	);
	if (takes_effort($model)) {
		/* a short, factual rewrite needs no deep reasoning */
		$body['output_config'] = array('effort' => 'low');
	}
	$headers = array(
		'Content-Type: application/json',
		'x-api-key: ' . $key,
		'anthropic-version: ' . $API_VERSION,
	);
	if ($with_fallback) {
		/* if a safety classifier ever declines, the server picks another model instead of failing */
		$body['fallbacks'] = 'default';
		$headers[] = 'anthropic-beta: ' . $FALLBACK_BETA;
	}

	$ch = curl_init();
	curl_setopt($ch, CURLOPT_URL, $API_URL);
	curl_setopt($ch, CURLOPT_POST, true);
	curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
	curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $CURL_TIMEOUT);
	curl_setopt($ch, CURLOPT_TIMEOUT, $CURL_TIMEOUT);
	$response = curl_exec($ch);
	if (curl_errno($ch)) {
		$error = curl_error($ch);
		curl_close($ch);
		fail(502, 'Claude API not reachable: ' . $error);
	}
	$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
	curl_close($ch);
	return array($status, $response);
}

/* The text of the answer, or null when the model declined or returned nothing usable */
function answer_text($data) {
	if (!isset($data['content']) || !is_array($data['content'])) {
		return null;
	}
	$text = '';
	foreach ($data['content'] as $block) {
		if (isset($block['type']) && $block['type'] === 'text' && isset($block['text'])) {
			$text .= $block['text'];
		}
	}
	$text = trim($text);
	return ($text === '') ? null : $text;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
	fail(405, 'Method not allowed.');
}
if (!awb_env_is_set('ANTHROPIC_API_KEY')) {
	fail(503, 'ANTHROPIC_API_KEY not set. Please add it to .env (next to the html directory) to use the rewritten forecast.');
}

$bulletin = trim(file_get_contents('php://input'));
if (strlen($bulletin) < $MIN_BULLETIN || strlen($bulletin) > $MAX_BULLETIN) {
	fail(400, 'No usable bulletin received.');
}

$model = configured_model();
$cache_file = $CACHE_DIR . '/awb-llfc-' . sha1($model . "\n" . $bulletin) . '.json';
if (is_readable($cache_file) && (time() - filemtime($cache_file)) < $CACHE_TTL) {
	header('X-Cache: HIT');
	readfile($cache_file);
	exit;
}

/* the refusal fallback is a feature of the large models; asking for it elsewhere only costs a
   round trip, and the retry below would have to undo it anyway */
list($status, $response) = ask_claude(awb_env('ANTHROPIC_API_KEY'), $model, $bulletin, takes_effort($model));
$data = json_decode($response, true);
if ($status === 400 && is_string($response) && stripos($response, 'fallback') !== false) {
	/* the account or the model does not have that beta: ask again without it */
	list($status, $response) = ask_claude(awb_env('ANTHROPIC_API_KEY'), $model, $bulletin, false);
	$data = json_decode($response, true);
}
if ($status != 200) {
	$message = isset($data['error']['message']) ? $data['error']['message'] : ('HTTP ' . $status);
	fail(502, 'Claude API returned an error: ' . $message);
}
if (isset($data['stop_reason']) && $data['stop_reason'] === 'refusal') {
	fail(502, 'Claude declined to rewrite this bulletin.');
}
$text = answer_text($data);
if ($text === null) {
	fail(502, 'Claude returned no text.');
}

$output = json_encode(array(
	'text' => $text,
	'model' => isset($data['model']) ? $data['model'] : $model,
	'rewritten_at' => gmdate('c'),
));
file_put_contents($cache_file, $output, LOCK_EX);
chmod($cache_file, 0600);
/* sweep up rewrites of older bulletins */
foreach (glob($CACHE_DIR . '/awb-llfc-*.json') as $old) {
	if (time() - filemtime($old) > $CACHE_TTL) {
		@unlink($old);
	}
}
header('X-Cache: MISS');
echo($output);
?>
