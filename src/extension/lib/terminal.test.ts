// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { pickTerminalCommand } from "./terminal";

const SCRIPT = "/opt/claudewatch/detailed-usage.py";

function findAmong(installed: string[]): (name: string) => string | null {
  return (name) => (installed.includes(name) ? `/usr/bin/${name}` : null);
}

describe("pickTerminalCommand", () => {
  it("returns null when no terminal is on PATH", () => {
    expect(pickTerminalCommand(SCRIPT, null, findAmong([]))).toBeNull();
  });

  it("prefers gnome-terminal's -- convention when it's first on PATH", () => {
    expect(
      pickTerminalCommand(SCRIPT, null, findAmong(["gnome-terminal", "xterm"])),
    ).toEqual(["/usr/bin/gnome-terminal", "--", SCRIPT]);
  });

  it("falls through the fixed list to the next known terminal", () => {
    expect(pickTerminalCommand(SCRIPT, null, findAmong(["xterm"]))).toEqual([
      "/usr/bin/xterm",
      "-e",
      SCRIPT,
    ]);
  });

  it("tries $TERMINAL before the fixed fallback list, even if both are installed", () => {
    expect(
      pickTerminalCommand(
        SCRIPT,
        "konsole",
        findAmong(["gnome-terminal", "konsole"]),
      ),
    ).toEqual(["/usr/bin/konsole", "-e", SCRIPT]);
  });

  it("falls back to the fixed list when $TERMINAL isn't actually on PATH", () => {
    expect(
      pickTerminalCommand(SCRIPT, "missing-terminal", findAmong(["xterm"])),
    ).toEqual(["/usr/bin/xterm", "-e", SCRIPT]);
  });

  it("uses the generic -e convention for an unrecognized $TERMINAL", () => {
    expect(
      pickTerminalCommand(SCRIPT, "my-custom-term", findAmong(["my-custom-term"])),
    ).toEqual(["/usr/bin/my-custom-term", "-e", SCRIPT]);
  });
});
