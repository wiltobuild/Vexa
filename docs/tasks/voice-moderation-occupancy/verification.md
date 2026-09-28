# Verification: voice-moderation-occupancy (Apollo)

Date: 2026-09-28. Branch `feat/voice-moderation-occupancy`, HEAD `749cdae`.

## Status: all acceptance criteria proven live

Dual-builder implementation (Track A/Sonnet: `apps/media`; Track B/Codex:
`apps/web`), cross-reviewed by the other model, one fix-pass round
(4 must-fix on Track A, 2 must-fix on Track B — including a real
cross-cutting gap, mute state not surviving reconnect/late-join, that
required a small contract addition mid-review), then this session ran
the full live verification.

## What was verified live (real Docker stack, real command output)

1. **Full `apps/media` integration suite: 14 passed, 1 skipped** (the
   pre-existing win32 SIGTERM limitation, unrelated to this task) —
   including 8 new tests for this task: mute/unmute against real
   `Producer.paused` state, permission denial (403) both for missing
   `MODERATE_MEMBERS` and for a moderator not present in the target room,
   404 for an absent target, `moderatorDisconnect` teardown +
   `removedByModerator` delivery, mute persistence across a real
   disconnect/reconnect (confirmed via a late joiner's `mutedParticipants`
   AND the reconnecting user's own new producer starting paused), the
   loopback-only debug endpoint still working for the legitimate local
   test case, and `voice.occupancy` published correctly across
   join/second-join/disconnect/moderator-disconnect via the real
   `vexa:dispatch` Redis channel (the same one `apps/gateway` itself
   subscribes to — not a mock).
2. **Full `apps/gateway` integration suite: 7 passed** — no regression.
3. **Full `pnpm test:e2e`: 18 passed, 1 expected skip** (19 total) —
   including the new moderation/occupancy e2e test (a real owner mutes and
   disconnects a real member; the member's UI reflects the locked and
   removed states; a third account watching the channel list, not joined
   to voice, sees the occupancy badge update live) and both prior
   voice-audio tests (two-peer real audio, mic-denial listen-only)
   confirmed still passing alongside it.
4. **`pnpm -r typecheck`** and **`pnpm build`** — clean. Confirmed no
   test-only debug references leak into the production `apps/web` build.

## Two rounds of real bugs found via review + live testing (not caught by either builder alone)

**Cross-review round** (before any live re-test):
- Track A: moderator actions weren't scoped to the moderator's own room
  (guild permission was checked correctly, but a moderator connected to a
  *different* room — or no room at all — could still target someone
  elsewhere); `moderatorSetMute` silently reported success even when the
  underlying `pause()`/`resume()` call actually failed; a test-only debug
  HTTP endpoint had no access control beyond an env var, a real exposure
  risk if that var were ever accidentally set in production.
- Track B: no e2e test existed yet for this feature (a real gap against
  the brief's own acceptance criteria); moderator-imposed mute state had
  no persistence — it never reached a late joiner and didn't survive a
  reconnect (the device-network-handling task's reconnect model is a full
  teardown+rejoin, not session resumption, so anything not explicitly
  carried across that boundary is lost). This required a small contract
  addition (`mutedParticipants` in `join`'s response, room-scoped, not
  cleared on an individual peer's disconnect) rather than a client-only
  fix.

All 6 fixed, re-reviewed implicitly via this session's own independent
live re-verification (not re-delegated for a second formal cross-review
round, given the fixes were concrete and testable — the live test suite
itself is the proof for this round, consistent with how correctness here
is actually established in this project).

## Acceptance criteria (from brief.md) — status

1-5 (mute/disconnect authorization and 403/404 correctness) — **proven
live** via the `apps/media` integration suite.
6 (occupancy visible without joining) — **proven live** via the e2e test's
third-account scenario.
7 (local mute-state UI reconciliation) — **proven live** via the e2e
test's lock-state assertion on the muted member's own page.
8 (no regressions) — **proven live**, all suites green.
9 (test coverage matching existing rigor) — met: 8 new `apps/media`
integration tests, 4 new `apps/web` unit tests, 1 new e2e test covering
the full moderation + occupancy flow live.

## Known, explicit gap (not hidden)

- The loopback-only restriction on the `/__test/producer-paused` debug
  endpoint is verified by code inspection and by confirming legitimate
  loopback access still works — it is **not** verified by an automated
  test that a genuinely non-loopback request is actually rejected, since
  originating one from within this same-host test suite isn't practical.
  Flagged by Track A's own fix-pass report, not hidden. The endpoint
  remains gated behind `MEDIA_TEST_DEBUG` (never set in the compose
  service or elsewhere) as the primary control either way.

## Recommendation

Ready to merge. Both the authorization surface (the highest-risk part of
this task, per its own risk assessment) and the cross-cutting
mute-state-persistence gap were caught and fixed before merge, all via
real cross-review and live re-verification — not just code inspection.
