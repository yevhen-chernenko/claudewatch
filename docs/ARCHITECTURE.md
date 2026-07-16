# Architecture

Status: planning draft. Nothing in this document is implemented yet.

## Components

CodeWatch has two independent halves that only agree on a file format. They
are versioned, installed, and reviewed separately.

1. **Hook handler** — a small script invoked by Claude Code itself, once per
   configured hook event. Not part of the GNOME extension package; not
   reviewed by extensions.gnome.org. Lives in its own repo location (e.g.
   `hooks/`) and is installed by the user (or by a setup action in the
   extension's preferences — see [Install flow](#install-flow)) as a command
   entry in `~/.claude/settings.json`.
2. **GNOME Shell extension** — GJS, ESM module format (GNOME 45+), the only
   piece submitted to extensions.gnome.org. Reads local state, renders the
   panel indicator and popup menu, owns preferences.

There is no long-running daemon in v1. The hook handler runs, does one small
write, and exits — every invocation. This is a deliberate simplification:
no process lifecycle to manage, no socket to secure, nothing to leak memory
between runs, nothing for the extension to spawn. If per-event file I/O
turns out to be too slow or too coarse (see [Open questions](#open-questions)),
a daemon + IPC socket is the fallback design for v2, not the v1 starting point.

```
Claude Code session
   │  (hook event, JSON on stdin)
   ▼
hook handler (node, zero deps)
   │  atomic write
   ▼
~/.local/state/codewatch/sessions/<session_id>.json
   │  Gio.FileMonitor (directory watch)
   ▼
GNOME extension (indicator + popup menu)
```

## Session state file

One file per Claude Code session, so concurrent sessions never contend for
the same file — each is written only by its own hook invocations, which are
serial by construction (Claude Code doesn't fire two hooks for one session
at once). This sidesteps file-locking entirely for v1.

Path: `${XDG_STATE_HOME:-~/.local/state}/codewatch/sessions/<session_id>.json`

Draft schema:

```jsonc
{
  "session_id": "abc123",
  "cwd": "/home/user/project",
  "status": "idle | running | waiting_approval | done",
  "started_at": "2026-07-16T10:00:00Z",
  "last_event_at": "2026-07-16T10:04:12Z",
  "counters": { "tool_calls": 12, "files_edited": 3, "commands_run": 5 },
  "last_notification": { "type": "permission_prompt", "at": "..." },
  "transcript_path": "/home/user/.claude/.../transcript.jsonl",
}
```

Write is a single `fs.writeFileSync(tmp)` + `rename()` (atomic replace on the
same filesystem) — never a partial-write read by the extension.

### Session lifecycle / state machine

| Hook event                                                                                             | Transition                                                                        |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `SessionStart`                                                                                         | create file, `status: idle`                                                       |
| `PreToolUse` / `PostToolUse`                                                                           | `status: running`, bump counters, refresh `last_event_at`                         |
| `Notification` (`permission_prompt`)                                                                   | `status: waiting_approval`, fire desktop notification                             |
| `Notification` (`idle_prompt`)                                                                         | `status: idle`                                                                    |
| `Stop`                                                                                                 | `status: done`, fire desktop notification, keep file around briefly for the recap |
| `SessionEnd` (if present at implementation time — confirm exact event name against current hooks docs) | delete the session file, or mark for GC                                           |

Garbage collection: the extension, on a periodic `GLib.timeout_add_seconds`
tick, removes session files whose `last_event_at` is older than a configurable
threshold (default a few hours) and whose status is `done` or stale-`idle`.
This also covers the case where a session's process was killed and never
fired a terminal hook — files don't accumulate forever.

## Extension internals

- `extension.js`: `Extension` subclass per the GNOME 45+ ESM API.
  `enable()` creates the `PanelMenu.Button`, starts the `Gio.FileMonitor` on
  the sessions directory, starts the GC timeout. `disable()` tears down all
  three, disconnects every signal, and clears any in-memory `Map` of session
  state — full enable/disable symmetry (see [SECURITY.md](SECURITY.md)).
- Panel indicator: icon/spinner reflecting the _aggregate_ state across all
  live sessions, priority order `waiting_approval > running > done > idle`
  (an approval request anywhere should never be hidden behind an "idle"
  icon just because another session is quiet).
- Popup menu: one row per active session (cwd, status, mechanical counters),
  plus a rolling recap section.
- `prefs.js`: GNOME 45+ preferences window (libadwaita), separate process
  from the shell — must not import `St`/`Clutter`/`Meta`/`Shell` here. Hosts
  the notification toggles, GC threshold, and the hook install/uninstall
  action.

All file reads off the FileMonitor callback are async (`Gio.File` async
APIs), never sync I/O on the shell's main loop.

## Install flow

Writing into `~/.claude/settings.json` is the one place CodeWatch touches a
file it doesn't own, so it needs to be explicit, reversible, and never
automatic:

1. User clicks "Enable Claude Code integration" in the extension's
   preferences (never triggered from `enable()` — must be a deliberate user
   action per GNOME review rules).
2. CodeWatch reads the existing `settings.json` (if any), shows what it's
   about to add (the hook command entries), and writes a timestamped backup
   copy before touching the original.
3. It merges its hook entries into the existing `hooks` object rather than
   overwriting the file — users likely already have other hooks configured.
4. An "Uninstall" action reverses exactly the entries CodeWatch added,
   tracked by a marker (e.g. a comment-equivalent identifiable command path)
   so it doesn't remove hooks the user added themselves.

## Open questions

Track decisions here as they're made; move resolved ones into the relevant
section above.

- **Hook handler runtime**: plan is plain Node.js, zero npm dependencies,
  single file — Claude Code already requires Node, so this adds no new
  runtime dependency for the user. Confirm no case exists where Claude Code
  is installed without a usable `node` on `PATH` before locking this in.
- **File-per-event vs. daemon+socket**: start with the file-per-session
  design above. Revisit only if the popup menu needs push-latency lower than
  a `Gio.FileMonitor` tick can give, or if per-event disk I/O shows up as a
  real cost.
- **Exact hook event set for v1**: `SessionStart`, `PreToolUse`, `PostToolUse`,
  `Notification`, `Stop` per the brief. Verify `SessionEnd` semantics and any
  newer/renamed events against the live hooks reference
  (https://code.claude.com/docs/en/hooks) at implementation time — the event
  list has changed since this doc was written.
- **Multi-session aggregate icon rules**: priority order proposed above;
  needs a quick usability pass once the panel exists.
- **GSettings schema ID**: must be namespaced under
  `org.gnome.shell.extensions.<uuid>` per EGO rules — pin the extension UUID
  early since it's load-bearing for the schema path and can't change later
  without breaking installs.
