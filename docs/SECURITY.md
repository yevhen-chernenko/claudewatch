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
  user's live session activity (cwd, counters, transcript path).
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

"Claude Usage" (`extension.js`, `_refreshRateLimits`/`_probeRateLimits`) is
the one feature that leaves the machine. It exists only because Anthropic
doesn't expose 5-hour/7-day rate-limit utilization through any local file or
documented CLI command — the only way to read it is a real network call.
It's a `GET` to the dedicated `/api/oauth/usage` status endpoint (the same
one the popular "Claude Code Usage Tracker" VS Code extension uses,
confirmed by reading its bundled source), not a Messages completion — no
model gets invoked, so unlike an earlier version of this feature, checking
usage costs no API quota. Design constraints that keep this contained:

- **Opt-in by construction, not a setting**: the check does nothing unless
  `~/.config/claudewatch/token` exists. The extension never creates, writes,
  or discovers this file itself — the user creates it manually by running
  `claude setup-token` and saving the output there (`chmod 600`). No file,
  no network call, ever. This is a deliberately narrower trust boundary
  than reading the interactive CLI's own live session credential
  (`~/.claude/.credentials.json`, which some other tools read directly) —
  ClaudeWatch only ever holds a token the user explicitly minted for this
  purpose.
- **Off by default, opt-in cadence when enabled**: clicking "Refresh Usage"
  is always available and is the only way this request fires by default. An
  "Auto-refresh on task complete" switch (`_autoRefreshItem`, unchecked on
  every `enable()`) lets the user opt into an automatic check as well; when
  on, it fires once per Stop hook event (edge-triggered on the state file's
  `status` transitioning to `"done"` — see `_refresh()` in `extension.js`).
  There is no interval timer and no menu-open auto-refresh either way
  (unlike the free local session-token summary next to it, which does
  refresh on menu open). The toggle state lives only in memory
  (`this._autoRefreshOnDone`), not in a GSettings key, so it resets to off
  on every shell reload/session start rather than silently persisting an
  opt-in across sessions.
- **Single fixed endpoint**: only ever talks to
  `https://api.anthropic.com/api/oauth/usage`. No user-configurable host, so
  the token can't be exfiltrated to an arbitrary destination via config.
- **Token never touches state.json or any file the extension writes** — it
  is read from `TOKEN_PATH` and held only in memory for the life of one
  request.

If EGO review flags this, the mitigation is to ship it disabled by default
or split it into a separate optional extension — not to widen scope here
casually. This whole section exists so that exception is disclosed, not
silently reintroduced.

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
  constrains what the _extension itself_ may spawn. If the extension ever
  needs to run something (it shouldn't, for v1 — file reads only), it must
  use `Gio.Subprocess`, never a bundled binary, never anything requiring
  elevated privileges.
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

- [ ] State directory created with `0700`, files with `0600` — not yet:
      `hook-handler.js`'s `mkdirSync`/`writeFileSync` don't pass a `mode`,
      so both fall back to the process umask (typically `0755`/`0644`).
- [x] Atomic writes only (`tmp` + `rename`) for every state file — verified
      in `hooks/hook-handler.js` (`writeFileSync(tmpPath)` +
      `renameSync(tmpPath, statePath)`).
- [x] Extension tolerates a missing/malformed/partially-written state file
      without crashing the shell — `extension.js`'s `_refresh()` catches
      the parse/read failure and falls back to `{}`.
- [x] No sync file I/O on the shell main loop — `Gio.File` async APIs
      only. Verified: no `_sync(` calls anywhere under `extension/`.
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
- [x] No network calls except the opt-in, user-triggered "Claude Usage"
      rate-limit check (see "Opt-in network egress" above) — everything
      else in the extension and hook handler stays local-only. `Soup` is
      only imported in `extension/lib/indicator.js`, and only used inside
      `_probeRateLimits()`.
- [x] No telemetry/analytics
- [x] Hook handler has zero npm dependencies (reduces supply-chain surface
      to just Node's builtins) — `hooks/hook-handler.js` only requires
      `fs`, `os`, `path`.
- [ ] GC policy for stale session files verified (no unbounded growth in
      `~/.local/state/claudewatch/`) — not applicable yet: there's a single
      global `state.json`, not per-session files, so nothing accumulates
      today, but there's also no GC logic to verify. Lands with the
      per-session rework.
- [x] SPDX GPL-2.0-or-later header on every source file — verified across
      `extension/extension.js`, every file under `extension/lib/`, and
      `hooks/hook-handler.js`.
- [ ] Self-review pass against the AI-generated-code rejection criteria
      above, done as its own pass before submission
- [ ] `gnome-extensions-tool` / EGO's own linting (if available) run clean
