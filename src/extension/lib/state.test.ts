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
    expect(resolveUiAction("waiting_background", undefined, true)).toBe(
      "consulting",
    );
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
    expect(resolveUiAction("waiting_background", "running", false)).toBe(
      "consulting",
    );
  });

  it("does not re-fire the active-status edge when unchanged", () => {
    expect(resolveUiAction("running", "running", false)).toBeNull();
    expect(resolveUiAction("waiting_approval", "waiting_approval", false)).toBeNull();
    expect(
      resolveUiAction("waiting_background", "waiting_background", false),
    ).toBeNull();
  });

  it("fires running again once a pending subagent reports back and the parent resumes", () => {
    // waiting_background -> running is just another active-status edge, same
    // rule as any other pair — called out explicitly since it's the specific
    // transition the false "done" flash used to hide.
    expect(resolveUiAction("running", "waiting_background", false)).toBe(
      "running",
    );
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

  it("clears running/waiting_approval/compacting/waiting_background once the session is dead", () => {
    expect(deriveEffectiveStatus("running", false)).toBeUndefined();
    expect(deriveEffectiveStatus("waiting_approval", false)).toBeUndefined();
    expect(deriveEffectiveStatus("compacting", false)).toBeUndefined();
    expect(deriveEffectiveStatus("waiting_background", false)).toBeUndefined();
  });

  it("leaves done and other statuses untouched even when the session is dead", () => {
    expect(deriveEffectiveStatus("done", false)).toBe("done");
    expect(deriveEffectiveStatus("standby", false)).toBe("standby");
    expect(deriveEffectiveStatus(undefined, false)).toBeUndefined();
  });

  it("clears a stale running/compacting/waiting_background status even while the session is alive", () => {
    // The pid check alone can't catch a turn that ended by interruption
    // rather than a clean Stop (running), an abandoned /compact
    // (compacting), or a subagent whose SubagentStop never fired
    // (waiting_background) — the CLI process is genuinely still alive, just
    // idling with no further hook ever firing for that session. isStale is
    // computed by the caller per-status (see isRunningStale/
    // isCompactingStale/isConsultingStale in indicator.ts), so a single
    // boolean here stands in for whichever one applied.
    expect(deriveEffectiveStatus("running", true, true)).toBeUndefined();
    expect(deriveEffectiveStatus("compacting", true, true)).toBeUndefined();
    expect(
      deriveEffectiveStatus("waiting_background", true, true),
    ).toBeUndefined();
  });

  it("does not treat waiting_approval as stale", () => {
    // waiting_approval has no stale fallback at all — it's a direct request
    // for the user, not background work with its own abandonment signal.
    expect(deriveEffectiveStatus("waiting_approval", true, true)).toBe(
      "waiting_approval",
    );
  });

  it("defaults isStale to false for existing 2-arg call sites", () => {
    expect(deriveEffectiveStatus("running", true)).toBe("running");
    expect(deriveEffectiveStatus("compacting", true)).toBe("compacting");
    expect(deriveEffectiveStatus("waiting_background", true)).toBe(
      "waiting_background",
    );
  });
});
