#!/usr/bin/env python3
"""A handful of slash commands for the board, so it can be looked after from a phone.

The board hangs in a hangar. When something looks wrong there is nobody with a keyboard, and the
person who notices is usually standing next to it with a phone in their hand. This turns the few
things worth doing from a distance into Discord commands: see how it is doing, look at the screen,
restart the browser, clear its cache, take the jumprun off the board for a while, reboot.

It holds no privileges of its own. Everything that changes something is a small script owned by
root, and this bot may run exactly those through sudo and nothing else; see install.sh. So the worst
a stolen token buys is the set of commands below, not a shell on the board.

Who may use it is a list of Discord user ids in the environment. Everyone else gets a refusal, which
is on purpose: rebooting the board is not something the whole club should be able to do by accident.
"""
import asyncio
import os
import re
import subprocess
import discord
from discord import app_commands

TOKEN = os.environ.get("AWB_DISCORD_TOKEN", "")
GUILD_ID = os.environ.get("AWB_DISCORD_GUILD", "")
ALLOWED = {int(x) for x in os.environ.get("AWB_DISCORD_USERS", "").replace(",", " ").split() if x.strip().isdigit()}
BOARD = os.environ.get("AWB_BOARD_NAME", "het bord")


def run(*args: str, timeout: int = 60) -> str:
    """One of the permitted scripts. Never a shell, and never anything built from user input."""
    return outcome(*args, timeout=timeout)[1]


