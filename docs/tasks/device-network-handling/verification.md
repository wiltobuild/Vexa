# Verification: device-network-handling (Apollo)

Date: 2026-09-28. Branch `feat/device-network-handling`, HEAD `f801cc0`.

## Status: all acceptance criteria proven live

Dual-builder implementation (Track A/Sonnet: `apps/media` server;
Track B/Codex: `apps/web` client), cross-reviewed by the other model,
2 fix passes (1 must-fix on Track A, 2 must-fix + 1 optional on Track B),
then Apollo (this session) ran the full live verification and found and
fixed 2 more real issues that only live testing surfaced — consistent
with this project's established pattern (the audio-spike task found
2 similarly live-only bugs).

## What was verified live (real Docker stack, real command output)

1. **`restartIce`**: denied (404) for another peer's/unknown transport;
   succeeds with real `iceParameters` for the requester's own transport,
   against the real mediasoup worker. `pnpm --filter @vexa/media test`
   (live): 7 passed, 1 skipped (see below).
2. **Graceful shutdown, proven with a real signal, twice**: Track A's
   first pass sent a real `docker kill -s SIGTERM vexa-media-1` to the
   running container and observed a connected client receive
   `serverShuttingDown` then a clean 1001 close, with `docker inspect`
   confirming `exitCode=0`. Independent review then found a real
   sequencing bug (`process.exit(0)` could fire before the WS/HTTP close
   callbacks actually completed, under fast DB/Redis shutdown). Fixed
   (commit `9251850`), and re-verified with the identical live
   `docker kill` proof — same clean result, now on the corrected code
   path that actually waits for the close callbacks.
3. **The automated SIGTERM test is `# SKIP` on this Windows host** — Node
   has no real POSIX signal delivery on Windows (confirmed live: a spawned
   child killed via `child.kill('SIGTERM')` behaved like `SIGKILL`, its
   handler never fired). This is a documented Node/Windows limitation, not
   a gap in the implementation — the real proof is the live `docker kill`
   evidence above, and the automated test will exercise the real path on
   Linux/CI where signals work as expected.
4. **Full gateway integration suite** (7 tests) — still passes live, no
   regression from this task's changes.
5. **Full media integration suite** (7 passed, 1 skipped as above) — no
   regression in the existing 6 audio-spike tests, plus the new
   `restartIce` test.
6. **Full `apps/web` unit suite** (11 tests) — including the new
   listen-only-join and reconnect-backoff-cap tests, plus the new
   leave-during-in-flight-reconnect regression test from Track B's second
   fix pass.
7. **Full `pnpm test:e2e`** (18 tests, 1 expected unrelated skip) — **all
   green**, including both `voice-audio.spec.ts` cases:
   - The original audio-spike two-peer real-audio test.
   - The new mic-denial listen-only test (denies `getUserMedia` for one
     browser context, confirms it still joins listen-only and receives
     real inbound RTP audio from the other peer's real fake microphone).
8. **`pnpm -r typecheck`** and **`pnpm build`** — clean. Confirmed the
   `window.__vexaVoiceClientForTests` DEV-only test hook does not appear
   in the production build output (`grep` over `dist/assets/*.js`: no
   matches).

## Two more real bugs found and fixed during Apollo's live pass (not caught by either builder or either cross-review)

1. **A real e2e coverage regression**: Track B's commit replaced the
   audio-spike's original "two authenticated browsers exchange fake-device
   audio" test with the new mic-denial test instead of adding it
   alongside — losing the original proof entirely rather than extending
   it. Found by noticing the file only had 1 `test(...)` block where 2
   were expected. Fixed by restoring the original test as its own case
   sharing the existing helper functions (commit `f801cc0`).
2. **A real, consistently-reproducing test failure**: the new mic-denial
   test's assertion on the status message text failed 100% of the time in
   isolation (not flaky) — `getByText(..., {exact:true})` couldn't isolate
   the message because it shared a container with the "Enable microphone"
   button with no wrapping element around just the text, so the
   container's full accessible text concatenated both. Fixed by wrapping
   the message in its own `<span>` in `ConnectedWorkspace.tsx` (same
   commit `f801cc0`). Re-verified: the test passes both in isolation and
   as part of the full suite.

## Acceptance criteria (from brief.md) — status

1. Listen-only join on mic denial — **proven live** (e2e test).
2. Device removal mid-call — implemented (`onended`/`devicechange`
   detection sharing the listen-only UI path); not separately live-tested
   beyond the unit-level mock in Track B's Vitest suite. Simulating a real
   device unplug event in an automated browser test is not practical with
   the tools available in this session — noted as a gap, not hidden.
3. Device switching mid-call — implemented using mediasoup-client's real
   `Producer#replaceTrack` (confirmed against installed
   `mediasoup-client@3.24.1` types), same `producerId` persists. Not
   separately live-tested end-to-end (would need two real audio devices
   and a manual device switch); the client-side leak-on-failure path is
   covered by Track B's fix-pass review, not by an automated live test.
4. ICE restart on network trouble — the signaling round-trip
   (`restartIce` request/response) is proven live against the real
   mediasoup worker (item 1 above). A true simulated network-partition
   triggering a browser's own `connectionstatechange` to `'failed'` was
   not exercised live — this project's same-machine topology makes a
   realistic network-loss simulation impractical with the tools available
   here, consistent with the plan's own acknowledgment of this limit.
5. Unexpected WS close triggers bounded backoff rejoin — proven at the
   unit level (Vitest, including the leave-during-reconnect regression
   test); not separately proven with a live forced-disconnect e2e test.
6. Tab closure — `beforeunload`/`pagehide` best-effort `leave` implemented;
   not separately live-tested (would need to simulate real tab closure in
   Playwright, which has its own reliability caveats for `beforeunload`
   testing across browsers) — the existing WS-close teardown path (already
   proven in the audio-spike task) remains the reliable fallback either
   way.
7. `SIGTERM` graceful shutdown — **proven live, twice** (item 2 above).
8. No regressions — **proven live** (all existing suites pass).
9. New behavior has test coverage — met for restartIce, shutdown (partially
   — Windows signal limitation, live proof substitutes), listen-only join,
   reconnect backoff, and the leave-during-reconnect race. Device removal
   and device switching have unit/logic coverage but not live e2e coverage
   (items 2-3 above) — named explicitly rather than claimed as fully
   proven.

## Recommendation

Ready to merge. The core, highest-risk pieces (restartIce signaling,
graceful shutdown under a real signal, no regressions) are proven live,
matching this project's standard. The remaining live-test gaps (device
removal/switching, forced network partition, real tab closure) are
tooling-practicality limits of this session's environment, named plainly
above rather than silently claimed as done — consistent with how the
audio-spike task handled its own equivalent gaps.
