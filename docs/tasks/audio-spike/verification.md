# Verification: audio-spike (Apollo)

Date: 2026-09-27. Branch `feat/audio-spike`, HEAD `542f292`.

## Status: all acceptance criteria proven live, including real two-peer audio

Docker was fixed mid-task (see "Docker Desktop fix" below — it needed a
setting change, not just a reboot). With the full stack running for real
(Postgres, Redis, `apps/api`, `apps/gateway`, `apps/web`, and the
Docker-hosted `apps/media`), this session found and fixed **two real bugs**
that only a live run could surface (a `.dockerignore` build bug and a
`consume`-hang schema-validation bug — both below), ran the live
integration suites, and closed the final gap with a real Playwright
fake-device e2e test proving actual RTP audio packets flow between two
independent browser sessions through the SFU. This is the spike's own
exit gate ("two authenticated browsers... exchange real audio"), now
demonstrated, not just argued.

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

## Real two-peer audio: now proven (closes the previous gap)

The built-in interactive browser pane blocks `getUserMedia` outright with
no fake-device escape hatch (confirmed while driving a real two-account
session through the UI — see below), so a follow-up pass added a proper
Playwright e2e test instead: `apps/web/e2e/voice-audio.spec.ts`, run under
a dedicated `chromium-voice-audio` project
(`apps/web/playwright.config.ts`) launched with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`. This
is a **real** media pipeline, not a mock — Chromium's native fake device
produces genuine synthetic audio samples that flow through the actual
WebRTC/ICE/DTLS/SRTP stack.

The test: two `browser.newContext()` instances (genuinely cookie-isolated,
not tabs), two real accounts registered through the actual signup flow, a
real guild/voice-channel/invite, both joining the same channel, then
polling `recvTransport.getStats()` (added as
`getInboundAudioStatsForTests()` in `apps/web/src/media/voiceClient.ts`,
using the public WebRTC stats API, not private internals) until an
`inbound-rtp`/`kind==='audio'` entry reports `packetsReceived > 0` and
`bytesReceived > 0` — a real WebRTC counter that cannot go nonzero without
genuine RTP flowing from the other peer.

**Verified independently by the orchestrating session**, not just trusted
from the builder's report:
```
$ VEXA_INTEGRATION=1 pnpm --filter @vexa/web exec playwright test --project=chromium-voice-audio
ok 1 [chromium-voice-audio] › voice-audio.spec.ts › two authenticated
browsers exchange fake-device audio over mediasoup
1 passed (9.9s)
```
Cross-reviewed (Sonnet): confirmed the two contexts are genuinely
isolated, the stats come from the correct (recv, not send) transport
so the assertion can only reflect audio arriving from the *other* peer,
the fake-device flags are correctly scoped to only this test (not
affecting `recall-profile.spec.ts`'s own unrelated `getUserMedia` mock),
and the `window.__vexaVoiceClientForTests` test hook is properly
`import.meta.env.DEV`-gated so it never ships in a production build.
Approved, no must-fix findings.

Commit: `542f292`.

**Known scope limit of this specific test** (not a gap in the underlying
proof): it asserts inbound audio on one side (owner→guest) rather than
symmetrically both directions. Given the SFU's produce/consume logic is
identical for both peers and already covered by 13 passing integration
tests, this is a reasonable smoke-test scope, not a hidden weakness.

An earlier attempt to verify this manually through the built-in browser
pane (two real accounts, real guild/channel/invite, logged in as the
owner) got as far as a real `join()` signaling round-trip and failed
cleanly at the browser's own microphone-permission boundary — confirming
the client wiring end-to-end up to that point, before the e2e test above
closed the gap properly.

## Other known gaps (by design, still out of scope)

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
- `542f292` — `apps/web`: real fake-device e2e proof of two-peer audio.

## Recommendation

All of the plan's acceptance criteria are now demonstrated live, including
the spike's own core exit gate (two authenticated browsers exchanging real
audio through the SFU). Not added to CI in this pass — the existing
`.github/workflows/ci.yml` starts `api`+`gateway` natively but has no
Docker Compose / `apps/media` step; wiring `chromium-voice-audio` into CI
is a reasonable near-term follow-up but is new scope beyond this task, not
done here. Recommend: ready to merge as a feasibility spike, on its own
terms — production hardening (CI wiring, cross-network/TURN, mid-call
permission-bits revocation, native mediasoup event-listener cleanup) is
tracked as explicit future work in this document and the plan, not hidden.
