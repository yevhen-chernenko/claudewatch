# First-time setup

Status: manual, start-to-finish. There is no installer yet — see
[ARCHITECTURE.md#install-flow](ARCHITECTURE.md#install-flow) for the
automated flow this will eventually become. Until that lands, every step
below is something a user (including you, today) has to do by hand, and
nothing here happens automatically just from enabling the GNOME extension.

## Prerequisites

- **GNOME Shell 46** (`gnome-shell --version`) — the UUID's `shell-version`
  in `extension/metadata.json`.
- **Claude Code**, installed and run at least once interactively (a plain
  `claude` login, not just `claude setup-token`). This is what creates
  `~/.claude/settings.json` (Step 2 writes into it) and, if you want the
  optional Claude Usage row (Step 4), `~/.claude/.credentials.json`.
- **Node.js on `PATH`** — the hook handler is a `node` script. Claude Code
  already requires Node to run at all, so if `claude` works, this is
  already satisfied; no separate install.

## Step 1 — Build

```sh
git clone <this repo>
cd claudewatch
npm install
npm run build
```

This compiles `src/` into `dist/` (gitignored). Two things come out of it
that the next two steps depend on: `dist/extension/` (the GNOME extension
itself) and `dist/hooks/hook-handler.js` (what Claude Code will invoke).
Note the absolute path to `dist/hooks/hook-handler.js` on your machine —
Step 3 needs it verbatim.

## Step 2 — Install the GNOME extension

```sh
ln -s "$PWD/dist/extension" ~/.local/share/gnome-shell/extensions/claudewatch@yevhen-chernenko.github.io
gnome-extensions enable claudewatch@yevhen-chernenko.github.io
```

Reload the shell so it picks up the new symlink (X11: Alt+F2, `r`, Enter;
Wayland: log out and back in). You should see a single "Agents are
recovering ☕" label appear in the top panel — that's the extension running
with zero live sessions, not a sign anything is broken.

## Step 3 — Wire up Claude Code's hooks

This is the step with no automation yet, and the one most likely to be
skipped silently: without it, the panel will sit on "Agents are recovering
☕" forever, no matter what you do in Claude Code, because Claude Code never
tells the hook handler anything happened.

Open `~/.claude/settings.json` (create it if it doesn't exist) and merge
these entries into its top-level `hooks` object — **merge, don't overwrite**;
if you already have other hooks configured, add to the arrays rather than
replacing them. Replace `/absolute/path/to/claudewatch` with the path from
Step 1:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "PreCompact": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["/absolute/path/to/claudewatch/dist/hooks/hook-handler.js"], "async": true }] }
    ]
  }
}
```

This is the complete event set the hook handler understands (see
`resolveStatus()` in `src/hooks/lib/status.ts` and
[ARCHITECTURE.md](ARCHITECTURE.md#session-lifecycle--state-machine)) —
omitting one just means that transition never shows up in the panel (e.g.
skip `PreCompact` if you don't care about seeing the "training" state).
Skipping `SubagentStart`/`SubagentStop` specifically means a session that
spawns a subagent and stops the visible turn while it's still working (e.g.
a backgrounded Task/Agent call) will flash "done" early instead of showing
"consulting" — see ARCHITECTURE.md for why.
`SessionEnd` is the one that matters most to not skip: without it, session
state files are only cleaned up by the periodic re-scan / label-retirement
fallbacks instead of immediately.

No restart of Claude Code is needed — hooks are read per-invocation, so the
very next prompt you send in any session picks this up.

## Step 4 — Verify

Fastest check, no real Claude Code session needed:

```sh
echo '{"hook_event_name":"UserPromptSubmit","session_id":"smoke-test"}' \
  | node /absolute/path/to/claudewatch/dist/hooks/hook-handler.js
```

The panel should switch to "Agent `<name>` is working 🕶️" within about a
second. If it doesn't, see Troubleshooting below. Clean up with:

```sh
echo '{"hook_event_name":"SessionEnd","session_id":"smoke-test"}' \
  | node /absolute/path/to/claudewatch/dist/hooks/hook-handler.js
```

Then confirm it end-to-end: open a real Claude Code session (CLI, VS Code
extension, or Desktop app's Code tab all work identically — see
[ARCHITECTURE.md#surface-independence](ARCHITECTURE.md#surface-independence))
and send a prompt. See [TESTING.md](TESTING.md) for a much longer scripted
walkthrough covering multi-session, notifications, and the popup menu.

## Step 5 — Optional: the "Claude Usage" rate-limit row

Skip this if you don't care about the 5h/7d usage percentages in the popup
menu — nothing else in the extension depends on it. It's opt-in by design
(see [SECURITY.md](SECURITY.md#opt-in-network-egress-the-rate-limit-check)):
the extension never creates this file itself.

```sh
mkdir -p ~/.config/claudewatch
ln -s ~/.claude/.credentials.json ~/.config/claudewatch/token
```

Then click "Show usage" in the popup menu. Full details, including why
it must be this file specifically (not `claude setup-token` output) and
what each error message on that row means, are in
[EXTENSION.md#setting-up-the-claude-usage-token](EXTENSION.md#setting-up-the-claude-usage-token).

The same token file also powers "Detailed usage" — a terminal-based,
auto-refreshing view of the same check — so no separate setup is needed
for it beyond this step. It additionally needs **Python 3** (stdlib only,
already on most distros) and **a terminal emulator on `PATH`**
(`gnome-terminal`/GNOME Console are already present on stock GNOME; set
`$TERMINAL` if you use something else it doesn't already know about — see
[EXTENSION.md](EXTENSION.md#popup-menu)).

## Troubleshooting

- **Panel never leaves "Agents are recovering ☕", even mid-prompt**: almost
  always Step 3 — either the hooks aren't in `~/.claude/settings.json` at
  all, or the `args` path doesn't point at your actual `dist/hooks/hook-handler.js`
  (check you used an absolute path, and that you ran `npm run build` after
  cloning). Confirm by running the Step 4 smoke-test command directly —
  if the panel doesn't move even from that, the extension/build is the
  problem, not the hook wiring; if it does move but real Claude Code
  sessions never trigger it, the hook wiring in `settings.json` is the
  problem.
- **Smoke-test command errors instead of running**: `node` isn't on `PATH`,
  or `dist/hooks/hook-handler.js` doesn't exist yet — re-run `npm run build`.
- **A session's label gets stuck on one state**: check
  `${XDG_STATE_HOME:-~/.local/state}/claudewatch/sessions/<session_id>.json`
  directly — if `pid` refers to a process that's no longer running, the
  periodic re-scan (`PERIODIC_REFRESH_SECONDS` in `extension.ts`, 30s by
  default) should retire it on its own; if it doesn't, that's a bug, not a
  setup problem.
- **Claude Usage row stuck on an error**: the row's own text is the error
  (e.g. "No token file at …", "OAuth token expired — run claude to refresh
  it") — see [EXTENSION.md](EXTENSION.md#setting-up-the-claude-usage-token)
  for what each one means.
