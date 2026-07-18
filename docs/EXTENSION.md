# The GNOME extension

Status: interim single-state-file implementation. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the per-session design this moves to
in Phase 2, and [ROADMAP.md](ROADMAP.md) for phase context.

## What it does

Shows a panel indicator with a label that reflects Claude Code's current
activity, read from a JSON state file written by the compiled
[hooks/hook-handler.js](../src/hooks/hook-handler.ts):

```text
${XDG_STATE_HOME:-~/.local/state}/claudewatch/state.json
```

Five states: idle (**standby**, plain dark label reading "All clear 👀" —
also where it lands 5s after a task finishes), a task in flight (**running**,
pulsing orange, "Agent &lt;name&gt; is working 🕶️"), paused on a permission
prompt or question (**waiting**, static blue — no pulse, since the color and
text alone read clearly enough, "Agent &lt;name&gt; needs support 📞"), a
manual `/compact` in progress (**compacting**, pulsing purple at the same
rate as running, "Agents are training 🔫" — no agent name, since it isn't
retained into the next session), and the 5s flash right after a task
finishes (**complete**, static green, "Agent &lt;name&gt; is done 🎖️"). The
agent name is picked once per run (on the standby → running transition, from
a fixed list in `lib/indicator.ts`) and reused across running/waiting/
complete until the run falls back to standby, so it doesn't re-roll on every
state-file update. Entering **waiting** or **complete** fires a desktop
notification (`Main.notify`) paired with a themed system sound
(`dialog-question` / `complete`) — see `_notify()` in
[lib/indicator.ts](../src/extension/lib/indicator.ts) — but only if the
popup menu's **Notifications** toggle is on (off by default on every
`enable()`; see [Popup menu](#popup-menu) below) — the panel color/text
change always happens regardless of the toggle. **compacting** never
notifies even with the toggle on: it's Claude pausing to summarize its own
transcript, not asking the user for anything, and an auto-triggered
compaction (context window filling up mid-task) is treated as an
implementation detail of the running task rather than its own state — see
the `PreCompact`/`trigger` handling in
[hooks/hook-handler.ts](../src/hooks/hook-handler.ts).

A `running`/`waiting_approval`/`compacting` status is only trusted while the
session that wrote it is still alive: the hook handler records its own
process's ppid (the Claude Code CLI process, since hooks run in exec form)
as `pid` in state.json, and `_isSessionAlive()` in `lib/indicator.ts` checks
`/proc/<pid>` before applying one of those three statuses — a killed
terminal or crashed session that never fired `Stop` falls back to standby
instead of leaving the panel stuck. State files with no `pid` (older format)
skip the check and trust the status as-is.

Claude Code fires no hook at all when a manual `/compact` is cancelled
mid-flight (only a *completed* compaction ever produces another state.json
write), so without help the panel would be stuck purple forever after a
cancel. `_watchTranscriptForCompactOutcome()` in
[lib/indicator.ts](../src/extension/lib/indicator.ts) tails the session
transcript directly for the two markers Claude Code writes there regardless
of any hook: a `{"type":"system","subtype":"compact_boundary",...}` entry on
a real completion, or a `local_command` entry containing `"AbortError:
Compaction canceled."` on a cancel — reacting within a file-monitor tick
either way. `_armCompactingTimeout()` is the fallback behind that fast path
(missing `transcript_path`, or Claude Code changing what it writes there):
it bounds `compacting` the same way `COMPLETE_FLASH_MS` bounds the
**complete** flash — if nothing moves the status past `compacting` within
`COMPACTING_STALE_MS` (3 minutes), it falls back to standby on its own.

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
      usage.ts
      rateLimit.ts
      indicator.ts
  hooks/
    hook-handler.ts
extension/            # static assets only — copied into dist/extension/ as-is
  metadata.json
  icons/
dist/                 # build output (gitignored)
  extension/
    extension.js
    metadata.json
    icons/
    lib/*.js
  hooks/
    hook-handler.js
```

- `extension.ts` — the `Extension` subclass: `enable()`/`disable()` and
  file-monitor wiring only. No widget or state-machine logic lives here —
  see `lib/indicator.ts`.
- `lib/state.ts` — `STATE_PATH`, the `SessionState` shape of state.json,
  `deriveEffectiveStatus()` (the pid-liveness check that discounts a leftover
  `running`/`waiting_approval`/`compacting` status from a session that's no
  longer alive), and `resolveUiAction()`, the pure edge-detection function
  that decides which UI transition (if any) a given status change triggers.
- `lib/usage.ts` — `formatTokenCount()` and `summarizeUsage()`, pure
  transcript token-counting math with no `gi://` imports.
- `lib/rateLimit.ts` — `TOKEN_PATH`, `RATE_LIMIT_URL`, and the pure
  formatting helpers (`formatResetTime`, `formatRateLimitWindow`) for the
  rate-limit check.
- `lib/indicator.ts` — `ClaudeWatchIndicator`, which owns the
  `PanelMenu.Button`, the popup menu, the pulse/notify state machine, and
  the rate-limit HTTP fetch (the only place `Soup` is used).
- Two gaps in the community `@girs/gnome-shell` types (still "experimental"
  per its own README) — `Actor.ease()` and `PopupMenu`'s
  `"open-state-changed"` signal, both real GNOME Shell APIs the types don't
  model — are filled with narrow local `as unknown as <Interface>` type
  assertions at their two call sites in `lib/indicator.ts`, not a shared
  `.d.ts` file. A `declare module` augmentation of the `@girs/*` packages was
  tried first and corrupted unrelated type resolution across the rest of the
  program under this project's `moduleResolution: "bundler"` setup, so the
  comment above those two assertions explains the tradeoff in place instead.

The split keeps GNOME Shell side-effecting code (widgets, signals, main-loop
sources, network I/O — all in `lib/indicator.ts` and `extension.ts`) separate
from pure logic (`lib/state.ts`, `lib/usage.ts`, the formatting half of
`lib/rateLimit.ts`) that needs no shell environment to run or test. GNOME
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

- `extension.ts` — `Gio` (file + file monitor), `Main` (`Main.panel.addToStatusArea`),
  `Extension` (the `enable()`/`disable()` lifecycle base class).
- `lib/indicator.ts` — `St`, `Clutter` (widget toolkit + the actor alignment
  enum), `GLib` (timeouts, easing durations), `Gio` (async file reads,
  `Gio.Subprocess` for the VS Code launch, `Gio.Settings` for the Exit item),
  `Main`/`PanelMenu`/`PopupMenu` (panel indicator + menu widgets), and `Soup`
  (libsoup 3.0) — the one network-capable import in the whole extension, used
  only by the rate-limit check. See
  [SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check) for
  why this is the sole exception to the local-only design.
- `lib/state.ts`, `lib/rateLimit.ts` — `GLib` only, for XDG-respecting path
  construction (`get_user_state_dir()`/`get_user_config_dir()`) and (in
  `rateLimit.ts`) `GLib.DateTime` reset-time math.
- `lib/usage.ts` — no `gi://` imports at all; pure string/number logic.

## Lifecycle

- **`enable()`** (`extension.ts`) — constructs a `ClaudeWatchIndicator`
  (`lib/indicator.ts`), adds its `button` to the panel via
  `Main.panel.addToStatusArea`, starts a `Gio.FileMonitor` on the state file,
  and does one initial `_refresh()`. Everything created here is torn down in
  `disable()` — required for EGO review (extensions must not leak
  signals/sources across disable/re-enable cycles).
- **`_refresh()`** (`extension.ts`) — reads the state file async and hands
  the parsed JSON to `this._indicator.applyState(state)`. Falls back to `{}`
  if the file doesn't exist yet or is mid-write (the hook handler writes
  atomically via `.tmp` + rename, but the file can still be briefly absent
  between mkdir and the first write).
- **`ClaudeWatchIndicator.applyState()`** (`lib/indicator.ts`) — stores the
  state, refreshes the local usage row, and runs it through
  `resolveUiAction()` to decide whether to transition the label (edge-
  triggered on `status` changes, not every file-monitor event — see the
  function's own comment in `lib/state.ts` for why the very first refresh
  after `enable()` is deliberately not treated as an edge).
- **`disable()`** (`extension.ts`) — disconnects the file monitor and calls
  `this._indicator.destroy()`, which disconnects the menu's
  `open-state-changed` signal, clears the pending flash timeout, and destroys
  the `PanelMenu.Button` (which takes its child widgets and menu items with
  it). Mirrors `enable()` exactly, per GNOME's enable/disable symmetry
  requirement.

## Popup menu

Built in `ClaudeWatchIndicator`'s constructor (`lib/indicator.ts`), top to
bottom:

- **Open in VS Code** (`PopupMenuItem`) — sensitive only once `this._state.cwd`
  is known; `activate` spawns `Gio.Subprocess.new(["code", cwd], …)`. A
  thrown `GLib.Error` (e.g. `code` missing from PATH) is caught and surfaced
  via `Main.notify` instead of failing silently.
- **"Claude Usage" section** — a labeled `PopupSeparatorMenuItem` heading
  three always-visible rows plus a refresh button, all `reactive: false`
  except the button:
  - **Session** (`_usageLabelItem`) — local token counts for the current
    session (`In … · Out … · Cached …`), no network involved. Reads
    `this._state.transcript_path` async and hands the contents to
    `summarizeUsage()` (`lib/usage.ts`) — a pure function that dedupes by
    `message.id` (the transcript repeats a message once per content block)
    and sums `input_tokens`/`output_tokens`/cache token fields from each
    `assistant` entry's `message.usage`. Refreshes on every state-file change
    and every menu open — cheap since it's a local file read.
  - **5h** / **7d** (`_rateLimit5hItem`/`_rateLimit7dItem`) — the
    account-level rate-limit windows. Reads a bearer token from
    `~/.config/claudewatch/token` (created out of band, normally as a
    symlink to `~/.claude/.credentials.json` — see
    ["Setting up the Claude Usage token"](#setting-up-the-claude-usage-token);
    the extension never writes this file) and GETs
    `api.anthropic.com/api/oauth/usage` — a dedicated usage-status endpoint,
    not a Messages completion, so it costs no API quota to check (same
    endpoint the popular "Claude Code Usage Tracker" VS Code extension
    uses). There's no local file or documented CLI command that exposes
    this directly. `formatRateLimitWindow()` (`lib/rateLimit.ts`) turns each
    window's `utilization`/`resets_at` JSON response fields into its own
    row's text (`5h 27% (resets in 1h 0m)`, `7d 11% (resets Wed 2:00 AM)`). A
    window missing from the response renders as `5h: unavailable` rather
    than hiding the row, so a partial response is still visibly a partial
    response. Both rows stay hidden until a check succeeds, and re-hide
    while a new check is in flight, so stale numbers are never shown as
    current.
  - **Auto-refresh on task complete** (`_autoRefreshItem`,
    `PopupSwitchMenuItem`) — off by default on every `enable()`. When on,
    `applyState()` edge-triggers `_refreshRateLimits()` when the state's
    `status` transitions to `"done"` (a Stop hook firing), tracked via
    `this._lastStatus` so it doesn't re-fire on every file-monitor event
    while status stays `"done"` or on menu reopen. When off (the default),
    the Stop-hook edge is still tracked but the request is skipped, so
    "Refresh Usage" is the only thing that triggers a rate-limit request.
    The toggle state (`this._autoRefreshOnDone`) is in-memory only — see
    [SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check)
    for why this stays opt-in (gated on both the token file existing and
    this switch) rather than unconditional, and
    ["Setting up the Claude Usage token"](#setting-up-the-claude-usage-token)
    below for how to actually get it working.
  - **Notifications** (`_notificationsItem`, `PopupSwitchMenuItem`) — off by
    default on every `enable()`, same toggle-without-closing-the-menu
    pattern as Auto-refresh above. Gates every `_notify()` call in
    `lib/indicator.ts` (the desktop notification + themed sound fired on
    entering **waiting** or **complete**) — the panel label's color and text
    always update regardless of this toggle; only the notification/sound
    pair is suppressed while it's off. In-memory only
    (`this._notificationsEnabled`), so it resets to off on every shell
    reload, same rationale as Auto-refresh.
  - **Refresh Usage** (`_refreshUsageItem`, `PopupMenuItem`) — manual
    override on top of the automatic refreshes above; `activate` calls both
    `_refreshUsage()` and `_refreshRateLimits()`. Also doubles as the status
    display for the rate-limit check specifically — its label reads
    "Checking…" while a request is in flight, and missing token file, empty
    token, or a failed request all resolve to an inline error string on
    this row instead of a silent failure.
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
symlink above — `resolveToken()` in `lib/rateLimit.ts` extracts
`claudeAiOauth.accessToken` from it) or a raw bearer token. The symlink is
the form that works: `/api/oauth/usage` requires the `user:profile` scope,
which only the interactive `claude` login credential carries — a token
minted by `claude setup-token` has only `user:inference` and gets rejected
with "OAuth token does not meet scope requirement user:profile". The
raw-token form stays supported in case setup-token ever gains the scope.

The symlink target is Claude Code's own credential file (already `0600`),
and Claude Code refreshes the access token in it whenever it runs — each
"Refresh Usage" click re-reads the file, so it always sends the current
token. If the check reports "OAuth token expired", the fix is just to run
`claude` once so it refreshes the credential.

Then click "Refresh Usage" in the panel menu. First click after setup may
show "No token file at …" if the file wasn't saved yet — that's the
extension correctly reporting its absence, not a bug; re-click once the
file exists. A successful check reveals the two rows below it with the
current 5h/7d utilization and reset times.
