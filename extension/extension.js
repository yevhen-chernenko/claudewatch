// SPDX-License-Identifier: GPL-2.0-or-later

import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import Soup from "gi://Soup?version=3.0";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const STATE_PATH = GLib.build_filenamev([
  GLib.get_user_state_dir(),
  "codewatch",
  "state.json",
]);

// See docs/SECURITY.md "Opt-in network egress" — this file is user-created
// (`claude setup-token`), never written by the extension, and its presence
// is what makes the rate-limit check opt-in rather than automatic.
const TOKEN_PATH = GLib.build_filenamev([
  GLib.get_user_config_dir(),
  "codewatch",
  "token",
]);

// Dedicated usage-status endpoint (same one the official Claude Code CLI's
// own usage display reads) — a GET with no model invocation, so it costs no
// API quota, unlike a Messages completion call.
const RATE_LIMIT_URL = "https://api.anthropic.com/api/oauth/usage";

// The panel label's three states: idle ("standby", also where it lands 5s
// after a task finishes), a task in flight ("running", pulsing orange), and
// the 5s green flash right after a task finishes ("complete").
const STANDBY_TEXT = "ClaudeWatch";
const RUNNING_TEXT = "Claude is working…";
const COMPLETE_TEXT = "Task complete!";

const STANDBY_STYLE = "padding: 0 6px;";
const RUNNING_STYLE =
  "padding: 0 6px; background-color: #e67e22; border-radius: 4px;";
const COMPLETE_STYLE =
  "padding: 0 6px; background-color: #2ecc71; border-radius: 4px;";
const COMPLETE_FLASH_MS = 5000;

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

// Transcript JSONL repeats the same message id once per content block
// (text, tool_use, …), each carrying that turn's cumulative usage — dedupe
// by id or totals balloon by however many blocks the turn happened to have.
function summarizeUsage(transcriptText) {
  const seenIds = new Set();
  let input = 0;
  let output = 0;
  let cached = 0;

  for (const line of transcriptText.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const usage = entry.message?.usage;
    const id = entry.message?.id;
    if (!usage || !id || seenIds.has(id)) continue;
    seenIds.add(id);
    input += usage.input_tokens ?? 0;
    output += usage.output_tokens ?? 0;
    cached +=
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
  }

  return `In ${formatTokenCount(input)} · Out ${formatTokenCount(output)} · Cached ${formatTokenCount(cached)}`;
}

