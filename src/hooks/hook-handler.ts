#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  resolveStatus,
  updateBackgroundTracking,
  type BackgroundTracking,
  type SessionStatus,
} from "./lib/status";

const stateDir = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "claudewatch",
);
const sessionsDir = path.join(stateDir, "sessions");

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  // Present on PreCompact and PostCompact; "manual" for /compact, "auto"
  // when the context window fills up on its own. Only a manual PreCompact
  // gets its own status — an auto-compact is an implementation detail of an
  // already-running session, not something worth surfacing in the panel.
  // A manual PostCompact is handled below (bypassing resolveStatus, same as
  // SessionEnd) to end the "compacting" state it started; auto stays a
  // no-op for the same reason auto PreCompact is.
  trigger?: string;
  // Only present on Notification; distinguishes an actual pending-input
  // reason (e.g. "permission_prompt") from unrelated ones the same event
  // also fires for (e.g. "idle_prompt", a no-op nudge — see resolveStatus).
  notification_type?: string;
  // Present on PreToolUse/PostToolUse; lets resolveStatus special-case
  // tools that block on a direct user response (see WAITING_TOOL_NAMES).
  tool_name?: string;
  // Present on PreToolUse/PostToolUse alongside tool_name — only
  // run_in_background is read here, to detect a backgrounded Bash launch
  // (see isBashBackgroundLaunch below). Untyped beyond that: shape varies
  // per tool and this handler has no use for the rest of it.
  tool_input?: { run_in_background?: boolean };
  // Present on SubagentStart/SubagentStop (and any hook firing inside a
  // subagent's own tool calls, which this handler doesn't otherwise use).
  // Feeds updateBackgroundTracking's agentType; round-tripped into the
  // state file but no longer read by the extension.
  agent_type?: string;
}

// session_id is a UUID in practice, but sanitize defensively before it
// becomes part of a filesystem path — never trust hook input as a path
// component as-is.
function sessionFilePath(sessionId: string): string {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
  return path.join(sessionsDir, `${safeId}.json`);
}

// Every hook invocation is a fresh process, so both the running
// SubagentStart/SubagentStop count and the pendingBash heuristic from
// updateBackgroundTracking have to round-trip through the session's own
// state file — this reads back whatever the previous invocation last
// wrote, plus the status it wrote (updateBackgroundTracking's pendingBash
// clearing needs that, see its own comment). Same defensive stance as the
// extension's own state parsing: a missing, mid-write, or malformed file
// just means "nothing pending yet", not a crash.
function readPriorState(statePath: string): {
  tracking: BackgroundTracking;
  previousStatus?: SessionStatus;
} {
  try {
    const prior = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
      status?: SessionStatus;
      pendingBackgroundCount?: number;
      pendingBackgroundBash?: boolean;
      backgroundAgentType?: string;
    };
    return {
      tracking: {
        pendingCount: prior.pendingBackgroundCount ?? 0,
        pendingBash: prior.pendingBackgroundBash ?? false,
        agentType: prior.backgroundAgentType,
      },
      previousStatus: prior.status,
    };
  } catch {
    return { tracking: { pendingCount: 0, pendingBash: false } };
  }
}

const input = JSON.parse(fs.readFileSync(0, "utf-8")) as HookInput;
const sessionId = input.session_id;
if (!sessionId) process.exit(0);

if (
  input.hook_event_name === "SessionEnd" ||
  (input.hook_event_name === "PostCompact" && input.trigger === "manual")
) {
  // A manual PostCompact means the "compacting" state PreCompact started
  // has run to completion — clearing the file (rather than writing a
  // status through resolveStatus) retires the label immediately with no
  // "complete" flash, the same outcome _checkTranscriptForCompactOutcome()
  // in indicator.ts already produces when it catches the same real-world
  // event by tailing the transcript instead. Without this, nothing ever
  // explicitly ends "compacting" — it was only ever cleared by that
  // transcript-tailing fast path or, failing that, COMPACTING_STALE_MS.
  fs.rmSync(sessionFilePath(sessionId), { force: true });
  process.exit(0);
}

const statePath = sessionFilePath(sessionId);
const { tracking: priorTracking, previousStatus } = readPriorState(statePath);

// True for both the launch's PreToolUse and its own immediate PostToolUse —
// see updateBackgroundTracking's comment on why the same input on both
// doesn't risk being mistaken for the later resumption signal.
const isBashBackgroundLaunch =
  (input.hook_event_name === "PreToolUse" ||
    input.hook_event_name === "PostToolUse") &&
  input.tool_name === "Bash" &&
  input.tool_input?.run_in_background === true;

const tracking = updateBackgroundTracking(
  input.hook_event_name,
  input.agent_type,
  isBashBackgroundLaunch,
  previousStatus,
  priorTracking,
);

const status = resolveStatus(
  input.hook_event_name,
  input.trigger,
  input.notification_type,
  input.tool_name,
  tracking.pendingCount,
  tracking.pendingBash,
);

if (status) {
  // 0700/0600: state files can carry transcript_path, so other local
  // accounts on a shared machine shouldn't be able to read them — see
  // SECURITY.md's threat model.
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
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
      // Round-trip fields for readPriorState above; backgroundAgentType is
      // no longer read by the extension, just carried along in the file.
      pendingBackgroundCount: tracking.pendingCount,
      pendingBackgroundBash: tracking.pendingBash,
      backgroundAgentType: tracking.agentType,
    }),
    { mode: 0o600 },
  );
  fs.renameSync(tmpPath, statePath);
}
