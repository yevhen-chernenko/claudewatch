// SPDX-License-Identifier: GPL-2.0-or-later

import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";

const STATE_PATH = GLib.build_filenamev([
  GLib.get_user_state_dir(),
  "codewatch",
  "state.json",
]);

const STATUS_TEXT = {
  running: "Task is running…",
  done: "Task complete!",
};

export default class CodeWatchExtension extends Extension {
  enable() {
    this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
    this._label = new St.Label({
      text: "CodeWatch",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._indicator.add_child(this._label);
    Main.panel.addToStatusArea(this.uuid, this._indicator);

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
      let text;
      try {
        const [, contents] = file.load_contents_finish(result);
        const state = JSON.parse(new TextDecoder().decode(contents));
        text = STATUS_TEXT[state.status] ?? "CodeWatch";
      } catch (e) {
        // No state file yet, or it's mid-write.
        text = "CodeWatch";
      }
      this._label?.set_text(text);
    });
  }

  disable() {
    this._monitor?.disconnect(this._monitorId);
    this._monitor = null;
    this._stateFile = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._label = null;
  }
}
