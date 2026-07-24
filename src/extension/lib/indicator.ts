// SPDX-License-Identifier: GPL-2.0-or-later

import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import {
  resolveUiAction,
  deriveEffectiveStatus,
  type SessionState,
} from "./state.js";
import { pickTerminalCommand } from "./terminal.js";

// Each live session gets its own label with the same state machine the
// single-session version had, minus the shared "standby" state: idle
// sessions don't get a label at all (see "Agents are recovering ☕" below), a task in
// flight ("running", pulsing), paused on a permission prompt or question
// ("waiting", static), a manual /compact in progress ("compacting", pulsing
// at the same rate as running), a Stop that landed while a subagent it
// spawned hasn't reported back yet ("consulting", pulsing — see
// waiting_background in hooks/lib/status.ts), and the 5s flash right after a
// task finishes ("complete", static) before the label is removed for good.
const STANDBY_TEXT = "Agents are recovering ☕";

// Picked once per session (when its label is first created) and reused for
// every status text until the session retires, so "Agent Smith" stays
// "Agent Smith" across running/waiting/complete instead of re-rolling on
// every state-file update. Concurrent sessions avoid picking the same name
// as each other where possible — see pickAgentName() below.
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

const runningText = (name: string) => `Agent ${name} is working 🕶️`;
const waitingText = (name: string) => `Agent ${name} needs support 📞`;
const completeText = (name: string) => `Agent ${name} is done 🎖️`;
const consultingText = (name: string) => `Agent ${name} is consulting notes 📓`;
const COMPACTING_TEXT = "Agents are training 🔫"; // no agent name — it isn't retained into the next session

// Backgrounds are all white-text-on-color, AA-contrast checked (≥4.5:1
// against #ffffff at this weight/size).
const STANDBY_STYLE =
  "padding: 0 6px; background-color: #333a3d; border-radius: 4px; color: #ffffff;"; // 11.6:1
const RUNNING_STYLE =
  "padding: 0 6px; background-color: #a0450a; border-radius: 4px; color: #ffffff;"; // 6.27:1
const WAITING_STYLE =
  "padding: 0 6px; background-color: #2457c5; border-radius: 4px; color: #ffffff;"; // 6.47:1
const COMPLETE_STYLE =
  "padding: 0 6px; background-color: #1a7a43; border-radius: 4px; color: #ffffff;"; // 5.37:1
const COMPACTING_STYLE =
  "padding: 0 6px; background-color: #7a3fa0; border-radius: 4px; color: #ffffff;"; // 6.89:1
const CONSULTING_STYLE =
  "padding: 0 6px; background-color: #7a5f00; border-radius: 4px; color: #ffffff;"; // 6.06:1
const OVERFLOW_STYLE =
  "padding: 0 6px; background-color: #333a3d; border-radius: 4px; color: #ffffff;"; // 11.6:1
const COMPLETE_FLASH_MS = 5000;
// Full pulse cycle (dim -> bright -> dim) is 2x this, i.e. 2.6s; opacity
// floor is 72% of 255.
const PULSE_HALF_CYCLE_MS = 1300;
const PULSE_DIM_OPACITY = Math.round(255 * 0.72);
// Claude Code only writes a hook-triggered state-file update for a
// *completed* compaction (PreCompact then, eventually, some later event once
// the session resumes) — cancelling a manual /compact mid-flight fires no
// hook at all, so the directory monitor never wakes this label back up on
// its own. _watchTranscriptForCompactOutcome() below tails the session
// transcript directly for the two markers Claude Code actually writes
// there — a `{"type":"system","subtype":"compact_boundary",...}` entry on a
// real completion, or a local_command entry containing "AbortError:
// Compaction canceled." on a cancel — and reacts within a file-monitor tick
// either way, so this timeout is normally not what the user waits on. It's
// the fallback behind that fast path: if transcript_path is missing or
// those markers ever change shape, this still bounds "compacting" the same
// way COMPLETE_FLASH_MS bounds "complete", so a label can't get stuck
// purple forever. Generous relative to how long even a large-transcript
// compaction realistically takes, so it shouldn't cut a genuine one off
// mid-flight.
const COMPACTING_STALE_MS = 3 * 60 * 1000;

// Bounds how long a "running" status is trusted once its own file stops
// moving — see deriveEffectiveStatus's isRunningStale param in state.ts for
// why pid-liveness can't catch this on its own (a turn that ends by
// interruption, not a clean Stop, leaves the CLI process alive and idling
// with no further hook ever firing for that session). Deliberately on a
// much longer leash than COMPACTING_STALE_MS: an actual compaction is
// bounded and rare, but a single legitimate tool call (a big test suite, a
// package install) can easily run this long between PreToolUse/PostToolUse
// updates, and this must clear comfortably past that or it'll retire a
// task that's still genuinely in flight.
const RUNNING_STALE_MS = 20 * 60 * 1000;

