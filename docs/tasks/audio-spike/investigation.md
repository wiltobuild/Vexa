# Investigation: audio-spike (Argus)

Date: 2026-09-27. Branch `main` @ `f394f99`.

## Verified facts

**1. Channel/voice model today**
- `packages/shared/src/index.ts:28` — `channelSchema` already includes `type: z.enum(['text','voice','category'])`.
- `infra/schema.sql:11` — `channels` table: `type text NOT NULL CHECK(type IN ('text','voice','category','dm','group_dm'))`. No voice-specific columns (no bitrate/user-limit/region). A voice channel row today is indistinguishable from a text channel except `type`.
- No `voice_sessions`/`voice_consents` tables exist. Those are only *proposed* in `docs/VOICE-RECALL.md:15`, not implemented.

**2. Permission model**
- `packages/shared/src/index.ts:2` — `Permission` bitfield already defines `CONNECT:32n` and `SPEAK:64n`, included in `DEFAULT_PERMISSIONS`.
- `apps/api/src/db.ts:35-43` — `channelPermissions(userId, channelId)` computes effective bits (guild membership → role union → overwrites → timeout mask). Timeouts strip `SEND_MESSAGES`/`SPEAK` but **not** `CONNECT` (db.ts:41) — a timed-out user can join/listen but not speak.
- `apps/api/src/db.ts:44` — `requireChannel(userId, channelId, permission=VIEW_CHANNEL)` throws 403 if the permission bit is missing. This is the exact function to call with `Permission.CONNECT`/`SPEAK` before granting a mediasoup transport — no new permission primitive needed.
- `apps/gateway/src/index.ts:20` already re-checks `requireChannel` per subscribe and per dispatched event — an existing template for "re-verify permission before granting access."
- DM channels have no voice concept — `dmPermissions` never grants voice bits.

**3. Gateway architecture**
- `apps/gateway/src/index.ts` (32 lines): cookie-based auth on WS upgrade, `gatewayInputSchema` (`packages/shared/src/index.ts:38-43`) has exactly 4 op types (IDENTIFY, HEARTBEAT, RESUME, SUBSCRIBE) with **no request/response correlation id**. Dispatch is broadcast/pub-sub via Redis, not request-response.
- `maxPayload: 16384` (16KB) cap on the gateway WS (`index.ts:2`).
- **Risk**: mediasoup signaling (`getRouterRtpCapabilities`, `createWebRtcTransport`, `connect`, `produce`, `consume`, ICE candidates) is inherently request/response with payloads that need correlation IDs. Bolting this onto the existing gateway is a real protocol-model change, not a small addition.

**4. Session/auth for a new service**
- Sessions: `infra/schema.sql:6` — SHA-256 hash of `vexa_session` cookie, looked up in `sessions(token_hash, user_id, expires_at)`.
- This check is **duplicated inline** in `apps/gateway/src/index.ts` rather than exported as a shared function from `apps/api`.
- `apps/gateway/src/index.ts:1` imports `{db, redis, requireChannel, config}` from `@vexa/api/db` — proving other workspace services can already consume `apps/api`'s DB/permission exports via subpath import. A new `apps/media` service could do the same, but would need to either duplicate the cookie-hash lookup again or (better) have it extracted into a shared exported helper first.

**5. Existing "voice" UI**
- `apps/web/src/App.tsx:50-72` — the **local-only demo** has a `view==='voice-room'` UI with fake connected participants and an explicit disclaimer: *"Voice is on the roadmap. The mediasoup call service isn't connected in this pass."* Illustrative only.
- `apps/web/src/ConnectedWorkspace.tsx:165` — the **real authenticated client** has **no voice-channel join UI at all**; channel sidebar filters to `type==='text'` only, and states *"Group calls, video and shared uploads are still in development."*
- `apps/web/src/Recall.tsx` is exclusively the personal Whisper voice-notes feature — unrelated to live group audio.
- Conclusion: nothing in the real client is reusable beyond visual reference; no real client-side voice-room state/hooks exist yet.

