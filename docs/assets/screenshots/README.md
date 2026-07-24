# Screenshots

Committed as regular repo assets (small cropped PNGs — a panel label or a
terminal window, not full desktop photos) rather than hosted externally, so
the main [README.md](../../../README.md) renders correctly offline and in a
private clone, with no dependency on an external image host staying up. Keep
each file cropped tightly to the relevant UI (the panel row, the popup menu,
or the terminal window) rather than a full-screen capture, so file size stays
small and the reader's eye isn't pulled to unrelated desktop content.

Files the README expects here, exact names:

| File | Shows |
| - | - |
| `standby.png` | The panel with zero live sessions — "Agents are recovering ☕" |
| `running.png` | A session in the **running** state — orange, pulsing |
| `waiting.png` | A session in the **waiting** state — blue, static |
| `compacting.png` | A session in the **compacting** state — purple, pulsing |
| `consulting.png` | A session in the **consulting** state — olive, pulsing |
| `complete.png` | The green "done" flash right before a label retires |
| `multi-agent.png` | Several concurrent sessions — inline labels plus the "+N more" overflow chip |
| `usage-terminal.png` | The "Show usage" terminal view (`extension/detailed-usage.py`), including its ASCII banner |

## How to capture each one

The fastest way to get all six state screenshots without driving a real
Claude Code session is the **Dev preview menu** — see
[TESTING.md](../../TESTING.md#dev-preview-menu):

```sh
echo "CLAUDEWATCH_DEV=1" > .env
npm run build
```

Reload the shell, click the panel indicator, and use the "Dev: preview
state" section — each button drives one state (Standby / Running / Waiting /
Compacting / Consulting / Complete / Overflow chip) without touching real
session files. Clicking a button closes the menu so the panel is
unobstructed, then capture just the top-panel label with a window/area
screenshot tool (e.g. `gnome-screenshot -a`, or GNOME's built-in
Screenshot app in selection mode) and save it under this directory using the
filename from the table above. `multi-agent.png` needs the panel driven via
the hook handler directly instead (see
[TESTING.md](../../TESTING.md#multiple-sessions)) so more than one label is
live at once, since the dev preview menu only drives one synthetic label at
a time.

For `usage-terminal.png`, set up the optional token (see
[EXTENSION.md](../../EXTENSION.md#setting-up-the-claude-usage-token)), click
"Show usage", let it complete its first fetch, and capture the terminal
window once it's showing real data.

Turn the dev menu back off afterwards (`CLAUDEWATCH_DEV=0` or delete `.env`)
so a normal build doesn't ship it.
