<?php
/*
 * Staat er een demo klaar, en tot wanneer?
 *
 * Twee soorten, met elk een eigen markering in /run - dus op een tmpfs, zodat geen van beide een
 * herstart van de Pi overleeft. Dat is met opzet: een bord dat na een stroomstoring blijft hangen in
 * verzonnen weer, op een plek waar mensen beslissen of ze springen, is precies wat niet mag
 * gebeuren. Zetten doet de Discord-bot, lezen doet het bord.
 *
 *   awb-demo-until   de mooiweerstand: het bord laadt zichzelf opnieuw met ?demo=<tijd> (demo.js)
 *   awb-demo-scene   een vast tafereel van een halve minuut, zonder herladen (demo-scenes.js)
 *   awb-outlook      het vooruitzicht voor morgen op de plek van het bulletin (outlook.js); dit
 *                    heeft geen eindtijd, het blijft staan tot /normaal
 *
 * En één die geen demo is maar dezelfde vraag beantwoordt - staat er iets anders dan normaal:
 *
 *   /run/awb-screens/second   er hangt een tweede scherm en daar staan de jumpruns. Dan hoeft
 *                     het bord ze niet ook nog eens in zijn kaartlus te zetten. Gezet door
 *                     awb-screen2.sh. De map wordt door systemd aangemaakt en is van de
 *                     kioskgebruiker, want /run zelf mag die niet beschrijven; en niet in /tmp,
 *                     want lighttpd heeft er met PrivateTmp een eigen exemplaar van en ziet daar
 *                     nooit iets van een ander staan.
 */
$until_file = '/run/awb-demo-until';
$scene_file = '/run/awb-demo-scene';
$outlook_file = '/run/awb-outlook';
$screen2_file = '/run/awb-screens/second';

$until = is_readable($until_file) ? (int) trim(file_get_contents($until_file)) : 0;
$active = ($until > time());

/* De markering van een tafereel is "<eindtijd> <naam>"; de naam is de sleutel in demo-scenes.js */
$scene = null;
if (is_readable($scene_file)) {
	$parts = preg_split('/\s+/', trim(file_get_contents($scene_file)), 2);
	if (count($parts) === 2 && (int) $parts[0] > time() && preg_match('/^[a-z0-9-]{1,40}$/', $parts[1])) {
		$scene = array('name' => $parts[1], 'until' => (int) $parts[0]);
	}
}

/* Het vooruitzicht voor morgen: staat de markering er, dan staat het op het bord. Geen eindtijd -
   het blijft tot iemand het uitzet, of tot de Pi herstart en /run leeg is. */
$outlook = (is_readable($outlook_file) && trim(file_get_contents($outlook_file)) !== '');

/* Draait er een tweede scherm met de jumpruns erop? */
$screen2 = is_readable($screen2_file);

header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');
echo(json_encode(array(
	'active' => $active,
	'until' => $active ? $until : null,
	'scene' => $scene,
	'outlook' => $outlook ? array('on' => true) : null,
	'screen2' => $screen2,
)));
