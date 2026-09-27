# Decisions Log

_Append-only. Each approved decision goes here so it is not re-litigated in a
later session. Newest at the bottom._

## 2026-09-27 — Merge PR #2 before starting new work

**Context**: PR #2 (`feat/demo-ai-recap` → `main`) was open, CI-green and
mergeable, carrying tracked-migration/release-config foundations (from PR
#15) plus voice-room/AI-recap navigation work. Building new work on stale
`main` risked conflicts.
**Options considered**: merge first vs. leave open and build around it.
**Decision**: Merge PR #2 into `main` first. Done — `main` is now at
`f394f99`.
**Approved by**: user

## 2026-09-27 — Phase 5/6 voice direction: proceed with mediasoup

**Context**: The delivery plan's next major feasibility risk is real group
audio (Phase 6 in PROFESSIONAL-DELIVERY-PLAN.md, "Phase 5" in the older
ROADMAP.md numbering). This requires a new major runtime dependency
(mediasoup) and real-time media architecture.
**Options considered**: proceed with mediasoup spike / skip voice and close
other phase gaps first / plan first, decide after.
**Decision**: Proceed with mediasoup — start with the two-peer audio
feasibility spike per the plan's recommended execution order (item 2:
"run the early Phase 6 two-peer audio spike immediately" after Phase 1/2
foundations).
**Approved by**: user

## 2026-09-27 — Dual-builder, cross-review implementation workflow (standing)

**Context**: Global CLAUDE.md defaults to Codex-only implementation with
Claude reviewing. User wants a different model for this project: two
builders always active (a Sonnet subagent and a Codex CLI agent), each
reviewed by the *other* model — Codex reviews what Sonnet builds, Sonnet
reviews what Codex builds. This is a deviation from the global default and
was confirmed as standing for this project, not a one-off.
**Options considered**: standing project override vs. one-off for the
current task only.
**Decision**: Standing override, documented in `docs/agent/workflow.md`.
Athena is responsible for splitting Feature/Architecture-tier work into
≤2 independently-scoped tracks so both builders can work without colliding
on the same files; for work too small to split, one model builds and the
other reviews (never same-model review).
**Approved by**: user

## 2026-09-27 — Bootstrap operating mode

**Context**: First `/bootstrap-project` run for this repository.
**Options considered**: documentation level (Lightweight/Standard/
Regulated); verification depth (unit-only vs. unit+runtime); git strategy;
data safety policy.
**Decision**:
- Documentation level: **Standard**.
- Verification depth: **unit + runtime/browser** (Docker confirmed
  available on this host, so integration tests and Playwright e2e run
  locally, not just in CI).
- Git strategy: feature branch → PR → merge, small commits per reviewable
  unit, no direct pushes to `main`, both cross-reviewers must accept before
  a PR is proposed for merge.
- Data safety policy: no irreplaceable data yet (low risk); preserve the
  existing tracked-migration safety (checksums + advisory locking) for any
  schema change; add an explicit backup step once Phase 2 onboards real
  users.
- Test/demo data stays synthetic for now; Phase 2 account-recovery work
  follows the plan's own sequencing rather than jumping the queue.
**Approved by**: user

## 2026-09-27 — Codex model slug for this environment: `gpt-5.6-terra`

**Context**: `codex exec` defaults to `gpt-6-sol` per `~/.codex/config.toml`,
which this ChatGPT-plan account is not authorized to use via `codex exec`
(`400 invalid_request_error`). `gpt-5-codex` also failed the same way.
`gpt-5.6-terra` (from `~/.codex/models_cache.json`) worked successfully as
an independent Themis reviewer. This also explains the user's earlier
"codex terra subagent" phrasing — it's a real model slug on this account,
not an invented role name.
**Decision**: Use `codex exec -m gpt-5.6-terra` for Codex-side work in this
project (both builder and reviewer roles) until/unless the user specifies
otherwise.
**Approved by**: inferred from working command output; not separately
confirmed with the user — flag if a different model is intended.

## 2026-09-27 — audio-spike plan approved after 3 rounds of independent review

**Context**: Architecture-change tier task (new `mediasoup` dependency, new
`apps/media` service). Athena's plan went through 3 rounds of independent
Codex (`gpt-5.6-terra`) review before user approval: round 1 found 9
must-fix issues (missing voice-channel-type check, no per-request session
re-validation, underspecified WS protocol, no late-joiner discovery, no
ownership binding, broken Docker networking, missing ICE listen config, a
double-start bug, no resource-abuse limits); round 2 (after revision) found
3 remaining issues plus 2 new ones introduced by the fix (teardown not
idempotent, wrong mediasoup field names/shapes for ICE/RTP parameters, an
ownership rule that made remote consumption structurally impossible, a
missing Opus codec on router creation, an inaccurate flag description);
round 3 (after a second revision) found one final gap (the `leave` handler
not explicitly wired to the shared teardown function), fixed directly as a
one-line patch.
**Decision**: Plan approved as revised. Proceeding to Phase 0 (contract
freeze) then parallel dual-builder implementation (Track A/Sonnet:
`apps/media` server; Track B/Codex: `apps/web` client integration).
**Approved by**: user
