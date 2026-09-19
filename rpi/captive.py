#!/usr/bin/env python3
"""Achter een captive portal komen zonder dat er iemand op een knop klikt.

Een bord aan de muur heeft geen toetsenbord en de kiosk staat op één pagina, dus het scherm waar
je normaal "Akkoord" aanklikt komt nooit in beeld. Dit script doet dat klikken: het merkt dat er
een portaal voor de deur staat, haalt de pagina op, vult het formulier in dat erop staat en kijkt
daarna of het internet er echt is.

    sudo rpi/captive.py run          nu proberen, en vertellen wat het tegenkwam
    sudo rpi/captive.py status       staat er internet, een portaal, of niets?
    sudo rpi/captive.py install      als dienst: bij elke nieuwe verbinding en elke vijf minuten
    sudo rpi/captive.py uninstall    er weer af
    sudo rpi/captive.py log          wat er de laatste keren gebeurde

Let wel: dit accepteert de voorwaarden van dat portaal namens de eigenaar van het bord, elke keer
opnieuw en zonder dat iemand meekijkt. Dat is een keuze die je bewust maakt voor je eigen netwerk;
op een netwerk van een ander hoort het niet. Vraagt het portaal om een CAPTCHA of om inloggegevens,
dan houdt het hier op - die los ik niet op, en dan is een handmatige aanmelding de weg.

De laatste pagina die het portaal gaf blijft staan in /var/lib/awb/captive-last.html. Lukt het
aanmelden niet, dan is dat het bestand waaraan je ziet waarom.
"""

import http.cookiejar
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

# Twee proefballonnetjes: de eerste die antwoordt telt. Allebei zijn het adressen die met opzet
# iets onbenulligs teruggeven, zodat een portaal dat ertussen zit meteen opvalt.
PROBES = [
    ('http://connectivitycheck.gstatic.com/generate_204', 204, ''),
    ('http://captive.apple.com/hotspot-detect.html', 200, 'Success'),
]
TIMEOUT = 10
STATE_DIR = '/var/lib/awb'
LAST_PAGE = os.path.join(STATE_DIR, 'captive-last.html')
LOG = '/var/log/awb-captive.log'
# Een gewone browser-UA: sommige portalen sturen een kale client een andere pagina, of helemaal
# geen formulier.
AGENT = ('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) '
         'Chrome/120.0 Safari/537.36')


class Forms(HTMLParser):
    """De formulieren op een pagina, met de velden die erin staan.

    Geen externe bibliotheek: dit bord heeft er al genoeg, en een portaalpagina is klein en simpel.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.forms = []
        self.current = None
        self.select = None

    def handle_starttag(self, tag, attrs):
        attrs = {name.lower(): (value or '') for name, value in attrs}
        if tag == 'form':
            self.current = {'action': attrs.get('action', ''),
                            'method': attrs.get('method', 'get').lower(),
                            'fields': []}
        elif tag == 'input' and self.current is not None:
            kind = attrs.get('type', 'text').lower()
            name = attrs.get('name')
            if not name or kind in ('file', 'image'):
                return
            if kind in ('checkbox', 'radio'):
                # Het vinkje "ik ga akkoord" is precies waar het hier om draait, dus die gaat aan.
                self.current['fields'].append((name, attrs.get('value', 'on')))
            elif kind in ('password',):
                # Een wachtwoordveld betekent inloggen, geen doorklikken. Merken we later op.
                self.current['fields'].append((name, None))
            else:
                self.current['fields'].append((name, attrs.get('value', '')))
        elif tag == 'select' and self.current is not None:
            self.select = attrs.get('name')
        elif tag == 'option' and self.select:
            self.current['fields'].append((self.select, attrs.get('value', '')))
            self.select = None
        elif tag == 'button' and self.current is not None:
            name = attrs.get('name')
            if name:
                self.current['fields'].append((name, attrs.get('value', '')))

    def handle_endtag(self, tag):
        if tag == 'form' and self.current is not None:
            self.forms.append(self.current)
            self.current = None
        elif tag == 'select':
            self.select = None


class Standstill(urllib.request.HTTPRedirectHandler):
    """Niet meelopen met een omleiding, maar vertellen waar hij heen wees.

    Een portaal antwoordt op de proef met "ga daar maar heen". Lopen we daar meteen achteraan, dan
    weten we niet meer wie ons stuurde en eindigen we soms op een adres dat de proef alleen maar
    troebel maakt. Het adres zelf is hier het antwoord.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener(follow=True):
    jar = http.cookiejar.CookieJar()
    handlers = [urllib.request.HTTPCookieProcessor(jar)]
    if not follow:
        handlers.append(Standstill())
    handler = urllib.request.build_opener(*handlers)
    handler.addheaders = [('User-Agent', AGENT)]
    return handler


