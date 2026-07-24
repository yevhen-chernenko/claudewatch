# Security & GNOME review readiness

Status: planning draft. This is the checklist ClaudeWatch is designed against
from day one, not a hardening pass bolted on at the end. Revisit it whenever
the architecture changes.

## Threat model

ClaudeWatch is a single-user, local-only desktop tool. There is no server
component, and the default posture is no network egress — everything it
reads and writes stays on the local filesystem. The one deliberate exception
is the "Claude Usage" rate-limit check; see "Opt-in network egress" below.
The relevant trust boundaries are:

- **Claude Code hook payloads → hook handler**: payloads can contain tool
  inputs (shell commands, file paths, file contents pasted into `Edit`
  calls) and, via `transcript_path`, a pointer to the full session
  transcript. Treat all of it as potentially sensitive — it can include
  proprietary source, credentials a user pasted into a prompt, internal
  hostnames, etc. ClaudeWatch should extract only the minimal fields it needs
  (session id, tool name, counters, status) and never copy raw tool
  input/output into its own state files unless a specific feature needs it
  and the retention/exposure of that copy has been thought through.
- **Hook handler → state files**: the state directory
  (`~/.local/state/claudewatch/`) is local-user-only. Create it `0700` and
  files `0600` so other local accounts on a shared machine can't read a
  user's live session activity (counters, transcript path).
- **State files → GNOME extension**: the extension only ever reads files it
  wrote (or that the hook handler wrote in the same schema). No parsing of
  untrusted remote input, but still validate/guard against a malformed or
  partially-written file (crash-only tolerance, not a crash).
