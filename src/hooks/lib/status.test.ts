// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { resolveStatus } from "./status";

describe("resolveStatus", () => {
  it("maps each known event to its status", () => {
    expect(resolveStatus("UserPromptSubmit", undefined)).toBe("running");
    expect(resolveStatus("PreToolUse", undefined)).toBe("running");
    expect(resolveStatus("PostToolUse", undefined)).toBe("running");
    expect(resolveStatus("Notification", undefined)).toBe("waiting_approval");
    expect(resolveStatus("PermissionRequest", undefined)).toBe(
      "waiting_approval",
    );
    expect(resolveStatus("Stop", undefined)).toBe("done");
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
});
