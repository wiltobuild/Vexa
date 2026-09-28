# Task Brief: voice-moderation-occupancy — Participant limits, moderator controls, room occupancy

**Date**: 2026-09-28
**Status**: brief

## Request

"go ahead" — continuing the next Phase 6 line item from
[docs/PROFESSIONAL-DELIVERY-PLAN.md](../../PROFESSIONAL-DELIVERY-PLAN.md):
"Add participant limits, moderator disconnect/mute controls, room
occupancy events and isolation between rooms. Reconcile UI mute state
with actual media flow." Per the user's standing "go full auto"/"do
everything, don't stop" instructions carried forward from the two prior
merged tasks, this proceeds through plan → dual-builder implementation →
cross-review → live verification → merge without intermediate approval
stops.

## Ground-truth preflight

- Branch: `main` → `feat/voice-moderation-occupancy`
- Commit: `4d3af1b` (device-network-handling merged)
- Working tree: clean before this task's contract addition

## Scope

**Already done, not re-scoped here** (confirmed by reading
`apps/media/src/index.ts`):
- **Participant limits**: `MAX_PEERS_PER_ROUTER = 8` already caps a
  channel's router; `join` beyond it already responds `{code:429, message:
  'Room full'}`. No new work here — the plan line item is already
  satisfied from the audio-spike task.
- **Isolation between rooms**: the tier-2 room-scoped producer registry
  (audio-spike task) already prevents cross-room producer access. No new
  work here either.

**New in this task**:
- **Moderator disconnect/mute controls**: a guild member with
  `MODERATE_MEMBERS` can force-mute (pause) or force-unmute another
  connected participant's producer, and can force-disconnect them from the
  voice call entirely — without needing to also have `KICK_MEMBERS`/ban
  the person from the guild, this is voice-call-scoped moderation, not
  guild membership moderation. Contract additions already made (mechanical
  Phase-0 step, before either builder starts):
  `packages/shared/src/media.ts` now has `moderatorSetMute`/
  `moderatorDisconnect` requests, their (empty) response schemas, and
  `participantMuted`/`removedByModerator` events. Full workspace
  typechecks clean with the addition in place.
- **Room occupancy events**: users browsing the channel list (not
  currently in the voice channel) should see how many people are
  currently in a voice channel, so they know before joining. This needs to
  reach clients that are NOT connected to `apps/media` at all — via the
  existing text gateway's dispatch mechanism (`publish()` in
  `apps/api/src/db.ts`, the same Redis pub/sub + replay stream every other
  live update already uses — `typing.start`, `reaction.update`, etc.),
  not a new `apps/media`-only event. `apps/media` calls `publish()`
  (already exported from `@vexa/api/db`, importable the same way
  `apps/media` already imports `requireChannel`/`config`/etc.) whenever a
  channel's connected-peer count changes.
- **Reconcile UI mute state with actual media flow**: when a moderator
  mutes someone, that participant's own mute toggle must reflect the
  forced state (disabled from self-unmuting until the moderator releases
  it, not just visually stale) — the server is the source of truth for a
  moderator-imposed mute, not the client's local toggle state.

**Explicitly out of scope** (named, not silently dropped):
- Self-mute broadcast to other participants (currently, and remaining,
  purely client-side `producer.pause()`/`resume()` with no server
  round-trip or notification to others — this task only reconciles
  *moderator-imposed* mute state, not building full mute-status
  broadcasting for everyone's own voluntary mute).
- Occupancy for anything beyond a simple connected-peer count (no speaking
  indicators, no per-user avatars-in-channel-list beyond what a count
  affords) — a richer presence UI is a separate, larger piece of work.
- Video/screenshare-related moderation (still out of scope generally, per
  every prior voice task in this repo).
- Any change to guild-level moderation (kick/ban/timeout) — those already
  exist in `apps/api` and are untouched; this task adds a
  voice-call-scoped moderation surface alongside them, not a replacement.

## Acceptance criteria

1. A guild member with `MODERATE_MEMBERS` can send `moderatorSetMute` for
   another connected participant in the same voice channel; the target's
   producer is paused/resumed server-side (not just a UI hint), verified
   live against the real mediasoup worker (the target's real inbound RTP
   stats — reusing `getInboundAudioStatsForTests()`-style verification
   from the prior tasks — actually stop/resume when muted/unmuted).
2. A member WITHOUT `MODERATE_MEMBERS` attempting the same request is
   denied (403), verified live, not just by code inspection.
3. `moderatorDisconnect` force-removes a target's connection: their
   producer/transports/consumers are torn down (reusing the existing
   `teardownPeer` path — no new cleanup logic duplicated), they receive
   `removedByModerator` before the socket closes, and everyone else in the
   room receives the existing `peerLeft` event. Verified live with a real
   third connection actually being disconnected.
4. A member without `MODERATE_MEMBERS` cannot disconnect another
   participant (403), verified live.
5. The moderator cannot be spoofed by `targetUserId` referring to someone
   not actually in that specific room (unknown/not-present target → 404,
   same error shape as every other "doesn't exist" case in this contract —
   not a silent no-op).
6. A text-channel-list user who has NOT joined a voice channel sees an
   accurate occupancy count for it, updating live as people join/leave —
   proven via the existing gateway WebSocket connection (no need to join
   `apps/media` to see this), verified live with real accounts.
7. The muted participant's own UI reflects the forced-mute state
   (mute button disabled/shows "muted by moderator", cannot self-unmute
   until the moderator releases it) — verified live in a real browser
   session, not just unit-tested.
8. `pnpm typecheck`, `pnpm build`, and all existing tests (every suite
   from the audio-spike and device-network-handling tasks) still pass —
   no regressions.
9. New behavior has test coverage matching the existing suites' rigor —
   integration tests in `apps/media` for the moderation ops, and
   integration/e2e tests covering the occupancy dispatch and the mute-UI
   reconciliation.

## Recommended workflow

**Feature**-tier, extending the already-approved `apps/media` architecture
(not a new architecture decision) — same pattern as the prior two tasks:
condensed plan (this document) → dual-builder implementation (Track A:
server-side moderation ops + occupancy publishing in `apps/media`; Track
B: client-side moderator controls UI + occupancy display + mute-state
reconciliation in `apps/web`) → cross-review by the other model → fix
passes → Apollo live verification → merge, without intermediate approval
stops per the user's standing instruction.

## Risk level

**Medium** — extends existing infrastructure with a new authorization
surface (voice-call moderation) that must not allow privilege escalation
or cross-room targeting; the audio-spike task's own review history shows
exactly this class of bug (ownership/authorization mistakes) is the
highest-value thing for cross-review and live verification to catch here.

## Approval gates for this task

Per the user's "do everything, don't stop": none expected. The contract
addition (mechanical, matching the existing frozen-contract pattern and
already typechecked) does not itself constitute a new architecture
decision requiring a stop.
