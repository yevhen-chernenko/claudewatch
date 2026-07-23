// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { resolveStatus, updateBackgroundTracking } from "./status";

describe("resolveStatus", () => {
  it("maps each known event to its status", () => {
    expect(resolveStatus("UserPromptSubmit", undefined)).toBe("running");
    expect(resolveStatus("PreToolUse", undefined)).toBe("running");
    expect(resolveStatus("PostToolUse", undefined)).toBe("running");
    expect(resolveStatus("PermissionRequest", undefined)).toBe(
      "waiting_approval",
    );
    expect(resolveStatus("Stop", undefined)).toBe("done");
  });

  it("maps Notification to waiting_approval only for a real pending-input type", () => {
    expect(
      resolveStatus("Notification", undefined, "permission_prompt"),
    ).toBe("waiting_approval");
    expect(
      resolveStatus("Notification", undefined, "elicitation_dialog"),
    ).toBe("waiting_approval");
  });

  it("does not surface an idle nudge or a completion notification as waiting", () => {
    expect(resolveStatus("Notification", undefined, "idle_prompt")).toBeUndefined();
    expect(resolveStatus("Notification", undefined, "auth_success")).toBeUndefined();
    expect(
      resolveStatus("Notification", undefined, "elicitation_complete"),
    ).toBeUndefined();
    expect(resolveStatus("Notification", undefined)).toBeUndefined();
  });

  it("maps PreToolUse to waiting_approval for tools that block on a direct user response", () => {
    expect(
      resolveStatus("PreToolUse", undefined, undefined, "AskUserQuestion"),
    ).toBe("waiting_approval");
  });

  it("leaves PreToolUse/PostToolUse as running for ordinary tools, including after an answered question", () => {
    expect(resolveStatus("PreToolUse", undefined, undefined, "Bash")).toBe(
      "running",
    );
    expect(
      resolveStatus("PostToolUse", undefined, undefined, "AskUserQuestion"),
    ).toBe("running");
  });

  it("maps PreCompact to compacting only for a manual trigger", () => {
    expect(resolveStatus("PreCompact", "manual")).toBe("compacting");
  });

  it("does not surface auto-compact or a missing trigger as a status", () => {
    expect(resolveStatus("PreCompact", "auto")).toBeUndefined();
    expect(resolveStatus("PreCompact", undefined)).toBeUndefined();
  });

  it("returns undefined for unknown or missing event names", () => {
    expect(resolveStatus("SomeOtherEvent", undefined)).toBeUndefined();
    expect(resolveStatus(undefined, undefined)).toBeUndefined();
  });

  it("maps SubagentStart/SubagentStop to running on their own", () => {
    expect(resolveStatus("SubagentStart", undefined)).toBe("running");
    expect(resolveStatus("SubagentStop", undefined)).toBe("running");
  });

  it("maps Stop to done when nothing is pending in the background", () => {
    expect(resolveStatus("Stop", undefined, undefined, undefined, 0)).toBe(
      "done",
    );
    // Default (no 5th arg) matches every existing Stop call site.
    expect(resolveStatus("Stop", undefined)).toBe("done");
  });

  it("maps Stop to waiting_background while a subagent hasn't reported back", () => {
    expect(resolveStatus("Stop", undefined, undefined, undefined, 1)).toBe(
      "waiting_background",
    );
    expect(resolveStatus("Stop", undefined, undefined, undefined, 2)).toBe(
      "waiting_background",
    );
  });

  it("maps Stop to waiting_background while a backgrounded Bash call is unresolved", () => {
    expect(resolveStatus("Stop", undefined, undefined, undefined, 0, true)).toBe(
      "waiting_background",
    );
  });

  it("maps Stop to done when the default pendingBash arg is used", () => {
    // Default (no 6th arg) matches every existing Stop call site.
    expect(resolveStatus("Stop", undefined, undefined, undefined, 0)).toBe(
      "done",
    );
  });
});

