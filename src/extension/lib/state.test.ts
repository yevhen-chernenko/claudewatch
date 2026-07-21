// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { deriveEffectiveStatus, resolveUiAction } from "./state";

describe("resolveUiAction", () => {
  it("syncs to the active action on the initial refresh", () => {
    expect(resolveUiAction("running", undefined, true)).toBe("running");
    expect(resolveUiAction("waiting_approval", undefined, true)).toBe(
      "waiting",
    );
    expect(resolveUiAction("compacting", undefined, true)).toBe("compacting");
  });

  it("syncs to standby on the initial refresh for a non-active status", () => {
    expect(resolveUiAction("done", undefined, true)).toBe("standby");
    expect(resolveUiAction(undefined, undefined, true)).toBe("standby");
    expect(resolveUiAction("something-unknown", undefined, true)).toBe(
      "standby",
    );
  });

  it("fires the active-status edge once, on change", () => {
    expect(resolveUiAction("running", "waiting_approval", false)).toBe(
      "running",
    );
    expect(resolveUiAction("waiting_approval", "running", false)).toBe(
      "waiting",
    );
  });

  it("does not re-fire the active-status edge when unchanged", () => {
    expect(resolveUiAction("running", "running", false)).toBeNull();
    expect(resolveUiAction("waiting_approval", "waiting_approval", false)).toBeNull();
  });

  it("fires complete when status transitions to done", () => {
    expect(resolveUiAction("done", "running", false)).toBe("complete");
  });

  it("does not re-fire complete once already done", () => {
    expect(resolveUiAction("done", "done", false)).toBeNull();
  });

  it("returns standby for any non-active, non-done status on every refresh", () => {
    expect(resolveUiAction("standby", "running", false)).toBe("standby");
    expect(resolveUiAction("standby", "standby", false)).toBe("standby");
    expect(resolveUiAction(undefined, "running", false)).toBe("standby");
  });
});

describe("deriveEffectiveStatus", () => {
  it("passes the status through unchanged while the session is alive", () => {
    expect(deriveEffectiveStatus("running", true)).toBe("running");
    expect(deriveEffectiveStatus("done", true)).toBe("done");
    expect(deriveEffectiveStatus(undefined, true)).toBeUndefined();
  });

  it("clears running/waiting_approval/compacting once the session is dead", () => {
    expect(deriveEffectiveStatus("running", false)).toBeUndefined();
    expect(deriveEffectiveStatus("waiting_approval", false)).toBeUndefined();
    expect(deriveEffectiveStatus("compacting", false)).toBeUndefined();
  });

  it("leaves done and other statuses untouched even when the session is dead", () => {
    expect(deriveEffectiveStatus("done", false)).toBe("done");
    expect(deriveEffectiveStatus("standby", false)).toBe("standby");
    expect(deriveEffectiveStatus(undefined, false)).toBeUndefined();
  });

  it("clears a stale running status even while the session is alive", () => {
    // The pid check alone can't catch a turn that ended by interruption
    // rather than a clean Stop — the CLI process is genuinely still alive,
    // just idling with no further hook ever firing for that session.
    expect(deriveEffectiveStatus("running", true, true)).toBeUndefined();
  });

  it("does not treat waiting_approval or compacting as stale", () => {
    expect(deriveEffectiveStatus("waiting_approval", true, true)).toBe(
      "waiting_approval",
    );
    expect(deriveEffectiveStatus("compacting", true, true)).toBe(
      "compacting",
    );
  });

  it("defaults isRunningStale to false for existing 2-arg call sites", () => {
    expect(deriveEffectiveStatus("running", true)).toBe("running");
  });
});
