// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";

// See docs/SECURITY.md "Opt-in network egress" — this file is user-created
// (`claude setup-token`), never written by the extension, and its presence
// is what makes the rate-limit check opt-in rather than automatic.
export const TOKEN_PATH = GLib.build_filenamev([
  GLib.get_user_config_dir(),
  "claudewatch",
  "token",
]);

// Dedicated usage-status endpoint (same one the official Claude Code CLI's
// own usage display reads) — a GET with no model invocation, so it costs no
// API quota, unlike a Messages completion call.
export const RATE_LIMIT_URL = "https://api.anthropic.com/api/oauth/usage";

// The token file holds either a raw bearer token (`claude setup-token`
// output) or `~/.claude/.credentials.json`-format JSON, typically via a
// user-created symlink to that file. The JSON form is what actually works
// for /api/oauth/usage: the endpoint requires the `user:profile` scope,
// which only the interactive-login credential carries — setup-token mints
// `user:inference`-only tokens that the endpoint rejects.
export function resolveToken(text) {
  if (!text.startsWith("{")) return { token: text };
  let credentials;
  try {
    credentials = JSON.parse(text);
  } catch {
    return { error: "Token file is neither a token nor valid JSON" };
  }
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken) {
    return { error: "No claudeAiOauth.accessToken in token file" };
  }
  if (oauth.expiresAt != null && oauth.expiresAt < Date.now()) {
    return { error: "OAuth token expired — run claude to refresh it" };
  }
  return { token: oauth.accessToken };
}

export function formatResetTime(isoString) {
  const reset = GLib.DateTime.new_from_iso8601(isoString, null);
  const hoursUntil =
    reset.difference(GLib.DateTime.new_now_local()) / 3_600_000_000;
  if (hoursUntil < 24) {
    const minutesUntil = Math.max(0, Math.round(hoursUntil * 60));
    return `in ${Math.floor(minutesUntil / 60)}h ${minutesUntil % 60}m`;
  }
  return reset.format("%a %l:%M %p").trim();
}

// /api/oauth/usage's five_hour/seven_day fields: utilization is a 0..1
// fraction, resets_at is an ISO 8601 timestamp. A window is absent if the
// account has no active usage in it yet.
export function formatRateLimitWindow(window, label) {
  if (window?.utilization == null) return `${label}: unavailable`;
  const percent = Math.round(window.utilization * 100);
  const resetText = window.resets_at
    ? ` (resets ${formatResetTime(window.resets_at)})`
    : "";
  return `${label} ${percent}%${resetText}`;
}
