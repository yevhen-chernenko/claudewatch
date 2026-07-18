# claudewatch

GNOME Shell extension that shows live Claude Code activity in your top panel.

**Status: in development.** Not yet installable or usable — full details
(installation, usage, screenshots) will be added here once there's a working
release. See [docs/ROADMAP.md](docs/ROADMAP.md) for current progress.

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
