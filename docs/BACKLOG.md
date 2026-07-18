# Backlog

## Features

- [ ] Support multiple agents

- [ ] Separate "compacting" status for manual context compaction
      surfaced too.

## Bugs

## Housekeeping

- [ ] Vitest, scoped to what's actually pure and host-independent:
      `src/extension/lib/state.ts`'s `resolveUiAction()`,
      `src/extension/lib/usage.ts`, the formatting half of
      `src/extension/lib/rateLimit.ts`, and `src/hooks/hook-handler.ts`'s
      event-to-status mapping. Everything that touches `gi://`/`Main`/`Soup`
      stays out of unit-test scope per this project's testing philosophy —
      that's what TESTING.md's manual pass is for.
- [ ] SPDX GPL-2.0-or-later headers on every source file; confirm no
      incompatible license leaked in via a copy-pasted snippet.
- [ ] Screenshots, description, and metadata for the extensions.gnome.org
      listing
