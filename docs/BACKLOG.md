# Backlog

## Features

## Bugs

## Housekeeping

- [ ] Investigate whether the `Notification` hook's `agent_needs_input`
      notification_type (per the hooks reference) should be added to
      `WAITING_NOTIFICATION_TYPES` in `src/hooks/lib/status.ts` alongside
      `permission_prompt`/`elicitation_dialog` — it reads like another
      genuine "Claude is waiting on you" signal, but it's unconfirmed
      whether it applies to a normal single-agent session or only to
      agent-team/subagent contexts this project doesn't otherwise handle.

## Release

- [ ] Release v0.1.0 preparations.
