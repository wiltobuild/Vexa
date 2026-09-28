# Task Brief: device-network-handling — Device/network resilience for the voice spike

**Date**: 2026-09-28
**Status**: brief

## Request

"start the next task for phase 6 device/network handling, do everything,
dont stop" — from
[docs/PROFESSIONAL-DELIVERY-PLAN.md](../../PROFESSIONAL-DELIVERY-PLAN.md)
Phase 6: "Handle device permission denial/removal, Bluetooth/device
switching, network changes, reconnects, tab closure and graceful media-node
shutdown. Release microphone/camera tracks on leave." Per the user's
explicit "go full auto" / "do everything, don't stop" instructions
(carried forward from the audio-spike task), this task proceeds through
plan → dual-builder implementation → cross-review → live verification →
merge without intermediate approval stops, except for a genuinely new
architecture decision or destructive action (neither expected here — this
extends the already-approved `apps/media`/mediasoup direction, it doesn't
change it).

## Ground-truth preflight

- Branch: `main` (will branch `feat/device-network-handling`)
- Commit: `8718235` (audio-spike merged)
- Working tree: clean

## Scope

**In scope**:
- **Device permission denial**: joining a voice channel should not hard-fail
  if the microphone is denied/unavailable — allow a listen-only join, with
  a clear "enable microphone" retry affordance.
- **Device removal mid-call**: detect the active input device disappearing
  (`track.onended`, `devicechange`) and degrade gracefully (stop the
  producer, surface a "microphone disconnected" state, offer reselect)
  instead of leaving the app in a broken/silent state.
- **Device switching**: let a user pick a different input device without
  leaving the call (replace the producer's track).
- **Network changes/reconnects**: monitor each transport's ICE connection
  state; on `disconnected`/`failed`, attempt an ICE restart via a new
  `restartIce` signaling op (server obtains fresh ICE parameters from
  mediasoup, client applies them) before giving up. If the signaling
  WebSocket itself drops unexpectedly (not a user-initiated leave), attempt
  a bounded, backed-off automatic rejoin (full rejoin, not session
  resumption — server-side peer state is torn down on disconnect by
  design, per the audio-spike plan's "Channel identity" note; this is a
  deliberate spike-level simplification, not silently glossed over).
- **Tab closure**: best-effort `leave` on `beforeunload`/`pagehide` so the
  server doesn't have to wait for the WS close-detection path.
- **Graceful media-node shutdown**: `apps/media` handles `SIGTERM`/`SIGINT`
  by stopping new connections, tearing down existing peers/routers/worker
  cleanly, then exiting — not an abrupt process kill mid-call.
- **Release tracks on leave**: already implemented in the merged
  audio-spike work (`voiceClient.ts`'s `leave()` stops every track) —
  extend the same discipline to the new failure paths above (device
  removal, ICE failure, tab closure) so tracks are never left dangling.

**Out of scope** (explicitly deferred):
- Participant limits, moderator disconnect/mute controls, room occupancy
  events — a separate Phase 6 line item, not device/network handling.
- Video/screenshare device handling (still out of scope per the original
  spike).
- Cross-network/TURN itself (still same-machine `announcedAddress`,
  unchanged) — this task is about *handling* network disruption on the
  existing same-machine topology, not adding TURN/cross-network transport.
- True session resumption (reusing existing transports/producers across a
  reconnect) — full rejoin is the deliberate simpler approach for this
  pass; named explicitly, not silently narrowed from "reconnect."
- Horizontal scaling / multi-instance `apps/media` — still explicitly out
  of scope per the standing plan.

## Acceptance criteria

1. Denying microphone permission on join still results in a connected,
   listen-only state (able to hear existing producers), not a failed join
   — with a visible way to retry enabling the mic later.
2. Simulating device removal (stopping the active track programmatically,
   the standard way to simulate this in tests) triggers graceful cleanup:
   producer closed server-side (registry entry removed, `producerClosed`
   broadcast to the room), UI shows a clear disconnected-mic state, no
   crash.
3. Switching input devices mid-call replaces the producer's track without
   requiring a full leave/rejoin, and the room's other participants keep
   receiving audio (from the new device) without a `producerClosed`/
   `newProducer` cycle being required (i.e. the same `producerId` persists
   across the switch) — if this specific constraint proves impractical
   against the installed mediasoup-client version's real API, document the
   deviation plainly rather than forcing it.
4. A simulated ICE failure (or a transport whose `connectionstatechange`
   fires `'failed'`) triggers a `restartIce` attempt; if it succeeds, the
   call continues; document what's actually observable given this is a
   same-machine, no real network-loss topology (an integration-level test
   of the signaling round-trip is achievable; a true network-partition
   test may not be, and that gap should be named, not hidden).
5. An unexpected signaling WebSocket close (not from `leave()`) triggers an
   automatic bounded rejoin attempt (with backoff and a max-attempts cap,
   not an infinite retry loop) and the UI reflects a "reconnecting" state
   during it.
6. Closing the tab (or triggering `beforeunload`/`pagehide`) results in the
   server observing a clean teardown (via the best-effort `leave` if it
   lands, or the existing WS-close teardown path as a fallback either way)
   — no orphaned resources, consistent with the existing AC4 standard from
   the audio-spike task.
7. Sending `SIGTERM` to the `apps/media` process while peers are connected
   results in a graceful shutdown: existing peers are torn down cleanly
   (their clients see appropriate close events, not silent connection
   drops with no explanation) and the process exits — verified by actually
   sending the signal to the running container/process and observing the
   behavior, not just reading the code.
8. `pnpm typecheck`, `pnpm build`, and all existing tests (including the
   full audio-spike integration/e2e suites) still pass — no regressions.
9. New behavior has test coverage matching the existing suites' rigor
   (integration tests in `apps/media` for server-side changes, e2e/unit
   tests in `apps/web` for client-side changes) — not just manual
   verification.

## Recommended workflow

This is a **Feature**-tier task extending the already-approved `apps/media`
architecture (not a new architecture decision) — per
[docs/agent/workflow.md](../../agent/workflow.md):

Investigation/plan (done inline by the orchestrating session, given deep
existing context from the just-completed audio-spike task — no separate
Argus/Athena spawn needed for a same-architecture extension) → **dual-
builder implementation** (Track A/Sonnet: server-side `restartIce` op +
graceful shutdown; Track B/Codex: client-side device/network resilience) →
cross-review (the other model reviews each track) → fix passes as needed →
Apollo verification against the live Docker stack (including an actual
`SIGTERM` test) → merge.

Per the user's explicit instruction, this proceeds end-to-end without
intermediate approval stops.

## Risk level

**Medium** — extends existing, already-verified infrastructure rather than
introducing new architecture or dependencies; the main risk is scope
creep across several distinct failure modes (device, ICE, WS reconnect,
process shutdown) rather than any single hard technical risk.

## Approval gates for this task

Per the user's "do everything, don't stop": none expected. If anything
requires a new dependency, a schema/migration change, or reveals that a
piece of this needs to become a genuine new architecture decision, that
still stops for approval per the project's standing gates — but nothing
in this scope is expected to trigger that.
