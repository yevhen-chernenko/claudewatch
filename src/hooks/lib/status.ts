// SPDX-License-Identifier: GPL-2.0-or-later

// Pure event-to-status mapping, kept separate from hook-handler.ts so it can
// be reasoned about (and unit tested) without the stdin/fs/process wrapper
// around it.

export type SessionStatus =
  | "running"
  | "waiting_approval"
  | "done"
  | "compacting"
  | "waiting_background";

const STATUS_BY_EVENT: Record<string, SessionStatus> = {
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  PermissionRequest: "waiting_approval",
  // A subagent's lifetime brackets whether it ran in the foreground or was
  // backgrounded, so on their own these are just more "something is
  // happening" activity — see updateBackgroundTracking below for the part
  // that actually matters, the running count Stop consults.
  SubagentStart: "running",
  SubagentStop: "running",
};

// Notification fires for several unrelated reasons distinguished by
// notification_type — only these actually mean "Claude needs the user to act
// right now". Others we've seen (idle_prompt: a "you still there?" nudge
// after a normal turn already ended; auth_success, elicitation_complete:
// completions, not waits) must not surface as waiting_approval, or every
// idle session flashes blue for no pending reason.
//
// agent_needs_input is emitted for a backgrounded subagent job (tracked the
// same way pendingBackgroundCount is here) that has hit something blocking
// on the user — not an alternate signal for the main turn, which already
// has permission_prompt/elicitation_dialog and the PreToolUse tool_name
// branch below. It's still a genuine "act now" signal, so it maps the same
// way.
const WAITING_NOTIFICATION_TYPES = new Set([
  "permission_prompt",
  "elicitation_dialog",
  "agent_needs_input",
]);

// Tools that block on a direct user response (a rendered question/choice)
// without ever going through PermissionRequest or a waiting Notification
// type — from the hook stream alone, calling one of these looks identical
// to running Bash unless we branch on tool_name specifically.
const WAITING_TOOL_NAMES = new Set(["AskUserQuestion"]);

// Only present on PreCompact; "manual" for /compact, "auto" when the context
// window fills up on its own. Only the former gets its own status — an
// auto-compact is an implementation detail of an already-running session,
// not something worth surfacing in the panel.
//
// pendingBackgroundCount/pendingBash are the caller's running tally from
// updateBackgroundTracking (see below) — hook-handler.ts is the one that
// carries them across invocations, since each hook event is a fresh
// process. They're what let Stop tell a turn that's actually finished apart
// from one that only looks finished because work it kicked off is still
// going: a subagent's lifetime is exactly bracketed by
// SubagentStart/SubagentStop regardless of whether it ran in the
// foreground or was backgrounded, but there's no equivalent hook for "a
// backgrounded Bash job finished" — pendingBash is a heuristic for that
// case instead (see updateBackgroundTracking).
export function resolveStatus(
  hookEventName: string | undefined,
  trigger: string | undefined,
  notificationType?: string,
  toolName?: string,
  pendingBackgroundCount = 0,
  pendingBash = false,
): SessionStatus | undefined {
  if (hookEventName === "PreCompact") {
    return trigger === "manual" ? "compacting" : undefined;
  }
  if (hookEventName === "Notification") {
    return notificationType && WAITING_NOTIFICATION_TYPES.has(notificationType)
      ? "waiting_approval"
      : undefined;
  }
  if (hookEventName === "PreToolUse" && toolName && WAITING_TOOL_NAMES.has(toolName)) {
    return "waiting_approval";
  }
  if (hookEventName === "Stop") {
    return pendingBackgroundCount > 0 || pendingBash ? "waiting_background" : "done";
  }
  if (!hookEventName) return undefined;
  return STATUS_BY_EVENT[hookEventName];
}

export interface BackgroundTracking {
  pendingCount: number;
  pendingBash: boolean;
  agentType?: string;
}

// SubagentStart/SubagentStop bracket exactly one Task-tool call's lifetime —
// so a running "started but not yet stopped" count, carried in the session
// state file across hook invocations, tells resolveStatus's Stop branch
// above whether the turn that just ended left a subagent still going.
// agentType is carried along purely for display (see indicator.ts's
// "consulting" text) — last-started wins, and is not cleared on
// SubagentStop, since it's only ever read while pendingCount > 0.
//
// pendingBash covers the case SubagentStart/SubagentStop can't: a plain
// `Bash` call with `run_in_background: true` and no subagent involved.
// There's no hook for "that job finished" to bracket it the same precise
// way, so this is a heuristic instead of a count: isBashBackgroundLaunch
// (computed by the caller from tool_name + tool_input on PreToolUse/
// PostToolUse) sets it, and it's only cleared by the first *other* event
// that arrives after a Stop already found it pending — Claude Code doesn't
// fire hooks while genuinely idle, so any further event for this session is
// good evidence it woke back up, either because the backgrounded job
// resolved or because the user started a new turn regardless of it. That
// second case is a known imprecision (see ARCHITECTURE.md): it clears
// pendingBash even if the original job is technically still running, which
// can let a *later* Stop read as done a beat early. Rare enough in practice
// not to be worth a more precise mechanism absent a real "job finished"
// hook.
export function updateBackgroundTracking(
  hookEventName: string | undefined,
  agentType: string | undefined,
  isBashBackgroundLaunch: boolean,
  previousStatus: SessionStatus | undefined,
  current: BackgroundTracking,
): BackgroundTracking {
  let pendingCount = current.pendingCount;
  let nextAgentType = current.agentType;
  if (hookEventName === "SubagentStart") {
    pendingCount += 1;
    nextAgentType = agentType;
  } else if (hookEventName === "SubagentStop") {
    pendingCount = Math.max(0, pendingCount - 1);
  }

  let pendingBash = current.pendingBash;
  if (isBashBackgroundLaunch) {
    pendingBash = true;
  } else if (previousStatus === "done" || previousStatus === "waiting_background") {
    pendingBash = false;
  }

  return { pendingCount, pendingBash, agentType: nextAgentType };
}
