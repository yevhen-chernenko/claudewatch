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
- `Extension`, `Main`, `PanelMenu`, `PopupMenu` — gnome-shell's own modules:
  the `enable()`/`disable()` lifecycle base class, the live shell singleton
  (`Main.panel.addToStatusArea`, `Main.notify`), the panel indicator widget,
  and the popup menu item classes.
- `Soup` (libsoup 3.0) — the one network-capable import, used only by the
  "Claude Usage" rate-limit check. See
  [SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check) for
  why this is the sole exception to the local-only design.

## Lifecycle

- **`enable()`** — builds the indicator + label, adds the popup menu items
  (Open in VS Code, Show Usage, Exit), adds the indicator to the panel,
  starts a `Gio.FileMonitor` on the state file, and does one initial
  `_refresh()`. Everything created here is torn down in `disable()` —
  required for EGO review (extensions must not leak signals/sources across
  disable/re-enable cycles).
- **`_refresh()`** — reads the state file async, maps `state.status` through
  `STATUS_TEXT` to a label string, and stores the parsed state on
  `this._state` so the menu items (which need `cwd`/`transcript_path`) can
  read it. Falls back to the default `"CodeWatch"` text and an empty state
  if the file doesn't exist yet or is mid-write (the hook handler writes
  atomically via `.tmp` + rename, but the file can still be briefly absent
  between mkdir and the first write).
- **`disable()`** — disconnects the monitor and the menu's
  `open-state-changed` signal, drops all object references. Mirrors
  `enable()` exactly, per GNOME's enable/disable symmetry requirement.

## Status → text mapping

`STATUS_TEXT` currently only handles `running` and `done`, matching the two
hook events wired in `~/.claude/settings.json` (`UserPromptSubmit`, `Stop`).
`idle` and `waiting_approval` from ARCHITECTURE.md's full state machine
aren't produced yet — that lands with Phase 2's per-session rework.

## Popup menu

Four rows, added in `enable()`:

- **Open in VS Code** (`PopupMenuItem`) — sensitive only once `this._state.cwd`
  is known; `activate` spawns `Gio.Subprocess.new(["code", cwd], …)`. A
  thrown `GLib.Error` (e.g. `code` missing from PATH) is caught and surfaced
  via `Main.notify` instead of failing silently.
- **Show Usage** (`PopupSwitchMenuItem`) + a read-only summary row below it
  (`PopupMenuItem` with `reactive: false`, hidden while the switch is off).
  Toggling on, or opening the menu while already on, calls `_refreshUsage()`,
  which reads `this._state.transcript_path` async and hands the contents to
  `summarizeUsage()` — a module-level pure function that dedupes by
  `message.id` (the transcript repeats a message once per content block) and
  sums `input_tokens`/`output_tokens`/cache token fields from each
  `assistant` entry's `message.usage`.
- **Claude Usage** (`PopupMenuItem`) — click-to-check, not auto-refreshed.
  Reads a bearer token from `~/.config/codewatch/token` (created out of band
  via `claude setup-token`; the extension never writes this file) and POSTs
  a minimal (`max_tokens: 1`) request to `api.anthropic.com/v1/messages`
  solely to read the `anthropic-ratelimit-unified-5h-*`/`-7d-*` response
  headers — there's no local file or documented CLI command that exposes
  these directly. `formatRateLimitWindow()` turns each window's utilization
  fraction/reset-timestamp headers into its own row's text (`5h 27% (resets
  in 1h 0m)`, `7d 11% (resets Wed 2:00 AM)`), shown on the two read-only rows
  below the click target (`_rateLimit5hItem`/`_rateLimit7dItem`, same
  `reactive: false` pattern as the Show Usage summary row). A window with no
  headers in the response renders as `5h: unavailable` rather than hiding
  the row, so a partial response is still visibly a partial response. Both
  rows stay hidden until a check succeeds, and re-hide while a new check is
  in flight, so stale numbers are never shown as current. Missing token
  file, empty token, or a failed request all resolve to an inline error
  string on the click-target row instead — see
  [SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check) for
  why this is opt-in and user-triggered rather than automatic, and
  ["Setting up the Claude Usage token"](#setting-up-the-claude-usage-token)
  below for how to actually get it working.
- **Exit** (`PopupMenuItem`) — removes the extension's uuid from the
  `org.gnome.shell` `enabled-extensions` gsetting via `Gio.Settings`. This is
  the same mechanism the GNOME Extensions app and `gnome-extensions disable`
  use, so it persists (won't come back next login) and the shell's own
  settings listener calls `disable()` for us — the handler doesn't tear
  anything down itself.

## Setting up the Claude Usage token

The "Claude Usage" row does nothing until `~/.config/codewatch/token`
exists — the extension deliberately never creates, writes, or prompts for
this file itself (see
[SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check)).
Set it up once, by hand:

```sh
claude setup-token
```

This opens a browser consent screen ("Claude Code would like to connect to
your Claude chat account") and then prints a long-lived token to stdout.
It's the same OAuth flow as a normal `claude` login, scoped for external
tool use — not something specific to this feature, and not a training-data
consent screen (that's a separate, account-level setting in your Claude.ai
privacy settings, unaffected by this).

Save the printed token and lock the file down to your user only:

```sh
mkdir -p ~/.config/codewatch
echo 'PASTE_TOKEN_HERE' > ~/.config/codewatch/token
chmod 600 ~/.config/codewatch/token
```

Then click "Claude Usage" in the panel menu. First click after setup may
show "No token file at …" if the file wasn't saved yet — that's the
extension correctly reporting its absence, not a bug; re-click once the
file exists. A successful check reveals the two rows below it with the
current 5h/7d utilization and reset times.
