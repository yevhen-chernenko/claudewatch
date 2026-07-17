// SPDX-License-Identifier: GPL-2.0-or-later

import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import Soup from "gi://Soup?version=3.0";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { resolveUiAction } from "./state.js";
import { summarizeUsage } from "./usage.js";
import {
  TOKEN_PATH,
  RATE_LIMIT_URL,
  formatRateLimitWindow,
} from "./rateLimit.js";

// The panel label's four states: idle ("standby", also where it lands 5s
// after a task finishes), a task in flight ("running", pulsing orange), the
// task paused on a permission prompt or question ("waiting", pulsing blue at
// twice the running rate so it reads as more urgent), and the 5s green flash
// right after a task finishes ("complete").
const STANDBY_TEXT = "Claude is resting...";
const RUNNING_TEXT = "Claude is working...";
const WAITING_TEXT = "Claude wants something!";
const COMPLETE_TEXT = "Claude is done!";

const STANDBY_STYLE = "padding: 0 6px;";
const RUNNING_STYLE =
  "padding: 0 6px; background-color: #e67e22; border-radius: 4px;";
const WAITING_STYLE =
  "padding: 0 6px; background-color: #3498db; border-radius: 4px;";
const COMPLETE_STYLE =
  "padding: 0 6px; background-color: #2ecc71; border-radius: 4px;";
const COMPLETE_FLASH_MS = 5000;
const RUNNING_PULSE_MS = 1200;
const WAITING_PULSE_MS = 600;

// Owns the panel indicator (`this.button`, a plain `PanelMenu.Button` — not
// subclassed, since GJS's GObject-subclassing ceremony buys nothing here
// over composition) and its popup menu: the visible state machine (label
// text/style/pulse, desktop notifications) and the "Claude Usage" section
// (local session totals plus the opt-in rate-limit check). extension.js
// only owns file-watching wiring and hands this class parsed state via
// applyState().
export class ClaudeWatchIndicator {
  constructor(uuid, name, extensionPath) {
    this._uuid = uuid;

    this.button = new PanelMenu.Button(0.0, name, false);

    this._icon = new St.Icon({
      gicon: Gio.icon_new_for_string(
        `${extensionPath}/icons/claudewatch-symbolic.svg`,
      ),
      icon_size: 16,
      y_align: Clutter.ActorAlign.CENTER,
      style: "padding-right: 6px;",
    });
    this._label = new St.Label({
      text: STANDBY_TEXT,
      y_align: Clutter.ActorAlign.CENTER,
      style: STANDBY_STYLE,
    });
    this._box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
    this._box.add_child(this._icon);
    this._box.add_child(this._label);
    this.button.add_child(this._box);

    // Fixed width so the menu doesn't reflow as row text changes length
    // (e.g. "Checking…" vs. a long rate-limit error string).
    this.button.menu.box.style =
      "width: 300px; min-width: 300px; max-width: 300px;";

    this._openInCodeItem = new PopupMenu.PopupMenuItem("Open in VS Code");
    this._openInCodeItem.setSensitive(false);
    this._openInCodeItem.connect("activate", () => this._openInVsCode());
    this.button.menu.addMenuItem(this._openInCodeItem);

    this.button.menu.addMenuItem(
      new PopupMenu.PopupSeparatorMenuItem("Claude Usage"),
    );

    this._usageLabelItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this.button.menu.addMenuItem(this._usageLabelItem);

    this._httpSession = new Soup.Session();
    this._lastStatus = null;
    this._initialRefreshDone = false;
    this._autoRefreshOnDone = false;
    this._flashTimeoutId = null;
    this._pulseDim = false;
    this._uiState = "standby";
    this._state = {};

    this._rateLimit5hItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this._rateLimit5hItem.visible = false;
    this.button.menu.addMenuItem(this._rateLimit5hItem);

    this._rateLimit7dItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this._rateLimit7dItem.visible = false;
    this.button.menu.addMenuItem(this._rateLimit7dItem);

    this._autoRefreshItem = new PopupMenu.PopupSwitchMenuItem(
      "Auto-refresh on task complete",
      false,
    );
    this._autoRefreshItem.connect("toggled", (item, state) => {
      this._autoRefreshOnDone = state;
    });
    this.button.menu.addMenuItem(this._autoRefreshItem);

    this._refreshUsageItem = new PopupMenu.PopupMenuItem("Refresh Usage");
    // Default activate() chains to super.activate(), which PopupMenu treats
    // as a close-triggering click; override so clicking never closes the
    // menu. This is a manual override on top of the automatic refreshes
    // below — not the only way either row updates.
    this._refreshUsageItem.activate = () => this._onRefreshUsageClicked();
    // Error strings from _probeRateLimits() (e.g. an OAuth scope/permission
    // message) can run well past the menu's fixed 300px width; without
    // wrapping, St.Label just clips them instead of ellipsizing, hiding the
    // actual reason.
    this._refreshUsageItem.label.clutter_text.set({
      line_wrap: true,
      line_wrap_mode: Pango.WrapMode.WORD_CHAR,
    });
    this.button.menu.addMenuItem(this._refreshUsageItem);

    this.button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._exitItem = new PopupMenu.PopupMenuItem("Exit");
    this._exitItem.connect("activate", () => this._onExit());
    this.button.menu.addMenuItem(this._exitItem);

    this._menuOpenStateId = this.button.menu.connect(
      "open-state-changed",
      (menu, open) => {
        if (open) this._refreshUsage();
      },
    );
  }

