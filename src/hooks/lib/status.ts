// SPDX-License-Identifier: GPL-2.0-or-later

// Pure event-to-status mapping, kept separate from hook-handler.ts so it can
// be reasoned about (and unit tested) without the stdin/fs/process wrapper
// around it.

export type SessionStatus = "running" | "waiting_approval" | "done" | "compacting";

const STATUS_BY_EVENT: Record<string, SessionStatus> = {
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  PermissionRequest: "waiting_approval",
  Stop: "done",
};

// Notification fires for several unrelated reasons distinguished by
// notification_type — only these actually mean "Claude needs the user to act
// right now". Others we've seen (idle_prompt: a "you still there?" nudge
// after a normal turn already ended; auth_success, elicitation_complete:
// completions, not waits) must not surface as waiting_approval, or every
// idle session flashes blue for no pending reason.
const WAITING_NOTIFICATION_TYPES = new Set(["permission_prompt", "elicitation_dialog"]);

// Tools that block on a direct user response (a rendered question/choice)
// without ever going through PermissionRequest or a waiting Notification
// type — from the hook stream alone, calling one of these looks identical
// to running Bash unless we branch on tool_name specifically.
const WAITING_TOOL_NAMES = new Set(["AskUserQuestion"]);

// Only present on PreCompact; "manual" for /compact, "auto" when the context
// window fills up on its own. Only the former gets its own status — an
// auto-compact is an implementation detail of an already-running session,
// not something worth surfacing in the panel.
export function resolveStatus(
  hookEventName: string | undefined,
  trigger: string | undefined,
  notificationType?: string,
  toolName?: string,
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
  if (!hookEventName) return undefined;
  return STATUS_BY_EVENT[hookEventName];
}
