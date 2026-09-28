# Task Brief: audio-spike — Two-peer authenticated mediasoup audio feasibility spike

**Date**: 2026-09-27
**Status**: brief

## Request

"start implementing what still needs to be built as per the implementation
plan" (original request) → narrowed via approved decisions to: proceed with
mediasoup for Phase 6 voice, starting with the two-peer audio feasibility
spike the delivery plan calls out as the top-priority next batch (see
[docs/PROFESSIONAL-DELIVERY-PLAN.md](../../PROFESSIONAL-DELIVERY-PLAN.md),
"First implementation batches after this plan", priority 4, and Phase 6's
opening instruction: "Start the feasibility spike immediately after the
deployed foundation and authentication are usable... Validate the existing
mediasoup direction against actual hosting/network/operating constraints,
or document a deliberate alternative in an ADR").

## Ground-truth preflight

- Branch: `main`
- Commit: `f394f99`
- Working tree: bootstrap artifacts staged (`CLAUDE.md`, `docs/agent/**`,
  `docs/tasks/README.md`) from the just-completed `/bootstrap-project` run,
  not yet committed.
- Repo state matches `docs/agent/project-profile.md`? Yes.

## Scope

**In scope**:
- Prove real two-peer audio through a mediasoup SFU between two authenticated
  browser sessions, joined to the same voice channel, running locally
  (localhost / same machine — not yet cross-network or TURN-only).
- Authenticated room membership/signaling: joining a voice channel checks
  the existing guild/channel permissions (`VIEW_CHANNEL`/`SPEAK` or
  equivalent) before granting a media transport.
- Minimal client UI: join/leave a voice channel, mute/deafen, see who's
  connected. Does not need to match the polish of the rest of the app.
- Record deployment/media-path notes: which ports mediasoup needs, what NAT
  traversal assumptions were made, what changes cross-network/TURN testing
  would require later.
- An ADR-style writeup of the decision (mediasoup vs. any alternative
  considered) as the delivery plan requires.

**Out of scope** (explicitly deferred, not silently dropped):
- Cross-network and TURN-only testing (needs real deployed infrastructure —
  Phase 1 staging isn't done yet). Flagged as a known gap in this spike's
  own report, not claimed as passed.
- Video/screenshare.
- Forwarding consented audio to Recall/transcription (Phase 7).
- Production hosting/deployment of the media service.
- Participant limits, moderator disconnect/mute controls, room occupancy
  events beyond what's needed to prove the two-peer case.
- Polished UI (speaking indicators, volume controls, device switching) —
  only what's needed to demonstrate and verify the spike.

## Acceptance criteria

1. Two separate authenticated browser sessions (real accounts, real cookies,
   not mocked) join the same voice channel and mediasoup reports both as
   connected producers/consumers.
2. Real audio is exchanged and can be confirmed (e.g. audio level/activity
   observed on both sides, not just "connection established").
3. An unauthorized/unrelated account (not a member of the guild, or lacking
   the relevant permission) is denied a media transport — this is a new
   attack surface and the delivery plan requires denial coverage for every
   new route/dispatch.
4. Leaving the channel or closing the tab releases the media transport
   (no orphaned mediasoup resources).
5. `pnpm typecheck`, `pnpm build`, and existing test suites still pass with
   the new service/code added.
6. A written record of what was and wasn't proven (ports, NAT/TURN
   assumptions, what's needed for cross-network testing) exists in this
   task's `verification.md` / final report.

## Recommended workflow

This introduces mediasoup (a new major runtime dependency) and a new
service/architecture surface — classified as **Architecture change** in
[docs/agent/workflow.md](../../agent/workflow.md)'s table:

1. **Argus** — investigate the existing gateway/permission/channel-type code
   the voice signaling needs to hook into (`apps/gateway`, `apps/api/src/db.ts`
   channel permissions, `packages/shared` channel types), and survey what a
   minimal mediasoup integration requires (worker/router/transport model,
   where a new `apps/media` (or similar) service would live, signaling
   transport choice).
2. **Athena** — turn that into a concrete plan: architecture decision
   (mediasoup topology, new service boundary, signaling protocol — reuse the
   existing gateway WebSocket or a separate one), split into the ≤2
   independently-scoped builder tracks the dual-builder workflow needs
   (e.g. Track A: server-side mediasoup service + signaling + permission
   checks; Track B: client-side mediasoup-client integration + minimal UI),
   and acceptance criteria refinement.
3. **Independent Themis review of the plan** (architecture-change tier
   requires this before implementation, on top of the normal review after
   implementation).
4. **Your approval** — hard stop, this is the main gate for the task.
5. Parallel dual-builder implementation (Sonnet + Codex on the two tracks).
6. Cross-review (Codex reviews the Sonnet track, Sonnet reviews the Codex
   track).
7. **Apollo** — real runtime verification: actually run two browser sessions
   locally and observe audio, run the denial-of-service-account test, run
   typecheck/build/tests.

## Risk level

**High** — new major dependency, new network-facing service, new attack
surface (unauthorized media access), and this is explicitly the delivery
plan's "largest product feasibility risk" to resolve early. Justifies the
full Architecture-change workflow rather than skipping straight to
implementation.

## Approval gates for this task

- The architecture decision itself (mediasoup topology / service boundary /
  signaling choice) — from `docs/agent/project-profile.md`'s standing gates.
- Adding the `mediasoup` npm package (and any transitive native build
  requirements) — new major dependency, flagged per project approval gates.
- Any change to `infra/schema.sql` or a new migration, if voice channel
  state needs new persisted fields (flag even if it looks minor).
