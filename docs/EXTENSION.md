# extension.js

Status: interim single-state-file implementation. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the per-session design this moves to
in Phase 2, and [ROADMAP.md](ROADMAP.md) for phase context.

## What it does

Shows a panel indicator (`this._indicator`, a `PanelMenu.Button`) with a
label that reflects Claude Code's current activity, read from a JSON state
file written by [hooks/hook-handler.js](../hooks/hook-handler.js).

```
${XDG_STATE_HOME:-~/.local/state}/codewatch/state.json
```

## Imports

See the imports themselves for the up-to-date list; briefly:

- `St`, `Clutter` — shell widget toolkit and the actor alignment enum
  (`Clutter.ActorAlign.CENTER`, used to vertically center the label).
- `GLib` — builds the state file path (`get_user_state_dir()`,
  `build_filenamev()`) the same XDG-respecting way the hook handler does on
  the Node side.
- `Gio` — `Gio.File` + `Gio.FileMonitor` to watch the state file and
  `load_contents_async` to read it without blocking the shell's main loop
  (sync I/O in `enable()`/callbacks is an EGO review rejection risk, see
  [SECURITY.md](SECURITY.md)).
- `Extension`, `Main`, `PanelMenu` — gnome-shell's own modules: the
  `enable()`/`disable()` lifecycle base class, the live shell singleton
  (`Main.panel.addToStatusArea`), and the panel indicator widget.

## Lifecycle

- **`enable()`** — builds the indicator + label, adds it to the panel,
  starts a `Gio.FileMonitor` on the state file, and does one initial
  `_refresh()`. Everything created here is torn down in `disable()` —
  required for EGO review (extensions must not leak signals/sources across
  disable/re-enable cycles).
- **`_refresh()`** — reads the state file async, maps `state.status` through
  `STATUS_TEXT` to a label string. Falls back to the default `"CodeWatch"`
  text if the file doesn't exist yet or is mid-write (the hook handler
  writes atomically via `.tmp` + rename, but the file can still be briefly
  absent between mkdir and the first write).
- **`disable()`** — disconnects the monitor, drops all object references.
  Mirrors `enable()` exactly, per GNOME's enable/disable symmetry
  requirement.

## Status → text mapping

`STATUS_TEXT` currently only handles `running` and `done`, matching the two
hook events wired in `~/.claude/settings.json` (`UserPromptSubmit`, `Stop`).
`idle` and `waiting_approval` from ARCHITECTURE.md's full state machine
aren't produced yet — that lands with Phase 2's per-session rework.
