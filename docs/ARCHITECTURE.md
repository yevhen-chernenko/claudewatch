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
surface-specific code. Verified directly: a bare `claude -p` session and a
VS Code-extension-driven session both produce/update the same
`<session_id>.json` shape and go through the same lifecycle.

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
  "status": "running | waiting_approval | done | compacting",
  "updated_at": "2026-07-16T10:04:12Z",
  "transcript_path": "/home/user/.claude/.../transcript.jsonl",
  "pid": 12345,
}
```

Write is a single `fs.writeFileSync(tmp)` + `rename()` (atomic replace on the
same filesystem) — never a partial-write read by the extension.

### Session lifecycle / state machine

| Hook event                                        | Transition                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | `status: running` (creates the file on first sight of a session)                          |
| `Notification` / `PermissionRequest`              | `status: waiting_approval`, fire desktop notification (if the Notifications toggle is on) |
| `PreCompact` (`trigger: "manual"`)                | `status: compacting`; `trigger: "auto"` is a no-op — not surfaced as its own state        |
| `Stop`                                            | `status: done`; the panel flashes green for 5s then the session's label retires           |
| `SessionEnd`                                      | delete the session's file immediately — the common-case cleanup path                      |

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
- Popup menu: the account-level "Claude Usage" rate-limit section, plus
  auto-refresh/notification toggles and an "Exit" action.
- `prefs.js`: GNOME 45+ preferences window (libadwaita), separate process
  from the shell — must not import `St`/`Clutter`/`Meta`/`Shell` here. Not
  built yet — see [Install flow](#install-flow) below; the
  Notifications/Auto-refresh toggles currently live in the popup menu
  instead, in-memory only.

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
  `PostToolUse`, `PreCompact`, `PermissionRequest`, `Notification`, `Stop`,
  `SessionEnd`. Confirmed against the live hooks reference
  ([hooks reference](https://code.claude.com/docs/en/hooks)): `session_id`
  is present on every hook's payload, and `SessionEnd` fires on session
  termination with no decision control — a plain side-effect hook, which is
  all the cleanup path needs. `SessionStart` isn't wired up: nothing in the
  current state machine needs a session to exist before its first real
  activity, so skipping it avoids one more hook entry to install.
- **Multi-session panel UI** — resolved differently than the aggregate-icon
  sketch above: one label per live session (capped, with overflow folding
  into a chip) rather than a single icon reflecting a priority-ordered
  aggregate. Chosen so a waiting session's request for input is always
  visibly distinct, not collapsed into one shared color/text.
- **GSettings schema ID**: still open — must be namespaced under
  `org.gnome.shell.extensions.<uuid>` per EGO rules — pin the extension UUID
  early since it's load-bearing for the schema path and can't change later
  without breaking installs. Matters once `prefs.js` actually lands.
