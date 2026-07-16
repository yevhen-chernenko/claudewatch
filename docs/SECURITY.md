# Security & GNOME review readiness

Status: planning draft. This is the checklist CodeWatch is designed against
from day one, not a hardening pass bolted on at the end. Revisit it whenever
the architecture changes.

## Threat model

CodeWatch is a single-user, local-only desktop tool. There is no server
component and, by design, no network egress at all in v1 — everything it
reads and writes stays on the local filesystem. The relevant trust
boundaries are:

- **Claude Code hook payloads → hook handler**: payloads can contain tool
  inputs (shell commands, file paths, file contents pasted into `Edit`
  calls) and, via `transcript_path`, a pointer to the full session
  transcript. Treat all of it as potentially sensitive — it can include
  proprietary source, credentials a user pasted into a prompt, internal
  hostnames, etc. CodeWatch should extract only the minimal fields it needs
  (session id, tool name, counters, status) and never copy raw tool
  input/output into its own state files unless a specific feature needs it
  and the retention/exposure of that copy has been thought through.
- **Hook handler → state files**: the state directory
  (`~/.local/state/codewatch/`) is local-user-only. Create it `0700` and
  files `0600` so other local accounts on a shared machine can't read a
  user's live session activity (cwd, counters, transcript path).
- **State files → GNOME extension**: the extension only ever reads files it
  wrote (or that the hook handler wrote in the same schema). No parsing of
  untrusted remote input, but still validate/guard against a malformed or
  partially-written file (crash-only tolerance, not a crash).
- **Extension → `~/.claude/settings.json`**: the one place CodeWatch writes
  to a file it doesn't own. See the install-flow requirements in
  [ARCHITECTURE.md](ARCHITECTURE.md#install-flow) — explicit user action,
  backup-before-write, merge not overwrite, reversible uninstall.

No telemetry, no analytics, no update-check pings, no crash reporting to a
remote endpoint. If that ever changes, it needs to be opt-in, disclosed in
the extensions.gnome.org listing, and probably its own ADR — don't add it
casually.

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
review risk specific to CodeWatch — not a generic checklist item.

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

- [ ] State directory created with `0700`, files with `0600`
- [ ] Atomic writes only (`tmp` + `rename`) for every state file
- [ ] Extension tolerates a missing/malformed/partially-written state file
      without crashing the shell
- [ ] No sync file I/O on the shell main loop — `Gio.File` async APIs only
- [ ] `enable()`/`disable()` audited for full symmetry (signals, sources,
      widgets, caches)
- [ ] No object/signal/source creation outside `enable()`
- [ ] `settings.json` writes: explicit user action, backup taken first,
      merge (not overwrite), reversible uninstall
- [ ] No network calls anywhere in the extension or hook handler
- [ ] No telemetry/analytics
- [ ] Hook handler has zero npm dependencies (reduces supply-chain surface
      to just Node's builtins)
- [ ] GC policy for stale session files verified (no unbounded growth in
      `~/.local/state/codewatch/`)
- [ ] SPDX GPL-2.0-or-later header on every source file
- [ ] Self-review pass against the AI-generated-code rejection criteria
      above, done as its own pass before submission
- [ ] `gnome-extensions-tool` / EGO's own linting (if available) run clean
