<?php
/*
 * Staat de demo aan, en tot wanneer?
 *
 * De markering is een bestand in /run met een eindtijd erin. Dat staat op een tmpfs, dus een demo
 * overleeft geen herstart van de Pi - precies goed: een bord dat na een stroomstoring verzonnen weer
 * blijft tonen is het laatste wat je wilt. Zetten doet de Discord-bot, lezen doet het bord.
 */
$file = '/run/awb-demo-until';
$until = is_readable($file) ? (int) trim(file_get_contents($file)) : 0;
$active = ($until > time());

header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');
echo(json_encode(array('active' => $active, 'until' => $active ? $until : null)));
