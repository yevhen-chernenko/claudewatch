# Manual testing

`npm test`/`npm run build` need Node ≥20.12 (`engines.node` in
`package.json`, `.nvmrc` pins the dev version) — `vite`'s `rolldown`
dependency imports `node:util`'s `styleText`, added in that Node release, so
older Nodes fail at startup with a `SyntaxError` before a single test runs.
This is a dev-toolchain-only requirement: the *installed* `hook-handler.js`
is zero-dependency plain JS and runs fine on whatever ancient Node Claude
Code itself already requires (see [SETUP.md](SETUP.md)'s Prerequisites) —
only building/testing this repo needs the newer one. Run `nvm use` first if
your default `node` is older.

Status: for the per-session implementation (see
[ARCHITECTURE.md](ARCHITECTURE.md)). The pure logic (`resolveUiAction()`/
`deriveEffectiveStatus()` in `lib/state.ts`, `resolveStatus()` in
`hooks/lib/status.ts`) has vitest coverage (`npm test`) — this doc is for
everything else: the GJS-dependent
glue in `extension.ts`, `lib/indicator.ts`, and `hooks/hook-handler.ts`'s
stdin/fs wrapper, none of which can run under Node. This is what to run by
hand after touching `src/extension/extension.ts`, anything under
`src/extension/lib/`, `extension/detailed-usage.py`, or
`src/hooks/hook-handler.ts`. See
[EXTENSION.md](EXTENSION.md#file-layout) for what lives in each file, and
[EXTENSION.md#building](EXTENSION.md#building) for the `npm run build` step
these commands assume you've already run.

## Reload the extension

The shell only picks up `dist/extension/extension.js` changes on reload, not
live, and only after a `npm run build`:

- X11: Alt+F2, type `r`, Enter.
- Wayland: log out and back in (no in-session reload).

## Dev preview menu

Fastest way to check a visual (color, text, pulse, flash timing) without
driving a real hook event or writing a state file. Create a `.env` file at
the repo root containing:

```sh
CLAUDEWATCH_DEV=1
```

(already gitignored, same as any other local-only config) and run
`npm run build` — `copy-assets.mjs` copies it into `dist/extension/.env`
next to `detailed-usage.py`/`ascii.txt`/etc., and `indicator.ts`'s
`readDevModeFlag()` reads it back from there at `enable()` time. A process
env var doesn't work for this: GNOME Shell inherits its environment from the
display manager / login session, not from whatever terminal `npm run build`
happens to run in, so the file is what actually gets read. Reload the
extension (see above) to pick it up.

With it set, the popup menu gets a "Dev: preview state" section at the
bottom with one button per possible panel look: Standby / clear preview,
Running, Waiting, Compacting, Consulting, Complete, and the Overflow chip.
Clicking one closes the menu (so the panel is unobstructed for a screenshot)
and drives a synthetic `__preview__` label through the same `AgentLabel`
code real sessions use — it never touches `sessions/` on disk and is
invisible to `applyStates()`, so it can't be retired by a real session's
file changing and doesn't affect anything a real session is doing
concurrently. "Complete" replays the real green flash and auto-retires after
`COMPLETE_FLASH_MS` (5s) exactly like a real completion. Without a
`CLAUDEWATCH_DEV=1` in `dist/extension/.env`, this section doesn't exist —
nothing to disable for a normal install/build.

## Drive the hook handler directly

Simulates the wired events without needing a real Claude Code turn. Every
payload needs a `session_id` — the hook handler no-ops without one. Watch
the panel after each command — it updates within ~1s via the
`Gio.FileMonitor` on `sessions/` in `extension.ts`, no reload needed. Run
`npm run build` first so `dist/hooks/hook-handler.js` is current.

Notifications (`Main.notify` + themed sound) only fire while the popup
menu's **Notifications** toggle is on — on by default on every `enable()`.
Turn it off first (open the menu, flip the switch) if you want to confirm
they're suppressed; the panel color/text transitions themselves happen
either way.

```sh
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agent <name> is working 🕶️" (orange, pulsing) — <name> is
# picked once per session from a fixed list in lib/indicator.ts

echo '{"hook_event_name":"Notification","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agent <name> needs support 📞" (blue, static — no pulse)
# also fires a desktop notification (Main.notify) plus a "dialog-question"
# themed system sound, if the Notifications toggle is on

echo '{"hook_event_name":"PermissionRequest","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# same "waiting" transition as Notification above — PermissionRequest and
# Notification both map to status: waiting_approval in hook-handler.ts

echo '{"hook_event_name":"PreToolUse","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agent <name> is working 🕶️" (orange, pulsing) again — confirms
# the waiting -> running edge fires once a permission prompt is answered and
# tool execution resumes, instead of staying blue until Stop

echo '{"hook_event_name":"PreCompact","trigger":"manual","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agents are training 🔫" (purple, pulsing) — manual /compact; no
# agent name in this state, since it isn't retained into the next session

echo '{"hook_event_name":"PreCompact","trigger":"auto","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# no-op: state file is untouched, panel doesn't move — auto-compact isn't
# surfaced as its own state

echo '{"hook_event_name":"PostCompact","trigger":"manual","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# deletes sessions/test-1.json immediately (same as SessionEnd, bypassing
# resolveStatus entirely) — panel drops straight back to "Agents are
# recovering ☕" with no green "complete" flash. Re-run the PreCompact
# manual line above first if you want to see the purple state before this
# clears it.

echo '{"hook_event_name":"PreCompact","trigger":"manual","session_id":"test-1"}' | node dist/hooks/hook-handler.js
echo '{"hook_event_name":"PostCompact","trigger":"auto","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# no-op, same as PreCompact/auto: state file still says "compacting", panel
# stays purple — confirms PostCompact only ends the state for a manual
# trigger, mirroring the PreCompact side that started it

echo '{"hook_event_name":"PreCompact","trigger":"manual","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agents are training 🔫" (purple) again. This state file has no
# transcript_path, so _watchTranscriptForCompactOutcome() has nothing to
# tail and only the COMPACTING_STALE_MS fallback applies here — leave it
# alone and wait ~3 minutes without firing any other hook, simulating a
# cancelled /compact.
# Confirms the timeout self-heal: the label should retire (panel falls back
# to "Agents are recovering ☕") on its own without a state-file write forcing it. To test
# the timeout itself instead of trusting the 3-minute wait, temporarily
# lower COMPACTING_STALE_MS in lib/indicator.ts, rebuild, and repeat.

# To test the fast path instead (_watchTranscriptForCompactOutcome), point
# a state file at a throwaway transcript file — NOT a real one under
# ~/.claude/projects/, so there's no risk of corrupting actual session data:
FAKE_TRANSCRIPT=/tmp/claudewatch-fake-transcript.jsonl
echo '{"type":"user","message":{"role":"user","content":"hi"}}' > "$FAKE_TRANSCRIPT"
SESSIONS_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claudewatch/sessions"
mkdir -p "$SESSIONS_DIR"
cat > "$SESSIONS_DIR/test-1.json" <<EOF
{
  "session_id": "test-1",
  "status": "compacting",
  "updated_at": "$(date -Iseconds)",
  "transcript_path": "$FAKE_TRANSCRIPT",
  "pid": $$
}
EOF
# panel -> "Agents are training 🔫" (purple). Then append one of the two
# outcome markers Claude Code itself writes on a real /compact, and confirm
# the label retires within a second or two — well before the 3-minute
# fallback:
echo '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}' \
  >> "$FAKE_TRANSCRIPT"
# (repeat the state-file step above and use this line instead to test the
# cancel marker:)
echo '{"type":"system","subtype":"local_command","content":"<local-command-stderr>AbortError: Compaction canceled.</local-command-stderr>"}' \
  >> "$FAKE_TRANSCRIPT"

echo '{"hook_event_name":"Stop","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agent <name> is done 🎖️" (green flash, then "Agents are recovering ☕" once
# the 5s flash elapses and the label retires) — also fires a desktop
# notification plus a "complete" themed system sound, if the Notifications
# toggle is on

echo '{"hook_event_name":"SessionEnd","session_id":"test-1"}' | node dist/hooks/hook-handler.js
# deletes sessions/test-1.json immediately — if run while a label is still
# live (before its complete flash elapses), confirm the flash is NOT cut
# short (AgentLabel.handleMissing() no-ops while uiState is "complete").

echo '{"hook_event_name":"UserPromptSubmit","session_id":"consult-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agent <name> is working 🕶️" (orange, pulsing)

echo '{"hook_event_name":"SubagentStart","session_id":"consult-1","agent_type":"Explore"}' | node dist/hooks/hook-handler.js
# still "running" — a subagent starting doesn't change the visible state on
# its own, it only increments the session's pendingBackgroundCount

echo '{"hook_event_name":"Stop","session_id":"consult-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agent <name> is consulting "Explore" manual 📓" (olive, pulsing)
# — the visible turn ended but the subagent it spawned hasn't reported back
# yet, so this reads as its own "consulting" state instead of flashing
# "done" early or looking stuck on "running"

echo '{"hook_event_name":"SubagentStop","session_id":"consult-1"}' | node dist/hooks/hook-handler.js
# panel -> back to "Agent <name> is working 🕶️" (orange, pulsing) — the
# subagent reported back, pendingBackgroundCount drops to 0, and the parent
# turn resumes

echo '{"hook_event_name":"Stop","session_id":"consult-1"}' | node dist/hooks/hook-handler.js
# panel -> "Agent <name> is done 🎖️" (green flash, then "Agents are
# recovering ☕" once the label retires) — nothing left pending this time

echo '{"hook_event_name":"SessionEnd","session_id":"consult-1"}' | node dist/hooks/hook-handler.js
# deletes sessions/consult-1.json
```

Inspect a session's state file directly if the panel doesn't move:

```sh
ls "${XDG_STATE_HOME:-$HOME/.local/state}/claudewatch/sessions/"
cat "${XDG_STATE_HOME:-$HOME/.local/state}/claudewatch/sessions/test-1.json"
```

## Multiple sessions

Confirms the core of the multi-session feature: independent labels, the
overflow chip, and "Agents are recovering ☕" appearing only once every session has
retired.

```sh
echo '{"hook_event_name":"UserPromptSubmit","session_id":"multi-1"}' | node dist/hooks/hook-handler.js
echo '{"hook_event_name":"UserPromptSubmit","session_id":"multi-2"}' | node dist/hooks/hook-handler.js
# panel -> two independent labels, e.g. "Agent Smith is working 🕶️" and
# "Agent Johnson is working 🕶️" — different names (pickAgentName() avoids
# collisions between concurrently-live sessions)

echo '{"hook_event_name":"Notification","session_id":"multi-2"}' | node dist/hooks/hook-handler.js
# only multi-2's label turns blue ("needs support"); multi-1 keeps pulsing
# orange, unaffected

echo '{"hook_event_name":"UserPromptSubmit","session_id":"multi-3"}' | node dist/hooks/hook-handler.js
echo '{"hook_event_name":"UserPromptSubmit","session_id":"multi-4"}' | node dist/hooks/hook-handler.js
# with MAX_INLINE_AGENTS = 3, the 4th concurrent session should NOT get its
# own inline label — instead the panel shows 3 labels plus a "+1 more" chip.

echo '{"hook_event_name":"Stop","session_id":"multi-1"}' | node dist/hooks/hook-handler.js
echo '{"hook_event_name":"Stop","session_id":"multi-2"}' | node dist/hooks/hook-handler.js
echo '{"hook_event_name":"Stop","session_id":"multi-3"}' | node dist/hooks/hook-handler.js
echo '{"hook_event_name":"Stop","session_id":"multi-4"}' | node dist/hooks/hook-handler.js
# each label flashes green independently, then retires — confirm "All
# Agents are recovering" only appears once the last of the four has finished its flash,
# never while any of the other three are still mid-flash or running.
```

To simulate a killed/crashed session (no `Stop`, no `SessionEnd`), write a
state file with a `pid` that doesn't exist and wait for the periodic
re-scan (`PERIODIC_REFRESH_SECONDS`, 30s by default) or trigger any other
session's hook event to force an immediate directory-monitor tick:

```sh
SESSIONS_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claudewatch/sessions"
mkdir -p "$SESSIONS_DIR"
cat > "$SESSIONS_DIR/crashed.json" <<EOF
{"session_id": "crashed", "status": "running", "updated_at": "$(date -Iseconds)", "pid": 999999}
EOF
```

`isSessionAlive()` discounts a stale status as soon as it's checked, and
`applyStates()`'s first-sight check uses that same liveness check before
ever creating a label — so a pid that's already dead at creation time
should be skipped entirely rather than producing a label at all. If a label
does appear and stay for this one, that's worth investigating as a
regression, not expected behavior.

## Popup menu

Click the indicator to open the menu.

- **Claude Usage section** — a labeled separator followed by a single "Show
  usage" button (account-level, not per-session; this is the only usage
  source in the extension — there's no inline rate-limit row in the menu).
  - **Notifications** toggle — should be **on** immediately after enabling
    the extension. Turn it off and run the "Drive the hook handler directly"
    `Notification` and `Stop` events, and confirm the panel color/text still
    transition but no `Main.notify` popup or sound fires. Turn the toggle
    back on and repeat: both events should now also produce a notification +
    themed sound. Toggling should never close the popup menu.
  - **Show usage** button — needs a token file first; see
    [EXTENSION.md](EXTENSION.md#setting-up-the-claude-usage-token) for how
    to create `~/.config/claudewatch/token` (normally a symlink to
    `~/.claude/.credentials.json`). Click it and confirm a terminal window
    opens showing "Claude usage — detailed view", the 5h/7d utilization and
    reset times (both a relative and absolute reset time), and a progress
    bar counting up to "next refresh in 60s" that ticks down once per second
    and triggers a fresh fetch when it completes — leave it running past one
    full cycle to confirm the auto-refresh actually happens, not just the
    countdown. Confirm Ctrl-C inside that terminal exits cleanly (a
    "Stopped." line, no traceback) and closes only that window, not the
    extension or any other session. Rename the token file temporarily to
    confirm the terminal shows "No token file at …" instead of crashing;
    truncate it to an empty file to confirm "Token file is empty". For the
    JSON token form, replace the file with `{}` to confirm "No
    claudeAiOauth.accessToken in token file", and with a copy of
    `.credentials.json` whose `expiresAt` is edited into the past to
    confirm "OAuth token expired — run claude to refresh it". To test the
    no-terminal-found path, temporarily rename every terminal emulator
    binary on `PATH` (or run in an environment without one) and confirm the
    "Show usage" row's own label becomes an inline "no terminal emulator
    found on PATH" error instead of the click silently doing nothing.
- **Exit** — clicking it should remove the indicator from the panel
  immediately and it should not reappear on the next login (it's gone from
  `dconf read /org/gnome/shell/enabled-extensions`) until re-enabled via
  `gnome-extensions enable` or the Extensions app.

## End-to-end

Send a real prompt in two or more Claude Code sessions with the hooks
installed (see `~/.claude/settings.json`, including `SessionEnd`) and
confirm each gets its own independent panel label that tracks its own
status, "Agents are recovering ☕" only shows once every session has finished and
flashed, and `sessions/*.json` doesn't accumulate stale files after a
session ends cleanly (`ls` the directory before/after).