**6. mediasoup fit / prior discussion**
- `mediasoup` is not a dependency anywhere in the repo today. No document specifies worker count/topology/port ranges/signaling transport — `docs/PROFESSIONAL-DELIVERY-PLAN.md:140` only says to validate or document an alternative. This is a genuinely open design question for the plan.
- `docs/VOICE-RECALL.md:9` mentions a mediasoup PlainTransport for the *future transcription pipeline* (Phase 7) — not the base two-peer topology, out of scope here.

**7. CI/port constraints**
- Confirmed ports: Postgres 5432, Redis 6379, API 3001 (`apps/api/src/config.ts:44`), gateway 3002, web dev 5173. A new media service needs its own non-colliding port, and if mediasoup workers bind RTP/ICE UDP ranges, those need explicit selection — nothing reserves this today, and GitHub Actions runners have no existing UDP-range handling in this repo.

**8. Windows/native-build constraints**
- `argon2@0.41.1` installs successfully via a **prebuilt binary** (`node_modules/.pnpm/argon2@0.41.1/.../prebuilds/win32-x64/argon2.glibc.node`), not a local C++ compile — `cl.exe` (MSVC) and a globally-resolvable `node-gyp` were both **not found on PATH**.
- `mediasoup-worker` (mediasoup's C++ binary) typically ships prebuilt binaries similarly, but Windows/Node-24 prebuild availability couldn't be verified without installing the package (gated behind the new-dependency approval anyway).
- Docker Desktop is confirmed present (`docker 29.7.2`) — a viable fallback (run the media service in a Linux container) if native Windows prebuilds are unavailable or troublesome.

## Inferences

- Reusing `channelPermissions`/`requireChannel` directly (with `Permission.CONNECT`/`SPEAK`) for the new signaling path is straightforward — **high confidence**.
- Reusing the *existing* gateway process/connection for mediasoup signaling is possible but requires: new op codes, request/response correlation (doesn't exist today), and a payload-size increase past 16KB — **medium confidence** this is more work than it looks; likely better as a separate concern even if it shares the gateway process.
- The `CONNECT` vs `SPEAK` bit split looks intentionally Discord-like (join/listen vs. speak) — **medium confidence**, inferred from bit-masking only, not a comment.

## Unknowns

- Whether a Windows-x64 mediasoup-worker prebuild exists for the locally installed Node version (only CI's pinned Node 24 was confirmed; this host's actual Node version wasn't separately re-checked by Argus beyond the earlier bootstrap session's `node --version` → v24.18.0).
- Whether CI can run real two-peer audio at all, or whether that's necessarily a local-only (Apollo) verification step — `ci.yml` never attempts real audio today.

## Risks

- **Protocol-fit risk**: the gateway's 16KB payload cap and lack of request/response correlation make naive reuse of the existing gateway connection for signaling a real architecture decision, not a detail — must be explicit in Athena's plan.
- **Native-build risk on Windows**: no confirmed MSVC/C++ toolchain on this host. Docker Desktop should likely be the default assumption for running the media service rather than a native Windows build, to de-risk the spike.
- **New attack surface, no test coverage yet by construction**: acceptance criterion 3 (deny unauthorized accounts a transport) requires the permission check to run *before* any transport/router work, mirroring the gateway's existing pattern — must be explicit in the plan, not assumed.
- **Schema risk** (correctly flagged by the brief already): if voice presence/participant state needs persistence, that's a new migration requiring the standing approval gate. No `voice_sessions` table exists yet.
- **CI/port collision risk**: a new service needs an explicit port (and possibly UDP range) that doesn't collide with 3001/3002/5173/5432/6379, wired into both local dev and CI.

## Files referenced

`packages/shared/src/index.ts`, `infra/schema.sql`, `apps/api/src/db.ts`, `apps/api/src/config.ts`, `apps/api/src/index.ts`, `apps/gateway/src/index.ts`, `apps/web/src/App.tsx`, `apps/web/src/ConnectedWorkspace.tsx`, `apps/web/src/Recall.tsx`, `docs/VOICE-RECALL.md`, `.github/workflows/ci.yml`.
