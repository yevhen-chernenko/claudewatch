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
}

export type UiAction =
  | "running"
  | "waiting"
  | "complete"
  | "standby"
  | "compacting"
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
// isRunningStale covers a gap pid-liveness can't: Claude Code fires no hook
// at all when a turn ends by interruption rather than a clean Stop — e.g.
// the user rejects/aborts a tool call and sends something else instead, so
// there's no PostToolUse, no Stop, no SessionEnd, and the CLI process just
// goes back to idling. The session is genuinely alive throughout, so the
// pid check alone can never tell that apart from a task still in flight,
// and "running" would otherwise stick forever. Same shape of problem
// indicator.ts's COMPACTING_STALE_MS bounds for an abandoned /compact;
// isRunningStale is that same idea computed by the caller from
// updated_at/now (see RUNNING_STALE_MS's own comment for why it's on a much
// longer leash) and passed in as a plain boolean for the same testability
// reason as isSessionAlive. Defaulted so existing 2-arg call sites are
// unaffected.
export function deriveEffectiveStatus(
  status: string | undefined,
  isSessionAlive: boolean,
  isRunningStale: boolean = false,
): string | undefined {
  if (status === "running" && isRunningStale) return undefined;
  if (isSessionAlive) return status;
  if (
    status === "running" ||
    status === "waiting_approval" ||
    status === "compacting"
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
