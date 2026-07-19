// SPDX-License-Identifier: GPL-2.0-or-later

// Minimal fake of gi://GLib for tests — covers only the surface
// src/extension/lib/state.ts and src/extension/lib/rateLimit.ts touch at
// module scope or inside their pure, host-independent functions. Not a
// general-purpose GLib shim.

class FakeDateTime {
  constructor(private readonly date: Date) {}

  // Real GLib returns a TimeSpan (microseconds) from difference(). The only
  // caller (formatResetTime) immediately does Number(...) / 3_600_000_000,
  // so a plain number of microseconds behaves identically.
  difference(other: FakeDateTime): number {
    return (this.date.getTime() - other.date.getTime()) * 1000;
  }

  // Only supports the one format string formatResetTime actually uses:
  // "%a %l:%M %p" (short weekday, blank-padded 12h hour, 2-digit minute,
  // AM/PM).
  format(fmt: string): string | null {
    const weekday = this.date.toLocaleDateString("en-US", {
      weekday: "short",
    });
    const hour24 = this.date.getHours();
    let hour12 = hour24 % 12;
    if (hour12 === 0) hour12 = 12;
    const hourStr = hour12 < 10 ? ` ${hour12}` : `${hour12}`;
    const minutes = String(this.date.getMinutes()).padStart(2, "0");
    const ampm = hour24 < 12 ? "AM" : "PM";
    return fmt
      .replace("%a", weekday)
      .replace("%l", hourStr)
      .replace("%M", minutes)
      .replace("%p", ampm);
  }
}

const GLib = {
  build_filenamev: (parts: string[]): string => parts.join("/"),
  get_user_state_dir: (): string => "/fake/state",
  get_user_config_dir: (): string => "/fake/config",
  DateTime: {
    new_from_iso8601: (isoString: string): FakeDateTime | null => {
      const date = new Date(isoString);
      return Number.isNaN(date.getTime()) ? null : new FakeDateTime(date);
    },
    new_now_local: (): FakeDateTime => new FakeDateTime(new Date()),
  },
};

export default GLib;
