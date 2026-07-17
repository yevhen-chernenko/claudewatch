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
- **Show Usage** — a `PopupMenu.PopupSwitchMenuItem`. Data source turned out
  to be local after all: every hook payload includes `transcript_path`,
  pointing at the session's JSONL transcript, and each `assistant` entry in
  it already carries a `message.usage` block (input/output/cache token
  counts) — no CLI subcommand and no network call needed, so the "no network
  calls in v1" principle holds. Refresh is menu-open-triggered, matching the
  cadence guess below. Note the transcript repeats a message id once per
  content block, so the summarizer dedupes by `message.id` before summing.
- **Exit** — removes the extension's uuid from the `org.gnome.shell`
  `enabled-extensions` gsetting (the same mechanism the Extensions app and
  `gnome-extensions disable` use), which persists and lets the shell's own
  listener call `disable()` — no manual teardown duplicated in the handler.

Still using the single global `state.json`, not the per-session design from
ARCHITECTURE.md — `cwd`/`transcript_path` reflect whichever session last
fired a hook, same limitation already true of `status`.

## Done: Claude Usage rate-limit row (opt-in network call)

Added a fourth popup menu row, "Claude Usage", that reads the account-level
5-hour/7-day rate-limit windows (the same numbers the CLI's own TUI shows)
by reading `anthropic-ratelimit-unified-5h-*`/`-7d-*` response headers off a
minimal (`max_tokens: 1`) call to `api.anthropic.com/v1/messages`. There's
no local file or documented `claude` subcommand that exposes this data —
confirmed by checking `claude auth status`, `doctor`, `agents`, `project`,
and grepping the installed CLI binary — so a real API call is the only way.

This is CodeWatch's first network call, which is why it's deliberately
opt-in (does nothing without a manually-created
`~/.config/codewatch/token`, minted via `claude setup-token`) and
click-to-refresh rather than automatic — see
[SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check) for
the full reasoning and why the "no network calls" hardening checklist item
was updated rather than silently violated.
