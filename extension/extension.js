// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { STATE_PATH } from "./lib/state.js";
import { ClaudeWatchIndicator } from "./lib/indicator.js";

export default class ClaudeWatchExtension extends Extension {
  enable() {
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

  _refresh() {
    this._stateFile.load_contents_async(null, (file, result) => {
      let state;
      try {
        const [, contents] = file.load_contents_finish(result);
        state = JSON.parse(new TextDecoder().decode(contents));
      } catch (e) {
        // No state file yet, or it's mid-write.
        state = {};
      }
      this._indicator?.applyState(state);
    });
  }

  disable() {
    this._monitor?.disconnect(this._monitorId);
    this._monitor = null;
    this._stateFile = null;
    this._indicator?.destroy();
    this._indicator = null;
  }
}
