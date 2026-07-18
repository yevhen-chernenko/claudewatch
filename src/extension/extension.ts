// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { STATE_PATH, type SessionState } from "./lib/state.js";
import { ClaudeWatchIndicator } from "./lib/indicator.js";

export default class ClaudeWatchExtension extends Extension {
  private _indicator: ClaudeWatchIndicator | null = null;
  private _stateFile: InstanceType<typeof Gio.File> | null = null;
  private _monitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private _monitorId = 0;

  enable(): void {
    this._indicator = new ClaudeWatchIndicator(
      this.uuid,
      this.metadata.name,
      this.path,
    );
    Main.panel.addToStatusArea(this.uuid, this._indicator.button);

    this._stateFile = Gio.File.new_for_path(STATE_PATH);
    this._monitor = this._stateFile.monitor_file(
      Gio.FileMonitorFlags.NONE,
      null,
    );
    this._monitorId = this._monitor.connect("changed", () => this._refresh());

    this._refresh();
  }

  private _refresh(): void {
    this._stateFile?.load_contents_async(null, (file, result) => {
      let state: SessionState;
      try {
        const [, contents] = file!.load_contents_finish(result);
        state = JSON.parse(new TextDecoder().decode(contents)) as SessionState;
      } catch {
        // No state file yet, or it's mid-write.
        state = {};
      }
      this._indicator?.applyState(state);
    });
  }

  disable(): void {
    if (this._monitor) this._monitor.disconnect(this._monitorId);
    this._monitor = null;
    this._stateFile = null;
    this._indicator?.destroy();
    this._indicator = null;
  }
}
