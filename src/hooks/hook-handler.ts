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

type SessionStatus = "running" | "waiting_approval" | "done";

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
}

const input = JSON.parse(fs.readFileSync(0, "utf-8")) as HookInput;
const status = input.hook_event_name ? STATUS_BY_EVENT[input.hook_event_name] : undefined;

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
    }),
  );
  fs.renameSync(tmpPath, statePath);
}
