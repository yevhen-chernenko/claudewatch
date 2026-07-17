// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";

export const STATE_PATH = GLib.build_filenamev([
  GLib.get_user_state_dir(),
  "codewatch",
  "state.json",
]);

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
export function resolveUiAction(status, previousStatus, isInitialRefresh) {
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
