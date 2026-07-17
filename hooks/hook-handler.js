#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const stateDir = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "codewatch",
);
const statePath = path.join(stateDir, "state.json");

const STATUS_BY_EVENT = {
  UserPromptSubmit: "running",
  Notification: "waiting_approval",
  PermissionRequest: "waiting_approval",
  Stop: "done",
};

const input = JSON.parse(fs.readFileSync(0, "utf-8"));
const status = STATUS_BY_EVENT[input.hook_event_name];

if (status) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({
      status,
      updated_at: new Date().toISOString(),
      cwd: input.cwd,
      transcript_path: input.transcript_path,
    }),
  );
  fs.renameSync(tmpPath, statePath);
}