  // Called by extension.js with the freshly-parsed state.json contents (or
  // {} if the file is missing/mid-write) every time the file monitor fires.
  // Edge-triggered on status transitions, not on every file-monitor event
  // while status stays the same. Text and style are both driven from
  // this._uiState (set by the _enter* methods below), not directly from the
  // raw hook status — that's what lets the 5s post-completion timer fall
  // back to "Standby" on its own even though the state file still says
  // status: "done". See resolveUiAction() for the transition rules
  // themselves.
  applyState(state) {
    this._state = state;
    this._openInCodeItem?.setSensitive(!!this._state.cwd);
    this._refreshUsage();
    const action = resolveUiAction(
      this._state.status,
      this._lastStatus,
      !this._initialRefreshDone,
    );
    this._initialRefreshDone = true;
    if (action === "running") this._enterRunning();
    else if (action === "waiting") this._enterWaiting();
    else if (action === "complete") this._enterComplete();
    else if (action === "standby") this._enterStandby();
    const justCompleted = action === "complete";
    this._lastStatus = this._state.status;
    // Gated on the Auto-refresh toggle (default off) so a manual "Refresh
    // Usage" click is the only rate-limit request by default — see
    // docs/SECURITY.md "Opt-in network egress".
    if (this._autoRefreshOnDone && justCompleted) {
      this._refreshRateLimits();
    }
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

  // Paused-on-prompt state: Claude stopped to ask for a permission or a
  // question and is waiting on the user. Same pulse as _enterRunning() but
  // blue and twice as fast, so it reads as more urgent than plain progress.
  // Also fires a desktop notification since the panel alone is easy to miss
  // while Claude is genuinely blocked on the user.
  _enterWaiting() {
    this._uiState = "waiting";
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    if (!this._label) return;
    this._label.style = WAITING_STYLE;
    this._label.set_text(WAITING_TEXT);
    this._label.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
    this._notify(WAITING_TEXT, "dialog-question");
  }

  // Desktop notification paired with a themed system sound — every waiting/
  // complete transition fires both together. Uses the shell's own sound
  // player (same mechanism as the screenshot/volume sounds) rather than
  // spawning a subprocess, and resolves soundName against the user's
  // current sound theme rather than shipping an audio file.
  _notify(text, soundName) {
    Main.notify("ClaudeWatch", text);
    global.display.get_sound_player().play_from_theme(soundName, text, null);
  }

  _pulseLoop() {
    if (!this._label) return;
    let pulseDuration = null;
    if (this._uiState === "running") pulseDuration = RUNNING_PULSE_MS;
    else if (this._uiState === "waiting") pulseDuration = WAITING_PULSE_MS;
    if (!pulseDuration) return;
    this._pulseDim = !this._pulseDim;
    this._label.ease({
      opacity: this._pulseDim ? 120 : 255,
      duration: pulseDuration,
      mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
      onComplete: () => this._pulseLoop(),
    });
  }

  // Just-finished state: flashes the label green for COMPLETE_FLASH_MS,
  // then falls back to standby on its own. Also fires a desktop notification
  // for the same reason as _enterWaiting() — easy to miss the panel alone.
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
    this._notify(COMPLETE_TEXT, "complete");
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
        "ClaudeWatch",
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
    const index = enabled.indexOf(this._uuid);
    if (index === -1) return;
    enabled.splice(index, 1);
    settings.set_strv("enabled-extensions", enabled);
  }

  // Mirrors the old disable()'s teardown exactly, scoped to what this class
  // owns: the GLib timeout and the menu signal connection are the two things
  // that actually leak across enable/disable cycles if left connected —
  // destroying `button` (a widget) takes its child actors and menu items
  // with it.
  destroy() {
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    this._label?.remove_all_transitions();
    this.button.menu.disconnect(this._menuOpenStateId);
    this._httpSession = null;
    this.button.destroy();
    this.button = null;
  }
}
