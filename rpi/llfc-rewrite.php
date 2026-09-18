#!/usr/bin/env php
<?php
/*
 * Herschrijft het weerbulletin voor de kleine luchtvaart van het KNMI in gewone taal, via de
 * Claude API, en zet het resultaat klaar als een gewoon bestand dat de webserver uitdeelt.
 *
 * Dit draait niet onder de webserver maar als losse opdracht, elke paar minuten aangezwengeld door
 * een timer van systemd (rpi/setup.sh maakt awb-llfc.timer). Dat is met opzet: zolang het
 * herschrijven een adres op de webserver was, kon iedereen die de Pi kan bereiken - de hele
 * clubwifi, de hele tailnet - er tekst naartoe sturen en de sleutel laten betalen. Er is nu geen
 * enkele weg van buiten naar de API: het bord leest alleen nog het antwoord dat hier klaar staat,
 * en de sleutel ligt in /etc/awb/anthropic-key, waar de webserver niet bij kan.
 *
 * Het bulletin wordt hier zelf opgehaald, met de etag van de vorige keer erbij: is er niets
 * veranderd, dan antwoordt het KNMI met 304 en nul bytes en is deze ronde klaar. Pas als er echt
 * een nieuw bulletin staat gaat er iets naar Claude - een keer of vier per dag.
 *
 *     rpi/llfc-rewrite.php                 ophalen, en herschrijven als het bulletin nieuw is
 *     rpi/llfc-rewrite.php --force         ook herschrijven als het al gedaan was
 *     rpi/llfc-rewrite.php --out /tmp/x.json --state /tmp/s.json --config html/config.json
 *
 * Raw HTTP op de API, net als de rest van dit project: er is geen composer en geen vendormap.
 */

require __DIR__ . '/../html/env.php';

$API_URL = 'https://api.anthropic.com/v1/messages';
$API_VERSION = '2023-06-01';
$FALLBACK_BETA = 'server-side-fallback-2026-07-01';
$DEFAULT_MODEL = 'claude-haiku-4-5';
$MAX_TOKENS = 1500;
$CURL_TIMEOUT = 60;
$MIN_BULLETIN = 200;			// tekens; korter is geen bulletin
$MAX_BULLETIN = 20000;

/* Waar de sleutel ligt. Apart van .env, want dat bestand leest de webserver ook (voor de sleutels
   van de weerbronnen); deze hoort alleen van root te zijn. In ontwikkeling mag hij uit .env komen. */
$KEY_FILE = '/etc/awb/anthropic-key';

/* Wat het bord leest, en wat dit script zelf onthoudt. Het eerste bestand deelt lighttpd uit als
   /llfc.json; het tweede blijft hier en bevat alleen de etag van het KNMI. */
$OUT_FILE = '/var/lib/awb/llfc.json';
$STATE_FILE = '/var/lib/awb/llfc-state.json';

/* De bron. Hetzelfde adres en dezelfde User-Agent als de module in de browser: zonder een gewone
   User-Agent geeft de CloudFront van het KNMI een 403. */
$BULLETIN_URL = 'https://www.knmi.nl/nederland-nu/luchtvaart/weerbulletin-kleine-luchtvaart';
$USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0';

/* Welk model, uit config.json, zodat je het kunt wijzigen zonder aan code te komen. Eén bestand is
   genoeg: het bulletin geldt voor heel Nederland, dus een tweede veld op dit bord leest hetzelfde
   antwoord. */
$CONFIG_FILE = __DIR__ . '/../html/config.json';


/* Wat het model moet doen. Staat hier en niet in de browser, zodat het van buiten niet te wijzigen
   is en elk scherm dezelfde woorden krijgt. */
$SYSTEM_PROMPT = <<<'PROMPT'
Je zet het weerbulletin voor de kleine luchtvaart van het KNMI om in een paar regels die een
parachutist op de dropzone meteen begrijpt. Schrijf zoals je het in de hangar zou vertellen aan
iemand die zo gaat springen.

Wat deze lezers willen weten:
- Bewolking: op welke hoogte hangt het en hoeveel. Begin met de basis van de laagste laag, want
  daar zakt de koepel doorheen.
- Wind aan de grond: hoe hard, uit welke hoek, en of er stoten bij zitten.
- Buien en onweer: wanneer, waar en hoe zwaar.
- Zicht.
- Turbulentie en thermiek, want dat voel je onder de koepel.
- Wat er morgen anders is, in een regel.

Regels, in deze volgorde van belang:
1. Verzin niets. Alles wat je schrijft moet in het bulletin staan.
2. Neem elk getal exact over: hoogtes, windsnelheden, zicht, richtingen. Hoogtes altijd in voeten;
   een vliegniveau schrijf je als voeten, FL100 wordt 10.000 voet.
3. Tijden neem je over zoals ze in het bulletin staan, inclusief UTC. Reken ze niet om: het bord
   zet er zelf de lokale tijd bij.
4. Onzekerheid blijft onzekerheid. Staat er "lokaal" of "kans op", schrijf dat dan ook.
5. Zeg niet of er wel of niet gesprongen kan worden, en geef geen advies. Dat bepaalt de
   springleiding; jij levert alleen het weerbeeld.
