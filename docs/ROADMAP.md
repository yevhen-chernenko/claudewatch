# Roadmap

Status: planning draft, no implementation yet. See [ARCHITECTURE.md](ARCHITECTURE.md)
for the technical design these phases build toward and [SECURITY.md](SECURITY.md)
for the review/security bar every phase is held to.

## Principles

- **Security and reviewability are not a phase — they're a constant.** Every
  phase below ships within the constraints in SECURITY.md, not just the
  final "hardening" one. The hardening phase is a _gate_, not where security
  gets added.
- **Local-only, always.** No network calls in v1, full stop. If that ever
  changes it's a deliberate, disclosed, opt-in decision — not default
  behavior.
- **Small and reviewable over clever.** This is going in front of GNOME's
  manual reviewers and, per the AI-generated-code policy, every line needs
  to be something the author (you) can explain. Favor boring, obvious code.
- **Out of scope for this repo**: the general AI-agent usage/token tracker
  (Claude + Codex + Copilot) is a separate, later project. Don't let it leak
  into CodeWatch's scope.

## Phase 0 — Throwaway prototype (Argos)

Goal: prove the hook → state → panel pipeline works end to end before
writing any real extension boilerplate.

- Wire a minimal hook config in `~/.claude/settings.json` for `SessionStart`,
  `PreToolUse`/`PostToolUse`, `Notification`, `Stop` pointed at a scratch
  script.
- Scratch script appends/overwrites a JSON file per the draft schema in
  ARCHITECTURE.md.
- An Argos (or GNOME 45+ fork) script reads that file and renders a static
  status string in the panel — no real `PanelMenu.Button`, no menu, no
  prefs.
- **Exit criteria**: you've watched a real Claude Code session flip the
  panel text through idle → running → waiting_approval → done at least
  once, and you're confident the hook events actually fire the way the docs
  say they do (event names, payload shape, timing) in your actual Claude
  Code version.
- Nothing from this phase ships. Delete or archive it once Phase 1 starts.

## Phase 1 — Foundation

Goal: real extension skeleton and real hook handler, but state machine and
UI are minimal. This phase is about getting the _shape_ of both halves
right, since some of these decisions (extension UUID, schema ID, state file
format) are expensive to change later.

- Hook handler: plain Node, zero dependencies, single file. Writes the
  per-session state file atomically. Handles being invoked concurrently
  across multiple sessions (see per-session-file design in ARCHITECTURE.md)
  without needing a lock.
- Pin the extension UUID and GSettings schema ID now — both are load-bearing
  for later installs and hard to change after real users have it installed.
- **Pending rename, not yet actioned**: app display name → "ClaudeWatch for
  GNOME", repo → `claudewatch` (from CodeWatch/codewatch). No code,
  `metadata.json`, or GitHub repo changes have been made yet. Resolve this
  _before_ treating the UUID/GSettings schema ID pin above as final — the
  UUID is conventionally derived from the name (e.g.
  `claudewatch@yevhen-chernenko.github.io`), and changing it after real
  installs exist is exactly the expensive-to-change scenario that bullet
  warns about. When this is actioned, it touches at minimum:
  `extension/metadata.json` (`name`, `uuid`, `url`), every `Main.notify(...)`
  call site (currently titled `"CodeWatch"`), README.md and the doc headers
  under `docs/`, and — as a separate, externally-visible step — the actual
  GitHub repository name and git remote URL.
- GNOME extension skeleton: ESM `extension.js`, `enable()`/`disable()` with
  full symmetry from the very first commit (not retrofitted later), a
  `PanelMenu.Button` with a static icon, a `Gio.FileMonitor` on the sessions
  directory that logs to console but doesn't drive UI yet.
- `metadata.json` with an honest, narrow `shell-version` list — check
  currently-supported GNOME releases at the time you write this, don't
  guess from training data.
- **Exit criteria**: extension loads via `gnome-extensions enable`, survives
  repeated enable/disable cycles with no leaked signals/sources (spot-check
  with `looking glass` / `journalctl --user -f` for warnings), and reacts to
  a hook-written state file appearing on disk.

## Phase 2 — v1 MVP

Goal: the feature set described in the brief, fully working, locally, for a
single user running Claude Code from VS Code and/or a terminal.

Checkboxes track what's actually landed in the current interim
single-state-file implementation (see [EXTENSION.md](EXTENSION.md) for what
exists today) versus what's still ahead — this list is a plan, not a
changelog, so keep it in sync as items ship rather than trusting it blindly.

- [x] Core state machine: standby / running / waiting_approval / done,
  implemented against the current single global `state.json`. Aggregate
  panel icon across concurrent sessions (priority order per
  ARCHITECTURE.md) is **not** done yet — that needs the per-session file
  layout from ARCHITECTURE.md first, since right now `cwd`/`status`/
  `transcript_path` just reflect whichever session last fired a hook.