describe("updateBackgroundTracking", () => {
  it("increments the count and records agentType on SubagentStart", () => {
    expect(
      updateBackgroundTracking("SubagentStart", "Explore", false, undefined, {
        pendingCount: 0,
        pendingBash: false,
      }),
    ).toEqual({ pendingCount: 1, pendingBash: false, agentType: "Explore" });
  });

  it("stacks concurrent subagents rather than overwriting the count", () => {
    const afterFirst = updateBackgroundTracking(
      "SubagentStart",
      "Explore",
      false,
      undefined,
      { pendingCount: 0, pendingBash: false },
    );
    const afterSecond = updateBackgroundTracking(
      "SubagentStart",
      "general-purpose",
      false,
      undefined,
      afterFirst,
    );
    expect(afterSecond).toEqual({
      pendingCount: 2,
      pendingBash: false,
      agentType: "general-purpose",
    });
  });

  it("decrements on SubagentStop without touching agentType", () => {
    expect(
      updateBackgroundTracking("SubagentStop", undefined, false, undefined, {
        pendingCount: 2,
        pendingBash: false,
        agentType: "Explore",
      }),
    ).toEqual({ pendingCount: 1, pendingBash: false, agentType: "Explore" });
  });

  it("floors the count at zero instead of going negative", () => {
    expect(
      updateBackgroundTracking("SubagentStop", undefined, false, undefined, {
        pendingCount: 0,
        pendingBash: false,
      }),
    ).toEqual({ pendingCount: 0, pendingBash: false, agentType: undefined });
  });

  it("passes other events through unchanged when nothing is pending", () => {
    const current = { pendingCount: 1, pendingBash: false, agentType: "Explore" };
    expect(
      updateBackgroundTracking("PreToolUse", undefined, false, "running", current),
    ).toEqual(current);
    expect(
      updateBackgroundTracking(undefined, undefined, false, "running", current),
    ).toEqual(current);
  });

  it("sets pendingBash on a backgrounded Bash launch", () => {
    expect(
      updateBackgroundTracking("PreToolUse", undefined, true, "running", {
        pendingCount: 0,
        pendingBash: false,
      }),
    ).toEqual({ pendingCount: 0, pendingBash: true, agentType: undefined });
  });

  it("keeps pendingBash set through the launch call's own PostToolUse", () => {
    // The launch's PreToolUse and PostToolUse both carry
    // tool_input.run_in_background: true (same call, same input) — neither
    // should be mistaken for the resumption signal below.
    const afterLaunch = updateBackgroundTracking(
      "PreToolUse",
      undefined,
      true,
      "running",
      { pendingCount: 0, pendingBash: false },
    );
    expect(
      updateBackgroundTracking("PostToolUse", undefined, true, "running", afterLaunch),
    ).toEqual({ pendingCount: 0, pendingBash: true, agentType: undefined });
  });

  it("does not clear pendingBash on ordinary activity while status stays running", () => {
    const current = { pendingCount: 0, pendingBash: true };
    expect(
      updateBackgroundTracking("PreToolUse", undefined, false, "running", current),
    ).toEqual({ pendingCount: 0, pendingBash: true, agentType: undefined });
  });

  it("clears pendingBash on the first event after a Stop found it pending", () => {
    const current = { pendingCount: 0, pendingBash: true };
    expect(
      updateBackgroundTracking(
        "PreToolUse",
        undefined,
        false,
        "waiting_background",
        current,
      ),
    ).toEqual({ pendingCount: 0, pendingBash: false, agentType: undefined });
  });

  it("clears pendingBash on the first event after a plain done Stop too", () => {
    const current = { pendingCount: 0, pendingBash: true };
    expect(
      updateBackgroundTracking("UserPromptSubmit", undefined, false, "done", current),
    ).toEqual({ pendingCount: 0, pendingBash: false, agentType: undefined });
  });
});
