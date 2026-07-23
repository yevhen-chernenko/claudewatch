# ClaudeWatch

GNOME Shell extension that shows live Claude Code activity in your top panel.

**Status: in development.** Not yet installable via an installer — everything
still has to be wired up by hand. See [docs/SETUP.md](docs/SETUP.md) for the
full first-time setup walkthrough (build, GNOME extension, Claude Code hook
wiring, optional usage tracking) and [docs/ROADMAP.md](docs/ROADMAP.md) for
current progress.

## Panel states

Each live Claude Code session gets its own panel label, cycling through
these states (full state-machine details in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#session-lifecycle--state-machine)):

| State | Color | Example label | When |
| - | - | - | - |
| 🟠 running | orange | "Agent Smith is working 🕶️" | a tool call or turn is in flight |
| 🔵 waiting | blue | "Agent Smith needs support 📞" | paused on a permission prompt or a question — needs you |
| 🟣 compacting | purple | "Agents are training 🔫" | a manual `/compact` is in progress |
| 🟡 consulting | olive | "Agent Smith is consulting notes 📓" | the turn ended but a spawned subagent hasn't reported back yet |
| 🟢 complete | green | "Agent Smith is done 🎖️" | just finished — flashes for 5s, then the label disappears |
| ⚪ standby | grey | "Agents are recovering ☕" | no session is live |

## Development

Written in TypeScript; `npm run build` compiles `src/` to `dist/`, which is
what actually runs (both the GNOME extension and the hook handler). See
[docs/EXTENSION.md](docs/EXTENSION.md#building) for the build step and
[docs/TESTING.md](docs/TESTING.md) for how to exercise it by hand.

```sh
npm install
npm run build
```

## License

[GPL-2.0-or-later](LICENSE)