def outcome(*args: str, timeout: int = 60) -> tuple[bool, str]:
    """The same, but saying whether it worked.

    A command that fails - a sudo rule that is missing, a script that is not there - still prints
    something, and a message that reports success anyway is worse than no message at all: you walk
    away believing the board has changed. So whoever changes something asks for this instead.
    """
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return out.returncode == 0, (out.stdout or out.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return False, "duurde te lang"
    except OSError as error:
        return False, f"lukte niet: {error}"


async def report(interaction: discord.Interaction, ok: bool, result: str, note: str, limit: int = 1500) -> None:
    """Melden wat er gebeurd is - en niet iets anders als het niet gebeurd is."""
    kop = note if ok else "Er is niets veranderd; het bord staat nog zoals het stond."
    await interaction.followup.send(f"{kop}\n```\n{result[:limit]}\n```")


class Bot(discord.Client):
    def __init__(self) -> None:
        super().__init__(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self) -> None:
        # A guild gets its commands straight away; without one they are global and Discord takes up
        # to an hour to hand them out, which looks exactly like a bot that does not work.
        #
        # Registering them in a guild needs the applications.commands scope there. Invite the bot
        # with only the bot scope and this fails with "Missing Access" - which used to take the
        # whole service down in a restart loop over something a re-invite fixes. Now it says so and
        # falls back to global commands, so the bot is at least running while you sort that out.
        if GUILD_ID.isdigit():
            guild = discord.Object(id=int(GUILD_ID))
            self.tree.copy_global_to(guild=guild)
            try:
                await self.tree.sync(guild=guild)
                # En de algemene versies weghalen. Die kunnen van een eerdere ronde zijn, toen dit
                # nog niet mocht; blijven ze staan, dan ziet iedereen elk commando dubbel in de
                # lijst en is niet te zien welke van de twee je kiest.
                self.tree.clear_commands(guild=None)
                await self.tree.sync()
                return
            except discord.Forbidden:
                print(
                    f"Geen recht om commando's in server {GUILD_ID} te zetten. Nodig de bot opnieuw "
                    "uit met applications.commands erbij; ik val nu terug op algemene commando's, "
                    "die tot een uur kunnen duren voordat Discord ze uitdeelt.",
                    flush=True,
                )
        await self.tree.sync()


bot = Bot()


def allowed(interaction: discord.Interaction) -> bool:
    return not ALLOWED or interaction.user.id in ALLOWED


async def deny(interaction: discord.Interaction) -> None:
    await interaction.response.send_message(
        f"Dat mag jij niet. Je Discord-id is `{interaction.user.id}`; die moet in de instelling staan.",
        ephemeral=True,
    )


@bot.tree.command(name="status", description="Hoe staat het bord ervoor?")
async def status(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    await interaction.followup.send("```\n" + run("sudo", "-n", "/usr/local/sbin/awb-status")[:1900] + "\n```")


@bot.tree.command(name="scherm", description="Laat zien wat er nu op het scherm staat")
async def scherm(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    path = run("sudo", "-n", "/usr/local/sbin/awb-screenshot", timeout=90)
    if not path.startswith("/") or not os.path.exists(path):
        return await interaction.followup.send(f"Geen afdruk gelukt: {path}")
    await interaction.followup.send(file=discord.File(path, filename="bord.png"))


@bot.tree.command(name="kiosk", description="De browser op het bord")
@app_commands.describe(wat="herstarten, of eerst de cache leegmaken")
@app_commands.choices(wat=[
    app_commands.Choice(name="herstart", value="herstart"),
    app_commands.Choice(name="cache leegmaken en herstarten", value="cache"),
])
async def kiosk(interaction: discord.Interaction, wat: app_commands.Choice[str]) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    if wat.value == "cache":
        ok, result = outcome("sudo", "-n", "/usr/local/sbin/awb-cache-clear", timeout=90)
        note = ("Cache leeg en browser herstart. Een wijziging die je net hebt geplaatst is nu "
                "zeker zichtbaar; zonder dit serveert Chromium soms nog het oude bestand.")
    else:
        ok, result = outcome("sudo", "-n", "/usr/local/sbin/awb-kiosk-restart", timeout=60)
        note = "Browser herstart. Een paar tellen zwart, dan staat het bord er weer."
    await report(interaction, ok, result, note)


@bot.tree.command(name="weer", description="Wat het station nu meet")
async def weer(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    await interaction.followup.send("```\n" + run("sudo", "-n", "/usr/local/sbin/awb-weer", timeout=45)[:1900] + "\n```")


@bot.tree.command(name="jumprun", description="Welke jumpruns staan er vandaag op het bord?")
@app_commands.describe(wat="laten zien wat er staat, of ze tijdelijk van het bord halen")
@app_commands.choices(wat=[
    app_commands.Choice(name="wat staat er", value="toon"),
    app_commands.Choice(name="tijdelijk van het bord halen", value="verberg"),
    app_commands.Choice(name="weer op het bord zetten", value="terug"),
])
async def jumprun(interaction: discord.Interaction, wat: app_commands.Choice[str] | None = None) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    keuze = wat.value if wat else "toon"
    if keuze in ("verberg", "terug"):
        # Niets wordt gewist: het plan blijft bij jumprun.nl staan, het bord laat het alleen even weg.
        ok, result = outcome("sudo", "-n", "/usr/local/sbin/awb-jumprun-tonen",
                             "verberg" if keuze == "verberg" else "toon", timeout=30)
        note = ("Van het bord af. Bij jumprun.nl staat hij er gewoon nog; met \u201cweer op het bord "
                "zetten\u201d komt hij binnen een minuut terug."
                if keuze == "verberg" else
                "Weer op het bord. Binnen een minuut staat hij er.")
        return await report(interaction, ok, result, note)
    staat = run("sudo", "-n", "/usr/local/sbin/awb-jumprun-tonen", "status", timeout=30).strip()
    kop = f"(op dit moment {staat} op het bord)\n" if staat.startswith("verborgen") else ""
    await interaction.followup.send(kop + "```\n" + run("sudo", "-n", "/usr/local/sbin/awb-jumprun", timeout=60)[:1800] + "\n```")


# ----------------------------------------------------------------- een jumprun opbouwen

DROPZONES = (("Hoogeveen", "hoogeveen"), ("Echten", "echten"))
# De hoogtes die als suggestie in het lijstje komen. Je bent er niet aan gebonden: het veld neemt
# elk getal aan, want welke hoogte er gesprongen wordt hangt van de dag af - het wolkendek, de
# klant, het vliegtuig. De eerste is de gewone hoge run en staat bovenaan.
EXIT_ALTS = ((12000, "hoge run"), (10000, ""), (9000, ""), (5000, "lage run"), (4000, ""), (3000, ""))
EXIT_MIN, EXIT_MAX = 1000, 20000
OFFSET_NM = [round(0.1 * i, 1) for i in range(0, 16)]          # 0,0 tot 1,5 NM
GREEN_NM = [round(0.1 * i, 1) for i in range(-8, 16)]          # −0,8 tot +1,5 NM
COMPASS = (("noord", "N"), ("oost", "O"), ("zuid", "Z"), ("west", "W"))
TRACK_SPREAD = range(-40, 50, 10)                              # koersen rond het advies, in stappen van tien


def nl(value: float) -> str:
    """Een getal zoals het hier uitgesproken wordt: 0,6 en niet 0.6."""
    return f"{value:.1f}".replace(".", ",")


class JumprunView(discord.ui.View):
    """Een jumprun uit lijstjes opbouwen, met het advies van jumprun.nl er al in.

    Het advies staat er meteen, dus wie het daarmee eens is drukt alleen op publiceren. Wie iets
    anders wil kiest het uit een lijst; er valt niets te typen, dus er valt ook niets te vertypen.
    Elke keuze laat het opnieuw uitrekenen: wat je niet zelf zet blijft het beste dat erbij past.
    """

    def __init__(self, user_id: int, station: str, exit_alt: int) -> None:
        super().__init__(timeout=600)
        self.user_id = user_id
        self.station = station
        self.exit_alt = exit_alt
        self.track: int | None = None      # graden magnetisch
        self.offset: float | None = None
        self.direction: str | None = None
        self.green: float | None = None
        self.text = "even rekenen..."
        self.advised_track: int | None = None

    # -- de som --------------------------------------------------------
    def command(self, post: bool = False) -> list[str]:
        args = ["sudo", "-n", "/usr/local/sbin/awb-jumprun-zetten", self.station, "--exit", str(self.exit_alt)]
        if self.track is not None:
            args += ["--koers", str(self.track)]
        if self.offset is not None:
            args += ["--offset", str(self.offset), "--richting", self.direction or "N"]
        if self.green is not None:
            args += ["--groen", str(self.green)]
        return args + (["--post"] if post else [])

    async def recompute(self) -> bool:
        ok, text = await asyncio.to_thread(outcome, *self.command(), timeout=90)
        self.text = text
        if ok and self.advised_track is None:
            # de koers uit het advies, om de lijst met koersen omheen te leggen
            match = re.search(r"koers (\d{3})°", text)
            if match:
                self.advised_track = int(match.group(1))
                self.build()
        return ok

    def message(self) -> str:
        eigen = [w for w, v in (("koers", self.track), ("offset", self.offset), ("groen licht", self.green)) if v is not None]
        staart = ("\nAlles volgt het advies." if not eigen else
                  "\nZelf gezet: " + ", ".join(eigen) + ". De rest is daar omheen gerekend.")
        return f"```\n{self.text[:1500]}\n```{staart}"

    # -- de knoppen en lijstjes ----------------------------------------
    def build(self) -> None:
        self.clear_items()
        base = self.advised_track if self.advised_track is not None else 0
        tracks = [(base + step) % 360 for step in TRACK_SPREAD]
        self.add_item(Choose(self, "track", "koers (magnetisch)",
                             [(f"{t:03d}°" + (" · advies" if t == base else ""), str(t)) for t in tracks]))
        self.add_item(Choose(self, "offset", "offset in NM",
                             [(f"{nl(v)} NM" if v else "geen offset", str(v)) for v in OFFSET_NM]))
        self.add_item(Choose(self, "direction", "kant van de bak",
                             [(naam, kort) for naam, kort in COMPASS]))
        self.add_item(Choose(self, "green", "groen licht in NM",
                             [(("+" if v >= 0 else "\u2212") + nl(abs(v)) + " NM", str(v)) for v in GREEN_NM]))
        self.add_item(Publish(self))
        self.add_item(Reset(self))

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.user_id:
            await interaction.response.send_message("Dit lijstje is van iemand anders.", ephemeral=True)
            return False
        return allowed(interaction)


class Choose(discord.ui.Select):
    def __init__(self, view: JumprunView, field: str, label: str, options: list[tuple[str, str]]) -> None:
        super().__init__(placeholder=label, min_values=1, max_values=1,
                         options=[discord.SelectOption(label=naam, value=waarde) for naam, waarde in options[:25]])
        self.jumprun = view
        self.field = field

    async def callback(self, interaction: discord.Interaction) -> None:
        waarde = self.values[0]
        if self.field == "track":
            self.jumprun.track = int(waarde)
        elif self.field == "offset":
            self.jumprun.offset = float(waarde)
            if self.jumprun.direction is None:
                self.jumprun.direction = "N"
        elif self.field == "direction":
            self.jumprun.direction = waarde
            if self.jumprun.offset is None:
                self.jumprun.offset = 0.0
        else:
            self.jumprun.green = float(waarde)
        await interaction.response.defer()
        await self.jumprun.recompute()
        await interaction.edit_original_response(content=self.jumprun.message(), view=self.jumprun)


class Reset(discord.ui.Button):
    def __init__(self, view: JumprunView) -> None:
        super().__init__(label="terug naar het advies", style=discord.ButtonStyle.secondary, row=4)
        self.jumprun = view

    async def callback(self, interaction: discord.Interaction) -> None:
        self.jumprun.track = self.jumprun.offset = self.jumprun.direction = self.jumprun.green = None
        await interaction.response.defer()
        await self.jumprun.recompute()
        await interaction.edit_original_response(content=self.jumprun.message(), view=self.jumprun)


class Publish(discord.ui.Button):
    def __init__(self, view: JumprunView) -> None:
        super().__init__(label="op het bord zetten", style=discord.ButtonStyle.primary, row=4)
        self.jumprun = view

    async def callback(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        ok, text = await asyncio.to_thread(outcome, *self.jumprun.command(post=True), timeout=120)
        # Per exithoogte één run: deze vervangt alleen wat er voor dezelfde hoogte stond, de andere
        # run van deze dropzone blijft staan.
        kop = (f"Op het bord gezet. Wat er voor {self.jumprun.exit_alt:,} ft stond is vervangen; een "
               "run op een andere hoogte blijft staan.".replace(",", ".")
               if ok else "Niet gelukt; er staat nog wat er stond.")
        self.jumprun.clear_items()
        await interaction.edit_original_response(content=f"{kop}\n```\n{text[:1500]}\n```", view=self.jumprun)
        self.jumprun.stop()


def exit_label(ft: int, wat: str) -> str:
    """12000 wordt "12.000 ft (hoge run)"; zonder omschrijving alleen het getal."""
    getal = f"{ft:,}".replace(",", ".") + " ft"
    return f"{getal} ({wat})" if wat else getal


async def exit_suggesties(interaction: discord.Interaction, wat: str) -> list[app_commands.Choice[int]]:
    """Meedenken terwijl je typt, zonder je vast te zetten.

    Typ je niets, dan staan de gebruikelijke hoogtes er; typ je een getal, dan is dat de eerste
    keuze - ook als het niet in het lijstje staat. Discord laat namelijk alleen kiezen uit wat de
    bot aanbiedt, dus zonder die eerste regel zou "13000" niet in te vullen zijn.
    """
    cijfers = "".join(teken for teken in wat if teken.isdigit())
    suggesties: list[app_commands.Choice[int]] = []
    if cijfers:
        eigen = int(cijfers)
        if EXIT_MIN <= eigen <= EXIT_MAX:
            suggesties.append(app_commands.Choice(name=exit_label(eigen, ""), value=eigen))
    for ft, omschrijving in EXIT_ALTS:
        if len(suggesties) >= 25:
            break
        if cijfers and not str(ft).startswith(cijfers):
            continue
        if any(keuze.value == ft for keuze in suggesties):
            continue
        suggesties.append(app_commands.Choice(name=exit_label(ft, omschrijving), value=ft))
    return suggesties


@bot.tree.command(name="jumprun-zetten", description="Een jumprun uitrekenen en op het bord zetten")
@app_commands.describe(dropzone="welk veld", hoogte="exithoogte in voet; kies er een of typ je eigen getal")
@app_commands.choices(
    dropzone=[app_commands.Choice(name=naam, value=id_) for naam, id_ in DROPZONES],
)
@app_commands.autocomplete(hoogte=exit_suggesties)
async def jumprun_zetten(interaction: discord.Interaction, dropzone: app_commands.Choice[str],
                         hoogte: int) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    if not EXIT_MIN <= hoogte <= EXIT_MAX:
        return await interaction.response.send_message(
            f"Een exithoogte tussen {EXIT_MIN:,} en {EXIT_MAX:,} ft graag.".replace(",", "."),
            ephemeral=True)
    await interaction.response.defer(thinking=True, ephemeral=True)
    view = JumprunView(interaction.user.id, dropzone.value, hoogte)
    view.build()
    await view.recompute()
    await interaction.followup.send(view.message(), view=view, ephemeral=True)


@bot.tree.command(name="log", description="De laatste foutmeldingen")
async def log(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    await interaction.followup.send("```\n" + run("sudo", "-n", "/usr/local/sbin/awb-log", timeout=45)[:1900] + "\n```")


@bot.tree.command(name="update", description="Haal de nieuwste versie op en zet hem live")
async def update(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    ok, result = outcome("sudo", "-n", "/usr/local/sbin/awb-update", timeout=240)
    await report(interaction, ok, result,
                 "Bijgewerkt en opnieuw gestart. De instellingen en de inloggegevens van dit bord "
                 "blijven staan.", limit=1700)


@bot.tree.command(name="summertime", description="Laat het bord even een perfecte springdag zien")
@app_commands.describe(minuten="hoe lang, standaard vijf; 0 stopt hem meteen")
async def summertime(interaction: discord.Interaction, minuten: int = 5) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    minuten = max(0, min(30, minuten))
    await interaction.response.defer(thinking=True)
    ok, result = outcome("sudo", "-n", "/usr/local/sbin/awb-summertime", str(minuten * 60), timeout=30)
    if minuten == 0:
        return await report(interaction, ok, result, "Demo gestopt.", limit=800)
    await report(interaction, ok, result,
                 f"Onbewolkt, 26 graden, 4 knopen en een palmeiland op de kaart. {minuten} minuten "
                 "lang. Met /normaal staat het echte weer er meteen weer.", limit=800)


@bot.tree.command(name="vooruitzicht", description="Het weer van morgen op de plek van het bulletin")
async def vooruitzicht(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    ok, result = outcome("sudo", "-n", "/usr/local/sbin/awb-vooruitzicht", timeout=30)
    await report(interaction, ok, result,
                 "De wind van morgen op 10, 12, 14 en 16 uur, met de bewolking erboven en het "
                 "verloop van de dag ernaast. Blijft staan tot /normaal.", limit=800)


@bot.tree.command(name="demo", description="Zet een half minuutje een vast tafereel op het bord")
@app_commands.describe(wat="welk tafereel", seconden="hoe lang, standaard dertig")
@app_commands.choices(wat=[
    app_commands.Choice(name="harde grondwind (24 kt, stoten 31)", value="grondwind"),
    app_commands.Choice(name="harde wind onderin (34 kt op 3.000 ft)", value="wind-laag"),
    app_commands.Choice(name="harde wind bovenin (52 kt op 12.000 ft)", value="wind-hoog"),
    app_commands.Choice(name="de windgrens in de tabel (geen kaart)", value="windgrens"),
    app_commands.Choice(name="stoten in de grondwind (12 kt G24)", value="stoten"),
    app_commands.Choice(name="handschoenen (0 °C op 6.000 ft)", value="handschoenen"),
    app_commands.Choice(name="drie wolkenlagen", value="wolkenlagen"),
    app_commands.Choice(name="een gesloten wolkendek (8/8 op 1.200 ft)", value="dek"),
    app_commands.Choice(name="onweer in het bulletin", value="onweer"),
    app_commands.Choice(name="het model wijkt af van het KNMI-bulletin", value="hoogtewinden"),
    app_commands.Choice(name="een jumprun op de kaart", value="jumprun"),
    app_commands.Choice(name="een hoge en een lage jumprun", value="jumprun-hoog-laag"),
    app_commands.Choice(name="stoppen", value="stop"),
])
async def demo(interaction: discord.Interaction, wat: app_commands.Choice[str], seconden: int = 30) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    seconden = max(5, min(300, seconden))
    await interaction.response.defer(thinking=True)
    if wat.value == "stop":
        ok, result = outcome("sudo", "-n", "/usr/local/sbin/awb-demo", "stop", timeout=30)
        return await report(interaction, ok, result, "Demo gestopt.", limit=800)
    ok, result = outcome("sudo", "-n", "/usr/local/sbin/awb-demo", wat.value, str(seconden), timeout=30)
    await report(interaction, ok, result,
                 f"{wat.name} — {seconden} seconden, dan is het bord weer zichzelf. Er staat DEMO "
                 "in de bovenbalk zolang het loopt.", limit=800)


@bot.tree.command(name="normaal", description="Alles eraf: terug naar het gewone bord")
async def normaal(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    """Alles wat tijdelijk op het bord kan staan gaat eraf. Elk stuk apart, zodat een mislukking bij
    het ene de andere niet tegenhoudt - en zodat je in het antwoord ziet wélk stuk niet meewerkte."""
    stukken = (
        ("mooiweerstand", ("/usr/local/sbin/awb-summertime", "0")),
        ("demo", ("/usr/local/sbin/awb-demo", "stop")),
        ("vooruitzicht", ("/usr/local/sbin/awb-vooruitzicht", "stop")),
    )
    klachten = []
    for naam, opdracht in stukken:
        ok, result = outcome("sudo", "-n", *opdracht, timeout=30)
        if not ok:
            klachten.append(f"{naam}: {result.strip().splitlines()[-1] if result.strip() else 'mislukt'}")
    if klachten:
        return await report(interaction, False, "\n".join(klachten), "", limit=800)
    await report(interaction, True, "", "Terug naar het gewone bord. Dat is binnen een paar tellen te zien.", limit=600)


@bot.tree.command(name="pi", description="De Raspberry Pi zelf")
@app_commands.describe(wat="herstarten")
@app_commands.choices(wat=[app_commands.Choice(name="herstart", value="herstart")])
async def pi(interaction: discord.Interaction, wat: app_commands.Choice[str]) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.send_message(
        f"{BOARD} gaat opnieuw op. Dat duurt ongeveer een minuut; daarna komt het bord vanzelf terug."
    )
    await asyncio.sleep(1)
    run("sudo", "-n", "/usr/local/sbin/awb-reboot", timeout=20)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("Geen AWB_DISCORD_TOKEN; zie /etc/awb-discord.env")
    bot.run(TOKEN, log_handler=None)
