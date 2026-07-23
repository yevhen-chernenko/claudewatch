// SPDX-License-Identifier: GPL-2.0-or-later

// Minimal fake of gi://GLib for tests — covers only the surface
// src/extension/lib/state.ts touches at module scope. Not a
// general-purpose GLib shim.

const GLib = {
  build_filenamev: (parts: string[]): string => parts.join("/"),
  get_user_state_dir: (): string => "/fake/state",
};

export default GLib;
