// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";

export const SESSIONS_DIR = GLib.build_filenamev([
  GLib.get_user_state_dir(),
  "claudewatch",
  "sessions",
]);

// Parsed contents of one sessions/<session_id>.json file, as written by
// hooks/hook-handler.js. All fields are optional: extension.js falls back to
// `{}` for any file that's missing, mid-write, or fails to parse (see its
// _loadSessions()).
export interface SessionState {
  session_id?: string;
  status?: string;
  updated_at?: string;
  transcript_path?: string;
  pid?: number;
  // Last-started subagent's agent_type (e.g. "Explore", "general-purpose"),
  // only meaningful while status is "waiting_background" — see indicator.ts's
  // "consulting" label. pendingBackgroundCount itself isn't listed here: it's
  // hook-side bookkeeping only (see updateBackgroundTracking in
  // hooks/lib/status.ts), nothing in the extension reads it directly.
  backgroundAgentType?: string;
}

export type UiAction =
  | "running"
  | "waiting"
  | "complete"
  | "standby"
  | "compacting"
  | "consulting"
  | null;

// A "running"/"waiting_approval"/"compacting" status only means something
// while the session that wrote it is still alive — otherwise it's leftover
// from one that ended without ever reaching "done" (killed terminal, crash,
// machine sleep) and shouldn't be trusted. "done" doesn't need this:
// resolveUiAction already treats any non-running/waiting/compacting status as
// standby on the initial refresh. Takes the liveness check as a plain
// boolean (rather than doing the /proc lookup itself) so this stays pure and
// testable like resolveUiAction below.
//
// isStale covers a gap pid-liveness can't: Claude Code fires no hook at all
// when a turn ends by interruption rather than a clean Stop — e.g. the user
// rejects/aborts a tool call and sends something else instead, so there's no
// PostToolUse, no Stop, no SessionEnd, and the CLI process just goes back to
// idling. The session is genuinely alive throughout, so the pid check alone
// can never tell that apart from a task still in flight. The same gap
// applies to an abandoned /compact or a subagent whose SubagentStop never
// fires (process killed outright). isStale is that same idea computed by
// the caller from each status's own updated_at/now threshold (RUNNING_STALE_MS,
// COMPACTING_STALE_MS, CONSULTING_STALE_MS in indicator.ts) and passed in as
// a plain boolean for the same testability reason as isSessionAlive —
// file-anchored rather than an in-memory timer, so it survives an extension/
// shell reload mid-status instead of the clock resetting to zero. Defaulted
// so existing 2-arg call sites are unaffected.
export function deriveEffectiveStatus(
  status: string | undefined,
  isSessionAlive: boolean,
  isStale: boolean = false,
): string | undefined {
  if (
    isStale &&
    (status === "running" ||
      status === "compacting" ||
      status === "waiting_background")
  )
    return undefined;
  if (isSessionAlive) return status;
  if (
    status === "running" ||
    status === "waiting_approval" ||
    status === "compacting" ||
    status === "waiting_background"
  )
    return undefined;
  return status;
}

// The UI action a "live" status (one only meaningful while the session is
// actively in that phase) maps to. "done" is deliberately excluded — it's
// handled as its own edge below since it maps to "complete" rather than a
// same-named action.
const ACTIVE_STATUS_ACTION: Record<
  string,
  Exclude<UiAction, "complete" | "standby" | null>
> = {
  running: "running",
  waiting_approval: "waiting",
  compacting: "compacting",
  // A Stop that landed while a subagent it spawned hasn't reported back yet
  // (see resolveStatus's Stop branch in hooks/lib/status.ts) — the turn
  // looks finished but de-facto isn't, so this reads as its own active
  // state rather than either "running" or "done".
  waiting_background: "consulting",
};

// Pure edge-detection: decides which _enter* transition (if any) a refresh
// should perform, given the freshly-read status, the previously-seen status,
// and whether this is the very first refresh after enable(). Kept separate
// from the indicator so the state-machine logic can be read (and reasoned
// about, and unit tested) without the async file-read wrapped around it.
//
// The first refresh after enable() is not an edge: state.json can still
// hold a leftover status from before the shell reload (most commonly
// "done", its natural resting state), and treating that as a fresh
// transition would replay the complete flash or waiting pulse on startup
// instead of just syncing straight to the current state.
export function resolveUiAction(
  status: string | undefined,
  previousStatus: string | null | undefined,
  isInitialRefresh: boolean,
): UiAction {
  const activeAction = status ? ACTIVE_STATUS_ACTION[status] : undefined;
  if (isInitialRefresh) return activeAction ?? "standby";
  if (activeAction && status !== previousStatus) return activeAction;
  if (status === "done" && previousStatus !== "done") return "complete";
  if (!activeAction && status !== "done") return "standby";
  return null;
}
