# ClaudeWatch

GNOME Shell extension that shows live Claude Code activity in your top panel.

**Status: in development.** Not yet installable via an installer — everything
still has to be wired up by hand. See [docs/SETUP.md](docs/SETUP.md) for the
full first-time setup walkthrough (build, GNOME extension, Claude Code hook
wiring, optional usage tracking) and [docs/ROADMAP.md](docs/ROADMAP.md) for
current progress.

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
