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

import {
  resolveUiAction,
  deriveEffectiveStatus,
  type SessionState,
} from "./state.js";
import { summarizeUsage } from "./usage.js";
import {
  TOKEN_PATH,
  RATE_LIMIT_URL,
  formatRateLimitWindow,
  resolveToken,
} from "./rateLimit.js";

// The panel label's five states: idle ("standby", also where it lands 5s
// after a task finishes), a task in flight ("running", pulsing orange), the
// task paused on a permission prompt or question ("waiting", pulsing blue at
// twice the running rate so it reads as more urgent), a manual /compact in
// progress ("compacting", pulsing purple at the same rate as running), and
// the 5s green flash right after a task finishes ("complete").
const STANDBY_TEXT = "All clear 👀"; // not colored

// Picked once per run (on the standby -> running transition) and reused for
// every status text until the run falls back to standby, so "Agent Smith"
// stays "Agent Smith" across running/waiting/complete instead of re-rolling
// on every state-file update.
const AGENT_NAMES = [
  "Smith",
  "Johnson",
  "Thompson",
  "Jackson",
  "Wilson",
  "Anderson",
  "Robertson",
  "Peterson",
  "Nelson",
  "Watson",
];

const runningText = (name: string) => `Agent ${name} is working 🕶️`; // orange mode
const waitingText = (name: string) => `Agent ${name} needs support 📞`; // blue mode
const completeText = (name: string) => `Agent ${name} is done 🎖️`; // green mode
const COMPACTING_TEXT = "Agents are training 🔫"; // purple mode; no agent name — it isn't retained into the next session

const STANDBY_STYLE = "padding: 0 6px;";
const RUNNING_STYLE =
  "padding: 0 6px; background-color: #e67e22; border-radius: 4px;";
const WAITING_STYLE =
  "padding: 0 6px; background-color: #3498db; border-radius: 4px;";
const COMPLETE_STYLE =
  "padding: 0 6px; background-color: #2ecc71; border-radius: 4px;";
const COMPACTING_STYLE =
  "padding: 0 6px; background-color: #9b59b6; border-radius: 4px;";
const COMPLETE_FLASH_MS = 5000;
const RUNNING_PULSE_MS = 1200;
const WAITING_PULSE_MS = 600;
const COMPACTING_PULSE_MS = 1200;
// Claude Code only writes a hook-triggered state.json update for a
// *completed* compaction (PreCompact then, eventually, some later event once
// the session resumes) — cancelling a manual /compact mid-flight fires no
// hook at all, so the file monitor never wakes applyState() back up on its
// own. _watchTranscriptForCompactOutcome() below tails the session
// transcript directly for the two markers Claude Code actually writes
// there — a `{"type":"system","subtype":"compact_boundary",...}` entry on a
// real completion, or a local_command entry containing "AbortError:
// Compaction canceled." on a cancel — and reacts within a file-monitor tick
// either way, so this timeout is normally not what the user waits on. It's
// the fallback behind that fast path: if transcript_path is missing or
// those markers ever change shape, this still bounds "compacting" the same
// way COMPLETE_FLASH_MS bounds "complete", so the panel can't get stuck
// purple forever. Generous relative to how long even a large-transcript
// compaction realistically takes, so it shouldn't cut a genuine one off
// mid-flight.
const COMPACTING_STALE_MS = 3 * 60 * 1000;

type UiState = "standby" | "running" | "waiting" | "complete" | "compacting";

// Two real GNOME Shell APIs the community @girs types don't model: Actor's
// `ease()` is JS-side sugar from environment.js (not GIR-introspected, so
// ts-for-gir never sees it), and PopupMenu's `SignalMap` is declared but
// left empty upstream even though it does emit "open-state-changed". A
// `declare module` augmentation of the generated `@girs/*` packages would be
// the usual fix, but doing so corrupts unrelated type resolution for those
// packages under this toolchain's module setup — so these stay as narrow
// local assertions instead of a global ambient patch.
type Easeable = {
  ease(properties: {
    opacity?: number;
    duration?: number;
    mode?: Clutter.AnimationMode;
    onComplete?: () => void;
  }): void;
};
type MenuWithOpenStateSignal = {
  connect(
    sigName: "open-state-changed",
    callback: (menu: PopupMenu.PopupMenu, open: boolean) => void,
  ): number;
};

