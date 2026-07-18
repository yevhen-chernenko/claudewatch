// SPDX-License-Identifier: GPL-2.0-or-later

// Pure event-to-status mapping, kept separate from hook-handler.ts so it can
// be reasoned about (and unit tested) without the stdin/fs/process wrapper
// around it.

export type SessionStatus = "running" | "waiting_approval" | "done" | "compacting";

const STATUS_BY_EVENT: Record<string, SessionStatus> = {
  UserPromptSubmit: "running",
  PreToolUse: "running",
  PostToolUse: "running",
  Notification: "waiting_approval",
  PermissionRequest: "waiting_approval",
  Stop: "done",
};

// Only present on PreCompact; "manual" for /compact, "auto" when the context
// window fills up on its own. Only the former gets its own status — an
// auto-compact is an implementation detail of an already-running session,
// not something worth surfacing in the panel.
export function resolveStatus(
  hookEventName: string | undefined,
  trigger: string | undefined,
): SessionStatus | undefined {
  if (hookEventName === "PreCompact") {
    return trigger === "manual" ? "compacting" : undefined;
  }
  if (!hookEventName) return undefined;
  return STATUS_BY_EVENT[hookEventName];
}
