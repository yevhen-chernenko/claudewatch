# Architecture

Status: the per-session design below is implemented — one state file per
Claude Code session, one panel label per live session, GC on retirement.
No install flow yet (hooks are still added to `~/.claude/settings.json` by
hand). See [EXTENSION.md](EXTENSION.md) for the as-built details and
[ROADMAP.md](ROADMAP.md) for phase context.

## Components

ClaudeWatch has two independent halves that only agree on a file format. They
are versioned, installed, and reviewed separately.

1. **Hook handler** — a small script invoked by Claude Code itself, once per
   configured hook event. Not part of the GNOME extension package; not
   reviewed by extensions.gnome.org. Source lives at `src/hooks/hook-handler.ts`
   and is compiled (`npm run build`, see [EXTENSION.md](EXTENSION.md#building))
   to `dist/hooks/hook-handler.js`, which is what a user (or a setup action in
   the extension's preferences — see [Install flow](#install-flow)) installs
   as a command entry in `~/.claude/settings.json`. TypeScript is a devtime
   dependency only — the installed script has zero runtime dependencies,
   same as before.
2. **GNOME Shell extension** — GJS, ESM module format (GNOME 45+), the only
   piece submitted to extensions.gnome.org. Reads local state, renders the
   panel indicator and popup menu, owns preferences. Also written in
   TypeScript (`src/extension/`) and compiled to plain JS (`dist/extension/`)
   before install/packaging — nothing for GNOME Shell or EGO's review to
   build.

There is no long-running daemon in v1. The hook handler runs, does one small
write, and exits — every invocation. This is a deliberate simplification:
no process lifecycle to manage, no socket to secure, nothing to leak memory
between runs, nothing for the extension to spawn. If per-event file I/O
turns out to be too slow or too coarse (see [Open questions](#open-questions)),
a daemon + IPC socket is the fallback design for v2, not the v1 starting point.

```text
Claude Code session
   │  (hook event, JSON on stdin)
   ▼
hook handler (node, zero deps)
   │  atomic write
   ▼
~/.local/state/claudewatch/sessions/<session_id>.json
   │  Gio.FileMonitor (directory watch)
   ▼
GNOME extension (indicator + popup menu)
```

## Surface independence

ClaudeWatch never distinguishes *how* Claude Code was launched — the hook
handler only reacts to hook events, and hooks are configured once, globally,
in `~/.claude/settings.json`. The CLI, the VS Code extension, and the Claude
Desktop app's Code tab all run the same underlying engine and share that
settings file (hooks, MCP servers, `CLAUDE.md`, skills), so any **locally
executing** session is visible to ClaudeWatch regardless of surface, with no
surface-specific code. Verified directly on Ubuntu 24.04.4 across all three
locally-executing input surfaces — the CLI (`claude -p` and interactive), the
official VS Code extension, and the Claude Desktop app's Code tab — each
produces/updates the same `<session_id>.json` shape and goes through the same
lifecycle.

This does not extend to Claude Code sessions where the engine itself runs on
a different machine than this one — the Desktop app's Remote/SSH/Cloud
session environments, and cloud-run Cowork background agents. Their hook
commands execute on that other host, so no local state file is ever written
here. This is an inherent boundary of the file-per-session design (see
[Components](#components)), not a bug to fix.

## Session state file

One file per Claude Code session, so concurrent sessions never contend for
the same file — each is written only by its own hook invocations, which are
serial by construction (Claude Code doesn't fire two hooks for one session
at once). This sidesteps file-locking entirely for v1.

Path: `${XDG_STATE_HOME:-~/.local/state}/claudewatch/sessions/<session_id>.json`

As-built schema (`SessionState` in `src/extension/lib/state.ts`) — smaller
than the original draft: no `counters`/`last_notification` object, since
nothing in the extension consumes them yet and unused fields would just be
dead weight the hook handler has to keep in sync:

```jsonc
{
  "session_id": "abc123",
  "status": "running | waiting_approval | done | compacting | waiting_background",
  "updated_at": "2026-07-16T10:04:12Z",
  "transcript_path": "/home/user/.claude/.../transcript.jsonl",
  "pid": 12345,
  // Hook-side bookkeeping only — see "Backgrounded subagent work" below.
  // Not read by the extension; round-tripped by the hook handler itself.
  "pendingBackgroundCount": 0,
  // Same, for a backgrounded Bash call rather than a subagent — a
  // heuristic rather than a precise count, see below for why.
  "pendingBackgroundBash": false,
  // Last SubagentStart's agent_type (e.g. "Explore"); round-tripped by the
  // hook handler but no longer read by the extension, which shows a fixed
  // generic "consulting" label regardless of agent_type.
  "backgroundAgentType": "Explore",
}
```

Write is a single `fs.writeFileSync(tmp)` + `rename()` (atomic replace on the
same filesystem) — never a partial-write read by the extension.

### Session lifecycle / state machine

| Hook event | Transition |
| - | - |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | `status: running` (creates the file on first sight of a session) |
| `PreToolUse` (`tool_name: "AskUserQuestion"`) | `status: waiting_approval` — blocks on a direct user response, bypassing `PermissionRequest`/`Notification` |
| `Notification` / `PermissionRequest` | `status: waiting_approval`, fire desktop notification (if the Notifications toggle is on) |
| `PreCompact` (`trigger: "manual"`) | `status: compacting`; `trigger: "auto"` is a no-op — not surfaced as its own state |
| `PostCompact` (`trigger: "manual"`) | delete the session's file immediately, bypassing `resolveStatus` (same as `SessionEnd`) — ends the `compacting` state the matching `PreCompact` started, with no `complete` flash; `trigger: "auto"` is a no-op, matching `PreCompact` |
| `SubagentStart` | `status: running`; increments the session's `pendingBackgroundCount` and records `backgroundAgentType` (see below) |
| `SubagentStop` | `status: running`; decrements `pendingBackgroundCount` (floored at 0) |
| `Stop` | `status: done` if `pendingBackgroundCount` is 0 and `pendingBackgroundBash` is false, else `status: waiting_background`; a `done` flashes green for 5s then the session's label retires |
| `SessionEnd` | delete the session's file immediately — the common-case cleanup path |

### Backgrounded subagent work

Without special-casing, `Stop` firing the moment a turn's *visible* activity
ends looks identical whether the agent is actually done or it just kicked
off a backgrounded Task/Agent tool call and is waiting on it — the panel
would flash "done" (green) for a session that's de-facto still working, then
flip back to "running" once the subagent's own next tool call reaches the
hook stream. `SubagentStart`/`SubagentStop` bracket exactly one subagent
call's lifetime regardless of whether it ran in the foreground or was
backgrounded, so a running count (`pendingBackgroundCount`, carried across
hook invocations in the session's own state file — see the schema above) is
enough for `Stop` to tell the two cases apart: a real finish
(`pendingBackgroundCount === 0`) still maps to `done`; a `Stop` that landed
with a subagent still unaccounted for maps to `waiting_background` instead,
which the extension renders as its own pulsing "consulting" state (see
`indicator.ts`) rather than either "running" or "done", with a fixed generic
label text — the session's `AgentLabel` and its picked name are unaffected
either way, since both are keyed by `session_id` in the extension and never
derived from hook payloads. `backgroundAgentType` (the most recently started
subagent's `agent_type`, e.g. `"Explore"`) is still round-tripped in the
state file by the hook handler, but the extension no longer reads it.

A plain backgrounded `Bash` call (`run_in_background: true`, no subagent
involved) has no equivalent bracketing hook — Claude Code's hook reference
doesn't document a "backgrounded Bash job finished" event — so it can't be
tracked as precisely as a subagent's `pendingBackgroundCount`. Instead,
`pendingBackgroundBash` is a heuristic boolean: `hook-handler.ts` sets it
when a `PreToolUse`/`PostToolUse` payload has `tool_name: "Bash"` and
`tool_input.run_in_background === true` (true on both the launch's
`PreToolUse` and its own immediate `PostToolUse` — that pair always lands
before `Stop`, so neither is mistaken for the signal below), and clears it
on the *first other hook event this session fires after a `Stop` already
found it pending* (checked via the previous `status` in the state file,
also read back in `readPriorState`). Claude Code doesn't fire hooks while a
session is genuinely idle, so any further event is treated as evidence the
session woke back up — either because the backgrounded command resolved, or
because the user started a new turn regardless of it. That second case is a
known imprecision: it clears `pendingBackgroundBash` even if the original
command is technically still running in the background, which can let a
*later* `Stop` read as `done` a beat early. Narrow enough in practice to
accept without a real "job finished" hook to build on.

`waiting_background` has its own staleness bound rather than sharing
`RUNNING_STALE_MS` — a genuinely long-running backgrounded subagent
shouldn't get its label retired on the same 20-minute leash as an ordinary
tool call. If `SubagentStop` were ever to not fire at all (e.g. the
subagent's process is killed outright rather than finishing cleanly) —
pid-liveness on the parent CLI process wouldn't catch that, since the parent
is still alive and idling — `isConsultingStale` in `indicator.ts` bounds it
at `CONSULTING_STALE_MS` (45 minutes), the same shape as `isCompactingStale`/
`COMPACTING_STALE_MS` for an abandoned `/compact`. Both are file-anchored off
`updated_at`, exactly like `isRunningStale`, and feed into
`deriveEffectiveStatus`'s single `isStale` param (one boolean, since
`state.status` is singular — at most one of the three checks can be true for
a given state) — so, like the `running` case below, they're re-evaluated on
every `applyStates()` call, including the periodic re-scan, rather than
relying solely on each `AgentLabel`'s own in-memory
`_armCompactingTimeout`/`_armConsultingTimeout` GLib timer. That timer is
still what fires the retirement in the common case, but being in-memory and
armed only on entry into the state, it resets to zero if the extension or
GNOME Shell reloads mid-flight; the file-anchored check is what catches a
session that was already stale before such a reload, on the very next
30-second tick instead of only after a fresh multi-minute wait.

Garbage collection: `SessionEnd` deleting the file is the common path. Two
fallbacks cover what it can't: (1) whenever an `AgentLabel` retires for any
reason (clean finish or a dead/crashed session), the extension deletes that
session's file too, in case `SessionEnd` never fired; (2) a periodic
`GLib.timeout_add_seconds` tick (`PERIODIC_REFRESH_SECONDS` in
`extension.ts`) re-scans the sessions directory even when nothing has
touched it, so a session whose process was killed mid-run (no `Stop`, no
`SessionEnd`, so its file is never touched again) still gets its
pid-liveness check re-evaluated and its label retired instead of sticking
forever.

pid-liveness alone doesn't cover every way a session goes quiet, though: if
a turn ends by interruption rather than a clean `Stop` (e.g. the user
rejects/aborts a tool call and sends something else instead), Claude Code
fires no hook at all for that — no `PostToolUse`, no `Stop`, no
`SessionEnd` — and the CLI process just goes back to idling, alive the
whole time. `deriveEffectiveStatus`'s `isStale` param (`state.ts`), fed by
`isRunningStale`/`RUNNING_STALE_MS` in `indicator.ts`, is the fallback for
that case:
a "running" status whose file hasn't moved in 20 minutes is no longer
trusted regardless of pid-liveness. The same periodic re-scan above is what
re-evaluates it, so no separate timer is needed. On a much longer leash
than the `waiting_approval`/`compacting` cases specifically because a
single legitimate tool call (a big test suite, a package install) can
easily run this long between hook updates on its own.

## Extension internals

- `extension.js`: `Extension` subclass per the GNOME 45+ ESM API.
  `enable()` creates the `PanelMenu.Button`, starts the `Gio.FileMonitor` on
  the sessions directory, starts the periodic GC/re-scan timeout.
  `disable()` tears down all three, disconnects every signal, and clears the
  indicator's in-memory session maps — full enable/disable symmetry (see
  [SECURITY.md](SECURITY.md)).
- Panel indicator: not a single aggregate icon — one label per live session
  (an `AgentLabel`, `lib/indicator.ts`), so a waiting session is never
  hidden behind another session's running/idle state. Labels beyond a small
  inline cap fold into a "+N more" chip; the "Agents are recovering ☕" label shows only
  when zero sessions are live.
- Popup menu: a "Claude Usage" section (a single "Show usage" button that
  opens the account-level rate-limit check in a terminal), a notification
  toggle, and an "Exit" action.
- `prefs.js`: GNOME 45+ preferences window (libadwaita), separate process
  from the shell — must not import `St`/`Clutter`/`Meta`/`Shell` here. Not
  built yet — see [Install flow](#install-flow) below; the Notifications
  toggle currently lives in the popup menu instead, in-memory only.

All file reads off the FileMonitor callback are async (`Gio.File` async
APIs), never sync I/O on the shell's main loop.

## Install flow

Writing into `~/.claude/settings.json` is the one place ClaudeWatch touches a
file it doesn't own, so it needs to be explicit, reversible, and never
automatic:

1. User clicks "Enable Claude Code integration" in the extension's
   preferences (never triggered from `enable()` — must be a deliberate user
   action per GNOME review rules).
2. ClaudeWatch reads the existing `settings.json` (if any), shows what it's
   about to add (the hook command entries), and writes a timestamped backup
   copy before touching the original.
3. It merges its hook entries into the existing `hooks` object rather than
   overwriting the file — users likely already have other hooks configured.
4. An "Uninstall" action reverses exactly the entries ClaudeWatch added,
   tracked by a marker (e.g. a comment-equivalent identifiable command path)
   so it doesn't remove hooks the user added themselves.

## Open questions

Track decisions here as they're made; move resolved ones into the relevant
section above.

- **Hook handler runtime** — resolved: plain Node.js, zero npm dependencies,
  single file. Confirmed fine in practice — Claude Code already requires
  Node on `PATH` to run at all.
- **File-per-event vs. daemon+socket** — resolved: file-per-session, as
  built. Revisit only if the panel needs push-latency lower than a
  `Gio.FileMonitor` tick can give, or if per-event disk I/O shows up as a
  real cost.
- **Exact hook event set** — resolved: `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PreCompact`, `PostCompact`, `PermissionRequest`,
  `Notification`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd`.
  Confirmed against the live hooks reference
  ([hooks reference](https://code.claude.com/docs/en/hooks)): `session_id`
  is present on every hook's payload, and `SessionEnd` fires on session
  termination with no decision control — a plain side-effect hook, which is
  all the cleanup path needs. `SubagentStart`/`SubagentStop` were added for
  the "Backgrounded subagent work" case above. `PostCompact` was added
  later than the rest of this list — it didn't exist yet when the
  transcript-tailing fallback in `_watchTranscriptForCompactOutcome()`
  (indicator.ts) was written to work around its absence; that fallback
  stays in place as the belt-and-suspenders path (it also covers a
  cancelled /compact, which fires no hook at all — see EXTENSION.md).
  `SessionStart` isn't wired up: nothing in the current state machine needs
  a session to exist before its first real activity, so skipping it avoids
  one more hook entry to install.
- **Multi-session panel UI** — resolved differently than the aggregate-icon
  sketch above: one label per live session (capped, with overflow folding
  into a chip) rather than a single icon reflecting a priority-ordered
  aggregate. Chosen so a waiting session's request for input is always
  visibly distinct, not collapsed into one shared color/text.
- **GSettings schema ID**: still open — must be namespaced under
  `org.gnome.shell.extensions.<uuid>` per EGO rules — pin the extension UUID
  early since it's load-bearing for the schema path and can't change later
  without breaking installs. Matters once `prefs.js` actually lands.
