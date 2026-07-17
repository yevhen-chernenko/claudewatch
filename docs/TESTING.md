# Manual testing

Status: interim, for the single-state-file implementation (see
[ARCHITECTURE.md](ARCHITECTURE.md) for the per-session design this will move
to). No automated tests yet — this is what to run by hand after touching
`extension/extension.js`, anything under `extension/lib/`, or
`hooks/hook-handler.js`. See [EXTENSION.md](EXTENSION.md#file-layout) for
what lives in each file.

## Reload the extension

The shell only picks up `extension.js` changes on reload, not live:

- X11: Alt+F2, type `r`, Enter.
- Wayland: log out and back in (no in-session reload).

## Drive the hook handler directly

Simulates the wired events without needing a real Claude Code turn. Watch
the panel label after each command — it updates within ~1s via the
`Gio.FileMonitor` in `extension.js`, no reload needed.

```sh
echo '{"hook_event_name":"UserPromptSubmit"}' | node hooks/hook-handler.js
# panel -> "Claude is working..." (orange, pulsing)

echo '{"hook_event_name":"Notification"}' | node hooks/hook-handler.js
# panel -> "Claude wants something!" (blue, pulsing twice as fast)
# also fires a desktop notification (Main.notify) plus a "dialog-question"
# themed system sound

echo '{"hook_event_name":"PermissionRequest"}' | node hooks/hook-handler.js
# same "waiting" transition as Notification above — PermissionRequest and
# Notification both map to status: waiting_approval in hook-handler.js

echo '{"hook_event_name":"Stop"}' | node hooks/hook-handler.js
# panel -> "Claude is done!" (green flash, then standby after 5s)
# also fires a desktop notification plus a "complete" themed system sound
```

Inspect the state file directly if the panel doesn't move:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/codewatch/state.json"
```

## End-to-end

Send a real prompt in a Claude Code session with the hooks installed (see
`~/.claude/settings.json`) and confirm the panel flips to "Claude is
working..." when the prompt is submitted, to "Claude wants something!" (with
a notification + sound) if Claude asks a question or needs a permission, and
to "Claude is done!" (with a notification + sound, then standby after 5s)
once Claude stops.

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
- **Claude Usage section** — a labeled separator followed by three
  always-visible rows and a "Refresh Usage" button (no toggle — the section
  is always shown).
  - **Session** row — should show `Session — In … · Out … · Cached …` any
    time `transcript_path` is set, with no manual action needed. Reopening
    the menu, or firing either hook event, should refresh the numbers.
  - **5h / 7d rows** — needs a token file first; see
    [EXTENSION.md](EXTENSION.md#setting-up-the-claude-usage-token) for how
    to create `~/.config/codewatch/token` via `claude setup-token`. They
    stay hidden until a check succeeds, and re-hide while a new check is in
    flight rather than showing stale numbers.
  - **Auto-refresh on task complete** toggle — should be **off** immediately
    after enabling the extension. With it off, run the "Drive the hook
    handler directly" `Stop` event (or finish a real prompt) while the menu
    is open and confirm the 5h/7d rows do **not** update on their own — only
    clicking "Refresh Usage" should trigger a request. Turn the toggle on
    and repeat: this time the rows should auto-refresh once per real turn.
    Fire `Stop` twice in a row without a `UserPromptSubmit` in between (with
    the toggle on) and confirm it does **not** double-fire the check the
    second time (the edge-trigger on `status` transitioning to `"done"`
    should only fire once per transition) — watch for a second "Checking…"
    flash on the Refresh Usage row, or check `journalctl --user -f -o cat`
    for a second request. Reopening the menu should never by itself trigger
    a rate-limit request, toggle on or off.
  - **Refresh Usage** button — clicking it should refresh both the Session
    row and the 5h/7d rows without closing the menu, showing "Checking…"
    while the rate-limit request is in flight. Rename the token file
    temporarily to confirm the "No token file at …" message appears on
    this row (with both 5h/7d rows hidden) instead of a silent failure;
    truncate it to an empty file to confirm "Token file is empty".
- **Exit** — clicking it should remove the indicator from the panel
  immediately and it should not reappear on the next login (it's gone from
  `dconf read /org/gnome/shell/enabled-extensions`) until re-enabled via
  `gnome-extensions enable` or the Extensions app.
