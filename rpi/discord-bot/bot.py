#!/usr/bin/env python3
"""A handful of slash commands for the board, so it can be looked after from a phone.

The board hangs in a hangar. When something looks wrong there is nobody with a keyboard, and the
person who notices is usually standing next to it with a phone in their hand. This turns the few
things worth doing from a distance into Discord commands: see how it is doing, look at the screen,
restart the browser, clear its cache, reboot.

It holds no privileges of its own. Everything that changes something is a small script owned by
root, and this bot may run exactly those through sudo and nothing else; see install.sh. So the worst
a stolen token buys is the set of commands below, not a shell on the board.

Who may use it is a list of Discord user ids in the environment. Everyone else gets a refusal, which
is on purpose: rebooting the board is not something the whole club should be able to do by accident.
"""
import asyncio
import os
import subprocess
import discord
from discord import app_commands

TOKEN = os.environ.get("AWB_DISCORD_TOKEN", "")
GUILD_ID = os.environ.get("AWB_DISCORD_GUILD", "")
ALLOWED = {int(x) for x in os.environ.get("AWB_DISCORD_USERS", "").replace(",", " ").split() if x.strip().isdigit()}
BOARD = os.environ.get("AWB_BOARD_NAME", "het bord")


def run(*args: str, timeout: int = 60) -> str:
    """One of the permitted scripts. Never a shell, and never anything built from user input."""
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return (out.stdout or out.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return "duurde te lang"
    except OSError as error:
        return f"lukte niet: {error}"


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
        result = run("sudo", "-n", "/usr/local/sbin/awb-cache-clear", timeout=90)
        note = ("Cache leeg en browser herstart. Een wijziging die je net hebt geplaatst is nu "
                "zeker zichtbaar; zonder dit serveert Chromium soms nog het oude bestand.")
    else:
        result = run("sudo", "-n", "/usr/local/sbin/awb-kiosk-restart", timeout=60)
        note = "Browser herstart. Een paar tellen zwart, dan staat het bord er weer."
    await interaction.followup.send(f"{note}\n```\n{result[:1500]}\n```")


@bot.tree.command(name="weer", description="Wat het station nu meet")
async def weer(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    await interaction.followup.send("```\n" + run("sudo", "-n", "/usr/local/sbin/awb-weer", timeout=45)[:1900] + "\n```")


@bot.tree.command(name="jumprun", description="Welke jumpruns staan er vandaag op het bord?")
async def jumprun(interaction: discord.Interaction) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    await interaction.response.defer(thinking=True)
    await interaction.followup.send("```\n" + run("sudo", "-n", "/usr/local/sbin/awb-jumprun", timeout=60)[:1900] + "\n```")


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
    result = run("sudo", "-n", "/usr/local/sbin/awb-update", timeout=240)
    await interaction.followup.send(
        "Bijgewerkt en opnieuw gestart. De instellingen en de inloggegevens van dit bord blijven staan.\n"
        "```\n" + result[:1700] + "\n```"
    )


@bot.tree.command(name="summertime", description="Laat het bord even een perfecte springdag zien")
@app_commands.describe(minuten="hoe lang, standaard vijf; 0 stopt hem meteen")
async def summertime(interaction: discord.Interaction, minuten: int = 5) -> None:
    if not allowed(interaction):
        return await deny(interaction)
    minuten = max(0, min(30, minuten))
    await interaction.response.defer(thinking=True)
    result = run("sudo", "-n", "/usr/local/sbin/awb-summertime", str(minuten * 60), timeout=30)
    if minuten == 0:
        return await interaction.followup.send("Demo gestopt.\n```\n" + result[:800] + "\n```")
    await interaction.followup.send(
        f"Onbewolkt, 26 graden, 4 knopen en een palmeiland op de kaart. {minuten} minuten lang.\n"
        "Er staat een balk boven het scherm dat het niet echt is: dat bord hangt op een plek waar "
        "mensen beslissen of ze springen, en verzonnen weer mag daar nooit voor echt doorgaan.\n"
        "```\n" + result[:800] + "\n```"
    )


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