// Owns the panel indicator (`this.button`, a plain `PanelMenu.Button` — not
// subclassed, since GJS's GObject-subclassing ceremony buys nothing here
// over composition) and its popup menu: the visible state machine (label
// text/style/pulse, desktop notifications) and the "Claude Usage" section
// (local session totals plus the opt-in rate-limit check). extension.js
// only owns file-watching wiring and hands this class parsed state via
// applyState().
export class ClaudeWatchIndicator {
  button: InstanceType<typeof PanelMenu.Button>;

  private readonly _uuid: string;
  private readonly _icon: InstanceType<typeof St.Icon>;
  private readonly _label: InstanceType<typeof St.Label>;
  private readonly _box: InstanceType<typeof St.BoxLayout>;
  // `PanelMenu.Button.menu` is typed as `PopupMenu | PopupDummyMenu` since
  // the ambient types don't narrow on the dontCreateMenu constructor arg;
  // it's always a real PopupMenu here since we pass `false` below.
  private readonly _menu: PopupMenu.PopupMenu;

  private readonly _openInCodeItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _usageLabelItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _rateLimit5hItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _rateLimit7dItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _autoRefreshItem: InstanceType<
    typeof PopupMenu.PopupSwitchMenuItem
  >;
  private readonly _notificationsItem: InstanceType<
    typeof PopupMenu.PopupSwitchMenuItem
  >;
  private readonly _refreshUsageItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _exitItem: InstanceType<typeof PopupMenu.PopupMenuItem>;
  private readonly _menuOpenStateId: number;

  private readonly _httpSession: InstanceType<typeof Soup.Session>;
  private _lastStatus: string | null = null;
  private _initialRefreshDone = false;
  private _autoRefreshOnDone = false;
  private _notificationsEnabled = false;
  private _flashTimeoutId: number | null = null;
  private _compactingTimeoutId: number | null = null;
  private _transcriptMonitor: InstanceType<typeof Gio.FileMonitor> | null =
    null;
  private _transcriptMonitorId: number | null = null;
  private _transcriptWatchFile: InstanceType<typeof Gio.File> | null = null;
  private _transcriptWatchStartLength = 0;
  private _pulseDim = false;
  private _uiState: UiState = "standby";
  private _state: SessionState = {};
  // Set on the standby -> running transition, cleared back to null on the
  // return to standby; see AGENT_NAMES above.
  private _agentName: string | null = null;

