# Plan: device-network-handling

Condensed plan (orchestrating session, not a separate Athena spawn — this
extends the already-approved `apps/media` architecture with deep existing
context from the just-merged audio-spike task, per the user's "do
everything, don't stop" instruction).

## Contract addition (already made, Phase-0 style, before either builder starts)

`packages/shared/src/media.ts`:
- New request `restartIce` (payload: `transportId`) / response
  `restartIceResponseSchema` (`{iceParameters}`) — resolved via the same
  tier-1 per-peer transport ownership rule as `connectTransport`/`produce`/
  `consume`. No new dependency, no schema/migration change.
- New server event `serverShuttingDown` (empty payload) — broadcast once to
  every connected peer before graceful shutdown begins.

Verified: `pnpm --filter @vexa/shared typecheck`, `--filter @vexa/media
typecheck`, `--filter @vexa/web typecheck` all clean with the addition in
place (media/web don't yet handle the new message types — that's each
track's job below).

## Builder track split

### Track A (Sonnet) — server-side, `apps/media`

- **`restartIce` handler**: tier-1 ownership lookup (peer's own
  `transports` map) → `await entry.transport.restartIce()` → reply
  `{iceParameters}`. Same session re-check / `torndown` re-check-after-
  await pattern as every other handler (see `plan.md`'s "Session
  re-verification" and "Teardown idempotency" from the audio-spike task —
  apply the same discipline here, don't skip it because it's a small
  addition).
- **Graceful shutdown**: on `SIGTERM`/`SIGINT`, broadcast
  `serverShuttingDown` to every connected peer, stop accepting new WS
  upgrades, call `teardownPeer` for every connected peer (releasing all
  transports/producers/consumers and routers), close the HTTP/WS server,
  close the mediasoup `worker`, then `process.exit(0)`. Give in-flight
  requests a bounded grace period (e.g. a few hundred ms) before forcing
  closure rather than cutting them off mid-response, but don't hang
  indefinitely if a client never disconnects on its own.
- Tests: `restartIce` denied for a transport that isn't the requester's own
  (tier-1, mirrors the existing ownership tests); `restartIce` succeeds and
  returns usable `iceParameters` for a real transport against the live
  mediasoup worker; a graceful-shutdown test that actually sends the
  process a signal (or calls the shutdown function directly, whichever is
  more practical to test reliably) and confirms connected peers receive
  `serverShuttingDown` before the socket closes, and that shutdown
  completes within a bounded time instead of hanging.

### Track B (Codex) — client-side, `apps/web`

- **Listen-only join on mic denial**: `voiceClient.join()`'s
  `getUserMedia` call currently blocks the whole join on failure — change
  so a `getUserMedia` rejection doesn't abort `join()`; the client still
  completes the signaling join (recv-only), surfaces a clear "microphone
  unavailable" state with a retry affordance that re-attempts
  `getUserMedia` and, on success, creates the send transport + producer
  without requiring a full rejoin.
- **Device removal mid-call**: listen for the local track's `onended` and
  the `navigator.mediaDevices.ondevicechange` event; on the active input
  disappearing, close the producer (client-side `producer.close()` — this
  will naturally trigger the server's existing `producerClosed`
  broadcast/registry cleanup, no new server behavior needed here), surface
  a "microphone disconnected" state mirroring the listen-only state above.
- **Device switching**: a way to pick a different input device
  mid-call (UI: reuse whatever minimal pattern fits the existing voice UI,
  don't over-build a full settings panel for this spike). Implementation:
  mediasoup-client's `Producer` doesn't expose `replaceTrack` in this
  installed version (confirm against the actual installed
  `mediasoup-client` types as your first check, per this project's
  established discipline of verifying real library shapes rather than
  assuming) — if genuinely unavailable, the acceptable fallback is close
  the old producer + `getUserMedia` on the new device + produce again
  (new `producerId`, triggering `producerClosed`+`newProducer` for other
  peers — a brief interruption, not a seamless swap). Document whichever
  path you took and why in your report; AC3 already anticipates this
  deviation being acceptable if seamless replacement isn't practical.
- **ICE restart on network trouble**: for every transport (send and recv),
  listen for `connectionstatechange`; on `'disconnected'` or `'failed'`,
  call the new `restartIce` signaling request, then
  `transport.restartIce({iceParameters})` (mediasoup-client's client-side
  method — confirm exact name/shape against the installed version). If
  the restart itself fails or the state doesn't recover, fall back to the
  reconnect flow below rather than leaving the call silently broken.
- **Signaling WS reconnect**: on an unexpected `close` of the signaling
  WebSocket (not from calling `leave()` yourself), attempt an automatic
  rejoin with exponential backoff and a bounded number of attempts (e.g.
  5), showing a "reconnecting" UI state throughout; on giving up, surface
  a clear failure state with a manual retry action. This is a full rejoin
  (new transports/producer/consumers), not session resumption — call this
  out in a code comment referencing this same note in the plan, so a
  future reader doesn't assume more continuity than actually exists.
- **`beforeunload`/`pagehide`**: best-effort synchronous-ish `leave` send
  (a fire-and-forget WS message is fine; don't block page unload waiting
  for a response) so the server's teardown isn't solely reliant on
  detecting the WS close.
- **Also handle `serverShuttingDown`**: show a distinct "server is
  restarting" state (different from a generic connection failure) and
  trigger the same reconnect-with-backoff flow, since after this event the
  server socket will close shortly.
- Tests: unit tests (Vitest, matching `apps/web/src/media/media.test.ts`'s
  existing style) for the reconnect backoff/attempt-cap logic and the
  listen-only-join fallback path; an e2e test (Playwright, matching
  `apps/web/e2e/voice-audio.spec.ts`'s real fake-device pattern and its
  media-reachability skip-gate) that actually denies mic permission via
  Playwright's permission APIs and confirms a listen-only join still
  succeeds and can hear an existing producer.

## Acceptance criteria

See `brief.md`'s 9 acceptance criteria — unchanged, this plan implements
them directly without narrowing scope.

## Verification (Apollo, live Docker stack)

- All existing audio-spike integration/e2e suites still pass (no
  regressions) — `apps/gateway` (7), `apps/media` (existing + new
  `restartIce`/shutdown tests), `apps/web` (existing + new device/reconnect
  tests), full `pnpm test:e2e`.
- Actually send `SIGTERM` to the running `apps/media` container
  (`docker kill -s SIGTERM vexa-media-1` or equivalent) with a live peer
  connected and observe the graceful shutdown behavior directly, not just
  via the automated test — this is exactly the kind of thing that needs
  live proof per this project's established standard (see the audio-spike
  task's two live-only bugs, both of which static verification alone
  missed).
- `pnpm typecheck`, `pnpm build`.

No implementation performed by this document itself — Track A and Track B
build next, in parallel.