// Same fallback shape as COMPACTING_STALE_MS above, for the same reason: the
// fast path here is SubagentStop actually firing, but if the tracked
// subagent's process were ever killed outright rather than cleanly
// finishing, no hook fires for that either, and pid-liveness alone can't
// catch it (the parent CLI is still alive and idling). On a longer leash
// than RUNNING_STALE_MS since a real agentic subagent task (e.g. a
// large-codebase Explore) can legitimately run long with no activity
// visible to this session's own file in the meantime.
const CONSULTING_STALE_MS = 45 * 60 * 1000;

// Labels beyond this count collapse into a single "+N more" chip so the
// panel bar can't grow unbounded with many concurrent sessions — full
// detail for every session is always in the popup menu.
const MAX_INLINE_AGENTS = 3;

type UiState = "running" | "waiting" | "complete" | "compacting" | "consulting";

// Every visual the panel can ever show, for the CLAUDEWATCH_DEV preview menu
// (see ClaudeWatchIndicator's constructor) — one entry per UiState plus
// "standby" (no label at all) and "overflow" (the "+N more" chip), so the
// menu can cover every possible look without needing a real session.
type PreviewKind =
  | "standby"
  | "running"
  | "waiting"
  | "compacting"
  | "consulting"
  | "complete"
  | "overflow";

// Actor's `ease()` is JS-side sugar from environment.js (not
// GIR-introspected, so ts-for-gir never sees it) — a real GNOME Shell API
// the community @girs types don't model. A `declare module` augmentation of
// the generated `@girs/*` packages was tried first and corrupted unrelated
// type resolution for those packages under this toolchain's module setup,
// so this stays as a narrow local assertion instead of a global ambient
// patch.
type Easeable = {
  ease(properties: {
    opacity?: number;
    duration?: number;
    mode?: Clutter.AnimationMode;
    onComplete?: () => void;
  }): void;
};

// A recorded pid means the hook that wrote it ran in exec form (no shell
// wrapper), so pid is the Claude Code CLI process itself — /proc/<pid>
// existing is a direct liveness check, not a heuristic. No pid (older state
// file, or none yet) means trust the status as-is. Shared between the
// pre-creation check in ClaudeWatchIndicator.applyStates() and each
// AgentLabel's own per-refresh check, so both apply the exact same rule.
function isSessionAlive(state: SessionState): boolean {
  const pid = state.pid;
  if (pid == null) return true;
  return Gio.File.new_for_path(`/proc/${pid}`).query_exists(null);
}

// Plain-boolean computation of "has this session's own file gone quiet for
// too long while stuck on running" — see RUNNING_STALE_MS above and
// deriveEffectiveStatus's isStale param in state.ts for why this exists
// alongside isSessionAlive rather than being covered by it.
function isRunningStale(state: SessionState): boolean {
  if (state.status !== "running" || !state.updated_at) return false;
  const updatedAt = Date.parse(state.updated_at);
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt > RUNNING_STALE_MS;
}

// Same shape as isRunningStale, for "compacting"/COMPACTING_STALE_MS and
// "waiting_background"/CONSULTING_STALE_MS respectively. These two statuses
// already have their own fallback via each AgentLabel's private
// _armCompactingTimeout/_armConsultingTimeout GLib timer (see below), but
// that timer is in-memory and only armed on entry into the state — an
// extension or GNOME Shell reload while a label is mid-flight destroys and
// recreates it from scratch, resetting the clock to zero. These file-
// anchored checks close that gap the same way isRunningStale already does
// for "running": fed through deriveEffectiveStatus, they get re-evaluated on
// every applyStates() call, including the periodic re-scan in extension.ts,
// so a session that's genuinely been stale since before a reload is caught
// immediately on the next tick rather than only after a fresh multi-minute
// wait.
function isCompactingStale(state: SessionState): boolean {
  if (state.status !== "compacting" || !state.updated_at) return false;
  const updatedAt = Date.parse(state.updated_at);
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt > COMPACTING_STALE_MS;
}