  constructor(uuid: string, name: string, extensionPath: string) {
    this._uuid = uuid;

    this.button = new PanelMenu.Button(0.0, name, false);
    this._menu = this.button.menu as PopupMenu.PopupMenu;

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
    this._menu.box.style = "width: 300px; min-width: 300px; max-width: 300px;";

    this._openInCodeItem = new PopupMenu.PopupMenuItem("Open in VS Code");
    this._openInCodeItem.setSensitive(false);
    this._openInCodeItem.connect("activate", () => this._openInVsCode());
    this._menu.addMenuItem(this._openInCodeItem);

    this._menu.addMenuItem(
      new PopupMenu.PopupSeparatorMenuItem("Claude Usage"),
    );

    this._usageLabelItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this._menu.addMenuItem(this._usageLabelItem);

    this._httpSession = new Soup.Session();

    this._rateLimit5hItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this._rateLimit5hItem.visible = false;
    this._menu.addMenuItem(this._rateLimit5hItem);

    this._rateLimit7dItem = new PopupMenu.PopupMenuItem("", {
      reactive: false,
      can_focus: false,
    });
    this._rateLimit7dItem.visible = false;
    this._menu.addMenuItem(this._rateLimit7dItem);

    this._autoRefreshItem = new PopupMenu.PopupSwitchMenuItem(
      "Auto-refresh on task complete",
      false,
    );
    this._autoRefreshItem.connect("toggled", (_item, state: boolean) => {
      this._autoRefreshOnDone = state;
    });
    // Default activate() chains to super.activate(), which PopupMenu treats
    // as a close-triggering click; override so toggling never closes the
    // menu. toggle() still flips the switch and fires "toggled" above.
    this._autoRefreshItem.activate = () => this._autoRefreshItem.toggle();
    this._menu.addMenuItem(this._autoRefreshItem);

    this._notificationsItem = new PopupMenu.PopupSwitchMenuItem(
      "Notifications",
      false,
    );
    this._notificationsItem.connect("toggled", (_item, state: boolean) => {
      this._notificationsEnabled = state;
    });
    this._notificationsItem.activate = () => this._notificationsItem.toggle();
    this._menu.addMenuItem(this._notificationsItem);

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
    this._menu.addMenuItem(this._refreshUsageItem);

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._exitItem = new PopupMenu.PopupMenuItem("Exit");
    this._exitItem.connect("activate", () => this._onExit());
    this._menu.addMenuItem(this._exitItem);

    this._menuOpenStateId = (
      this._menu as unknown as MenuWithOpenStateSignal
    ).connect("open-state-changed", (_menu, open) => {
      if (open) this._refreshUsage();
    });
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
  applyState(state: SessionState): void {
    this._state = state;
    this._openInCodeItem.setSensitive(!!this._state.cwd);
    this._refreshUsage();
    const status = deriveEffectiveStatus(
      this._state.status,
      this._isSessionAlive(),
    );
    const action = resolveUiAction(
      status,
      this._lastStatus,
      !this._initialRefreshDone,
    );
    this._initialRefreshDone = true;
    if (action === "running") this._enterRunning();
    else if (action === "waiting") this._enterWaiting();
    else if (action === "compacting") this._enterCompacting();
    else if (action === "complete") this._enterComplete();
    else if (action === "standby") this._enterStandby();
    // Re-armed on every refresh that still reports "compacting" — not just
    // the initial transition into it — so a /compact retried after a
    // cancelled one (same status both times, so `action` above is null and
    // _enterCompacting() doesn't re-fire) still gets both self-heal paths
    // reset instead of being timed/watched from the first, aborted attempt.
    if (status === "compacting") {
      this._armCompactingTimeout();
      this._watchTranscriptForCompactOutcome();
    } else {
      this._clearCompactingTimeout();
      this._stopWatchingTranscript();
    }
    const justCompleted = action === "complete";
    this._lastStatus = status ?? null;
    // Gated on the Auto-refresh toggle (default off) so a manual "Refresh
    // Usage" click is the only rate-limit request by default — see
    // docs/SECURITY.md "Opt-in network egress".
    if (this._autoRefreshOnDone && justCompleted) {
      this._refreshRateLimits();
    }
  }

  // Idle state: no pulse, no flash, plain padded label. Also where the
  // 5s post-completion flash lands once it times out.
  private _enterStandby(): void {
    this._uiState = "standby";
    this._label.remove_all_transitions();
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    // Whichever compacting self-heal path (timeout or transcript marker)
    // got us here, the other one is now stale — always tear down both so
    // entering standby is a clean terminal action regardless of trigger.
    this._clearCompactingTimeout();
    this._stopWatchingTranscript();
    // Both self-heal paths call this directly, outside applyState(), so
    // _lastStatus never sees the drop out of "compacting" — without this,
    // a retried /compact writes the same "compacting" status again,
    // resolveUiAction() sees no edge, and the panel never re-enters
    // compacting. applyState()'s own standby transition harmlessly
    // overwrites this again right after with the real current status.
    this._lastStatus = null;
    this._label.opacity = 255;
    this._label.style = STANDBY_STYLE;
    this._label.set_text(STANDBY_TEXT);
    this._agentName = null;
  }

  // Picks the run's agent name on first use after standby; subsequent calls
  // within the same run return the same name.
  private _ensureAgentName(): string {
    if (!this._agentName) {
      this._agentName =
        AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)]; //NOSONAR - cosmetic name pick, not security-sensitive
    }
    return this._agentName;
  }

  // Task-in-flight state: slowly pulses the label orange by easing its
  // opacity back and forth (the background color itself stays fixed).
  private _enterRunning(): void {
    this._uiState = "running";
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    this._label.style = RUNNING_STYLE;
    this._label.set_text(runningText(this._ensureAgentName()));
    this._label.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  // Paused-on-prompt state: Claude stopped to ask for a permission or a
  // question and is waiting on the user. Same pulse as _enterRunning() but
  // blue and twice as fast, so it reads as more urgent than plain progress.
  // Also fires a desktop notification since the panel alone is easy to miss
  // while Claude is genuinely blocked on the user.
  private _enterWaiting(): void {
    this._uiState = "waiting";
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    this._label.style = WAITING_STYLE;
    const text = waitingText(this._ensureAgentName());
    this._label.set_text(text);
    this._label.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
    this._notify(text, "dialog-question");
  }

  // Manual /compact in progress: Claude paused to summarize its own
  // transcript, not to ask the user anything, so this doesn't fire a
  // notification the way _enterWaiting() does — same pulse cadence as
  // _enterRunning(), just purple, since it's progress rather than a block.
  private _enterCompacting(): void {
    this._uiState = "compacting";
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    this._label.style = COMPACTING_STYLE;
    this._label.set_text(COMPACTING_TEXT);
    this._label.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  // See COMPACTING_STALE_MS above: the self-heal for a cancelled /compact,
  // since Claude Code fires no hook at all when one is aborted mid-flight.
  private _armCompactingTimeout(): void {
    this._clearCompactingTimeout();
    this._compactingTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      COMPACTING_STALE_MS,
      () => {
        this._compactingTimeoutId = null;
        if (this._uiState === "compacting") this._enterStandby();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _clearCompactingTimeout(): void {
    if (this._compactingTimeoutId) {
      GLib.source_remove(this._compactingTimeoutId);
      this._compactingTimeoutId = null;
    }
  }

  // Fast path for the same problem COMPACTING_STALE_MS guards against:
  // tails the session transcript from its current length (so a leftover
  // marker from an earlier /compact attempt earlier in the same file can't
  // false-trigger this one) for either outcome marker Claude Code actually
  // writes — a compact_boundary system entry on success, or a local_command
  // entry containing "AbortError: Compaction canceled." on a cancel — and
  // reacts immediately instead of waiting for the fallback timeout.
  // Best-effort: if transcript_path is missing, or the markers never show
  // up, COMPACTING_STALE_MS still catches it.
  private _watchTranscriptForCompactOutcome(): void {
    const transcriptPath = this._state.transcript_path;
    if (!transcriptPath) {
      this._stopWatchingTranscript();
      return;
    }
    const file = Gio.File.new_for_path(transcriptPath);
    file.load_contents_async(null, (_file, result) => {
      let startLength = 0;
      try {
        const [, contents] = file.load_contents_finish(result);
        startLength = new TextDecoder().decode(contents).length;
      } catch {
        // Transcript not there yet — watch from the start so nothing
        // already-written can hide a fresh marker.
      }
      // The UI may have already moved on (timeout fired first, or a fresh
      // status update landed) while this async read was in flight.
      if (this._uiState !== "compacting") return;
      this._stopWatchingTranscript();
      this._transcriptWatchStartLength = startLength;
      this._transcriptWatchFile = file;
      this._transcriptMonitor = file.monitor_file(
        Gio.FileMonitorFlags.NONE,
        null,
      );
      this._transcriptMonitorId = this._transcriptMonitor.connect(
        "changed",
        () => this._checkTranscriptForCompactOutcome(),
      );
    });
  }

  private _checkTranscriptForCompactOutcome(): void {
    const file = this._transcriptWatchFile;
    if (!file || this._uiState !== "compacting") return;
    file.load_contents_async(null, (_file, result) => {
      // A newer watch may have started (different file/offset) while this
      // read was in flight — don't act on data that no longer applies.
      if (this._uiState !== "compacting" || this._transcriptWatchFile !== file)
        return;
      let contents: string;
      try {
        const [, bytes] = file.load_contents_finish(result);
        contents = new TextDecoder().decode(bytes);
      } catch {
        return; // Mid-write; the next "changed" event retries.
      }
      if (contents.length <= this._transcriptWatchStartLength) return;
      const appended = contents.slice(this._transcriptWatchStartLength);
      for (const line of appended.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: { type?: string; subtype?: string; content?: unknown };
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue; // Partial line mid-write; keep waiting.
        }
        if (entry.type !== "system") continue;
        const isAbort =
          entry.subtype === "local_command" &&
          typeof entry.content === "string" &&
          entry.content.includes("AbortError: Compaction canceled.");
        if (entry.subtype === "compact_boundary" || isAbort) {
          this._enterStandby();
          return;
        }
      }
    });
  }

  private _stopWatchingTranscript(): void {
    if (this._transcriptMonitor && this._transcriptMonitorId) {
      this._transcriptMonitor.disconnect(this._transcriptMonitorId);
    }
    this._transcriptMonitor = null;
    this._transcriptMonitorId = null;
    this._transcriptWatchFile = null;
  }

  // Desktop notification paired with a themed system sound — every waiting/
  // complete transition fires both together. Uses the shell's own sound
  // player (same mechanism as the screenshot/volume sounds) rather than
  // spawning a subprocess, and resolves soundName against the user's
  // current sound theme rather than shipping an audio file. No-op unless
  // the "Notifications" toggle is on (default off).
  private _notify(text: string, soundName: string): void {
    if (!this._notificationsEnabled) return;
    Main.notify("ClaudeWatch", text);
    global.display.get_sound_player().play_from_theme(soundName, text, null);
  }

  private _pulseLoop(): void {
    let pulseDuration: number | null = null;
    if (this._uiState === "running") pulseDuration = RUNNING_PULSE_MS;
    else if (this._uiState === "waiting") pulseDuration = WAITING_PULSE_MS;
    else if (this._uiState === "compacting")
      pulseDuration = COMPACTING_PULSE_MS;
    if (!pulseDuration) return;
    this._pulseDim = !this._pulseDim;
    (this._label as unknown as Easeable).ease({
      opacity: this._pulseDim ? 120 : 255,
      duration: pulseDuration,
      mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
      onComplete: () => this._pulseLoop(),
    });
  }

  // Just-finished state: flashes the label green for COMPLETE_FLASH_MS,
  // then falls back to standby on its own. Also fires a desktop notification
  // for the same reason as _enterWaiting() — easy to miss the panel alone.
  private _enterComplete(): void {
    this._uiState = "complete";
    this._label.remove_all_transitions();
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    this._label.opacity = 255;
    this._label.style = COMPLETE_STYLE;
    const text = completeText(this._ensureAgentName());
    this._label.set_text(text);
    this._notify(text, "complete");
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

  private _openInVsCode(): void {
    const cwd = this._state.cwd;
    if (!cwd) return;
    try {
      Gio.Subprocess.new(["code", cwd], Gio.SubprocessFlags.NONE);
    } catch {
      Main.notify(
        "ClaudeWatch",
        "Couldn't launch VS Code — is `code` on your PATH?",
      );
    }
  }

  // A recorded pid means the hook that wrote it ran in exec form (no shell
  // wrapper), so pid is the Claude Code CLI process itself — /proc/<pid>
  // existing is a direct liveness check, not a heuristic. No pid (older
  // state file, or none yet) means trust the status as before.
  private _isSessionAlive(): boolean {
    const pid = this._state.pid;
    if (pid == null) return true;
    return Gio.File.new_for_path(`/proc/${pid}`).query_exists(null);
  }

  private _refreshUsage(): void {
    const transcriptPath = this._state.transcript_path;
    if (!transcriptPath) {
      this._usageLabelItem.label.set_text("No active session yet");
      return;
    }

    Gio.File.new_for_path(transcriptPath).load_contents_async(
      null,
      (file, result) => {
        let text: string;
        try {
          const [, contents] = file!.load_contents_finish(result);
          text = `${summarizeUsage(new TextDecoder().decode(contents))}`;
        } catch {
          // Transcript may be mid-write, same as the state file.
          text = "Session — usage unavailable";
        }
        this._usageLabelItem.label.set_text(text);
      },
    );
  }

  private _onRefreshUsageClicked(): void {
    this._refreshUsage();
    this._refreshRateLimits();
  }

  private _refreshRateLimits(): void {
    this._refreshUsageItem.label.set_text("Checking…");
    this._rateLimit5hItem.visible = false;
    this._rateLimit7dItem.visible = false;
    Gio.File.new_for_path(TOKEN_PATH).load_contents_async(
      null,
      (file, result) => {
        let text: string;
        try {
          const [, contents] = file!.load_contents_finish(result);
          text = new TextDecoder().decode(contents).trim();
        } catch {
          this._refreshUsageItem.label.set_text(
            `No token file at ${TOKEN_PATH}`,
          );
          return;
        }
        if (!text) {
          this._refreshUsageItem.label.set_text("Token file is empty");
          return;
        }
        const { token, error } = resolveToken(text);
        if (error || !token) {
          this._refreshUsageItem.label.set_text(error ?? "No token found");
          return;
        }
        this._probeRateLimits(token);
      },
    );
  }

  private _probeRateLimits(token: string): void {
    const message = Soup.Message.new("GET", RATE_LIMIT_URL);
    if (!message) {
      this._refreshUsageItem.label.set_text(
        "Rate limit check failed — bad URL",
      );
      return;
    }
    message.request_headers.append("authorization", `Bearer ${token}`);
    message.request_headers.append("anthropic-beta", "oauth-2025-04-20");

    this._httpSession.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      null,
      (session, result) => {
        let bytes;
        try {
          bytes = session!.send_and_read_finish(result);
        } catch (e) {
          this._refreshUsageItem.label.set_text(
            `Rate limit check failed — ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
        // Not message.get_status(): GJS throws when the raw HTTP status
        // (e.g. 429) isn't one of libsoup's named Soup.Status enum values,
        // which would abort this callback before any set_text() below runs
        // and leave the row stuck on "Checking…" — status_code is the same
        // guint without the enum marshaling.
        const statusCode = message.status_code;
        let data: {
          error?: { message?: string };
          five_hour?: import("./rateLimit.js").RateLimitWindow;
          seven_day?: import("./rateLimit.js").RateLimitWindow;
        } | null;
        try {
          const raw = bytes?.get_data();
          data = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
        } catch {
          data = null;
        }
        if (statusCode < 200 || statusCode >= 300) {
          const detail = data?.error?.message ?? `HTTP ${statusCode}`;
          this._refreshUsageItem.label.set_text(
            `Rate limit check failed — ${detail}`,
          );
          return;
        }
        if (!data) {
          this._refreshUsageItem.label.set_text(
            "Rate limit check failed — bad response",
          );
          return;
        }
        this._refreshUsageItem.label.set_text("Refresh Usage");
        this._rateLimit5hItem.label.set_text(
          formatRateLimitWindow(data.five_hour, "5h"),
        );
        this._rateLimit7dItem.label.set_text(
          formatRateLimitWindow(data.seven_day, "7d"),
        );
        this._rateLimit5hItem.visible = true;
        this._rateLimit7dItem.visible = true;
      },
    );
  }

  private _onExit(): void {
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
  destroy(): void {
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
    this._clearCompactingTimeout();
    this._stopWatchingTranscript();
    this._label.remove_all_transitions();
    this._menu.disconnect(this._menuOpenStateId);
    // Nothing reads `button`/`_httpSession` after this call (extension.js
    // drops its own reference to this indicator in the same disable() that
    // calls destroy()), so there's no need to null them out here the way
    // the pre-TS version did.
    this.button.destroy();
  }
}