function formatResetTime(isoString) {
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
function formatRateLimitWindow(window, label) {
  if (window?.utilization == null) return `${label}: unavailable`;
  const percent = Math.round(window.utilization * 100);
  const resetText = window.resets_at
    ? ` (resets ${formatResetTime(window.resets_at)})`
    : "";
  return `${label} ${percent}%${resetText}`;
}

export default class CodeWatchExtension extends Extension {
  enable() {
    this._state = {};

    this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
    this._label = new St.Label({
      text: STANDBY_TEXT,
      y_align: Clutter.ActorAlign.CENTER,
      style: STANDBY_STYLE,
    });
    this._indicator.add_child(this._label);

    // Fixed width so the menu doesn't reflow as row text changes length
    // (e.g. "Checking…" vs. a long rate-limit error string).
    this._indicator.menu.box.style =
      "width: 300px; min-width: 300px; max-width: 300px;";

    this._openInCodeItem = new PopupMenu.PopupMenuItem("Open in VS Code");
    this._openInCodeItem.setSensitive(false);
    this._openInCodeItem.connect("activate", () => this._openInVsCode());
    this._indicator.menu.addMenuItem(this._openInCodeItem);

    this._indicator.menu.addMenuItem(
      new PopupMenu.PopupSeparatorMenuItem("Claude Usage"),
    );

    this._usageLabelItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this._indicator.menu.addMenuItem(this._usageLabelItem);

    this._httpSession = new Soup.Session();
    this._lastStatus = null;
    this._initialRefreshDone = false;
    this._autoRefreshOnDone = false;
    this._flashTimeoutId = null;
    this._pulseDim = false;
    this._uiState = "standby";

    this._rateLimit5hItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this._rateLimit5hItem.visible = false;
    this._indicator.menu.addMenuItem(this._rateLimit5hItem);

    this._rateLimit7dItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this._rateLimit7dItem.visible = false;
    this._indicator.menu.addMenuItem(this._rateLimit7dItem);

    this._autoRefreshItem = new PopupMenu.PopupSwitchMenuItem(
      "Auto-refresh on task complete",
      false,
    );
    this._autoRefreshItem.connect("toggled", (item, state) => {
      this._autoRefreshOnDone = state;
    });
    this._indicator.menu.addMenuItem(this._autoRefreshItem);

    this._refreshUsageItem = new PopupMenu.PopupMenuItem("Refresh Usage");
    // Default activate() chains to super.activate(), which PopupMenu treats
    // as a close-triggering click; override so clicking never closes the
    // menu. This is a manual override on top of the automatic refreshes
    // below — not the only way either row updates.
    this._refreshUsageItem.activate = () => this._onRefreshUsageClicked();
    this._indicator.menu.addMenuItem(this._refreshUsageItem);

    this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._exitItem = new PopupMenu.PopupMenuItem("Exit");
    this._exitItem.connect("activate", () => this._onExit());
    this._indicator.menu.addMenuItem(this._exitItem);

    this._menuOpenStateId = this._indicator.menu.connect(
      "open-state-changed",
      (menu, open) => {
        if (open) this._refreshUsage();
      },
    );

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    this._stateFile = Gio.File.new_for_path(STATE_PATH);
    this._monitor = this._stateFile.monitor_file(
      Gio.FileMonitorFlags.NONE,
      null,
    );
    this._monitorId = this._monitor.connect("changed", () => this._refresh());

    this._refresh();
  }

  _refresh() {
    this._stateFile.load_contents_async(null, (file, result) => {
      try {
        const [, contents] = file.load_contents_finish(result);
        this._state = JSON.parse(new TextDecoder().decode(contents));
      } catch (e) {
        // No state file yet, or it's mid-write.
        this._state = {};
      }
      this._openInCodeItem?.setSensitive(!!this._state.cwd);
      this._refreshUsage();
      // Edge-triggered on status transitions, not on every file-monitor
      // event while status stays the same. Text and style are both driven
      // from this._uiState (set by the _enter* methods below), not
      // directly from the raw hook status — that's what lets the 5s
      // post-completion timer fall back to "Standby" on its own even
      // though the state file still says status: "done".
      //
      // The very first refresh after enable() is not an edge: state.json
      // can still say status: "done" from before the shell reload, and
      // treating that as a fresh completion would replay the green flash
      // on startup instead of landing on standby (or, for a leftover
      // "running" status, on the pulsing running state with no edge to
      // trigger it).
      let justCompleted = false;
      if (!this._initialRefreshDone) {
        this._initialRefreshDone = true;
        if (this._state.status === "running") {
          this._enterRunning();
        } else {
          this._enterStandby();
        }
      } else {
        const previousStatus = this._lastStatus;
        const justStarted =
          this._state.status === "running" && previousStatus !== "running";
        justCompleted =
          this._state.status === "done" && previousStatus !== "done";

        if (justStarted) {
          this._enterRunning();
        } else if (justCompleted) {
          this._enterComplete();
        } else if (
          this._state.status !== "running" &&
          this._state.status !== "done"
        ) {
          // No task in flight and no recent completion (e.g. a
          // malformed/reset state file) — idle.
          this._enterStandby();
        }
      }
      this._lastStatus = this._state.status;
      // Gated on the Auto-refresh toggle (default off) so a manual "Refresh
      // Usage" click is the only rate-limit request by default — see
      // docs/SECURITY.md "Opt-in network egress".
      if (this._autoRefreshOnDone && justCompleted) {
        this._refreshRateLimits();
      }
    });
  }

  // Idle state: no pulse, no flash, plain padded label. Also where the
  // 5s post-completion flash lands once it times out.
  _enterStandby() {
    this._uiState = "standby";
    this._label?.remove_all_transitions();
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    if (this._label) {
      this._label.opacity = 255;
      this._label.style = STANDBY_STYLE;
      this._label.set_text(STANDBY_TEXT);
    }
  }

  // Task-in-flight state: slowly pulses the label orange by easing its
  // opacity back and forth (the background color itself stays fixed).
  _enterRunning() {
    this._uiState = "running";
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    if (!this._label) return;
    this._label.style = RUNNING_STYLE;
    this._label.set_text(RUNNING_TEXT);
    this._label.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  _pulseLoop() {
    if (!this._label || this._uiState !== "running") return;
    this._pulseDim = !this._pulseDim;
    this._label.ease({
      opacity: this._pulseDim ? 120 : 255,
      duration: 1200,
      mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
      onComplete: () => this._pulseLoop(),
    });
  }

  // Just-finished state: flashes the label green for COMPLETE_FLASH_MS,
  // then falls back to standby on its own.
  _enterComplete() {
    this._uiState = "complete";
    this._label?.remove_all_transitions();
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    if (!this._label) return;
    this._label.opacity = 255;
    this._label.style = COMPLETE_STYLE;
    this._label.set_text(COMPLETE_TEXT);
    this._flashTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      COMPLETE_FLASH_MS,
      () => {
        this._flashTimeoutId = null;
        this._enterStandby();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _openInVsCode() {
    const cwd = this._state.cwd;
    if (!cwd) return;
    try {
      Gio.Subprocess.new(["code", cwd], Gio.SubprocessFlags.NONE);
    } catch (e) {
      Main.notify(
        "CodeWatch",
        "Couldn't launch VS Code — is `code` on your PATH?",
      );
    }
  }

  _refreshUsage() {
    const transcriptPath = this._state.transcript_path;
    if (!transcriptPath) {
      this._usageLabelItem.label.set_text("No active session yet");
      return;
    }

    Gio.File.new_for_path(transcriptPath).load_contents_async(
      null,
      (file, result) => {
        let text;
        try {
          const [, contents] = file.load_contents_finish(result);
          text = `${summarizeUsage(new TextDecoder().decode(contents))}`;
        } catch (e) {
          // Transcript may be mid-write, same as the state file.
          text = "Session — usage unavailable";
        }
        this._usageLabelItem?.label.set_text(text);
      },
    );
  }

  _onRefreshUsageClicked() {
    this._refreshUsage();
    this._refreshRateLimits();
  }

  _refreshRateLimits() {
    this._refreshUsageItem.label.set_text("Checking…");
    this._rateLimit5hItem.visible = false;
    this._rateLimit7dItem.visible = false;
    Gio.File.new_for_path(TOKEN_PATH).load_contents_async(
      null,
      (file, result) => {
        let token;
        try {
          const [, contents] = file.load_contents_finish(result);
          token = new TextDecoder().decode(contents).trim();
        } catch (e) {
          this._refreshUsageItem?.label.set_text(
            `No token file at ${TOKEN_PATH}`,
          );
          return;
        }
        if (!token) {
          this._refreshUsageItem?.label.set_text("Token file is empty");
          return;
        }
        this._probeRateLimits(token);
      },
    );
  }

  _probeRateLimits(token) {
    const message = Soup.Message.new("GET", RATE_LIMIT_URL);
    message.request_headers.append("authorization", `Bearer ${token}`);
    message.request_headers.append("anthropic-beta", "oauth-2025-04-20");

    this._httpSession.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      null,
      (session, result) => {
        let bytes;
        try {
          bytes = session.send_and_read_finish(result);
        } catch (e) {
          this._refreshUsageItem?.label.set_text(
            `Rate limit check failed — ${e.message}`,
          );
          return;
        }
        // Not message.get_status(): GJS throws when the raw HTTP status
        // (e.g. 429) isn't one of libsoup's named Soup.Status enum values,
        // which would abort this callback before any set_text() below runs
        // and leave the row stuck on "Checking…" — status_code is the same
        // guint without the enum marshaling.
        const statusCode = message.status_code;
        let data;
        try {
          data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch (e) {
          data = null;
        }
        if (statusCode < 200 || statusCode >= 300) {
          const detail = data?.error?.message ?? `HTTP ${statusCode}`;
          this._refreshUsageItem?.label.set_text(
            `Rate limit check failed — ${detail}`,
          );
          return;
        }
        if (!data) {
          this._refreshUsageItem?.label.set_text(
            "Rate limit check failed — bad response",
          );
          return;
        }
        this._refreshUsageItem?.label.set_text("Refresh Usage");
        this._rateLimit5hItem?.label.set_text(
          formatRateLimitWindow(data.five_hour, "5h"),
        );
        this._rateLimit7dItem?.label.set_text(
          formatRateLimitWindow(data.seven_day, "7d"),
        );
        if (this._rateLimit5hItem) this._rateLimit5hItem.visible = true;
        if (this._rateLimit7dItem) this._rateLimit7dItem.visible = true;
      },
    );
  }

  _onExit() {
    const settings = new Gio.Settings({ schema_id: "org.gnome.shell" });
    const enabled = settings.get_strv("enabled-extensions");
    const index = enabled.indexOf(this.uuid);
    if (index === -1) return;
    enabled.splice(index, 1);
    settings.set_strv("enabled-extensions", enabled);
  }

  disable() {
    this._monitor?.disconnect(this._monitorId);
    this._monitor = null;
    this._stateFile = null;
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    this._label?.remove_all_transitions();
    this._indicator?.menu.disconnect(this._menuOpenStateId);
    this._indicator?.destroy();
    this._indicator = null;
    this._label = null;
    this._pulseDim = null;
    this._uiState = null;
    this._openInCodeItem = null;
    this._usageLabelItem = null;
    this._rateLimit5hItem = null;
    this._rateLimit7dItem = null;
    this._autoRefreshItem = null;
    this._refreshUsageItem = null;
    this._httpSession = null;
    this._lastStatus = null;
    this._initialRefreshDone = null;
    this._autoRefreshOnDone = null;
    this._exitItem = null;
    this._state = null;
  }
}
