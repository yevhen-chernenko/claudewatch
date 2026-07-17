# Next steps

Status: backlog of concrete features to build next, on top of the current
interim implementation. Not yet scheduled against [ROADMAP.md](ROADMAP.md)'s
phases — capturing them here first, phase them in later.

## Done: indicator menu (Open in VS Code, Show Usage, Exit)

The indicator's popup menu (`extension.js`) now has three rows:

- **Open in VS Code** — spawns `code <cwd>` via `Gio.Subprocess` (argv-array
  form, not a shell string) using the `cwd` the hook handler now captures
  from the hook JSON payload and writes into `state.json`. Insensitive until
  a `cwd` is known. If `code` isn't on PATH, `Gio.Subprocess.new` throws and
  the handler shows a `Main.notify` toast rather than failing silently.
- **Show Usage** — originally a `PopupMenu.PopupSwitchMenuItem` gating a
  hidden summary row; later removed in favor of an always-visible "Session"
  row (see the rate-limit section below — the two were merged under one
  "Claude Usage" section heading). Data source turned out to be local after
  all: every hook payload includes `transcript_path`, pointing at the
  session's JSONL transcript, and each `assistant` entry in it already
  carries a `message.usage` block (input/output/cache token counts) — no
  CLI subcommand and no network call needed, so the "no network calls in
  v1" principle holds. Refresh is menu-open- and hook-triggered. Note the
  transcript repeats a message id once per content block, so the summarizer
  dedupes by `message.id` before summing.
- **Exit** — removes the extension's uuid from the `org.gnome.shell`
  `enabled-extensions` gsetting (the same mechanism the Extensions app and
  `gnome-extensions disable` use), which persists and lets the shell's own
  listener call `disable()` — no manual teardown duplicated in the handler.

Still using the single global `state.json`, not the per-session design from
ARCHITECTURE.md — `cwd`/`transcript_path` reflect whichever session last
fired a hook, same limitation already true of `status`.

## Done: Claude Usage rate-limit row (opt-in network call)

Added a fourth popup menu row, originally titled "Claude Usage", that reads
the account-level
5-hour/7-day rate-limit windows (the same numbers the CLI's own TUI shows).
There's no local file or documented `claude` subcommand that exposes this
data — confirmed by checking `claude auth status`, `doctor`, `agents`,
`project`, and grepping the installed CLI binary — so a real network call is
the only way. Initially implemented as a `max_tokens: 1` Messages completion
call (parsing `anthropic-ratelimit-unified-*` response headers), which
worked but spent real API quota on every check. Replaced with a `GET` to
`api.anthropic.com/api/oauth/usage`, a dedicated usage-status endpoint that
doesn't invoke a model — found by reading the bundled source of the popular
"Claude Code Usage Tracker" VS Code extension, which uses the same endpoint.
This costs no quota, so the only remaining reason for the request/reset
cadence design is network-disclosure discipline, not cost avoidance.

This is CodeWatch's first network call, which is why it's deliberately
opt-in (does nothing without a manually-created
`~/.config/codewatch/token`, minted via `claude setup-token`). It
auto-refreshes once per real turn (edge-triggered off the Stop hook's
`status: "done"` transition) plus on manual click, rather than on a
background timer — see
[SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check) for
the full reasoning and why the "no network calls" hardening checklist item
was updated rather than silently violated.

Later merged with the Show Usage row above under one "Claude Usage" section
heading (a labeled `PopupSeparatorMenuItem`), with the Show Usage toggle
removed — both rows are always visible now, and a single "Refresh Usage"
button replaced the old click-target row as the manual-override trigger for
both. See [EXTENSION.md](EXTENSION.md#popup-menu) for the current
structure.
