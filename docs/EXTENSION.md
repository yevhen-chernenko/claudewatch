# The GNOME extension

Status: per-session implementation, as designed in
[ARCHITECTURE.md](ARCHITECTURE.md). See [ROADMAP.md](ROADMAP.md) for phase
context.

## What it does

Shows a panel indicator with one label per live Claude Code session, read
from per-session JSON state files written by the compiled
[hooks/hook-handler.js](../src/hooks/hook-handler.ts):

```text
${XDG_STATE_HOME:-~/.local/state}/claudewatch/sessions/<session_id>.json
```

Each session's label goes through five states while it's live: a task in
flight (**running**, pulsing orange, "Agent &lt;name&gt; is working 🕶️"),
paused on a permission prompt or question (**waiting**, static blue — no
pulse, since the color and text alone read clearly enough, "Agent
&lt;name&gt; needs support 📞"), a manual `/compact` in progress
(**compacting**, pulsing purple at the same rate as running, "Agents are
training 🔫" — no agent name, since it isn't retained into the next
session), a `Stop` that landed while a subagent it spawned hasn't reported
back yet (**consulting**, pulsing olive at the same rate as running, "Agent
&lt;name&gt; is consulting notes 📓" — see
[ARCHITECTURE.md](ARCHITECTURE.md#backgrounded-subagent-work) for why this
needs its own state instead of flashing "done" early or looking stuck on
"running"), and the 5s flash right after a task finishes (**complete**,
static green, "Agent &lt;name&gt; is done 🎖️") before that session's label
is removed for good. The agent name is picked once per session (when its
label is first created, from a fixed list in `lib/indicator.ts`) and reused
across running/waiting/consulting/complete until the session retires;
concurrent sessions avoid picking the same name as each other where possible
(`pickAgentName()`). When no session is live, the panel shows a single
static "Agents are recovering ☕" label — it only appears once every session has
retired, never alongside a live one.

Panel space is capped: only the first `MAX_INLINE_AGENTS` (3) sessions get
an inline label, and the rest collapse into a single "+N more" chip.

Entering **waiting** or **complete** fires a desktop notification
(`Main.notify`) paired with a themed system sound (`dialog-question` /
`complete`) — see `_notify()` in [lib/indicator.ts](../src/extension/lib/indicator.ts)
— but only if the popup menu's **Notifications** toggle is on (on by
default on every `enable()`; see [Popup menu](#popup-menu) below) — the
panel color/text change always happens regardless of the toggle.
**compacting** never notifies even with the toggle on: it's Claude pausing
to summarize its own transcript, not asking the user for anything, and an
auto-triggered compaction (context window filling up mid-task) is treated
as an implementation detail of the running task rather than its own state
— see the `PreCompact`/`trigger` handling in
[hooks/hook-handler.ts](../src/hooks/hook-handler.ts).

A `running`/`waiting_approval`/`compacting`/`waiting_background` status is
only trusted while the session that wrote it is still alive: the hook
handler records its own process's ppid (the Claude Code CLI process, since
hooks run in exec form) as `pid` in the session's state file, and
`isSessionAlive()` in `lib/indicator.ts` checks `/proc/<pid>` before
applying one of those four statuses to a session — a killed terminal or
crashed session that never fired `Stop` retires immediately (no green
flash) instead of leaving its label stuck. A session's file disappearing from the directory entirely
(`SessionEnd` cleanup, or a manual delete) is treated the same way, unless
that session is already mid-complete-flash — see `AgentLabel.handleMissing()`.

Claude Code fires no hook at all when a manual `/compact` is cancelled
mid-flight (only a _completed_ compaction ever produces another state-file
write), so without help a session's label would be stuck purple forever
after a cancel. `_watchTranscriptForCompactOutcome()` in
[lib/indicator.ts](../src/extension/lib/indicator.ts) tails that session's
transcript directly for the two markers Claude Code writes there regardless
of any hook: a `{"type":"system","subtype":"compact_boundary",...}` entry on
a real completion, or a `local_command` entry containing `"AbortError:
Compaction canceled."` on a cancel — reacting within a file-monitor tick
either way. `_armCompactingTimeout()` is the fallback behind that fast path
(missing `transcript_path`, or Claude Code changing what it writes there):
it bounds `compacting` the same way `COMPLETE_FLASH_MS` bounds the
**complete** flash — if nothing moves the status past `compacting` within
`COMPACTING_STALE_MS` (3 minutes), that session's label retires on its own.

## File layout

Source lives under `src/`, written in TypeScript; `npm run build` compiles it
with `tsc` into `dist/` (gitignored), which is the actual installable
extension directory / the path a `~/.claude/settings.json` hook entry should
point `hooks/hook-handler.js` at. See [Building](#building) below.

```text
src/
  extension/
    extension.ts
    lib/
      state.ts
      terminal.ts
      indicator.ts
  hooks/
    hook-handler.ts
extension/            # static assets only — copied into dist/extension/ as-is
  metadata.json
  icons/
  detailed-usage.py
dist/                 # build output (gitignored)
  extension/
    extension.js
    metadata.json
    icons/
    detailed-usage.py
    lib/*.js
  hooks/
    hook-handler.js
```

- `extension.ts` — the `Extension` subclass: `enable()`/`disable()`,
  directory-monitor wiring on `sessions/`, paged directory enumeration
  (`_collectNames()`), the periodic re-scan tick, and per-session file
  deletion on retirement (`_deleteSessionFile()`). No widget or state-machine
  logic lives here — see `lib/indicator.ts`.
- `lib/state.ts` — `SESSIONS_DIR`, the `SessionState` shape of one session's
  state file, `deriveEffectiveStatus()` (the pid-liveness check that
  discounts a leftover `running`/`waiting_approval`/`compacting` status from
  a session that's no longer alive), and `resolveUiAction()`, the pure
  edge-detection function that decides which UI transition (if any) a given
  status change triggers for one session — reused by every live `AgentLabel`.
- `lib/terminal.ts` — `pickTerminalCommand()`, the pure argv-resolution
  logic behind the "Show usage" row: given `$TERMINAL` and an injected
  PATH-lookup function, picks which terminal emulator to spawn and how.
- `extension/detailed-usage.py` (top-level, not under `src/` — a static
  asset like `metadata.json`, not TypeScript) — the stdlib-only script
  "Show usage" launches; a self-contained account-level rate-limit check
  (token resolution, the `/api/oauth/usage` request, and formatting all
  live in this one script) on its own 60-second refresh loop. This is the
  extension's only usage source — there's no TypeScript-side equivalent.
- `lib/indicator.ts` — two classes: `AgentLabel` (one per live session —
  owns its panel label widget and the pulse/notify/compacting-watch state
  machine) and `ClaudeWatchIndicator` (owns the `PanelMenu.Button`, the
  label box, the popup menu shell, and the `Map` of live `AgentLabel`
  instances keyed by session id).
- A gap in the community `@girs/gnome-shell` types (still "experimental" per
  its own README) — `Actor.ease()`, a real GNOME Shell API the types don't
  model — is filled with a narrow local `as unknown as <Interface>` type
  assertion at its call site in `lib/indicator.ts`, not a shared `.d.ts`
  file. A `declare module` augmentation of the `@girs/*` packages was tried
  first and corrupted unrelated type resolution across the rest of the
  program under this project's `moduleResolution: "bundler"` setup, so the
  comment above that assertion explains the tradeoff in place instead.

The split keeps GNOME Shell side-effecting code (widgets, signals, main-loop
sources — all in `lib/indicator.ts` and `extension.ts`) separate from pure
logic (`lib/state.ts`) that needs no shell environment to run or test. GNOME
Shell's ESM extension format (45+) resolves these as ordinary relative
imports at runtime — the `tsc` build only type-checks and downlevels syntax,
it never rewrites import specifiers or bundles, so `dist/` is plain ESM JS
GNOME Shell loads exactly as it always has.

## Building

```sh
npm install   # once
npm run build       # compiles src/ -> dist/, copies metadata.json + icons/
npm run typecheck   # type-check only, no output — fast loop while editing
```

`dist/` is what you point a symlink or `gnome-extensions pack` at; it's
gitignored and always regenerated from `src/`, never hand-edited.

For local dev, symlink `dist/extension` (not `extension/` — that's static
assets only) into GNOME Shell's extensions directory under the UUID from
`extension/metadata.json`, then reload the shell (X11: Alt+F2, `r`; Wayland:
log out/in) so it picks up the new symlink:

```sh
ln -s "$PWD/dist/extension" ~/.local/share/gnome-shell/extensions/claudewatch@yevhen-chernenko.github.io
gnome-extensions enable claudewatch@yevhen-chernenko.github.io
```

## Imports

See each file's own imports for the up-to-date list; briefly, by module:

- `extension.ts` — `Gio` (directory enumeration, file monitor, per-session
  file deletion), `GLib` (the sessions directory path, the periodic re-scan
  timeout), `Main` (`Main.panel.addToStatusArea`), `Extension` (the
  `enable()`/`disable()` lifecycle base class).
- `lib/indicator.ts` — `St`, `Clutter` (widget toolkit + the actor alignment
  enum), `GLib` (timeouts, easing durations, spawning the terminal for
  "Show usage"), `Gio` (async file reads, `Gio.Settings` for the Exit item,
  the `/proc/<pid>` liveness check, `Gio.Subprocess` for "Show usage"), and
  `Main`/`PanelMenu`/`PopupMenu` (panel indicator + menu widgets). No
  network-capable import — the extension itself makes no network calls; the
  account-level rate-limit check happens entirely out-of-process in the
  spawned `extension/detailed-usage.py`. See
  [SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check).
- `lib/state.ts` — `GLib` only, for XDG-respecting path construction
  (`get_user_state_dir()`).

## Lifecycle

- **`enable()`** (`extension.ts`) — constructs a `ClaudeWatchIndicator`
  (`lib/indicator.ts`), adds its `button` to the panel via
  `Main.panel.addToStatusArea`, creates the `sessions/` directory (`0700`)
  if it doesn't exist yet, starts a `Gio.FileMonitor` on it, starts the
  periodic re-scan timeout (`PERIODIC_REFRESH_SECONDS`), and does one
  initial `_refresh()`. Everything created here is torn down in `disable()`
  — required for EGO review (extensions must not leak signals/sources
  across disable/re-enable cycles).
- **`_refresh()`** (`extension.ts`) — asynchronously enumerates every
  `*.json` file in `sessions/` (paging through `next_files_async()` rather
  than requesting an unbounded batch), reads each one, and hands the
  resulting `Map<sessionId, SessionState>` to
  `this._indicator.applyStates(states)`. A monotonic `_refreshGeneration`
  counter discards a slow read's result if a newer refresh has already
  started, so two overlapping directory-monitor events can't have the
  slower one clobber the faster one's more current result. A file that's
  missing, mid-write, or fails to parse is just dropped from that refresh's
  map — the next directory-monitor tick retries it.
- **`ClaudeWatchIndicator.applyStates()`** (`lib/indicator.ts`) — for every
  previously-live session missing from the new map, calls
  `AgentLabel.handleMissing()` (immediate retirement, unless it's already
  mid-complete-flash). For every session in the new map: an existing
  `AgentLabel` gets `applyState()` (edge-triggered on status transitions via
  `resolveUiAction()`, same rule as the single-session version used — see
  its comment in `lib/state.ts`); a session seen for the first time only
  gets a new `AgentLabel` if its effective status is actually live
  (`running`/`waiting_approval`/`compacting`) — a session first seen already
  `done` doesn't get a label at all, so re-enabling the extension doesn't
  replay a flash for something it never saw start. Then `_syncBox()`
  reconciles the panel's label row against `MAX_INLINE_AGENTS`/the overflow
  chip/the "Agents are recovering ☕" label.
- **`_retireAgent()`** (`lib/indicator.ts`) — destroys an `AgentLabel`,
  removes it from `_agents`, and calls the `onSessionRetired` callback
  passed in from `extension.ts`, which deletes that session's state file
  (`_deleteSessionFile()`) — the fallback GC path for when `SessionEnd`
  didn't fire. See
  [ARCHITECTURE.md](ARCHITECTURE.md#session-lifecycle--state-machine).
- **`disable()`** (`extension.ts`) — disconnects the file monitor, removes
  the periodic re-scan timeout, and calls `this._indicator.destroy()`,
  which destroys every live `AgentLabel` and the `PanelMenu.Button` (which
  takes its child widgets/menu items with it). Mirrors `enable()` exactly,
  per GNOME's enable/disable symmetry requirement.

## Popup menu

Built in `ClaudeWatchIndicator`'s constructor (`lib/indicator.ts`), top to
bottom:

- **"Claude Usage" section** — a labeled `PopupSeparatorMenuItem` heading a
  single button:
  - **Show usage** (`_showUsageItem`, `PopupMenuItem`) — opens a terminal
    running `extension/detailed-usage.py`, an auto-refreshing (every 60s,
    with a progress bar to the next refresh) view of the account-level 5h/7d
    rate-limit windows. This is the only usage source in the extension —
    there's no inline rate-limit row in the popup menu itself. The script
    reads a bearer token from `~/.config/claudewatch/token` (created out of
    band, normally as a symlink to `~/.claude/.credentials.json` — see
    ["Setting up the Claude Usage token"](#setting-up-the-claude-usage-token);
    the extension never writes this file) and GETs
    `api.anthropic.com/api/oauth/usage` — a dedicated usage-status endpoint,
    not a Messages completion, so it costs no API quota to check (same
    endpoint the popular "Claude Code Usage Tracker" VS Code extension
    uses). There's no local file or documented CLI command that exposes
    this directly. Which terminal it opens is necessarily best-effort
    (`pickTerminalCommand()`, `lib/terminal.ts`): `$TERMINAL` if set, else
    the first of `gnome-terminal`/`kgx`/`konsole`/`xfce4-terminal`/`xterm`
    found on `PATH`. If none is found, or `Gio.Subprocess` fails to launch
    it, this row's own label becomes the inline error instead of the click
    silently doing nothing. The script itself is stdlib-only Python (no pip
    dependencies) and keeps running — independent of the extension — until
    the terminal window is closed or the user hits Ctrl-C. See
    [SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check)
    for why this stays opt-in (gated on the token file existing) rather than
    unconditional.
  - **Notifications** (`_notificationsItem`, `PopupSwitchMenuItem`) — on by
    default on every `enable()`, toggle-without-closing-the-menu pattern.
    Gates every `_notify()` call in `lib/indicator.ts` (the desktop
    notification + themed sound fired on any session entering **waiting**
    or **complete**) — each label's color/text always updates regardless of
    this toggle; only the notification/sound pair is suppressed while it's
    off. In-memory only (`this._notificationsEnabled`), so it's back on
    again after every shell reload rather than persisting a user's choice to
    turn it off.
- **Exit** (`PopupMenuItem`) — removes the extension's uuid (passed into
  `ClaudeWatchIndicator`'s constructor from `this.uuid` in `extension.ts`) from
  the `org.gnome.shell` `enabled-extensions` gsetting via `Gio.Settings`.
  This is the same mechanism the GNOME Extensions app and
  `gnome-extensions disable` use, so it persists (won't come back next
  login) and the shell's own settings listener calls `disable()` for us —
  the handler doesn't tear anything down itself.

## Setting up the Claude Usage token

The "Claude Usage" row does nothing until `~/.config/claudewatch/token`
exists — the extension deliberately never creates, writes, or prompts for
this file itself (see
[SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check)).
Set it up once, by hand:

```sh
mkdir -p ~/.config/claudewatch
ln -s ~/.claude/.credentials.json ~/.config/claudewatch/token
```

The token file may contain either credentials.json-format JSON (as with the
symlink above — `resolve_token()` in `extension/detailed-usage.py` extracts
`claudeAiOauth.accessToken` from it) or a raw bearer token. The symlink is
the form that works: `/api/oauth/usage` requires the `user:profile` scope,
which only the interactive `claude` login credential carries — a token
minted by `claude setup-token` has only `user:inference` and gets rejected
with "OAuth token does not meet scope requirement user:profile". The
raw-token form stays supported in case setup-token ever gains the scope.

The symlink target is Claude Code's own credential file (already `0600`),
and Claude Code refreshes the access token in it whenever it runs — each
refresh in the terminal view re-reads the file, so it always sends the
current token. If the check reports "OAuth token expired", the fix is just
to run `claude` once so it refreshes the credential.

Then click "Show usage" in the panel menu — it opens a terminal running
`extension/detailed-usage.py`. A missing or empty token file, or a failed
request, all resolve to an inline error/status line in that terminal
instead of a silent failure. A successful check shows the current 5h/7d
utilization and reset times, auto-refreshing every 60s.