function isConsultingStale(state: SessionState): boolean {
  if (state.status !== "waiting_background" || !state.updated_at) return false;
  const updatedAt = Date.parse(state.updated_at);
  if (Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt > CONSULTING_STALE_MS;
}

// state.status is singular, so at most one of the three checks above can
// ever be true for a given state — this just dispatches to whichever one
// applies before feeding deriveEffectiveStatus's single isStale param.
function isStale(state: SessionState): boolean {
  return (
    isRunningStale(state) ||
    isCompactingStale(state) ||
    isConsultingStale(state)
  );
}

// Whether the "Dev: preview state" menu section should be built — read from
// a `.env` file shipped next to detailed-usage.py/ascii.txt/etc. in the
// extension's own directory (copy-assets.mjs copies the repo root's .env
// there, when one exists) rather than a process env var: GNOME Shell runs as
// a long-lived session process that inherits its environment from the
// display manager / login session, not from whatever terminal you happen to
// run `npm run build` in, so a real env var set there would never actually
// reach it. A repo-root `.env` (gitignored, same as any other local-only
// config) sidesteps that entirely. Read synchronously since this only ever
// runs once, at ClaudeWatchIndicator construction — GNOME Shell's own
// enable() is already synchronous by the time this constructor runs, so
// there's no async flow here to fit into.
function readDevModeFlag(extensionPath: string): boolean {
  const path = GLib.build_filenamev([extensionPath, ".env"]);
  let contents: string;
  try {
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    contents = new TextDecoder().decode(bytes);
  } catch {
    return false; // No .env shipped with this build — the common case.
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === "CLAUDEWATCH_DEV") {
      return trimmed.slice(eq + 1).trim() === "1";
    }
  }
  return false;
}

// Picks a name for a newly-seen session, avoiding names already in use by
// other concurrently-live sessions where possible. Falls back to a numbered
// suffix on the fixed list's first name once every name is already taken
// (an 11th+ concurrent session) rather than silently duplicating a name.
function pickAgentName(namesInUse: ReadonlySet<string>): string {
  const available = AGENT_NAMES.filter((name) => !namesInUse.has(name));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)]; //NOSONAR - cosmetic name pick, not security-sensitive
  }
  let suffix = 2;
  let candidate = `${AGENT_NAMES[0]} ${suffix}`;
  while (namesInUse.has(candidate)) {
    suffix += 1;
    candidate = `${AGENT_NAMES[0]} ${suffix}`;
  }
  return candidate;
}

// One live Claude Code session's panel label and notification/pulse state
// machine. Created when a session first reports a
// running/waiting_approval/compacting status, destroyed when it retires
// (task done and the post-completion flash has elapsed, or the session goes
// away/dies without ever finishing cleanly). Owns exactly the per-session
// slice of what the single-session ClaudeWatchIndicator used to own itself.
class AgentLabel {
  readonly sessionId: string;
  readonly actor: InstanceType<typeof St.Label>;
  readonly agentName: string;

  private readonly _notify: (text: string, soundName: string) => void;
  private readonly _onRetired: () => void;

  private _uiState: UiState = "running";
  private _lastStatus: string | null = null;
  private _state: SessionState = {};
  private _pulseDim = false;
  private _flashTimeoutId: number | null = null;
  private _compactingTimeoutId: number | null = null;
  private _consultingTimeoutId: number | null = null;
  private _pulseTimeoutId: number | null = null;
  private _transcriptMonitor: InstanceType<typeof Gio.FileMonitor> | null =
    null;
  private _transcriptMonitorId: number | null = null;
  private _transcriptWatchFile: InstanceType<typeof Gio.File> | null = null;
  private _transcriptWatchStartLength = 0;

  constructor(
    sessionId: string,
    agentName: string,
    notify: (text: string, soundName: string) => void,
    onRetired: () => void,
  ) {
    this.sessionId = sessionId;
    this.agentName = agentName;
    this._notify = notify;
    this._onRetired = onRetired;
    // Placeholder only — applyState() runs synchronously right after
    // construction (see ClaudeWatchIndicator._createAgent()) and always
    // overwrites this before it's ever painted.
    this.actor = new St.Label({
      y_align: Clutter.ActorAlign.CENTER,
      style: RUNNING_STYLE,
      text: "",
    });
  }

  get state(): SessionState {
    return this._state;
  }

  get uiState(): UiState {
    return this._uiState;
  }

