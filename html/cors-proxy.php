<?php
/*
 * Fetch a URL on behalf of the board, for sources that send no CORS headers.
 *
 * The board asks for the url in the X-Request-Url header. That header comes from the browser, so it
 * comes from whoever has the page open - and this board hangs on a club network where that is not
 * only the board itself. Without a list of allowed hosts this file is an open proxy: anything that
 * can reach the Pi can have it fetch any address, including the router next to it and every other
 * machine on that network, and read the answer. So: only the sources the board actually uses, only
 * https, and never an address that resolves to the network the Pi is standing on.
 */
$CURL_TIMEOUT = 5;

/* The hosts the modules fetch through here. A module that needs another source gets a line. */
$ALLOWED_HOSTS = array(
	'www.knmi.nl',					// low level forecast bulletin
	'geoservices.knmi.nl',			// precipitation radar (WMS)
	'view.eumetsat.int',			// satellite imagery (WMS)
	'server.arcgisonline.com',		// base map tiles
	'tgftp.nws.noaa.gov',			// METAR and TAF
	'windsaloft.us',				// winds aloft
);

/* Addresses on the network the board itself stands on. A hostname that resolves to one of these is
   refused: that is the case this list exists for, and a name in the list above can never point
   there, but a compromised or hijacked name could. */
function awb_is_local($ip) {
	if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 | FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false) {
		return false;
	}
	if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6 | FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false) {
		return false;
	}
	return true;
}

function awb_refuse($code, $message) {
	http_response_code($code);
	header('Content-Type: text/plain');
	echo($message . "\n");
	exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	awb_refuse(405, 'Only GET.');
}
if (!isset($_SERVER['HTTP_X_REQUEST_URL']) || $_SERVER['HTTP_X_REQUEST_URL'] === '') {
	awb_refuse(400, 'No X-Request-Url.');
}

$url = $_SERVER['HTTP_X_REQUEST_URL'];
$parts = parse_url($url);
if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
	awb_refuse(400, 'Not a url.');
}
if (strtolower($parts['scheme']) !== 'https') {
	awb_refuse(403, 'Only https.');
}
$host = strtolower($parts['host']);
if (!in_array($host, $ALLOWED_HOSTS, true)) {
	awb_refuse(403, 'Host not allowed: ' . $host);
}
foreach (array_merge(gethostbynamel($host) ?: array(), array()) as $ip) {
	if (awb_is_local($ip)) {
		awb_refuse(403, 'Host points at this network.');
	}
}

$headers = array();
$headers[] = isset($_SERVER['HTTP_CACHE_CONTROL'])
	? 'Cache-Control: ' . $_SERVER['HTTP_CACHE_CONTROL']
	: 'Cache-Control: no-cache, no-store, must-revalidate, max-age=0';
$headers[] = isset($_SERVER['HTTP_PRAGMA']) ? 'Pragma: ' . $_SERVER['HTTP_PRAGMA'] : 'Pragma: no-cache';
if (isset($_SERVER['HTTP_X_USER_AGENT'])) {
	$headers[] = 'User-Agent: ' . $_SERVER['HTTP_X_USER_AGENT'];
}

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $CURL_TIMEOUT);
curl_setopt($ch, CURLOPT_TIMEOUT, 4 * $CURL_TIMEOUT);
/* No redirects: a redirect is the way around a list of allowed hosts. */
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
$data = curl_exec($ch);

if (curl_errno($ch)) {
	header('X-CORSProxy-Error: ' . curl_errno($ch));
	http_response_code(502);
	curl_close($ch);
	exit;
}
http_response_code(curl_getinfo($ch, CURLINFO_HTTP_CODE));
if (curl_getinfo($ch, CURLINFO_CONTENT_TYPE) !== null) {
	header('Content-Type: ' . curl_getinfo($ch, CURLINFO_CONTENT_TYPE));
}
header('X-CORSProxy-Total-Time: ' . curl_getinfo($ch, CURLINFO_TOTAL_TIME));
echo($data);
curl_close($ch);
