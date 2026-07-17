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

## Popup menu

Click the indicator to open the menu. Needs a `state.json` with `cwd` and
`transcript_path` populated — a real hook-fired session covers this; to
fake it by hand:

```sh
mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/codewatch"
cat > "${XDG_STATE_HOME:-$HOME/.local/state}/codewatch/state.json" <<EOF
{
  "status": "done",
  "updated_at": "$(date -Iseconds)",
  "cwd": "$PWD",
  "transcript_path": "$(ls ~/.claude/projects/*/*.jsonl | head -1)"
}
EOF
```

- **Open in VS Code** — should be greyed out before any state file exists,
  clickable once `cwd` is set; clicking opens VS Code at that directory.
  Temporarily rename `code` off PATH to confirm the "couldn't launch"
  notification appears instead of a silent failure.
- **Show Usage** — toggling the switch on reveals a row below it with
  token counts (`In … · Out … · Cached …`); toggling off hides it again.
  Reopening the menu while it's on should refresh the numbers.
- **Claude Usage** — needs a token file first; see
  [EXTENSION.md](EXTENSION.md#setting-up-the-claude-usage-token) for how to
  create `~/.config/codewatch/token` via `claude setup-token`.

  Clicking the row should show "Checking…" then settle back to "Claude
  Usage — click to refresh", revealing two rows below it — one like `5h
  27% (resets in 1h 0m)`, the other like `7d 11% (resets Wed 2:00 AM)` —
  without closing the menu. It should **not** refresh on its own — reopen
  the menu a few times and confirm the two rows don't change until you
  click the top row again. While a new check is in flight the two rows
  should disappear rather than show stale numbers. Rename the token file
  temporarily to confirm the "No token file at …" message appears on the
  click row (with both sub-rows hidden) instead of a silent failure;
  truncate it to an empty file to confirm "Token file is empty".
- **Exit** — clicking it should remove the indicator from the panel
  immediately and it should not reappear on the next login (it's gone from
  `dconf read /org/gnome/shell/enabled-extensions`) until re-enabled via
  `gnome-extensions enable` or the Extensions app.
