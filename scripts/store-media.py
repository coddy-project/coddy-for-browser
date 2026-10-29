#!/usr/bin/env python3
"""Prepare store images from genuine captures. Requires Python 3 and Pillow."""
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/screenshots"
CHROME = ROOT / "cws/media"
FIREFOX = ROOT / "amo/media"
FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
BOLD = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(path, optimize=True)


def copy(source, destination):
    with Image.open(SOURCE / source) as image:
        assert image.size == (1280, 800), source
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE / source, destination)


def backdrop():
    image = Image.new("RGB", (1280, 800))
    pixels = image.load()
    for y in range(800):
        for x in range(1280):
            glow = max(0, 1 - ((x - 640) / 1000) ** 2 - ((y - 100) / 850) ** 2)
            pixels[x, y] = (round(16 + 16 * glow), round(15 + 8 * glow), round(21 + 30 * glow))
    return image


def approvals():
    image = backdrop()
    draw = ImageDraw.Draw(image)
    draw.text((80, 100), "You approve access", font=ImageFont.truetype(str(BOLD), 46), fill="#f5f3ff")
    draw.text((80, 178), "Before a new website or a chat from another machine", font=ImageFont.truetype(str(FONT), 23), fill="#c4b5d6")
    for x, filename, label in (
        (80, "site-approval-dark-510.png", "Website access"),
        (690, "remote-chat-dark-510.png", "Another Coddy process"),
    ):
        draw.text((x, 270), label, font=ImageFont.truetype(str(BOLD), 21), fill="#ddd6fe")
        with Image.open(SOURCE / filename) as capture:
            assert capture.width == 510
            image.paste(capture.convert("RGB"), (x, 316))
    save(image, CHROME / "03-access-approvals.png")


def android():
    overview = backdrop()
    for x, name in zip((80, 470, 860), ("approval", "chat", "working")):
        source = f"phone-{name}-dark-540.png"
        with Image.open(SOURCE / source) as capture:
            assert capture.size == (540, 1200), source
            overview.paste(capture.convert("RGB").resize((340, 756), Image.Resampling.LANCZOS), (x, 22))
            # AMO accepts up to 2400x1800; preserve the original phone detail.
            save(capture, FIREFOX / f"android-{name}.png")
    save(overview, FIREFOX / "android-overview.png")


if __name__ == "__main__":
    copy("chrome-panel-dark-1280.png", CHROME / "01-side-panel-dark.png")
    copy("working-tab-light-1280.png", CHROME / "02-working-tab.png")
    approvals()
    with Image.open(SOURCE / "settings-dark-1280.png") as capture:
        assert capture.size == (1280, 1080)
        save(capture.crop((0, 0, 1280, 800)), CHROME / "04-connection-settings.png")
    copy("chrome-panel-light-1280.png", CHROME / "05-side-panel-light.png")
    copy("firefox-sidebar-dark-1280.png", FIREFOX / "desktop-sidebar.png")
    android()
    metadata = {
        "chrome": [
            {"file": "cws/media/01-side-panel-dark.png", "source": ["docs/screenshots/chrome-panel-dark-1280.png"], "en": "Ask your own Coddy about the page beside the chat.", "ru": "Спросите своего Coddy о странице рядом с чатом."},
            {"file": "cws/media/02-working-tab.png", "source": ["docs/screenshots/working-tab-light-1280.png"], "en": "The working tab glows and offers a Stop button.", "ru": "Рабочая вкладка подсвечивается и показывает кнопку Stop."},
            {"file": "cws/media/03-access-approvals.png", "source": ["docs/screenshots/site-approval-dark-510.png", "docs/screenshots/remote-chat-dark-510.png"], "kind": "overview of two genuine UI captures, not one browser state", "en": "Approve a new website or a chat from another Coddy process.", "ru": "Разрешите новый сайт или чат другого процесса Coddy."},
            {"file": "cws/media/04-connection-settings.png", "source": ["docs/screenshots/settings-dark-1280.png"], "kind": "top 1280x800 crop", "en": "Connect your own server and manage website access.", "ru": "Подключите свой сервер и настройте доступ к сайтам."},
            {"file": "cws/media/05-side-panel-light.png", "source": ["docs/screenshots/chrome-panel-light-1280.png"], "en": "The same side-panel chat in the light theme.", "ru": "Тот же чат в боковой панели со светлой темой."},
        ],
        "firefox": [
            {"file": "amo/media/desktop-sidebar.png", "source": ["docs/screenshots/firefox-sidebar-dark-1280.png"], "en": "Chat with your Coddy in Firefox's sidebar beside the page.", "ru": "Общайтесь со своим Coddy в сайдбаре Firefox рядом со страницей."},
            {"file": "amo/media/android-chat.png", "source": ["docs/screenshots/phone-chat-dark-540.png"], "en": "Firefox for Android opens the chat in a tab.", "ru": "Firefox для Android открывает чат во вкладке."},
            {"file": "amo/media/android-approval.png", "source": ["docs/screenshots/phone-approval-dark-540.png"], "en": "Approve website access on your phone before Coddy acts.", "ru": "Разрешите доступ к сайту на телефоне, прежде чем Coddy начнёт работу."},
            {"file": "amo/media/android-working.png", "source": ["docs/screenshots/phone-working-dark-540.png"], "en": "The active page is highlighted, with Stop available on Android too.", "ru": "Рабочая страница подсвечивается, кнопка Stop доступна и на Android."},
        ],
        "optional": [{"file": "amo/media/android-overview.png", "kind": "three genuine Android screens arranged without text", "source": [f"docs/screenshots/phone-{name}-dark-540.png" for name in ("approval", "chat", "working")]}],
    }
    out = ROOT / "docs/store-media"
    out.mkdir(parents=True, exist_ok=True)
    (out / "captions.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    for file in sorted([*CHROME.glob("[0-9]*.png"), *FIREFOX.glob("*.png")]):
        with Image.open(file) as image:
            assert image.mode == "RGB", file
            if file.parent == CHROME:
                assert image.size == (1280, 800), file
            print(f"{file.relative_to(ROOT)}: {image.width}x{image.height}, RGB, {file.stat().st_size} bytes")