- **Extension → `~/.claude/settings.json`**: the one place ClaudeWatch writes
  to a file it doesn't own. See the install-flow requirements in
  [ARCHITECTURE.md](ARCHITECTURE.md#install-flow) — explicit user action,
  backup-before-write, merge not overwrite, reversible uninstall.

No telemetry, no analytics, no update-check pings, no crash reporting to a
remote endpoint.

### Opt-in network egress: the rate-limit check

"Show usage" (`lib/indicator.ts`, `_onShowUsageClicked`) opens a terminal
running `extension/detailed-usage.py` — the only way this project surfaces
5-hour/7-day rate-limit utilization, since Anthropic doesn't expose it
through any local file or documented CLI command. The extension itself
(the reviewed TypeScript package, `lib/indicator.ts` included) makes zero
network calls of its own — there is no network-capable import anywhere
under `src/extension/`. The actual `GET` to the dedicated `/api/oauth/usage`
status endpoint (the same one the popular "Claude Code Usage Tracker" VS
Code extension uses, confirmed by reading its bundled source) happens
entirely inside that spawned, out-of-process script, on its own 60-second
refresh loop. It's not a Messages completion — no model gets invoked, so
checking usage costs no API quota.

This is also the only feature where the extension spawns a subprocess at
all — see the "External scripts/binaries" guideline below for why that's
constrained, not just disclosed here: the script it launches is bundled
plain-text source (never a compiled/opaque binary), the terminal choice
comes from `pickTerminalCommand()` (`lib/terminal.ts`) trying `$TERMINAL`
then a fixed list of known terminal emulators — never a user-configurable
command — and the spawned process needs no elevated privileges.

- **Opt-in by construction, not a setting**: the check does nothing unless
  `~/.config/claudewatch/token` exists. The extension never creates, writes,
  or discovers this file itself — the user creates it manually, normally as
  a symlink to `~/.claude/.credentials.json` (see
  [EXTENSION.md](EXTENSION.md#setting-up-the-claude-usage-token); the
  endpoint requires the `user:profile` scope, which only that interactive
  login credential carries — `claude setup-token` output lacks it and gets
  rejected). No file, no network call, ever. Neither the extension nor the
  script goes looking for `~/.claude/.credentials.json` on its own — only
  the one path the user explicitly pointed at a credential, and the token
  found there is never written anywhere, only held in memory for the life
  of one request.
- **User-triggered only**: clicking "Show usage" is the only way the
  terminal — and therefore the network request — ever launches. There is no
  interval timer and no menu-open trigger; the script's own 60-second loop
  only re-checks usage for a terminal the user already opened.
- **Single fixed endpoint**: only ever talks to
  `https://api.anthropic.com/api/oauth/usage`. No user-configurable host, so
  the token can't be exfiltrated to an arbitrary destination via config.
- **Credential auto-refresh, same opt-in gate**: if `resolve_token()` finds
  the token file's `expiresAt` in the past, the script runs
  `claude auth status --json` — a fixed argv, output discarded, 15s timeout,
  failures (missing binary, still-expired afterward) swallowed and reported
  as an inline error rather than raised — so the CLI can refresh its own
  `.credentials.json` in place using its own trusted refresh flow, instead
  of this script reimplementing OAuth. This only runs against the same
  file the user already opted in by pointing `TOKEN_PATH` at, and only when
  it's already in the expired state; it is not a new standing trigger.
- **Token never touches any session state file or any other file the
  extension writes** — it is read from `TOKEN_PATH` and held only in memory
  for the life of one request.
- **Only one fixed, repo-bundled script is ever launched by the extension
  itself**: clicking "Show usage" is the only way `Gio.Subprocess` fires in
  the whole extension; there is no menu-open or interval-based auto-launch.
  The argv is always `<a terminal found on PATH> <fixed flag> <the path to
  detailed-usage.py>` — never a user-supplied path or command, so this
  can't be repurposed into running arbitrary commands via config. That
  spawned script may in turn launch one other fixed, non-bundled binary —
  `claude auth status --json`, resolved off `PATH` like the terminal choice
  — but only for the credential auto-refresh described above, never with a
  user-configurable argv.

If EGO review flags either of these, the mitigation is to ship the
affected one disabled by default or split it into a separate optional
extension — not to widen scope here casually. This whole section exists so
both exceptions are disclosed, not silently reintroduced.

## GNOME Shell extension review guidelines (EGO)

Sourced from the [official review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and the [EGO AI-code policy post](https://blogs.gnome.org/jrahmatzadeh/2025/12/06/ai-and-gnome-shell-extensions/).
Re-check both before submission — guidelines evolve.

- **Initialization discipline**: `extension.js` at module scope may only
  contain static data (`Map`, `RegExp`, constants). No object creation, no
  signal connections, no main-loop sources, no touching Shell state outside
  `enable()`. This is a hard rule, not a style preference — violating it is
  a common rejection reason.
- **`enable()`/`disable()` symmetry**: every `GObject`, widget, signal
  connection, and `GLib` source created in `enable()` must be destroyed /
  disconnected / removed in `disable()`. Any module-scope `Map` used as a
  session-state cache must be `.clear()`-ed. This isn't just a review
  checkbox — an extension that leaks between enable/disable cycles degrades
  the whole shell session for the user, which is the actual harm the rule
  exists to prevent.
- **Forbidden imports**: no deprecated `ByteArray`/`Lang`/`Mainloop`; no
  `Gtk`/`Gdk`/`Adw` inside the shell process; no `Clutter`/`Meta`/`St`/`Shell`
  inside `prefs.js` (separate process, separate allowed API surface).
- **No telemetry** of any kind — reinforces the "no network egress" design
  decision above; it's not just a preference here, it's a submission
  requirement.
- **External scripts/binaries**: "strongly discouraged... unless
  unavoidable." The hook handler already lives outside the reviewed package
  (Claude Code invokes it directly, not the extension), so this mainly
  constrains what the _extension itself_ may spawn. "Show usage" is the
  one deliberate, disclosed instance of the extension itself spawning
  something (see "Opt-in network egress" above) — a dropdown button that
  opens a terminal is unavoidably a subprocess spawn. It follows the rule
  exactly: `Gio.Subprocess`, a bundled plain-text script rather than a
  compiled binary, no elevated privileges. Nothing else in the extension
  spawns anything.
- **GSettings schema**: ID namespaced `org.gnome.shell.extensions.<uuid>`,
  path `/org/gnome/shell/extensions/<uuid>/`, `.gschema.xml` shipped and
  compiled correctly. Pin the extension UUID early — see the open question
  in ARCHITECTURE.md.
- **Licensing**: GPL-2.0-or-later on every source file (a short SPDX header
  is the simplest way to satisfy "code must be readable and reviewable" plus
  the license requirement at once). Repo license is already GPL-2.0,
  confirm every new file inherits it explicitly rather than relying on the
  repo-level LICENSE alone.
- **Code quality / reviewability**: "developers should be able to justify
  and explain the code they submit." No dead code, no unreachable branches,
  no defensive `try/catch` around calls that can't throw, no comments that
  read like leftover LLM narration.

## AI-generated-code rejection risk — read this one twice

As of December 2025, EGO explicitly rejects submissions that show signs of
being AI-generated without developer understanding: unnecessary
try/catch-style padding, inconsistent style, calls to APIs that don't
actually exist ("imaginary API usage"), and comments that read like prompt
output rather than engineering notes. This project is being built with
Claude Code as the primary tool, which makes this the single most relevant
review risk specific to ClaudeWatch — not a generic checklist item.

Mitigations, concrete and ongoing (not a one-time pass before submission):

- Every file that goes into the submitted extension package gets read and
  understood, not just diffed and accepted. If a chunk of generated code
  can't be explained in a sentence, it doesn't ship as-is.
- No comments narrating what was done or why a tool call happened ("added
  this to fix X", "Claude generated this helper") — this is already covered
  by the user's global AI-artifact-hygiene rule, but it's worth restating
  here because it maps directly onto a real EGO rejection criterion, not
  just a personal preference.
- Prefer straightforward, idiomatic GJS/JS over defensive scaffolding —
  no speculative error handling for cases the GNOME Shell API guarantees
  can't happen, no wrapping every call in try/catch "just in case."
  Consistent with this repo's existing scope-discipline rule.
- Before submission, do a dedicated self-review pass specifically looking
  for the four rejection patterns above, treating it as a distinct review
  lens from "does this work correctly."
- Nothing under `.claude/` or any session/planning artifact ever enters the
  submitted package — already covered globally, called out here because a
  stray file here specifically jeopardizes the GNOME submission, not just
  repo hygiene.

## Hardening checklist (track status as phases land)

- [x] State directory created with `0700`, files with `0600` —
      `hook-handler.ts`'s `mkdirSync`/`writeFileSync` calls pass `mode`
      explicitly rather than falling back to the process umask.
- [x] Atomic writes only (`tmp` + `rename`) for every state file — verified
      in `src/hooks/hook-handler.ts` (`writeFileSync(tmpPath)` +
      `renameSync(tmpPath, statePath)`).
- [x] Extension tolerates a missing/malformed/partially-written state file
      without crashing the shell — `extension.ts`'s `_refresh()` catches
      the parse/read failure and falls back to `{}`.
- [x] No sync file I/O on the shell main loop — `Gio.File` async APIs
      only. Verified: no `_sync(` calls anywhere under `src/extension/`.
- [x] `enable()`/`disable()` audited for full symmetry (signals, sources,
      widgets, caches) — re-audited during the Phase 2 `extension/lib/`
      split: `enable()`'s file monitor is disconnected in `disable()`, and
      `ClaudeWatchIndicator.destroy()` removes the pending flash timeout,
      disconnects the menu's `open-state-changed` signal, and destroys the
      `PanelMenu.Button` (which takes its child widgets/menu items with
      it). Re-verify after any future change to `enable()`/`disable()` or
      `ClaudeWatchIndicator`'s constructor/`destroy()`.
- [x] No object/signal/source creation outside `enable()` — verified: no
      module-scope `new`/`Main.`/`Gio.`/`GLib.` calls anywhere under
      `extension/`, only constant and class/function definitions.
- [ ] `settings.json` writes: explicit user action, backup taken first,
      merge (not overwrite), reversible uninstall — not implemented yet;
      no install-flow/prefs code exists (see ARCHITECTURE.md's install
      flow and ROADMAP.md's Phase 2 preferences-window item).
- [x] No network calls anywhere in the extension itself — no
      network-capable import exists under `src/extension/`. The opt-in,
      user-triggered "Claude Usage" rate-limit check (see "Opt-in network
      egress" above) happens entirely inside the spawned, out-of-process
      `extension/detailed-usage.py`, not the reviewed package.
- [x] No subprocess spawning except the opt-in, user-triggered "Show
      usage" button — `Gio.Subprocess` is only imported/used in
      `_onShowUsageClicked()` (`lib/indicator.ts`), spawns only a
      terminal emulator plus the fixed, bundled `detailed-usage.py`, never
      a user-configurable command.
- [x] No telemetry/analytics
- [x] Hook handler has zero npm dependencies (reduces supply-chain surface
      to just Node's builtins) — `src/hooks/hook-handler.ts` only requires
      `fs`, `os`, `path`.
- [x] GC policy for stale session files verified (no unbounded growth in
      `~/.local/state/claudewatch/sessions/`) — three layers: the
      `SessionEnd` hook deletes a session's file immediately (the common
      case); `ClaudeWatchIndicator`'s `onSessionRetired` callback
      (`extension.ts`'s `_deleteSessionFile()`) deletes it again whenever a
      session's `AgentLabel` retires for any reason, in case `SessionEnd`
      never fired; and a periodic `GLib.timeout_add_seconds` re-scan
      (`PERIODIC_REFRESH_SECONDS`) re-evaluates every session's
      pid-liveness even when nothing has touched the directory, so a
      session whose process was killed mid-run doesn't linger forever with
      no event left to wake the extension back up.
- [x] SPDX GPL-2.0-or-later header on every source file — verified across
      `src/extension/extension.ts`, every file under `src/extension/lib/`, and
      `src/hooks/hook-handler.ts`.
- [ ] Self-review pass against the AI-generated-code rejection criteria
      above, done as its own pass before submission
- [ ] `gnome-extensions-tool` / EGO's own linting (if available) run clean
