// SPDX-License-Identifier: GPL-2.0-or-later

// There's no OS-level "default terminal" standard on Linux the way there is
// a default browser/mail client (xdg-mime), so this is necessarily
// best-effort: try the user's own $TERMINAL first, then a fixed, ordered
// list of common terminal emulators. Each entry's argv shape is its own
// "run this one command, exit when it exits" convention — gnome-terminal
// deprecated `-e` in favor of `--`, the rest still use `-e`.
interface TerminalSpec {
  name: string;
  buildArgv: (binaryPath: string, scriptPath: string) => string[];
}

const GENERIC_ARGV = (binaryPath: string, scriptPath: string): string[] => [
  binaryPath,
  "-e",
  scriptPath,
];

const KNOWN_TERMINALS: readonly TerminalSpec[] = [
  { name: "gnome-terminal", buildArgv: (bin, script) => [bin, "--", script] },
  { name: "kgx", buildArgv: (bin, script) => [bin, "-e", script] },
  { name: "konsole", buildArgv: (bin, script) => [bin, "-e", script] },
  { name: "xfce4-terminal", buildArgv: (bin, script) => [bin, "-e", script] },
  { name: "xterm", buildArgv: (bin, script) => [bin, "-e", script] },
];

// Pure so it's unit-testable without touching the real filesystem/PATH —
// `findProgram` is `GLib.find_program_in_path` at the call site (indicator.ts),
// injected here as a plain function. Returns the full argv to spawn the
// script under a terminal, or null if no terminal emulator could be found on
// PATH at all.
export function pickTerminalCommand(
  scriptPath: string,
  envTerminal: string | null,
  findProgram: (name: string) => string | null,
): string[] | null {
  const knownNames = KNOWN_TERMINALS.map((spec) => spec.name);
  const candidateNames = envTerminal
    ? [envTerminal, ...knownNames.filter((name) => name !== envTerminal)]
    : knownNames;

  for (const name of candidateNames) {
    const binaryPath = findProgram(name);
    if (!binaryPath) continue;
    const spec = KNOWN_TERMINALS.find((entry) => entry.name === name);
    const buildArgv = spec ? spec.buildArgv : GENERIC_ARGV;
    return buildArgv(binaryPath, scriptPath);
  }
  return null;
}