  // Called with this session's freshly-parsed state-file contents every
  // time the sessions directory changes. Edge-triggered on status
  // transitions via resolveUiAction(), same rules as the single-session
  // version — see its comment in lib/state.ts.
  applyState(state: SessionState, isInitial: boolean): void {
    this._state = state;
    const status = deriveEffectiveStatus(
      state.status,
      isSessionAlive(state),
      isStale(state),
    );
    const action = resolveUiAction(status, this._lastStatus, isInitial);
    this._lastStatus = status ?? null;
    if (action === "running") this._enterRunning();
    else if (action === "waiting") this._enterWaiting();
    else if (action === "compacting") this._enterCompacting();
    else if (action === "consulting") this._enterConsulting();
    else if (action === "complete") this._enterComplete();
    else if (action === "standby") {
      // Not a fresh "done" — the session went away without a clean finish
      // (process killed, crashed). No green flash for that, straight to
      // retirement, same as the single-session version snapping to standby.
      this._retire();
      return;
    }
    // Arm only on the transition into "compacting", not on every repeat
    // tick — the directory monitor re-dispatches this session's state on
    // *any* session's file changing, so arming unconditionally on raw
    // status would keep resetting the fallback clock off the back of
    // unrelated sessions' activity and it would never elapse.
    if (action === "compacting") {
      this._armCompactingTimeout();
      this._watchTranscriptForCompactOutcome();
    } else if (status !== "compacting") {
      this._clearCompactingTimeout();
      this._stopWatchingTranscript();
    }
    // Same arm-on-entry-only rule as compacting above, and for the same
    // reason: re-arming on every repeat tick (fired by any session's file
    // changing, not just this one's) would keep pushing the fallback clock
    // out and it would never elapse.
    if (action === "consulting") this._armConsultingTimeout();
    else if (status !== "waiting_background") this._clearConsultingTimeout();
  }

  // The session's file disappeared from the directory entirely (SessionEnd
  // cleanup, or a manual/external delete) rather than reporting a new
  // status. A no-op while already mid-complete-flash — that timer already
  // owns retirement, and a vanished file doesn't need to race it.
  handleMissing(): void {
    if (this._uiState === "complete") return;
    this._retire();
  }

