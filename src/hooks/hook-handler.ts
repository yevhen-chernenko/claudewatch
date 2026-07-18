#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const stateDir = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "claudewatch",
);
const statePath = path.join(stateDir, "state.json");

type SessionStatus = "running" | "waiting_approval" | "done" | "compacting";

const STATUS_BY_EVENT: Record<string, SessionStatus> = {
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  Notification: "waiting_approval",
  PermissionRequest: "waiting_approval",
  Stop: "done",
};

interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  transcript_path?: string;
  // Only present on PreCompact; "manual" for /compact, "auto" when the
  // context window fills up on its own. Only the former gets its own status
  // — an auto-compact is an implementation detail of an already-running
  // session, not something worth surfacing in the panel.
  trigger?: string;
}

const input = JSON.parse(fs.readFileSync(0, "utf-8")) as HookInput;
let status: SessionStatus | undefined;
if (input.hook_event_name === "PreCompact") {
  if (input.trigger === "manual") status = "compacting";
} else if (input.hook_event_name) {
  status = STATUS_BY_EVENT[input.hook_event_name];
}

if (status) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({
      status,
      updated_at: new Date().toISOString(),
      cwd: input.cwd,
      transcript_path: input.transcript_path,
      // Hooks run in exec form (command+args, no shell), so this is the
      // Claude Code CLI process itself — lets the extension tell a
      // genuinely running session apart from a stale "running" left behind
      // by one that ended without ever firing Stop (killed terminal, crash).
      pid: process.ppid,
    }),
  );
  fs.renameSync(tmpPath, statePath);
}
