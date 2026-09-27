# Verification: audio-spike (Apollo)

Date: 2026-09-27. Branch `feat/audio-spike`, HEAD `df8f2fa`.

## Status: signaling/permission pipeline fully verified live; real audio capture blocked by tooling, not the code

Docker was fixed mid-task (see "Docker Desktop fix" below — it needed a
setting change, not just a reboot). With the full stack running for real
(Postgres, Redis, `apps/api`, `apps/gateway`, `apps/web`, and the
Docker-hosted `apps/media`), this session found and fixed **two real bugs**
that only a live run could surface (a `.dockerignore` build bug and a
`consume`-hang schema-validation bug — both below), then ran the actual
live integration suites and a real two-account browser session. What's
proven now goes well beyond the previous (pre-reboot) static-only pass.

**What's still not proven**: literal two-way audio packets flowing between
two real browsers with real microphones. Every tool available in this
session (the built-in browser pane) blocks `getUserMedia` outright with no
fake-device escape hatch, so this is a tooling ceiling, not a code gap —
see "What could not be verified" below for exactly what's needed to close
it and by whom.

## What was verified live (real Docker stack, real command output, this session)

1. **`docker compose up -d postgres redis media`** — all three containers
   build and start healthy. `apps/media`'s Dockerfile builds correctly,
   including mediasoup's Linux native worker prebuild
   (`mediasoup-worker-3.27.1-linux-x64-kernel6.tgz`), downloaded and
   validated automatically during the image build.
2. **Bug found and fixed: no `.dockerignore` existed anywhere in the
   repo.** `apps/media/Dockerfile`'s `COPY apps/media apps/media` was
   copying the host's Windows-symlinked `node_modules` over the image's
   own correctly pnpm-installed Linux `node_modules`, breaking `tsx`
   module resolution at container startup (`Cannot find module
   '/app/apps/media/node_modules/tsx/dist/cli.mjs'`). Fixed by commit
   `d070d2a` (root `.dockerignore`). Confirmed fixed: `media-1` now starts
   cleanly and `/live`+`/ready` both return `{"ok":true}`.
3. **`pnpm db:migrate`** against the real Postgres container — succeeds.
4. **Native `api`+`gateway`+`web`** started against the real Postgres/Redis
   containers — all reachable (`/health`, `/live`, `:5173` all confirmed).
5. **`VEXA_INTEGRATION=1 pnpm --filter @vexa/gateway test`** against the
   real live stack — **all 7 tests pass** (auth/permission flow, role
   escalation guards, friends/DMs/blocking, liveness/readiness, pins,
   reactions, profiles/outbox). Required bumping `API_RATE_LIMIT_MAX` in
   addition to the README's documented `AUTH_REGISTER_RATE_LIMIT_MAX` —
   the general per-route limiter (not just registration) was tripping
   under this suite's request volume; both are now in `.env` for local
   verification runs (not committed — local-only override).
