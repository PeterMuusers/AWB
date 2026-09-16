<?php
/*
 * Reads settings that must never reach the browser: the .env file in the directory above
 * the web root (/var/www/.env on the Raspberry Pi, the repository root in development, see
 * .env.example), or real environment variables, which take precedence. Used by the proxies.
 */

function awb_env_file() {
	return dirname(__DIR__) . '/.env';
}

/* Parse a .env file (KEY=value per line, # comments, optional quotes) */
function awb_parse_env_file($file) {
	$values = array();
	if (!is_readable($file)) {
		return $values;
	}
	foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
		$line = trim($line);
		if ($line === '' || substr($line, 0, 1) === '#' || strpos($line, '=') === false) {
			continue;
		}
		list($key, $value) = explode('=', $line, 2);
		$key = trim($key);
		$value = trim($value);
		if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'") && substr($value, -1) === $value[0]) {
			$value = substr($value, 1, -1);
		}
		$values[$key] = $value;
	}
	return $values;
}

/* Value of a setting, '' when not set */
function awb_env($key) {
	static $values = null;
	if ($values === null) {
		$values = awb_parse_env_file(awb_env_file());
	}
	$value = getenv($key);
	if ($value !== false && $value !== '') {
		return $value;
	}
	return isset($values[$key]) ? $values[$key] : '';
}

/* True when a setting is filled in and not one of the placeholders from .env.example */
function awb_env_is_set($key) {
	$value = awb_env($key);
	return ($value !== '' && $value !== '0000000000' && $value !== 'user@example.com');
}
?>
