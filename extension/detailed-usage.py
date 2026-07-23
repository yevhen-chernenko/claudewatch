#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Launched by ClaudeWatch's "Show usage" menu item (lib/indicator.ts) — the
# extension's only usage source; this script owns the opt-in token
# resolution, request, and formatting on its own. Stdlib only, no pip
# dependencies.

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOKEN_PATH = (
    Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    / "claudewatch"
    / "token"
)
RATE_LIMIT_URL = "https://api.anthropic.com/api/oauth/usage"
REFRESH_SECONDS = 60 * 2  # auto-refresh cadence; change this to adjust it
BAR_WIDTH = 30
LABEL_WIDTH = 13

COLOR_BANNER = "#7dd3fc"
COLOR_FIVE_HOUR = "#f0883e"
COLOR_SEVEN_DAY = "#4ade80"
COLOR_REFRESH = "#7dd3fc"
COLOR_LABEL = "#9aa4b2"
COLOR_MUTED = "#6b7280"

ALT_SCREEN_ENTER = "\x1b[?1049h"
ALT_SCREEN_EXIT = "\x1b[?1049l"
HIDE_CURSOR = "\x1b[?25l"
SHOW_CURSOR = "\x1b[?25h"

WINDOW_TITLE = "ClaudeWatch"
SET_TITLE = f"\x1b]0;{WINDOW_TITLE}\x07"

LOGO_PATH = Path(__file__).resolve().parent / "ascii.txt"


def _load_logo():
    try:
        return LOGO_PATH.read_text().splitlines()
    except OSError:
        return ["ClaudeWatch"]


LOGO_LINES = _load_logo()


def resolve_token(text):
    if not text.startswith("{"):
        return text, None
    try:
        credentials = json.loads(text)
    except ValueError:
        return None, "Token file is neither a token nor valid JSON"
    oauth = credentials.get("claudeAiOauth") or {}
    access_token = oauth.get("accessToken")
    if not access_token:
        return None, "No claudeAiOauth.accessToken in token file"
    expires_at = oauth.get("expiresAt")
    if expires_at is not None and expires_at < time.time() * 1000:
        return None, "OAuth token expired — run claude to refresh it"
    return access_token, None


def read_token():
    try:
        text = TOKEN_PATH.read_text().strip()
    except OSError:
        return None, f"No token file at {TOKEN_PATH}"
    if not text:
        return None, "Token file is empty"
    return resolve_token(text)


def fetch_usage(token):
    request = urllib.request.Request(
        RATE_LIMIT_URL,
        headers={
            "authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode()), None
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode()).get("error", {}).get("message")
        except ValueError:
            detail = None
        return None, detail or f"HTTP {error.code}"
    except urllib.error.URLError as error:
        return None, str(error.reason)


def format_reset(iso_string):
    try:
        reset = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
    except ValueError:
        return "unknown"
    now = datetime.now(timezone.utc)
    hours_until = (reset - now).total_seconds() / 3600
    absolute = reset.astimezone().strftime("%a %-I:%M %p")
    if hours_until < 24:
        minutes_until = max(0, round(hours_until * 60))
        relative = f"in {minutes_until // 60}h {minutes_until % 60}m"
    else:
        relative = f"in {round(hours_until / 24)}d"
    return f"{relative} ({absolute})"


def window_status(window):
    if not window or window.get("utilization") is None:
        return None, "unavailable"
    percent = round(window["utilization"])
    resets_at = window.get("resets_at")
    detail = f"resets {format_reset(resets_at)}" if resets_at else ""
    return percent, detail


def fg(hex_color, text, bold=False):
    r, g, b = int(hex_color[1:3], 16), int(hex_color[3:5], 16), int(hex_color[5:7], 16)
    style = "1;" if bold else ""
    return f"\x1b[{style}38;2;{r};{g};{b}m{text}\x1b[0m"


def bar(percent, color):
    percent = max(0, min(100, percent))
    filled = round(BAR_WIDTH * percent / 100)
    body = "█" * filled + "░" * (BAR_WIDTH - filled)
    return fg(color, body)


def render_row(label, fill_percent, value_text, color, detail="", label_color=COLOR_LABEL):
    label_part = fg(label_color, label.ljust(LABEL_WIDTH))
    bar_part = bar(fill_percent, color)
    value_part = fg(color, value_text.rjust(5), bold=True)
    detail_part = f" {detail}" if detail else ""
    return f"{label_part} {bar_part} {value_part}{detail_part}"


PADDING_TOP = 1
PADDING_LEFT = 2
MARGIN = " " * PADDING_LEFT


def out(text=""):
    print(f"{MARGIN}{text}" if text else "")


SEPARATOR_WIDTH = LABEL_WIDTH + 1 + BAR_WIDTH


def separator():
    pattern = "".join("#" if i % 2 == 0 else ":" for i in range(SEPARATOR_WIDTH))
    out(fg(COLOR_BANNER, pattern))


def render(data, error, remaining):
    print("\x1b[2J\x1b[H", end="")
    for _ in range(PADDING_TOP):
        print()

    for line in LOGO_LINES:
        out(fg(COLOR_BANNER, line))
    out()

    five_hour = data.get("five_hour") if data else None
    percent, detail = window_status(five_hour)
    if percent is None:
        out(f"{fg(COLOR_LABEL, '5h window'.ljust(LABEL_WIDTH))} {detail}")
    else:
        out(render_row("5h window", percent, f"{percent}%", COLOR_FIVE_HOUR, detail))
    separator()

    seven_day = data.get("seven_day") if data else None
    percent, detail = window_status(seven_day)
    if percent is None:
        out(f"{fg(COLOR_LABEL, '7d window'.ljust(LABEL_WIDTH))} {detail}")
    else:
        out(render_row("7d window", percent, f"{percent}%", COLOR_SEVEN_DAY, detail))
    separator()

    elapsed = REFRESH_SECONDS - remaining
    refresh_percent = 100 * elapsed / REFRESH_SECONDS
    out(
        render_row(
            "next refresh",
            refresh_percent,
            f"{remaining}s",
            COLOR_REFRESH,
            label_color=COLOR_MUTED,
        )
    )

    if error:
        out()
        out(error)
        out("Usage will be attempted to refresh on the next tick.")


def main():
    data = None
    sys.stdout.write(SET_TITLE + ALT_SCREEN_ENTER + HIDE_CURSOR)
    sys.stdout.flush()
    try:
        while True:
            token, error = read_token()
            if not error:
                fetched, error = fetch_usage(token)
                if fetched is not None:
                    data = fetched
            for remaining in range(REFRESH_SECONDS, 0, -1):
                render(data, error, remaining)
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(SHOW_CURSOR + ALT_SCREEN_EXIT)
        sys.stdout.flush()
    print("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