6. **Bug found and fixed: `consume` hung indefinitely on every real
   success path.** `VEXA_INTEGRATION=1 pnpm --filter @vexa/media test`
   against the live stack initially showed 3 of 6 tests timing out
   (7s client-side timeout, no server response, no error logged
   anywhere). Root-caused with real evidence (temporary debug logging,
   since removed): mediasoup's `Router#rtpCapabilities.headerExtensions`
   includes both audio- and video-kind entries (~18 total) even for an
   audio-only router — mediasoup does not filter this list to configured
   `mediaCodecs`. The frozen contract's `rtpCapabilitiesSchema`
   (`packages/shared/src/media.ts`) requires every entry to be
   `kind:'audio'` and caps the array at 16. Since `join`'s reply sent the
   raw, unfiltered router object, and the client/test echoes it back
   verbatim as `consume`'s `rtpCapabilities`, that `consume` request
   failed the frozen contract's own schema on the way back in —
   indistinguishable from a hang, since a schema-parse failure closes the
   socket with no reply (code 4002) per the contract's own malformed-
   request rule. Fixed by commit `df8f2fa` (filters `headerExtensions` to
   `kind==='audio'` before sending in `join`'s reply). Independently
   re-reviewed (Codex/`gpt-5.6-terra`): approved, no must-fix findings.
7. **Re-ran `apps/media`'s full integration suite after the fix — all 6
   tests pass for real** (permission/channel-type denial, disconnect
   cleanup releasing transport+producer with no orphaned resources, tier-1
   ownership rejecting cross-peer transport/consumer IDs, tier-2 registry
   correctly allowing same-channel consumption and rejecting
   cross-channel, duplicate-consume rejected with 409), runtime ~1.9s
   (down from ~22.7s of timeouts before the fix). This is the strongest
   evidence yet for AC1 and AC3: **two genuinely distinct authenticated
   accounts, a real mediasoup worker, real `Router`/`Transport`/
   `Producer`/`Consumer` objects, one peer's real producer consumed by a
   same-channel peer and correctly rejected for a different-channel
   peer** — the entire SFU signaling and authorization pipeline, exercised
   end-to-end against live infrastructure, not mocked.
8. **Real two-account browser session** (built-in browser pane, connected
   workspace, not the local demo): registered two real accounts via the
   API, created a guild with a `general-voice` channel and an invite,
   joined the second account via that invite, then logged in as the owner
   in the browser and navigated to the voice channel. The **"Join voice"**
   UI (Track B's work) renders correctly and is gated to `type==='voice'`
   channels as designed. Clicking it reaches the client's real `join()`
   flow (a real WS connection to `apps/media`, a real signaling
   round-trip) and fails cleanly at the exact point of requesting
   microphone access, showing a "Permission denied" banner with a
   working retry/dismiss UI — confirming the client wiring is correct
   end-to-end up to the browser's own device-permission boundary.

## What could not be verified (and exactly why)

- **Real audio packets between two real browsers.** The built-in browser
  pane blocks `getUserMedia` outright ("microphone access... is blocked in
  the Browser pane") with no fake-device flag exposed to this session —
  this is a tooling ceiling common to sandboxed/automated browser
  contexts, not something the app can work around. Playwright (used by
  this repo's own e2e suite) supports `--use-fake-device-for-media-stream`
  for exactly this reason, but that flag isn't available through the
  interactive browser-pane tool used in this session.
- **What would close this gap**: either (a) the repo owner runs two real
  browser windows on a machine with working microphones (e.g. two Chrome
  profiles, or two devices) against this same running stack and confirms
  audio both ways, or (b) a future session adds a Playwright-based e2e
  test using `--use-fake-device-for-media-stream` that drives two real
  browser contexts through the full join→produce→consume flow and checks
  for actual RTP activity (e.g. via `getStats()` on the consumer's
  `RTCPeerConnection` reporting nonzero `packetsReceived`) — this would
  also give durable, repeatable CI-style coverage instead of a one-off
  manual check.
- **Cross-network/TURN**: not attempted, out of scope for this spike by
  design (`announcedAddress=127.0.0.1`, same-machine only).
- **Mid-call permission-*bits* revocation** (distinct from session
  invalidation, which the 30s sweep does handle): explicitly out of scope,
  per the approved plan.

## Docker Desktop fix (for the record — not an app bug)

Docker Desktop's backend crashed on startup repeatedly, alternating
between two different internal AF_UNIX sockets
(`Docker/run/dockerInference`, `docker-secrets-engine/engine.sock`) with
"The file cannot be accessed by the system." **A full reboot alone did
not fix this** — it recurred identically after rebooting. The actual fix:
disabling `EnableDockerAI` in `%AppData%\Docker\settings-store.json`
(Docker Desktop's "Docker AI"/Model Runner feature, which owns the
Inference manager component that was crash-looping) and relaunching. This
is a pre-existing host/Docker Desktop issue unrelated to this repository —
noted here only so a future session doesn't have to re-diagnose it if it
recurs.

## Ports/topology for the record

Media WS on `3003`; RTP/ICE UDP+TCP range `40000-40099`; Docker-hosted
`mediasoup-worker` with `announcedAddress=127.0.0.1`.

## Files changed since the previous (pre-reboot) verification pass

- `d070d2a` — root `.dockerignore` (fixes the `apps/media` Docker build).
- `df8f2fa` — `apps/media`: fix the `consume` hang (audio-only
  `rtpCapabilities` filtering).

## Recommendation

The signaling/permission/ownership pipeline is now proven end-to-end
against live infrastructure — this was the harder, riskier half of the
spike (the plan's own review rounds spent most of their findings here).
The remaining gap (real audio packets) is a tooling limitation of this
session's environment, not an open question about the implementation's
correctness. Recommend: merge once the repo owner (or a session with
fake-device-capable browser automation) closes that last gap — do not
claim it proven without that evidence, per this task's own standard of not
overclaiming feasibility.
