#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveStatus } from "./lib/status";

const stateDir = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "claudewatch",
);
const sessionsDir = path.join(stateDir, "sessions");

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  // Only present on PreCompact; "manual" for /compact, "auto" when the
  // context window fills up on its own. Only the former gets its own status
  // — an auto-compact is an implementation detail of an already-running
  // session, not something worth surfacing in the panel.
  trigger?: string;
  // Only present on Notification; distinguishes an actual pending-input
  // reason (e.g. "permission_prompt") from unrelated ones the same event
  // also fires for (e.g. "idle_prompt", a no-op nudge — see resolveStatus).
  notification_type?: string;
}

// session_id is a UUID in practice, but sanitize defensively before it
// becomes part of a filesystem path — never trust hook input as a path
// component as-is.
function sessionFilePath(sessionId: string): string {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
  return path.join(sessionsDir, `${safeId}.json`);
}

const input = JSON.parse(fs.readFileSync(0, "utf-8")) as HookInput;
const sessionId = input.session_id;
if (!sessionId) process.exit(0);

if (input.hook_event_name === "SessionEnd") {
  fs.rmSync(sessionFilePath(sessionId), { force: true });
  process.exit(0);
}

const status = resolveStatus(
  input.hook_event_name,
  input.trigger,
  input.notification_type,
);

if (status) {
  // 0700/0600: state files can carry transcript_path, so other local
  // accounts on a shared machine shouldn't be able to read them — see
  // SECURITY.md's threat model.
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const statePath = sessionFilePath(sessionId);
  const tmpPath = `${statePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({
      session_id: sessionId,
      status,
      updated_at: new Date().toISOString(),
      transcript_path: input.transcript_path,
      // Hooks run in exec form (command+args, no shell), so this is the
      // Claude Code CLI process itself — lets the extension tell a
      // genuinely running session apart from a stale "running" left behind
      // by one that ended without ever firing Stop (killed terminal, crash).
      pid: process.ppid,
    }),
    { mode: 0o600 },
  );
  fs.renameSync(tmpPath, statePath);
}