  private _enterRunning(): void {
    this._uiState = "running";
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.style = RUNNING_STYLE;
    this.actor.set_text(runningText(this.agentName));
    this.actor.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  private _enterWaiting(): void {
    this._uiState = "waiting";
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.remove_all_transitions();
    this.actor.style = WAITING_STYLE;
    const text = waitingText(this.agentName);
    this.actor.set_text(text);
    this.actor.opacity = 255;
    this._notify(text, "dialog-question");
  }

  private _enterCompacting(): void {
    this._uiState = "compacting";
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.style = COMPACTING_STYLE;
    this.actor.set_text(COMPACTING_TEXT);
    this.actor.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  // A Stop landed while a subagent this session spawned hasn't reported back
  // via SubagentStop yet (waiting_background — see hooks/lib/status.ts).
  // Pulses like running/compacting since this is genuine ongoing work, just
  // not visible in the transcript the same way; unlike "waiting" it isn't a
  // request for the user, so no notification fires.
  private _enterConsulting(): void {
    this._uiState = "consulting";
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.style = CONSULTING_STYLE;
    this.actor.set_text(consultingText(this.agentName));
    this.actor.opacity = 255;
    this._pulseDim = false;
    this._pulseLoop();
  }

  // Just-finished state: flashes the label green for COMPLETE_FLASH_MS,
  // then retires (removes) the label entirely — unlike the single-session
  // version there's no shared standby state to fall back to; "Agents are recovering ☕"
  // only appears once every session has retired.
  private _enterComplete(): void {
    this._uiState = "complete";
    this.actor.remove_all_transitions();
    this._clearFlashTimeout();
    this._clearPulseTimeout();
    this.actor.opacity = 255;
    this.actor.style = COMPLETE_STYLE;
    const text = completeText(this.agentName);
    this.actor.set_text(text);
    this._notify(text, "complete");
    this._flashTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      COMPLETE_FLASH_MS,
      () => {
        this._flashTimeoutId = null;
        this._retire();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _retire(): void {
    this._onRetired();
  }

  private _clearFlashTimeout(): void {
    if (this._flashTimeoutId) {
      GLib.source_remove(this._flashTimeoutId);
      this._flashTimeoutId = null;
    }
  }

  private _armCompactingTimeout(): void {
    this._clearCompactingTimeout();
    this._compactingTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      COMPACTING_STALE_MS,
      () => {
        this._compactingTimeoutId = null;
        if (this._uiState === "compacting") this._retire();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _armConsultingTimeout(): void {
    this._clearConsultingTimeout();
    this._consultingTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      CONSULTING_STALE_MS,
      () => {
        this._consultingTimeoutId = null;
        if (this._uiState === "consulting") this._retire();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _clearConsultingTimeout(): void {
    if (this._consultingTimeoutId) {
      GLib.source_remove(this._consultingTimeoutId);
      this._consultingTimeoutId = null;
    }
  }

  private _clearCompactingTimeout(): void {
    if (this._compactingTimeoutId) {
      GLib.source_remove(this._compactingTimeoutId);
      this._compactingTimeoutId = null;
    }
  }

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
          this._retire();
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

  private _clearPulseTimeout(): void {
    if (this._pulseTimeoutId) {
      GLib.source_remove(this._pulseTimeoutId);
      this._pulseTimeoutId = null;
    }
  }

  // Only "running" and "compacting" pulse — "waiting" reads clearly enough
  // from its color/text alone and stays static, same as "complete". Driven
  // by GLib.timeout_add rather than ease()'s onComplete: an actor that
  // isn't mapped (hidden past MAX_INLINE_AGENTS, or mid-teardown) makes
  // Clutter resolve ease() synchronously, and onComplete recursing straight
  // back into _pulseLoop() from inside that same synchronous call blows the
  // stack ("too much recursion") instead of ticking over real time. A
  // GLib timeout always defers to the main loop regardless of the actor's
  // mapped state, so this can't recurse no matter what.
  private _pulseLoop(): void {
    if (
      this._uiState !== "running" &&
      this._uiState !== "compacting" &&
      this._uiState !== "consulting"
    )
      return;
    this._pulseDim = !this._pulseDim;
    (this.actor as unknown as Easeable).ease({
      opacity: this._pulseDim ? PULSE_DIM_OPACITY : 255,
      duration: PULSE_HALF_CYCLE_MS,
      mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
    });
    this._pulseTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      PULSE_HALF_CYCLE_MS,
      () => {
        this._pulseTimeoutId = null;
        this._pulseLoop();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  destroy(): void {
    this._clearFlashTimeout();
    this._clearCompactingTimeout();
    this._clearConsultingTimeout();
    this._clearPulseTimeout();
    this._stopWatchingTranscript();
    this.actor.remove_all_transitions();
    this.actor.destroy();
  }
}

// Owns the panel indicator (`this.button`, a plain `PanelMenu.Button` — not
// subclassed, since GJS's GObject-subclassing ceremony buys nothing here
// over composition), the row of per-session AgentLabels inside it, and the
// popup menu: the "Claude Usage" section (a single button that opens the
// opt-in, terminal-based rate-limit check). extension.js only owns
// directory-watching wiring and hands this class parsed per-session state
// via applyStates().
export class ClaudeWatchIndicator {
  button: InstanceType<typeof PanelMenu.Button>;

  private readonly _uuid: string;
  private readonly _box: InstanceType<typeof St.BoxLayout>;
  private readonly _standbyLabel: InstanceType<typeof St.Label>;
  private readonly _overflowLabel: InstanceType<typeof St.Label>;
  // `PanelMenu.Button.menu` is typed as `PopupMenu | PopupDummyMenu` since
  // the ambient types don't narrow on the dontCreateMenu constructor arg;
  // it's always a real PopupMenu here since we pass `false` below.
  private readonly _menu: PopupMenu.PopupMenu;

  private readonly _notificationsItem: InstanceType<
    typeof PopupMenu.PopupSwitchMenuItem
  >;
  private readonly _showUsageItem: InstanceType<typeof PopupMenu.PopupMenuItem>;
  private readonly _raiseIssueItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _viewSourceItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _discussionsItem: InstanceType<
    typeof PopupMenu.PopupMenuItem
  >;
  private readonly _exitItem: InstanceType<typeof PopupMenu.PopupMenuItem>;

  private readonly _extensionPath: string;
  private readonly _onSessionRetired: (sessionId: string) => void;
  private _notificationsEnabled = true;
  private readonly _agents = new Map<string, AgentLabel>();
  // Insertion order, oldest first — determines which sessions show inline
  // vs. fold into the overflow chip once there are more than
  // MAX_INLINE_AGENTS live at once.
  private readonly _order: string[] = [];

  // Dev-only visual QA aid, populated by the CLAUDEWATCH_DEV preview menu
  // built in the constructor below. Deliberately kept out of `_agents`/
  // `_order`: those two drive every read of real on-disk session state
  // (applyStates(), _syncBox(), handleMissing() on a vanished file), so a
  // synthetic preview "session" living in there could get silently retired
  // the moment any real session's file change triggers the next disk scan.
  private _previewLabel: AgentLabel | null = null;
  private _previewActor: InstanceType<typeof St.Label> | null = null;
  // Extra inline AgentLabels for the "overflow" preview only — it shows two
  // full running labels ahead of the "+N more" chip (held in _previewActor
  // above) so the chip's neighboring context is visible too, not just the
  // chip in isolation.
  private readonly _previewOverflowLabels: AgentLabel[] = [];

  constructor(
    uuid: string,
    name: string,
    extensionPath: string,
    onSessionRetired: (sessionId: string) => void,
  ) {
    this._uuid = uuid;
    this._extensionPath = extensionPath;
    this._onSessionRetired = onSessionRetired;

    this.button = new PanelMenu.Button(0.0, name, false);
    this._menu = this.button.menu as PopupMenu.PopupMenu;

    this._box = new St.BoxLayout({ style: "spacing: 4px;" });
    this.button.add_child(this._box);

    this._standbyLabel = new St.Label({
      text: STANDBY_TEXT,
      y_align: Clutter.ActorAlign.CENTER,
      style: STANDBY_STYLE,
    });
    this._box.add_child(this._standbyLabel);

    this._overflowLabel = new St.Label({
      y_align: Clutter.ActorAlign.CENTER,
      style: OVERFLOW_STYLE,
      visible: false,
    });
    this._box.add_child(this._overflowLabel);

    // Fixed width so the menu doesn't reflow as row text changes length
    // (e.g. a long "failed to launch terminal" error string).
    this._menu.box.style = "width: 300px; min-width: 300px; max-width: 300px;";

    this._menu.addMenuItem(
      new PopupMenu.PopupSeparatorMenuItem("Claude Usage"),
    );

    this._showUsageItem = new PopupMenu.PopupMenuItem("Show usage");
    // Default activate() chains to super.activate(), which PopupMenu treats
    // as a close-triggering click; override so clicking never closes the
    // menu.
    this._showUsageItem.activate = () => this._onShowUsageClicked();
    this._showUsageItem.label.clutter_text.set({
      line_wrap: true,
      line_wrap_mode: Pango.WrapMode.WORD_CHAR,
    });
    this._menu.addMenuItem(this._showUsageItem);

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem("Settings"));

    this._notificationsItem = new PopupMenu.PopupSwitchMenuItem(
      "Notifications",
      true,
    );
    this._notificationsItem.connect("toggled", (_item, state: boolean) => {
      this._notificationsEnabled = state;
    });
    this._notificationsItem.activate = () => this._notificationsItem.toggle();
    this._menu.addMenuItem(this._notificationsItem);

    this._menu.addMenuItem(
      new PopupMenu.PopupSeparatorMenuItem("Help & Feedback"),
    );

    this._raiseIssueItem = new PopupMenu.PopupMenuItem("Raise an issue");
    this._raiseIssueItem.connect("activate", () =>
      Gio.AppInfo.launch_default_for_uri(
        "https://github.com/yevhen-chernenko/claudewatch/issues",
        null,
      ),
    );
    this._menu.addMenuItem(this._raiseIssueItem);

    this._discussionsItem = new PopupMenu.PopupMenuItem("Discussions");
    this._discussionsItem.connect("activate", () =>
      Gio.AppInfo.launch_default_for_uri(
        "https://github.com/yevhen-chernenko/claudewatch/discussions",
        null,
      ),
    );
    this._menu.addMenuItem(this._discussionsItem);

    this._viewSourceItem = new PopupMenu.PopupMenuItem("View source on GitHub");
    this._viewSourceItem.connect("activate", () =>
      Gio.AppInfo.launch_default_for_uri(
        "https://github.com/yevhen-chernenko/claudewatch",
        null,
      ),
    );
    this._menu.addMenuItem(this._viewSourceItem);

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._exitItem = new PopupMenu.PopupMenuItem("Exit ClaudeWatch");
    this._exitItem.connect("activate", () => this._onExit());
    this._menu.addMenuItem(this._exitItem);

    // Visual QA only — lets every panel look (including ones that normally
    // need a real live session, like "complete"'s green flash) be pulled up
    // on demand for screenshots, without a real hook event or session file.
    // Gated on readDevModeFlag() rather than shipped unconditionally so it
    // can never appear for a real user: nothing here reads real session
    // state, and _setPreviewState()/_clearPreview() only ever touch the
    // dev-only _previewLabel/_previewActor fields, never `_agents`/`_order`.
    if (readDevModeFlag(extensionPath)) {
      this._menu.addMenuItem(
        new PopupMenu.PopupSeparatorMenuItem("Dev: preview state"),
      );
      const previewItems: { label: string; kind: PreviewKind }[] = [
        { label: "Standby / clear preview", kind: "standby" },
        { label: "Running", kind: "running" },
        { label: "Waiting", kind: "waiting" },
        { label: "Compacting", kind: "compacting" },
        { label: "Consulting", kind: "consulting" },
        { label: "Complete", kind: "complete" },
        { label: "Multi-agent & overflow", kind: "overflow" },
      ];
      for (const { label, kind } of previewItems) {
        const item = new PopupMenu.PopupMenuItem(label);
        // Default activate() (unlike _showUsageItem's/_notificationsItem's
        // overridden one above) closes the menu same as Exit/View source —
        // wanted here so the panel is unobstructed right after picking a
        // state, ready to screenshot.
        item.connect("activate", () => this._setPreviewState(kind));
        this._menu.addMenuItem(item);
      }
    }
  }

  // Called by extension.js with every session's freshly-parsed state-file
  // contents every time the sessions directory changes — one entry per
  // sessions/<session_id>.json file currently on disk, keyed by session id.
  applyStates(states: ReadonlyMap<string, SessionState>): void {
    for (const [sessionId, label] of this._agents) {
      if (!states.has(sessionId)) label.handleMissing();
    }

    for (const [sessionId, state] of states) {
      const existing = this._agents.get(sessionId);
      if (existing) {
        existing.applyState(state, false);
        continue;
      }
      const status = deriveEffectiveStatus(
        state.status,
        isSessionAlive(state),
        isStale(state),
      );
      if (
        status !== "running" &&
        status !== "waiting_approval" &&
        status !== "compacting" &&
        status !== "waiting_background"
      ) {
        continue; // Not a session worth showing a fresh label for.
      }
      this._createAgent(sessionId, state);
    }

    this._syncBox();
  }

  private _createAgent(sessionId: string, state: SessionState): void {
    const namesInUse = new Set(
      Array.from(this._agents.values(), (agent) => agent.agentName),
    );
    const agentName = pickAgentName(namesInUse);
    const label = new AgentLabel(
      sessionId,
      agentName,
      (text, sound) => this._notify(text, sound),
      () => this._retireAgent(sessionId),
    );
    this._agents.set(sessionId, label);
    this._order.push(sessionId);
    // Parent the actor into the box before running applyState() below so
    // the very first ease() (from _enterRunning()/_enterCompacting() inside
    // it) has somewhere on-stage to animate rather than resolving instantly.
    this._syncBox();
    label.applyState(state, true);
  }

  private _retireAgent(sessionId: string): void {
    const label = this._agents.get(sessionId);
    if (!label) return;
    label.destroy();
    this._agents.delete(sessionId);
    const orderIndex = this._order.indexOf(sessionId);
    if (orderIndex !== -1) this._order.splice(orderIndex, 1);
    this._syncBox();
    this._onSessionRetired(sessionId);
  }

  // Shows every live session's label up to MAX_INLINE_AGENTS, folding the
  // rest into a single "+N more" chip, or the standby "Agents are recovering ☕" label
  // when nothing is live.
  private _syncBox(): void {
    const count = this._order.length;
    // Skip while a dev preview is on screen — real disk-driven refreshes
    // (the periodic timer, the sessions-dir file monitor) call this on their
    // own schedule regardless of preview state, and would otherwise flip
    // standby back on under a preview since real count is normally 0 during
    // dev-menu testing. _setPreviewState()/_clearPreview() own standby
    // visibility for the duration of a preview instead.
    if (!this._previewLabel && !this._previewActor) {
      this._standbyLabel.visible = count === 0;
    }
    for (const [index, sessionId] of this._order.entries()) {
      const label = this._agents.get(sessionId);
      if (!label) continue;
      if (!label.actor.get_parent()) {
        this._box.add_child(label.actor);
        this._box.set_child_below_sibling(label.actor, this._overflowLabel);
      }
      label.actor.visible = index < MAX_INLINE_AGENTS;
    }
    const overflowCount = count - MAX_INLINE_AGENTS;
    this._overflowLabel.visible = overflowCount > 0;
    if (overflowCount > 0) {
      this._overflowLabel.set_text(`+${overflowCount} more`);
    }
  }

  // Drives the dev-only preview menu built in the constructor. Reuses
  // AgentLabel itself (rather than reimplementing its styles/text/pulsing)
  // so a preview can never drift from what a real session actually looks
  // like — it's fed a synthetic SessionState instead of one read off disk,
  // going through the exact same applyState() a real disk-driven refresh
  // uses, but the resulting label is never added to `_agents`/`_order`, so
  // the real applyStates()/handleMissing() path can never see or retire it.
  private _setPreviewState(kind: PreviewKind): void {
    this._clearPreview();
    if (kind === "standby") return;
    // Previewing any non-standby state should show only that preview, not
    // the standby label alongside it — _clearPreview() above just restored
    // standby visibility based on real session count, which is normally 0
    // during dev-menu clicking, so it needs hiding again here.
    this._standbyLabel.visible = false;
    if (kind === "overflow") {
      for (const name of ["Smith", "Anderson"]) {
        const label = new AgentLabel(
          `__preview_overflow_${name}__`,
          name,
          () => {},
          () => this._clearPreview(),
        );
        this._box.add_child(label.actor);
        this._box.set_child_below_sibling(label.actor, this._overflowLabel);
        label.applyState({ status: "running" }, true);
        this._previewOverflowLabels.push(label);
      }
      this._previewActor = new St.Label({
        text: "+2 more",
        y_align: Clutter.ActorAlign.CENTER,
        style: OVERFLOW_STYLE,
      });
      this._box.add_child(this._previewActor);
      this._box.set_child_below_sibling(
        this._previewActor,
        this._overflowLabel,
      );
      return;
    }
    this._previewLabel = new AgentLabel(
      "__preview__",
      "Smith",
      () => {}, // No desktop notification/sound spam while clicking through states.
      () => this._clearPreview(),
    );
    this._box.add_child(this._previewLabel.actor);
    this._box.set_child_below_sibling(
      this._previewLabel.actor,
      this._overflowLabel,
    );
    if (kind === "complete") {
      // resolveUiAction() only fires the green flash on a status -> "done"
      // *edge*, not on a first-ever refresh (see its isInitialRefresh branch
      // in state.ts) — so previewing the real flash+auto-retire needs a
      // running start state first, then a second call that actually crosses
      // the edge, same as a real session finishing a turn.
      this._previewLabel.applyState({ status: "running" }, true);
      this._previewLabel.applyState({ status: "done" }, false);
      return;
    }
    const statusForKind: Record<
      Exclude<PreviewKind, "standby" | "overflow" | "complete">,
      string
    > = {
      running: "running",
      waiting: "waiting_approval",
      compacting: "compacting",
      consulting: "waiting_background",
    };
    const state: SessionState = { status: statusForKind[kind] };
    this._previewLabel.applyState(state, true);
  }

  private _clearPreview(): void {
    if (this._previewLabel) {
      this._previewLabel.destroy();
      this._previewLabel = null;
    }
    if (this._previewActor) {
      this._previewActor.destroy();
      this._previewActor = null;
    }
    for (const label of this._previewOverflowLabels) label.destroy();
    this._previewOverflowLabels.length = 0;
    // Restore standby to whatever real session count says it should be —
    // covers both an explicit "Standby / clear preview" click and the
    // "complete" preview auto-retiring itself via _onRetired() after its
    // flash, neither of which should leave the standby label hidden.
    this._standbyLabel.visible = this._order.length === 0;
  }

  // Desktop notification paired with a themed system sound — every waiting/
  // complete transition fires both together. Uses the shell's own sound
  // player (same mechanism as the screenshot/volume sounds) rather than
  // spawning a subprocess, and resolves soundName against the user's
  // current sound theme rather than shipping an audio file. No-op unless
  // the "Notifications" toggle is on (default on).
  private _notify(text: string, soundName: string): void {
    if (!this._notificationsEnabled) return;
    Main.notify("ClaudeWatch", text);
    global.display.get_sound_player().play_from_theme(soundName, text, null);
  }

  // Opens a terminal running detailed-usage.py — the opt-in rate-limit check
  // (see SECURITY.md#opt-in-network-egress-the-rate-limit-check), read from a
  // terminal since this is the only usage source in the menu. There's no
  // OS-level "default terminal" standard on Linux, so pickTerminalCommand()
  // (lib/terminal.ts) is necessarily best-effort: $TERMINAL first, then a
  // fixed list of common terminal emulators. Gio.Subprocess.new() can
  // genuinely throw (e.g. exec failure), so the try/catch here is a real
  // failure path, not defensive padding.
  private _onShowUsageClicked(): void {
    const scriptPath = GLib.build_filenamev([
      this._extensionPath,
      "detailed-usage.py",
    ]);
    const argv = pickTerminalCommand(
      scriptPath,
      GLib.getenv("TERMINAL"),
      (name) => GLib.find_program_in_path(name),
    );
    if (!argv) {
      this._showUsageItem.label.set_text(
        "Show usage — no terminal emulator found on PATH",
      );
      return;
    }
    try {
      Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    } catch (e) {
      this._showUsageItem.label.set_text(
        `Show usage — failed to launch terminal: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private _onExit(): void {
    const settings = new Gio.Settings({ schema_id: "org.gnome.shell" });
    const enabled = settings.get_strv("enabled-extensions");
    const index = enabled.indexOf(this._uuid);
    if (index === -1) return;
    enabled.splice(index, 1);
    settings.set_strv("enabled-extensions", enabled);
  }

  // Scoped to what this class owns: each AgentLabel's pending GLib timeout
  // is the thing that actually leaks across enable/disable cycles if left
  // connected — destroying `button` (a widget) takes its child actors and
  // menu items with it.
  destroy(): void {
    this._clearPreview();
    for (const label of this._agents.values()) label.destroy();
    this._agents.clear();
    this._order.length = 0;
    // Nothing reads `button` after this call — extension.js drops its own
    // reference to this indicator in the same disable() that calls
    // destroy() — so there's no need to null it out here.
    this.button.destroy();
  }
}
