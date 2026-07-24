#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Launched by ClaudeWatch's "Show usage" menu item (lib/indicator.ts) — the
# extension's only usage source; this script owns the opt-in token
# resolution, request, and formatting on its own. Stdlib only, no pip
# dependencies.

import json
import os
import subprocess
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
EXPIRED_ERROR = "OAuth token expired — run claude to refresh it"
REFRESH_FAILED_ERROR = (
    "OAuth token still expired after an automatic refresh attempt — "
    "run claude to sign in again"
)
CREDENTIAL_REFRESH_TIMEOUT = 15
BAR_WIDTH = 30
LABEL_WIDTH = 13

COLOR_BANNER = "#7dd3fc"
COLOR_FIVE_HOUR = "#f0883e"
COLOR_SEVEN_DAY = "#4ade80"
COLOR_OPUS = "#c084fc"
COLOR_SONNET = "#60a5fa"
COLOR_EXTRA = "#facc15"
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
        return None, EXPIRED_ERROR
    return access_token, None


def read_token():
    try:
        text = TOKEN_PATH.read_text().strip()
    except OSError:
        return None, f"No token file at {TOKEN_PATH}"
    if not text:
        return None, "Token file is empty"
    return resolve_token(text)


def attempt_credential_refresh():
    # Reuses Claude Code's own refresh flow instead of reimplementing OAuth here.
    try:
        subprocess.run(
            ["claude", "auth", "status", "--json"],
            capture_output=True,
            timeout=CREDENTIAL_REFRESH_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


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


def render_optional_window_row(label, window, color):
    # Unlike five_hour/seven_day, per-model windows are absent (not an
    # error) when the account has no plan-level split for that model, so
    # the row is skipped entirely rather than shown as "unavailable".
    percent, detail = window_status(window)
    if percent is None:
        return None
    return render_row(label, percent, f"{percent}%", color, detail)


def render_extra_usage_row(extra_usage):
    if not extra_usage or not extra_usage.get("is_enabled"):
        return None
    used = extra_usage.get("used_credits")
    limit = extra_usage.get("monthly_limit")
    detail = f"${used:.2f} / ${limit:.2f}" if used is not None and limit is not None else ""
    percent = extra_usage.get("utilization")
    if percent is None:
        return f"{fg(COLOR_LABEL, 'Extra usage'.ljust(LABEL_WIDTH))} Enabled {detail}".rstrip()
    percent = round(percent)
    return render_row("Extra usage", percent, f"{percent}%", COLOR_EXTRA, detail)


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
    value_part = fg(color, value_text.ljust(5), bold=True)
    detail_part = f" {detail}" if detail else ""
    return f"{label_part} {bar_part} {value_part}{detail_part}"


PADDING_TOP = 1
PADDING_LEFT = 2
MARGIN = " " * PADDING_LEFT

# Erase-to-end-of-line, appended to every row so a shorter line this frame
# still overwrites a longer one from the last frame — without it we'd need a
# full-screen clear every render, which is what caused the visible blink
# (clear -> blank frame -> repaint, once a second, forever).
CLEAR_EOL = "\x1b[K"
# Erase from the cursor to the end of the screen — same idea as CLEAR_EOL but
# for a frame with fewer *rows* than the previous one (e.g. the error block
# disappearing).
CLEAR_TO_END = "\x1b[0J"

_frame = []


def out(text=""):
    line = f"{MARGIN}{text}" if text else ""
    _frame.append(f"{line}{CLEAR_EOL}")


SEPARATOR_WIDTH = LABEL_WIDTH + 1 + BAR_WIDTH


def separator():
    out(fg(COLOR_BANNER, " " * SEPARATOR_WIDTH))


def render(data, error, remaining):
    _frame.clear()
    for _ in range(PADDING_TOP):
        out()

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

    opus_row = render_optional_window_row(
        "7d opus", data.get("seven_day_opus") if data else None, COLOR_OPUS
    )
    if opus_row:
        out(opus_row)
        separator()

    sonnet_row = render_optional_window_row(
        "7d sonnet", data.get("seven_day_sonnet") if data else None, COLOR_SONNET
    )
    if sonnet_row:
        out(sonnet_row)
        separator()

    extra_row = render_extra_usage_row(data.get("extra_usage") if data else None)
    if extra_row:
        out(extra_row)
        separator()

    elapsed = REFRESH_SECONDS - remaining
    refresh_percent = 100 * elapsed / REFRESH_SECONDS
    out(
        render_row(
            "Next refresh",
            refresh_percent,
            f"{remaining}s",
            COLOR_REFRESH,
            label_color=COLOR_LABEL,
        )
    )

    if error:
        out()
        out(error)
        out("Usage will be attempted to refresh on the next tick.")

    # Cursor-home (not a full clear) plus one buffered write: the terminal
    # gets a single atomic frame instead of ~15 separate print() flushes
    # racing a blanked screen, which is what made every refresh visibly
    # blink. CLEAR_TO_END mops up any rows a shorter frame (e.g. the error
    # block disappearing) would otherwise leave stale below the last line.
    sys.stdout.write("\x1b[H" + "\n".join(_frame) + "\n" + CLEAR_TO_END)
    sys.stdout.flush()


def main():
    data = None
    sys.stdout.write(SET_TITLE + ALT_SCREEN_ENTER + HIDE_CURSOR + "\x1b[2J")
    sys.stdout.flush()
    try:
        while True:
            token, error = read_token()
            if error == EXPIRED_ERROR:
                attempt_credential_refresh()
                token, error = read_token()
                if error == EXPIRED_ERROR:
                    error = REFRESH_FAILED_ERROR
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
