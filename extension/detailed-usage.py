#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Launched by ClaudeWatch's "Detailed usage" menu item (lib/indicator.ts).
# Same opt-in token file and endpoint as the popup menu's "Show usage" row
# (lib/rateLimit.ts) — this is a fuller, terminal-based view of that same
# check, not a separate one. Stdlib only, no pip dependencies.

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
REFRESH_SECONDS = 60  # auto-refresh cadence; change this to adjust it
BAR_WIDTH = 30


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


def format_window(window, label):
    if not window or window.get("utilization") is None:
        return f"{label}: unavailable"
    percent = round(window["utilization"])
    resets_at = window.get("resets_at")
    reset_text = f", resets {format_reset(resets_at)}" if resets_at else ""
    return f"{label}: {percent}% used{reset_text}"


def render(data, error, remaining):
    print("\x1b[2J\x1b[H", end="")
    print("Claude usage — detailed view (Ctrl-C to stop)")
    print(f"Checked {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    if data:
        print(format_window(data.get("five_hour"), "5h window"))
        print(format_window(data.get("seven_day"), "7d window"))
    else:
        print("No usage data yet.")
    print()
    elapsed = REFRESH_SECONDS - remaining
    filled = int(BAR_WIDTH * elapsed / REFRESH_SECONDS)
    bar = "#" * filled + "-" * (BAR_WIDTH - filled)
    print(f"[{bar}] next refresh in {remaining}s")
    if error:
        print(f"\n{error}")
        print("Usage will be attempted to refresh on the next tick.")


def main():
    data = None
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
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
