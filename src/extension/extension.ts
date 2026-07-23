// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { SESSIONS_DIR, type SessionState } from "./lib/state.js";
import { ClaudeWatchIndicator } from "./lib/indicator.js";

// How many entries to request per enumerate_children_async() batch — well
// above any realistic concurrent-session count, so a single batch normally
// covers everything; _collectNames() loops for the rare case it doesn't.
const ENUMERATE_BATCH_SIZE = 64;

// A session whose process dies without ever firing Stop or SessionEnd
// leaves its file untouched forever, so the directory monitor (which only
// fires on a create/change/delete within the directory) never wakes
// _refresh() back up for it on its own. This periodic tick is the fallback
// that eventually re-evaluates every session's pid-liveness check even when
// nothing else in the directory changes — mirrors the GC tick sketched in
// ARCHITECTURE.md.
const PERIODIC_REFRESH_SECONDS = 30;

export default class ClaudeWatchExtension extends Extension {
  private _indicator: ClaudeWatchIndicator | null = null;
  private _sessionsDir: InstanceType<typeof Gio.File> | null = null;
  private _monitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private _monitorId = 0;
  private _periodicRefreshId: number | null = null;
  // Discards a stale _loadSessions() completion from an overlapping refresh
  // (e.g. two directory-monitor events firing before the first finishes
  // reading every file) so a slow read can't clobber a newer one.
  private _refreshGeneration = 0;

  enable(): void {
    this._indicator = new ClaudeWatchIndicator(
      this.uuid,
      this.metadata.name,
      this.path,
      (sessionId) => this._deleteSessionFile(sessionId),
    );
    Main.panel.addToStatusArea(this.uuid, this._indicator.button);

    // Unlike the one file ClaudeWatch doesn't own (settings.json — see
    // SECURITY.md), this is our own state directory, so we can create it
    // here too, not just in the hook handler — the directory monitor below
    // always has something to watch even before any hook has fired in a
    // fresh install.
    GLib.mkdir_with_parents(SESSIONS_DIR, 0o700);

    this._sessionsDir = Gio.File.new_for_path(SESSIONS_DIR);
    this._monitor = this._sessionsDir.monitor_directory(
      Gio.FileMonitorFlags.NONE,
      null,
    );
    this._monitorId = this._monitor.connect("changed", () => this._refresh());

    this._periodicRefreshId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      PERIODIC_REFRESH_SECONDS,
      () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      },
    );

    this._refresh();
  }

  private _refresh(): void {
    const generation = ++this._refreshGeneration;
    this._sessionsDir?.enumerate_children_async(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT,
      null,
      (dir, result) => {
        if (generation !== this._refreshGeneration) return;
        let enumerator: InstanceType<typeof Gio.FileEnumerator>;
        try {
          enumerator = dir!.enumerate_children_finish(result);
        } catch {
          this._loadSessions(generation, []);
          return;
        }
        this._collectNames(generation, enumerator, []);
      },
    );
  }

  // Pages through the enumerator with next_files_async() until it returns
  // an empty batch, accumulating every ".json" entry's name.
  private _collectNames(
    generation: number,
    enumerator: InstanceType<typeof Gio.FileEnumerator>,
    namesSoFar: string[],
  ): void {
    enumerator.next_files_async(
      ENUMERATE_BATCH_SIZE,
      GLib.PRIORITY_DEFAULT,
      null,
      (_enumerator, result) => {
        if (generation !== this._refreshGeneration) return;
        let infos: InstanceType<typeof Gio.FileInfo>[];
        try {
          infos = enumerator.next_files_finish(result);
        } catch {
          this._loadSessions(generation, namesSoFar);
          return;
        }
        if (infos.length === 0) {
          this._loadSessions(generation, namesSoFar);
          return;
        }
        const names = namesSoFar.concat(
          infos
            .map((info) => info.get_name())
            .filter((name) => name.endsWith(".json")),
        );
        this._collectNames(generation, enumerator, names);
      },
    );
  }

  private _loadSessions(generation: number, names: string[]): void {
    if (names.length === 0) {
      this._indicator?.applyStates(new Map());
      return;
    }
    const sessions = new Map<string, SessionState>();
    let remaining = names.length;
    for (const name of names) {
      const file = Gio.File.new_for_path(
        GLib.build_filenamev([SESSIONS_DIR, name]),
      );
      file.load_contents_async(null, (loadedFile, result) => {
        try {
          const [, contents] = loadedFile!.load_contents_finish(result);
          const state = JSON.parse(
            new TextDecoder().decode(contents),
          ) as SessionState;
          sessions.set(name.replace(/\.json$/, ""), state);
        } catch {
          // Missing or mid-write — the next directory-monitor tick retries.
        }
        remaining -= 1;
        if (remaining === 0 && generation === this._refreshGeneration) {
          this._indicator?.applyStates(sessions);
        }
      });
    }
  }

  // Called once a session's AgentLabel fully retires (complete-flash
  // elapsed, or the session went away without a clean finish) — closes the
  // loop on SECURITY.md's "GC policy for stale session files" item so
  // sessions/ doesn't accumulate one file per session forever. A no-op if
  // SessionEnd already deleted the file (the common case).
  private _deleteSessionFile(sessionId: string): void {
    const file = Gio.File.new_for_path(
      GLib.build_filenamev([SESSIONS_DIR, `${sessionId}.json`]),
    );
    file.delete_async(GLib.PRIORITY_DEFAULT, null, () => {
      // Nothing to react to either way — already gone is the expected
      // common case, and a real failure just leaves the file for the next
      // periodic refresh to retry against.
    });
  }

  disable(): void {
    if (this._monitor) this._monitor.disconnect(this._monitorId);
    this._monitor = null;
    this._sessionsDir = null;
    if (this._periodicRefreshId) {
      GLib.source_remove(this._periodicRefreshId);
      this._periodicRefreshId = null;
    }
    this._indicator?.destroy();
    this._indicator = null;
  }
}
