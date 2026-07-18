// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";

export const STATE_PATH = GLib.build_filenamev([
  GLib.get_user_state_dir(),
  "claudewatch",
  "state.json",
]);

// Parsed contents of state.json, as written by hooks/hook-handler.js. All
// fields are optional: extension.js falls back to `{}` when the file is
// missing or mid-write (see its _refresh()).
export interface SessionState {
  status?: string;
  updated_at?: string;
  cwd?: string;
  transcript_path?: string;
  pid?: number;
}

export type UiAction = "running" | "waiting" | "complete" | "standby" | null;

// A "running"/"waiting_approval" status only means something while the
// session that wrote it is still alive — otherwise it's leftover from one
// that ended without ever reaching "done" (killed terminal, crash, machine
// sleep) and shouldn't be trusted. "done" doesn't need this: resolveUiAction
// already treats any non-running/waiting status as standby on the initial
// refresh. Takes the liveness check as a plain boolean (rather than doing
// the /proc lookup itself) so this stays pure and testable like
// resolveUiAction below.
export function deriveEffectiveStatus(
  status: string | undefined,
  isSessionAlive: boolean,
): string | undefined {
  if (isSessionAlive) return status;
  if (status === "running" || status === "waiting_approval") return undefined;
  return status;
}

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
  if (isInitialRefresh) {
    if (status === "running") return "running";
    if (status === "waiting_approval") return "waiting";
    return "standby";
  }
  if (status === "running" && previousStatus !== "running") return "running";
  if (status === "waiting_approval" && previousStatus !== "waiting_approval")
    return "waiting";
  if (status === "done" && previousStatus !== "done") return "complete";
  if (
    status !== "running" &&
    status !== "waiting_approval" &&
    status !== "done"
  )
    return "standby";
  return null;
}