- [ ] Popup menu: per-session breakdown (cwd, status, mechanical counters:
  commands run, files edited) plus aggregate view. _Shipped so far, ahead of
  and independent from this per-session design: "Open in VS Code", a local
  session token summary, an opt-in "Claude Usage" rate-limit check, and
  "Exit" — see [EXTENSION.md](EXTENSION.md#popup-menu). None of these are
  session-scoped yet, since there's still only one state file._
- [x] Desktop notifications: permission-needed and run-finished, wired to
  the `Notification`/`PermissionRequest` and `Stop` hooks respectively, each
  paired with a themed system sound (`Main.notify` + `play_from_theme`, see
  `_notify()` in `extension/lib/indicator.js`). **Not yet toggleable** —
  there is no prefs window yet at all, see the mute-toggle and preferences
  items below.
- [ ] Mute-notifications toggle (muted by default) gating the desktop
  notifications above, mirroring the existing "Auto-refresh on task
  complete" opt-in toggle pattern in the popup menu.
- [ ] Separate "compacting" status for manual context compaction: `PreCompact`
  (matcher `manual`) enters it, `PostCompact` clears it back to standby.
  Deliberately scoped to the manual `/compact` path only — the matcher
  distinction lives in the hook routing config, not the payload, so the
  `auto` matcher stays unwired unless a later decision explicitly wants
  auto-compaction surfaced too.
- [ ] Mechanical recap counters only — no semantic summarization yet (that's
  Phase 4, explicitly a stretch goal per the brief). `hook-handler.js`
  doesn't track `tool_calls`/`files_edited`/`commands_run` yet, only
  `status`/`cwd`/`transcript_path`.
- [ ] Preferences window (libadwaita, separate process): notification toggles,
  stale-session GC threshold, and the hook install/uninstall action from
  ARCHITECTURE.md's install flow (explicit action, backup, merge, reversible).
- [ ] Stale-session GC running on a periodic timeout, verified not to leak or
  grow unbounded. Not applicable yet to the single global state file; lands
  with the per-session rework.
- [ ] TypeScript for type checking: JSDoc-annotated `.js`, checked via
  `tsc --checkJs --allowJs --noEmit` against type stubs for the `gi://`
  and shell-resource modules — not a compile-to-`.js` build step. The
  extension package still ships plain ESM JS with no bundler, consistent
  with EGO's "external scripts/binaries strongly discouraged" stance and
  this repo's existing no-build-step layout (see
  [EXTENSION.md](EXTENSION.md#file-layout)). Also directly targets EGO's
  "imaginary API usage" rejection criterion (SECURITY.md) by catching
  calls to APIs that don't actually exist at check time instead of only at
  review time.
- [ ] Vitest, scoped to what's actually pure and host-independent:
  `extension/lib/state.js`'s `resolveUiAction()`, `extension/lib/usage.js`,
  the formatting half of `extension/lib/rateLimit.js`, and
  `hooks/hook-handler.js`'s event-to-status mapping. Everything that
  touches `gi://`/`Main`/`Soup` stays out of unit-test scope per this
  project's testing philosophy (behavior-driven, mock only at real system
  boundaries, extract pure helpers rather than mock shell internals) —
  that's what [TESTING.md](TESTING.md)'s manual pass is for. The Phase 2
  `extension/lib/` split already isolated exactly the functions this would
  cover.
- **Exit criteria**: you use it as your actual daily driver for a week
  across at least two concurrent sessions (e.g. VS Code + terminal) without
  needing to manually intervene, restart the shell, or edit state files by
  hand. Every box in SECURITY.md's hardening checklist is checked.

## Phase 3 — EGO submission readiness

Goal: gate before publishing. Nothing new functionally — this phase is an
audit, not a feature phase.

- Full pass against the [review guidelines checklist](SECURITY.md#gnome-shell-extension-review-guidelines-ego),
  re-fetched fresh from gjs.guide (guidelines change; don't trust this
  planning doc's snapshot).
- Dedicated self-review pass against the AI-generated-code rejection
  criteria (SECURITY.md) — separate from a correctness review.
- SPDX GPL-2.0-or-later headers on every source file; confirm no
  incompatible license leaked in via a copy-pasted snippet.
- Screenshots, description, and metadata written for the extensions.gnome.org
  listing — description explicitly states the local-only/no-network
  guarantee, since that's a real differentiator and a fair thing to ask
  reviewers/users to trust without just taking your word for it (point at
  the code).
- Confirm no `.claude/`, scratch files, or planning docs (this directory
  included, if you don't want it public) ship in the packaged zip —
  `gnome-extensions pack` output should be diffed against the repo before
  upload.
- Submit. Expect review latency and possibly a back-and-forth round with
  reviewers — budget calendar time, not engineering time, for this step.

## Phase 4 — Stretch: semantic recap (post-v1, explicitly v2)

Only after Phase 3 ships and the mechanical version has been used for a
while. Per the brief, this costs real tokens, so it needs its own design
pass on cost/opt-in behavior before starting:

- Use `transcript_path` from hook payloads to tail the session JSONL for
  Claude's latest text/plan snippet, or a `prompt`-type hook with a cheap
  model call to summarize current activity.
- Must be opt-in and clearly disclosed — this is the one place the local-only
  guarantee could break (a `prompt`-type hook call goes over the network to
  a model), so it needs its own line in SECURITY.md's threat model when it
  lands, not a silent extension of "no network calls."
- Re-evaluate the daemon+socket architecture note in ARCHITECTURE.md's open
  questions if transcript-tailing needs lower latency than periodic file
  polling gives.

## Milestone summary

| Phase              | Ships to users?                              | Primary risk being retired                                           |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------------- |
| 0 — Prototype      | No                                           | Hook wiring assumptions might be wrong                               |
| 1 — Foundation     | No                                           | Extension-shape decisions that are expensive to change later         |
| 2 — v1 MVP         | Optionally, informally (e.g. share the repo) | Feature completeness, daily-driver stability                         |
| 3 — EGO readiness  | Submission                                   | Review rejection (guideline compliance, AI-code policy)              |
| 4 — Semantic recap | Yes, as v2                                   | Network/cost/opt-in design for the one feature that isn't local-only |
