# Roadmap

See [ARCHITECTURE.md](ARCHITECTURE.md) for the technical design these phases
build toward, [SECURITY.md](SECURITY.md) for the review/security bar every
phase is held to, and [BACKLOG.md](BACKLOG.md) for the concrete wishlist and
bug tracker — this doc stays high-level on purpose.

## Principles

- **Security and reviewability are not a phase — they're a constant.** Every
  phase below ships within the constraints in SECURITY.md, not just the
  final "hardening" one.
- **Local-only, always.** No network calls in v1, full stop. If that ever
  changes it's a deliberate, disclosed, opt-in decision — not default
  behavior.
- **Small and reviewable over clever.** This is going in front of GNOME's
  manual reviewers and, per the AI-generated-code policy, every line needs
  to be something the author (you) can explain. Favor boring, obvious code.
- **Out of scope for this repo**: the general AI-agent usage/token tracker
  (Claude + Codex + Copilot) is a separate, later project. Don't let it leak
  into ClaudeWatch's scope.

## Phase 0 — Foundation (done)

Goal: prove the hook → state → panel pipeline works end to end, then build a
real extension skeleton around it. Result: a workable extension, ready for
features.

- Hook wiring validated against a throwaway Argos prototype — event names,
  payload shape, and timing confirmed against real Claude Code sessions.
- Real extension skeleton: ESM `extension.js`, symmetric `enable()`/
  `disable()`, a `PanelMenu.Button`, a `Gio.FileMonitor` on the sessions
  directory.
- Hook handler: plain Node, zero dependencies, writes the state file
  atomically and handles concurrent sessions without a lock.
- Extension identity locked in: name "ClaudeWatch for GNOME", uuid
  `claudewatch@yevhen-chernenko.github.io`, repo slug `claudewatch`, config/
  state paths under `~/.config/claudewatch/` and `~/.local/state/claudewatch/`.
- TypeScript sources under `src/`, compiled to `dist/` dev-time only; `strict`
  mode on across the extension and `hooks/hook-handler.js`.

## Phase 1 — MVP (current phase)

Goal: the feature set described in the brief, working locally, and ready to
ship on the GNOME Extensions library (EGO).

What's landed so far — per-session state machine (running / waiting_approval
/ compacting / done, one `AgentLabel` per live session) with per-session
agent-name flavor text, multiple concurrent sessions each getting their own
panel label (capped inline with a "+N more" overflow chip, full detail
always in the popup menu), an opt-in "Notifications" toggle gating the
desktop notifications wired to the `Notification`/`PermissionRequest`,
`PreCompact` (manual trigger only), `Stop`, and `SessionEnd` hooks, a
pid-liveness check so a killed/crashed session's leftover status doesn't
stick, stale-session file GC (delete-on-retire plus a periodic re-scan), and
the popup menu's per-session "Open in VS Code"/token summary, opt-in
account-level usage/rate-limit check, and "Exit" — is documented in
[EXTENSION.md](EXTENSION.md). What's still ahead (preferences window, tests,
and the EGO submission checklist) is tracked in [BACKLOG.md](BACKLOG.md)
rather than duplicated here.

- **Exit criteria**: used as an actual daily driver for a week across at
  least two concurrent sessions (e.g. VS Code + terminal) without needing to
  manually intervene, restart the shell, or edit state files by hand. Every
  box in SECURITY.md's hardening checklist and the EGO review-guidelines
  checklist is checked, then submitted.

## Phase 2 — Beta

Goal: published and installable from EGO, but openly framed as Early Access —
bugs are still expected, and the point of this phase is to surface them
against real users and real machines rather than just your own daily driving.

- Listing stays up, but README/description are explicit that this is a beta:
  known-rough edges, feedback wanted, no stability guarantee yet.
- Incoming bug reports get triaged straight into [BACKLOG.md](BACKLOG.md)'s
  Bugs section.
- **Exit criteria**: no known critical/data-loss bugs open, and enough real
  user feedback has come in (not just your own usage) to be confident the
  extension behaves reasonably across GNOME versions and setups you don't
  personally run.

## Phase 3 — Ongoing development (open source)

Not time-boxed. Once Phase 2 stabilizes, development continues indefinitely
as an open-source project — priorities come from [BACKLOG.md](BACKLOG.md) and
whatever issues/contributions come in, not a fixed plan. This includes
stretch goals like the opt-in semantic recap (tailing `transcript_path` or a
`prompt`-type hook to summarize activity), which — per the brief — is the one
feature that would need its own network/cost/opt-in design pass and a
dedicated SECURITY.md threat-model entry before it could land.
