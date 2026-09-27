# Task artifacts

Each task run through `/start-task` gets its own directory here:
`docs/tasks/<task-id>/`, typically containing:

- `brief.md` — the approved task brief (scope, acceptance criteria)
- `investigation.md` — Argus's findings
- `plan.md` — Athena's plan, including any `## Decision:` blocks
- `handoff-codex.md` / `handoff-sonnet.md` — the builder handoff(s) actually
  sent, one per track when the task used the dual-builder split (see
  [../agent/workflow.md](../agent/workflow.md))
- `review-*.md` — each cross-reviewer's findings (Codex reviewing the
  Sonnet track, Sonnet reviewing the Codex track, or the single other-model
  review for small/unsplit tasks)
- `verification.md` — Apollo's verification report

This is the **Standard** documentation tier (see
[../agent/project-profile.md](../agent/project-profile.md)): every task
gets this trail, short of the full Regulated-tier ADR/external-audit
overhead.
