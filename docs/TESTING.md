# Manual testing

Status: interim, for the single-state-file implementation (see
[ARCHITECTURE.md](ARCHITECTURE.md) for the per-session design this will move
to). No automated tests yet — this is what to run by hand after touching
`extension/extension.js` or `hooks/hook-handler.js`.

## Reload the extension

The shell only picks up `extension.js` changes on reload, not live:

- X11: Alt+F2, type `r`, Enter.
- Wayland: log out and back in (no in-session reload).

## Drive the hook handler directly

Simulates the two wired events without needing a real Claude Code turn.
Watch the panel label after each command — it updates within ~1s via the
`Gio.FileMonitor` in `extension.js`, no reload needed.

```sh
echo '{"hook_event_name":"UserPromptSubmit"}' | node hooks/hook-handler.js
# panel -> "Task is running…"

echo '{"hook_event_name":"Stop"}' | node hooks/hook-handler.js
# panel -> "Task complete!"
```

Inspect the state file directly if the panel doesn't move:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/codewatch/state.json"
```

## End-to-end

Send a real prompt in a Claude Code session with the hooks installed (see
`~/.claude/settings.json`) and confirm the panel flips to "Task is
running…" when the prompt is submitted and "Task complete!" once Claude
stops.