def probe(client):
    """Wat staat er voor de deur: internet, een portaal, of niets?

    Geeft (staat, adres) terug, waarbij staat 'online', 'portal' of 'down' is. Bij een portaal is
    het tweede het adres ervan; komen we nergens, dan staat daar waarom - een naam die niet opgelost
    wordt leest anders dan een verbinding die dichtgehouden wordt, en dat scheelt raden.
    """
    problems = []
    for url, code, needle in PROBES:
        try:
            answer = client.open(url, timeout=TIMEOUT)
        except urllib.error.HTTPError as error:
            # Een omleiding of een foutcode: allebei zijn het een portaal. Staat er een adres bij,
            # dan is dat waar we moeten zijn.
            target = error.headers.get('Location') if error.headers else None
            return 'portal', urllib.parse.urljoin(url, target) if target else error.geturl()
        except Exception as error:
            problems.append(urllib.parse.urlparse(url).hostname + ': ' + str(error))
            continue
        body = answer.read(4096).decode('utf-8', 'replace')
        if answer.status == code and (not needle or needle in body) and answer.geturl() == url:
            return 'online', None
        # Antwoord is anders dan afgesproken, of we zijn ergens anders uitgekomen: er zit iets
        # tussen, en waar dat woont staat in het adres waar we belandden.
        return 'portal', answer.geturl()
    return 'down', '; '.join(problems)


def accept(client, url, note):
    """Het formulier op de portaalpagina invullen en versturen."""
    answer = client.open(url, timeout=TIMEOUT)
    page = answer.read(200000).decode('utf-8', 'replace')
    here = answer.geturl()
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LAST_PAGE, 'w', encoding='utf-8') as handle:
        handle.write('<!-- ' + here + ' -->\n' + page)

    parser = Forms()
    parser.feed(page)
    forms = [form for form in parser.forms if form['fields']]
    if not forms:
        note('portaal op ' + here + ' heeft geen formulier; zie ' + LAST_PAGE)
        return False

    form = forms[0]
    if any(value is None for _, value in form['fields']):
        note('portaal op ' + here + ' vraagt om een wachtwoord; dat is geen doorklikken')
        return False

    target = urllib.parse.urljoin(here, form['action'] or here)
    data = urllib.parse.urlencode(form['fields']).encode('ascii')
    note('formulier van ' + here + ' versturen naar ' + target)
    if form['method'] == 'post':
        client.open(urllib.request.Request(target, data=data), timeout=TIMEOUT)
    else:
        client.open(target + ('&' if '?' in target else '?') + data.decode('ascii'), timeout=TIMEOUT)
    return True


def run(verbose=True, tries=1, pause=5):
    lines = []

    def note(text):
        lines.append(text)
        if verbose:
            print(text)

    # De proef loopt niet mee met omleidingen (dan weten we waar het portaal woont); het aanmelden
    # erna wel, want een portaal stuurt je onderweg nog een paar keer door.
    scout = opener(follow=False)
    client = opener()
    # Vlak na het verbinden is er een lease maar nog geen naamserver, en dan lijkt een netwerk dat
    # prima werkt even helemaal dood. Daarom niet één keer kijken maar een paar keer, met een
    # tussenpoos: dat is het verschil tussen "nog even" en "hier komen we niet door".
    for poging in range(1, tries + 1):
        state, url = probe(scout)
        if state != 'down' or poging == tries:
            break
        time.sleep(pause)
    if state == 'online':
        note('internet is er al')
        return 0, lines
    if state == 'down':
        note('geen portaal en geen internet na ' + str(poging) + ' pogingen (' + str(url) + ')')
        return 1, lines

    note('portaal gevonden op ' + str(url))
    # Twee ronden: portalen sturen je vaak eerst naar een tussenpagina en pas daarna naar het
    # formulier dat er echt toe doet.
    for ronde in (1, 2):
        try:
            if not accept(client, url, note):
                return 1, lines
        except Exception as error:
            note('aanmelden mislukte: ' + str(error))
            return 1, lines
        state, url = probe(scout)
        if state == 'online':
            note('binnen, na ronde ' + str(ronde))
            return 0, lines
        if state == 'down':
            note('na het formulier is er niets meer: ' + str(url))
            return 1, lines
        note('nog steeds een portaal, nu op ' + str(url))
    note('het portaal laat ons er niet door; de pagina staat in ' + LAST_PAGE)
    return 1, lines