6. Beschrijf een wolkenlaag altijd als: hoeveel, basis op zoveel voet, toppen tot zoveel voet.
   Verwissel nooit een basis met een top en verander nooit de volgorde van de lagen. In het
   bulletin staat de basis eerst en de toppen erachter.
7. Geen vakjargon en geen afkortingen. Schrijf buienwolken in plaats van cumulonimbus of CB,
   stapelwolken in plaats van cumulus of CU, laaghangende bewolking in plaats van stratocumulus of
   SC. Weinig, verspreid, veel en gesloten in plaats van few, sct, bkn en ovc. Gebruik ook deze
   woorden niet: geisoleerd (schrijf hier en daar), significant, occlusie, frontale zone, periode,
   landinwaarts (schrijf in het binnenland). Let op je Nederlands, lees je zinnen na.

Vorm: een regel per onderwerp, in deze volgorde en met precies deze woorden ervoor:
Bewolking, Grondwind, Buien, Zicht, Thermiek, Morgen. Achter het onderwerp een dubbele punt en dan
de tekst. Zet informatie onder het onderwerp waar ze hoort, dus zicht niet bij buien. Laat een
onderwerp alleen weg als het bulletin er niets over zegt. Korte zinnen. Geen opsommingstekens, geen markdown, geen inleiding en
geen afsluiting. Het nulgradenniveau, de hoogtewinden, de maximumtemperatuur en de daglichtperiode
mag je weglaten: die staan elders op het bord.
PROMPT;

function fail($message) {
	fwrite(STDERR, $message . "\n");
	exit(1);
}

/* Meldingen die geen fout zijn horen in het journaal, maar niet in de mailbox van een timer */
function note($message) {
	fwrite(STDOUT, $message . "\n");
}

/* De sleutel: eerst het bestand dat alleen root kan lezen, anders .env (voor ontwikkeling) */
function api_key($file) {
	if (is_readable($file)) {
		$key = trim(file_get_contents($file));
		if ($key !== '') {
			return $key;
		}
	}
	return awb_env_is_set('ANTHROPIC_API_KEY') ? awb_env('ANTHROPIC_API_KEY') : '';
}

/* Alleen herschrijven als het bord erom vraagt. Staat llfc.mode niet op ai, dan hoeft de sleutel er
   ook niet aan: het bord toont dan het bulletin zoals het KNMI het schrijft. Dezelfde voorwaarde als
   in knmi_llfc.js, zodat de timer nooit iets klaarzet dat niemand leest. */
function rewriting_wanted($file) {
	if (!is_readable($file)) {
		return false;
	}
	$config = json_decode(file_get_contents($file), true);
	return isset($config['llfc']['mode']) && $config['llfc']['mode'] === 'ai';
}

/* Het model uit config.json, of het standaardmodel */
function configured_model($file, $fallback) {
	if (is_readable($file)) {
		$config = json_decode(file_get_contents($file), true);
		if (isset($config['llfc']['model']) && preg_match('/^[a-z0-9.\[\]-]+$/', $config['llfc']['model'])) {
			return $config['llfc']['model'];
		}
	}
	return $fallback;
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

/* De pagina van het KNMI ophalen, met de etag van de vorige keer erbij. Geeft array(status, body,
   etag); bij 304 is de body leeg en staat het bulletin dat we al hebben nog steeds. */
function fetch_bulletin($url, $agent, $etag, $timeout) {
	$headers = array('User-Agent: ' . $agent);
	if ($etag !== null && $etag !== '') {
		$headers[] = 'If-None-Match: ' . $etag;
	}
	$seen = '';
	$ch = curl_init();
	curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $line) use (&$seen) {
		if (preg_match('/^ETag:\s*(.+?)\s*$/i', $line, $m)) {
			$seen = $m[1];
		}
		return strlen($line);
	});
	curl_setopt($ch, CURLOPT_URL, $url);
	curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $timeout);
	curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
	curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
	curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
	$body = curl_exec($ch);
	if (curl_errno($ch)) {
		$error = curl_error($ch);
		curl_close($ch);
		fail('Het KNMI is niet bereikbaar: ' . $error);
	}
	$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
	curl_close($ch);
	return array($status, $body, $seen);
}

/* Het bulletin uit de pagina snijden, precies zoals de module in de browser dat doet: het staat in
   telexopmaak tussen ZCZC en het einde van het pre-blok. */
function slice_bulletin($page) {
	$start = strpos($page, 'ZCZC');
	$end = strpos($page, '</pre>');
	if ($start === false || $end === false || $end <= $start) {
		return '';
	}
	return trim(substr($page, $start, $end - $start));
}

/* Het moment waarop dit bulletin is uitgegeven: de zes cijfers achter EHDB, dag-uur-minuut in UTC.
   Het bord vergelijkt dit met het bulletin dat het zelf ophaalde en toont de herschreven tekst pas
   als ze bij elkaar horen - anders zou je na een nieuw bulletin even de oude uitleg zien. */
