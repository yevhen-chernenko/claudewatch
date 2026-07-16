# Next steps

Status: backlog of concrete features to build next, on top of the current
interim implementation. Not yet scheduled against [ROADMAP.md](ROADMAP.md)'s
phases — capturing them here first, phase them in later.

## Open the indicator's menu with a VS Code action

`PanelMenu.Button` already gets a menu for free (`dontCreateMenu: false` in
the constructor call in `extension.js`) — it's just empty right now, so
clicking the indicator shows nothing useful. Add a `PopupMenu.PopupMenuItem`
that shells out to open VS Code.

Open questions:

- **Which directory?** The current state file has no `cwd` — only
  `status`/`updated_at`. Needs the hook handler to also capture and persist
  the session's working directory (available on the hook JSON payload, or
  via `process.cwd()` when the hook runs). This is really a preview of the
  per-session state file from ARCHITECTURE.md — with only one global state
  file, "open in VS Code" only makes sense for a single active session
  anyway, so this may be a good forcing function to do the per-session move
  earlier than planned.
- **Launch mechanism**: `Gio.Subprocess` (async, non-blocking) spawning
  `code <cwd>`, not `GLib.spawn_command_line_async` — prefer the argv-array
  API so a path with spaces/shell metacharacters can't be misinterpreted.
- **If `code` isn't on PATH**: decide whether to fail silently, show a
  notification, or fall back to opening a file manager at that path.

## Usage toggle

A toggle in the menu that shows current Claude usage (whatever `/usage`
inside a Claude Code session reports — token/cost consumption).

Open questions:

- **Data source**: unclear yet whether this is obtainable non-interactively
  (a CLI subcommand producing machine-readable output) or only exists as
  interactive slash-command output inside a running session. Needs
  investigation before design — don't assume an API exists.
- **Local-only guarantee**: if this requires a network call (e.g. hitting
  Anthropic's API for usage/billing data) rather than reading something
  Claude Code already writes locally, it breaks the "no network calls in
  v1" principle from ROADMAP.md and needs the same treatment as Phase 4's
  semantic recap — opt-in, disclosed, own line in SECURITY.md's threat
  model.
- **Refresh cadence**: polled on menu-open vs. kept live — probably
  menu-open is enough given it's a toggle you check occasionally, not a
  persistent panel readout.