def log_run():
    """Zoals run(), maar stil en met een regel in het logboek.

    De timer komt elke vijf minuten langs en meestal is er gewoon internet; dat hoeft niet
    driehonderd keer per dag in een logboek. Alleen wat afwijkt wordt opgeschreven.
    """
    code, lines = run(verbose=False, tries=6, pause=5)
    if code == 0 and lines == ['internet is er al']:
        return 0
    stamp = subprocess.run(['date', '+%Y-%m-%d %H:%M:%S'], capture_output=True, text=True,
                           check=False).stdout.strip()
    try:
        with open(LOG, 'a', encoding='utf-8') as handle:
            for line in lines:
                handle.write(stamp + '  ' + line + '\n')
    except OSError:
        pass
    return code


SERVICE = """[Unit]
Description=Achter het captive portal komen
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/awb-captive quiet
"""

TIMER = """[Unit]
Description=Elke vijf minuten kijken of we nog achter het captive portal zitten

[Timer]
OnBootSec=60
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
"""

# NetworkManager roept dit aan zodra er een verbinding bijkomt. Dan is het portaal er meteen, en
# hoeft niemand op de timer te wachten.
DISPATCH = """#!/bin/sh
# Bij een nieuwe verbinding meteen kijken of er een portaal voor de deur staat.
if [ "$2" = "up" ] || [ "$2" = "connectivity-change" ]; then
\tsystemctl start --no-block awb-captive.service
fi
"""


def install():
    here = os.path.abspath(__file__)
    subprocess.run(['install', '-m', '0755', here, '/usr/local/sbin/awb-captive'], check=True)
    with open('/etc/systemd/system/awb-captive.service', 'w', encoding='utf-8') as handle:
        handle.write(SERVICE)
    with open('/etc/systemd/system/awb-captive.timer', 'w', encoding='utf-8') as handle:
        handle.write(TIMER)
    hook = '/etc/NetworkManager/dispatcher.d/90-awb-captive'
    with open(hook, 'w', encoding='utf-8') as handle:
        handle.write(DISPATCH)
    os.chmod(hook, 0o755)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'awb-captive.timer'], check=True)
    print('geïnstalleerd: bij elke nieuwe verbinding en verder elke vijf minuten')
    print('logboek: ' + LOG)


def uninstall():
    subprocess.run(['systemctl', 'disable', '--now', 'awb-captive.timer'], check=False)
    for path in ('/etc/systemd/system/awb-captive.service',
                 '/etc/systemd/system/awb-captive.timer',
                 '/etc/NetworkManager/dispatcher.d/90-awb-captive',
                 '/usr/local/sbin/awb-captive'):
        try:
            os.remove(path)
        except OSError:
            pass
    subprocess.run(['systemctl', 'daemon-reload'], check=False)
    print('eraf gehaald')


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if what == 'run':
        return run(tries=6, pause=5)[0]
    if what == 'quiet':
        return log_run()
    if what == 'status':
        state, url = probe(opener(follow=False))
        print({'online': 'internet is er',
               'portal': 'captive portal: ' + str(url),
               'down': 'geen verbinding'}[state])
        return 0 if state == 'online' else 1
    if what == 'install':
        install()
        return 0
    if what == 'uninstall':
        uninstall()
        return 0
    if what == 'log':
        subprocess.run(['tail', '-n', '40', LOG], check=False)
        return 0
    print(__doc__)
    return 1


if __name__ == '__main__':
    sys.exit(main())