function issued_at($bulletin) {
	return preg_match('/EHDB (\d{6})/', $bulletin, $m) ? $m[1] : '';
}

/* Schrijven zonder dat het bord ooit een half bestand kan lezen */
function write_atomic($file, $content, $mode) {
	$temp = $file . '.' . getmypid();
	if (file_put_contents($temp, $content, LOCK_EX) === false) {
		fail('Kan niet schrijven in ' . dirname($file));
	}
	chmod($temp, $mode);
	if (!rename($temp, $file)) {
		@unlink($temp);
		fail('Kan ' . $file . ' niet vervangen');
	}
}

/* ------------------------------------------------------------------ uitvoeren */

$force = false;
$argv_ = array_slice($argv, 1);
for ($i = 0; $i < count($argv_); $i++) {
	$flag = $argv_[$i];
	$value = isset($argv_[$i + 1]) ? $argv_[$i + 1] : '';
	if ($flag === '--force') {
		$force = true;
	} elseif ($flag === '--out') {
		$OUT_FILE = $value; $i++;
	} elseif ($flag === '--state') {
		$STATE_FILE = $value; $i++;
	} elseif ($flag === '--config') {
		$CONFIG_FILE = $value; $i++;
	} elseif ($flag === '--key-file') {
		$KEY_FILE = $value; $i++;
	} else {
		fail('Onbekende optie: ' . $flag);
	}
}

if (!rewriting_wanted($CONFIG_FILE)) {
	/* niets te doen, en niets om over te klagen */
	exit(0);
}

$key = api_key($KEY_FILE);
if ($key === '') {
	fail('Geen sleutel. Zet hem in ' . $KEY_FILE . ' of als ANTHROPIC_API_KEY in .env.');
}

$current = is_readable($OUT_FILE) ? json_decode(file_get_contents($OUT_FILE), true) : null;
$state = is_readable($STATE_FILE) ? json_decode(file_get_contents($STATE_FILE), true) : null;
/* Alleen vragen of er iets veranderd is als we het antwoord van de vorige keer ook echt nog hebben */
$etag = (is_array($current) && is_array($state) && isset($state['etag'])) ? $state['etag'] : null;

list($status, $page, $seen_etag) = fetch_bulletin($BULLETIN_URL, $USER_AGENT, $etag, $CURL_TIMEOUT);
if ($status === 304) {
	exit(0);
}
if ($status !== 200) {
	fail('Het KNMI antwoordt met HTTP ' . $status);
}

$bulletin = slice_bulletin($page);
if (strlen($bulletin) < $MIN_BULLETIN || strlen($bulletin) > $MAX_BULLETIN) {
	fail('Geen bruikbaar bulletin in de pagina (' . strlen($bulletin) . ' tekens)');
}

$model = configured_model($CONFIG_FILE, $DEFAULT_MODEL);
/* De opdracht hoort bij de sleutel: verander je de woorden, dan wordt er opnieuw gevraagd in
   plaats van dat de oude uitleg blijft staan tot het bulletin verandert. */
$fingerprint = sha1($model . "\n" . $SYSTEM_PROMPT . "\n" . $bulletin);
$fresh_etag = ($seen_etag !== '') ? $seen_etag : $etag;

if (!$force && is_array($current) && isset($current['fingerprint']) && $current['fingerprint'] === $fingerprint) {
	/* Zelfde bulletin, andere etag: onthouden, en verder niets te doen */
	write_atomic($STATE_FILE, json_encode(array('etag' => $fresh_etag)), 0600);
	exit(0);
}

/* de terugval bij een weigering is iets van de grote modellen; elders kost vragen erom alleen een
   ronde, en de tweede poging hieronder zou hem toch weer weg moeten halen */
list($status, $response) = ask_claude($key, $model, $bulletin, takes_effort($model));
$data = json_decode($response, true);
if ($status === 400 && is_string($response) && stripos($response, 'fallback') !== false) {
	/* het account of het model heeft die beta niet: opnieuw vragen zonder */
	list($status, $response) = ask_claude($key, $model, $bulletin, false);
	$data = json_decode($response, true);
}
if ($status != 200) {
	$message = isset($data['error']['message']) ? $data['error']['message'] : ('HTTP ' . $status);
	fail('De Claude API antwoordt met een fout: ' . $message);
}
if (isset($data['stop_reason']) && $data['stop_reason'] === 'refusal') {
	fail('Claude weigert dit bulletin te herschrijven.');
}
$text = answer_text($data);
if ($text === null) {
	fail('Claude gaf geen tekst terug.');
}

write_atomic($OUT_FILE, json_encode(array(
	'text' => $text,
	'model' => isset($data['model']) ? $data['model'] : $model,
	'rewritten_at' => gmdate('c'),
	'issued' => issued_at($bulletin),
	'fingerprint' => $fingerprint,
)), 0644);
write_atomic($STATE_FILE, json_encode(array('etag' => $fresh_etag)), 0600);
note('Nieuw bulletin van ' . issued_at($bulletin) . ' herschreven met ' . $model);
