# Plan: audio-spike — Two-peer authenticated mediasoup audio feasibility spike

(Athena — Sonnet subagent, 2026-09-27. Revision pass 2, after two rounds of
independent Themis review — Codex/gpt-5.6-terra: round 1 returned 9
must-fix findings (resolved in the first revision); round 2 reviewed that
revision and returned 3 incompletely-fixed items plus 2 issues introduced
by the first revision, 5 findings total, resolved in this pass. Read
`brief.md`, `investigation.md`, `workflow.md`, `project-profile.md`,
`packages/shared/src/index.ts`, `apps/gateway/src/index.ts`,
`apps/api/src/db.ts`, `apps/api/src/config.ts`, `docker-compose.yml`,
`.env.example`, root `package.json` in full before revising. No
implementation performed; no builder spawned.)

---

## Resolved from independent review

Each of Themis's 9 must-fix findings, and where this revision addresses it:

1. **No voice-channel-type check** → "Permission/security design" now
   requires `result.channel.type === 'voice'` immediately after
   `requireChannel`, before any router/transport work, in every handler
   that can create media state (`join`). See that section and the frozen
   contract's `join` handler description.
2. **Session validity never rechecked mid-call** → "Permission/security
   design" adds two mechanisms: (a) every signaling request re-runs the
   gateway's `authorized()`-style session check before executing, and (b) a
   periodic 30s sweep re-validates every connected peer's session
   independent of whether they're sending requests, and force-closes +
   fully tears down media state for anyone whose session is gone —
   otherwise a peer who stops signaling but keeps their WebRTC transport
   open would never be caught.
3. **WS protocol underspecified** → "Frozen contract" section is rewritten
   with concrete Zod schemas for every request/response/event payload,
   transport direction, transport/producer/consumer ID shapes, the
   consumer create-then-resume sequence, and an explicit malformed-request
   rule.
4. **No late-joiner consumer discovery** → `join`'s response now returns
   `existingProducers` (every live producer in the room at join time), so a
   peer joining after another is already producing can immediately consume
   it, not just wait for a future `newProducer` event.
5. **No ownership binding** → "Permission/security design" specifies that
   every transport/producer/consumer is stored *only* in that socket's own
   per-connection maps (never a global registry keyed just by ID), so an
   operation naming an ID it doesn't own structurally cannot resolve to
   another user's object — detailed in "Ownership & resource binding"
   below. (**Corrected in round 2, finding 3**: this rule as originally
   stated made `consume` impossible, since a producer being consumed is by
   definition owned by a different peer. See "Ownership & resource
   binding"'s two-tier model below for the fix.)
6. **Docker topology nonfunctional as written** → "Docker topology" section
   now gives concrete env values (`DATABASE_URL`/`REDIS_URL` pointed at the
   `postgres`/`redis` Compose service names, `HOST=0.0.0.0` inside the
   container) and the exact `docker-compose.yml` service block.
7. **Missing mediasoup ICE listen configuration** → "mediasoup transport
   configuration" section specifies the exact `WebRtcTransport`
   `listenInfos` (UDP+TCP, `announcedAddress: 127.0.0.1`) and the mapped
   host port range, matching this spike's same-machine topology.
8. **Phase 3 starts media twice** → "Local run — single authoritative path"
   section: `dev:all` is changed to exclude `@vexa/media`
   (`pnpm --filter '!@vexa/media' -r --parallel dev`); Docker Compose is the
   only way `apps/media` runs locally. Phase 3 is rewritten to match.
9. **No resource-abuse controls** → "Resource limits & cleanup" section
   specifies payload cap, rate limiting (mirroring the gateway's existing
   30 msgs/10s pattern), per-peer transport/producer caps, a per-router
   peer cap, and a cleanup rule that runs on every failure path via
   try/catch + WS close handler, not just the happy path.

Nothing from the original plan's Decision blocks, dependency choice, or
builder-track seam rationale changes — Themis didn't dispute those; this
revision adds detail under them.

### Round 2 — second independent review (Themis, Codex/gpt-5.6-terra), 5 findings

The first revision above resolved the original 9 findings but introduced 2
new issues and left 3 incompletely fixed. This round's 5 findings, and
where this revision addresses each:

1. **Teardown not idempotent/ordered** → "Session re-verification" and
   "Resource limits & cleanup" now specify a per-peer `torndown` boolean,
   checked-and-set synchronously as the first line of the single shared
   `teardownPeer()` function, before any close/decrement logic runs — so
   the periodic sweep, WS `close`, and WS `error` paths can never
   double-execute cleanup even if more than one fires for the same peer.
2. **Frozen protocol's wire schemas didn't match real mediasoup payloads**
   → "Frozen contract": `createTransportResponseSchema`'s `iceCandidates`
   entries now use `address` (matching mediasoup's actual
   `IceCandidate.address`), not `ip`; `rtpParametersSchema` is now defined
   as its own standalone shape matching mediasoup's real `RtpParameters`
   type (no top-level `kind`, `codecs[]` carrying `payloadType` directly)
   instead of extending the RTP *capabilities* codec schema.
3. **Ownership rule made remote consumption structurally impossible** →
   "Ownership & resource binding" is rewritten as an explicit two-tier
   model: transports/consumers a peer creates for itself stay in that
   peer's own connection maps (unchanged from round 1), plus a new
   room-scoped (per-router) producer registry that lets any authorized
   member of the same voice channel resolve and consume another peer's
   producer, while peers outside that channel cannot.
4. **Missing `mediaCodecs` on router creation** → "mediasoup transport
   configuration" now shows `worker.createRouter({ mediaCodecs: [...] })`
   with an explicit Opus entry, before the `WebRtcTransport` example.
5. **`enableUdp`/`enableTcp`/`preferUdp` described inaccurately for
   `listenInfos`-based transports** → "mediasoup transport configuration"
   removes those flags from the example and explains that each
   `listenInfos` entry's own `protocol` field is what enables that
   protocol; the flags aren't part of the `listenInfos` transport-creation
   path.

---

## Decision: Architecture — service boundary and signaling transport

### Evidence
- Gateway (`apps/gateway/src/index.ts`) has `maxPayload: 16384`, exactly 4
  op codes, and no request/response correlation id — it's a pub/sub
  broadcast model (Redis `vexa:dispatch` → clients), not RPC
  (investigation.md §3, "Protocol-fit risk").
- mediasoup signaling (`getRouterRtpCapabilities`, `createWebRtcTransport`,
  `connect`, `produce`, `consume`) is inherently request/response and needs
  correlation ids and larger payloads (ICE candidates, DTLS params).
- `apps/gateway/src/index.ts:1` already imports `{db, redis, requireChannel,
  config}` from `@vexa/api/db` — proves a new workspace service can consume
  the same DB/permission exports via subpath import.
- Session/cookie auth is duplicated inline in the gateway (investigation.md
  §4) rather than exported as a shared helper — a second consumer (a new
  media service) would either duplicate it a third time or get a shared
  extraction.

### Options
1. **Extend `apps/gateway`** with new op-codes + bolt-on correlation ids +
   raise `maxPayload`.
2. **New `apps/media` service**, separate WebSocket endpoint, own port,
   request/response protocol with `reqId` correlation from the start.
3. HTTP long-poll/REST for signaling, WS only for events.

### Recommendation
Option 2 — new `apps/media` service with its own WS endpoint.

### Why
Option 1 forces a protocol-model change onto code whose whole design
(broadcast dispatch, no correlation, 16KB cap) is built around a different
shape of problem — Argus flagged this as "more work than it looks," and it
entangles voice-signaling bugs with the always-on chat/presence gateway's
stability. Option 3 doesn't fit ICE trickling's latency needs. A new
service also isolates the native `mediasoup-worker` binary's
lifecycle/crash domain from the gateway process, and gives the spike a
clean place to be deleted if the ADR concludes mediasoup is the wrong
direction.

Signaling shape: JSON over WS, `{reqId, type, payload}` requests →
`{reqId, ok, data}` or `{reqId, ok:false, error}` responses, plus
unsolicited server events (`peerJoined`, `peerLeft`, `newProducer`,
`producerClosed`; no `reqId`) — same cookie-based same-origin auth pattern
as the gateway's upgrade handler. Fully specified in "Frozen contract"
below.

As a corollary, extract the session-hash lookup that's currently duplicated
inline in `apps/gateway/src/index.ts` into a shared exported helper in
`apps/api` (e.g. `authenticateSession(cookieHeader)` next to
`requireChannel`), so `apps/media` doesn't duplicate it a third time. This
is a small, behavior-preserving refactor, not a new capability — flagging
it here for visibility since both builder tracks depend on it, not because
it needs separate architectural sign-off.

### Approval requested
Confirm: (a) `apps/media` as a new service rather than extending
`apps/gateway`; (b) a separate WS endpoint with `reqId`-correlated
request/response as the signaling protocol; (c) the small session-auth
extraction into `apps/api`.

---

## Decision: Dependency — mediasoup / mediasoup-client, and how the spike runs locally

### Evidence
- `argon2@0.41.1` installs via a **prebuilt** binary on this host;
  `cl.exe`/MSVC and a globally-resolvable `node-gyp` are **not on PATH**
  (investigation.md §8).
- `mediasoup-worker` is a native C++ binary; Windows/Node-24 prebuild
  availability for it is **unverified** without actually installing the
  package.
- Docker Desktop is confirmed present (`docker 29.7.2`, compose v5.3.1) and
  is already the project's assumed mechanism for the full local stack
  (project-profile.md, workflow.md "Verification depth").
- `mediasoup-client` is browser-side JS (WebRTC APIs only) — no native
  build step, runs fine in `apps/web` regardless of server hosting.

### Options
1. Native Windows install of `mediasoup` in `apps/media`, run via
   `pnpm dev:all` like every other service.
2. `apps/media` runs inside a Docker container (Linux base image), added to
   `docker-compose.yml`; rest of the stack (api/gateway/web) stays native
   as today.
3. Move the entire dev workflow into a Dev Container/WSL2.

### Recommendation
Option 2. Add `mediasoup` to `apps/media`'s package.json, `mediasoup-client`
to `apps/web`'s; run `apps/media` in a Linux container via Docker Compose,
with the mediasoup RTP/ICE UDP port range mapped to the host and the
container joined to the same Compose network as Postgres/Redis.

### Why
This directly de-risks the one unverified native-build unknown Argus
flagged, without touching how the rest of the stack is developed (Option 3
is strictly more scope than a spike needs). If a Windows-x64 prebuild does
turn out to exist, that's a cheap thing to try first (attempt native
`pnpm --filter @vexa/media install` early) — but Docker is the committed
fallback and default assumption, so the spike isn't blocked on discovering
that mid-build, and (per finding 8 below) Docker is now the *only*
authoritative way this service runs locally, not just a fallback.

### Approval requested
Confirm: (a) adding `mediasoup` (server, `apps/media`) and
`mediasoup-client` (browser, `apps/web`) as new dependencies; (b)
Docker-hosted `apps/media` as the sole local-run mode for this spike
(native install attempt allowed only as a first, non-blocking dependency
check, never as an alternative run path — see finding 8's fix).

---

## Permission/security design

- `apps/media`'s WS upgrade handler mirrors the gateway's: same-origin
  check against `config.webOrigin`, then cookie → session-hash lookup via
  the extracted `authenticateSession` helper. No socket is accepted without
  a valid session.
- On a `join` request for `channelId`:
  1. Call `requireChannel(userId, channelId, Permission.CONNECT)`. On
     failure, respond `{reqId, ok:false, error:{code:403, message:'Channel
     access denied'}}` and create nothing.
  2. **(Finding 1 fix)** Check `result.channel.type === 'voice'`. If not,
     respond `{reqId, ok:false, error:{code:400, message:'Not a voice
     channel'}}` and create nothing — `requireChannel` only proves
     permission/visibility, not channel type, and `DEFAULT_PERMISSIONS`
     grants `CONNECT`/`SPEAK` broadly enough that any guild member could
     otherwise target a text channel's id.
  3. Only after both checks pass: get-or-create the channel's router
     (lazy, per-channel), create the peer's server-side peer record, and
     return `rtpCapabilities` + `existingProducers` (finding 4 fix, see
     Frozen contract).
- On a `produce` request (starting to send audio), additionally call
  `requireChannel(userId, channelId, Permission.SPEAK)` before
  `transport.produce()`. This preserves the existing `CONNECT` (join/listen)
  vs `SPEAK` (speak) split Argus identified, and matches current timeout
  semantics (a timed-out user can still join/listen, consistent with
  today's chat behavior — not a new inconsistency).
- Router-per-channel is created lazily on first authorized join and torn
  down when the last participant leaves — no persistence, no new table.

### Session re-verification (finding 2 fix)
Checking session validity only at WS-upgrade time (as originally written)
means a client whose session expires or is logged out mid-call keeps its
transport and can keep issuing signaling requests indefinitely. Two
mechanisms, mirroring the gateway's own patterns:
- **Per-request check**: every signaling request handler starts by running
  the same `authorized(c)`-equivalent query the gateway runs on every
  heartbeat (`SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND
  expires_at>now()`) before doing anything else. On failure: close the
  socket (`4001`, "Session expired") and call `teardownPeer(peer)` (see
  idempotency fix below and "Resource limits & cleanup").
- **Periodic sweep, independent of client activity**: a 30-second interval
  (parallel to the gateway's 10s heartbeat-timeout sweep) re-validates
  every connected peer's session, not just ones currently sending requests.
  A peer whose session no longer validates is force-closed via the same
  `teardownPeer(peer)` call, even if they've gone silent and kept their
  WebRTC media flowing. This is the actual fix for the identified gap:
  per-request checks alone never fire for a peer that simply stops
  signaling while still receiving/sending audio.

### Teardown idempotency (round 2, finding 1 fix)
Round 1 left three independent triggers — the 30s sweep, the WS `close`
handler, and the WS `error` handler — each able to call teardown logic for
the same peer, with no guard against more than one firing (e.g. the sweep
force-closes a socket for an invalidated session, which itself then raises
a `close` event that would otherwise also run teardown). Concretely, this
would double-decrement the router's peer count or call `.close()` on
already-closed mediasoup objects. Fix: a single `teardownPeer(peer)`
function is the *only* place cleanup logic lives, and the `Peer` record
carries an explicit guard flag:
```ts
type Peer = {
  // ...existing fields...
  torndown: boolean;
};

function teardownPeer(peer: Peer) {
  if (peer.torndown) return;   // check-and-set: no `await` before this line
  peer.torndown = true;        // whichever caller reaches here first wins
  for (const { transport } of peer.transports.values()) transport.close();
  peer.transports.clear();
  peer.producers.clear();
  peer.consumers.clear();
  if (peer.channelId) decrementRouterRefcount(peer.channelId);
}
```
Because Node's event loop is single-threaded and `teardownPeer` performs no
`await` before the check-and-set, the `if (peer.torndown) return` / `peer.
torndown = true` pair is effectively atomic — no interleaving is possible
between the check and the set. All four triggers — periodic sweep, WS
`close`, WS `error`, and the **`leave` request handler** (which calls
`teardownPeer(peer)` directly as its entire implementation, then replies
`{reqId, ok:true, data:{}}`) — plus the per-request session-check failure
path above, call this same function; whichever runs first executes cleanup
exactly once, every other caller is a no-op. This is the same function
referenced under "Resource limits & cleanup" below.

### Ownership & resource binding (finding 5 fix, round 1; corrected round 2, finding 3)
Round 1 said every ID referenced in a request — including `producerId` in a
`consume` request — is resolved *only* from the requesting socket's own
per-connection maps. That's wrong for `consume` specifically: consuming
inherently means playing *another peer's* audio, so that producer's ID can
never be in the consumer's own map by definition — as written, the rule
made remote consumption structurally impossible. Fix: a two-tier model.

**Tier 1 — unchanged from round 1, and still correct for this part**:
every transport and consumer a peer creates *for itself* is stored **only**
inside that specific WS connection's own peer record — never in a single
global `Map<id, object>` keyed just by the mediasoup-generated ID.
Concretely, per connection:
```ts
type Peer = {
  userId: string; channelId: string | null;
  torndown: boolean;
  transports: Map<string, {transport: WebRtcTransport; direction: 'send'|'recv'}>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
};
```
`connectTransport`, `produce`, and `resumeConsumer` resolve their
`transportId`/`consumerId` by looking it up **only in the requesting
peer's own maps**. If the ID isn't in that peer's own map — another user's,
another channel's, or nonexistent — the lookup fails with `{reqId,
ok:false, error:{code:404, message:'Unknown transport/consumer'}}` without
ever touching another peer's mediasoup object. No other peer can reference
or operate on a transport/consumer that isn't theirs.

**Tier 2 — new, round 2 fix — room-scoped producer registry**: a `consume`
request's `producerId` identifies a producer that, by design, belongs to a
*different* peer in the same voice channel. That lookup can't go through a
peer's own maps; it goes through a registry scoped to the channel's router,
not global and not per-peer:
```ts
// one of these per active channel router, alongside the router itself —
// created when the router is created, destroyed when the router is
// (i.e. same lifecycle as "Router-per-channel is created lazily...torn
// down when the last participant leaves" above)
type ChannelProducerRegistry = Map<string, {
  ownerUserId: string;
  channelId: string;
  transportId: string;
  producer: Producer;
}>;
```
- **Added**: on a successful `produce` (after `requireChannel(...,
  Permission.SPEAK)` and `transport.produce()` both succeed), the entry is
  added to that channel's `ChannelProducerRegistry`, keyed by the new
  `producerId`.
- **Removed**: when the producer closes (explicit `leave`, `teardownPeer`
  cleanup, or the underlying `transport.close()` cascade) or the owning
  peer disconnects — same trigger set as "Teardown idempotency" above, so
  a producer never outlives the connection that created it.
- **Resolved on `consume`**: the handler looks up `producerId` in the
  *joined channel's* registry (using the requesting peer's own
  `peer.channelId`, set once at `join` and immutable for the connection's
  lifetime — unchanged from round 1). Because `join` already required
  `requireChannel` + the voice-channel-type check (finding 1) before the
  peer's `channelId` could be set at all, any peer who can resolve *a*
  registry to look in is, by construction, an authorized member of that
  channel — a peer in a different room has a different (or no) `channelId`
  and therefore cannot reach that channel's registry at all, let alone the
  entry in it. If `producerId` isn't in the joined channel's registry (the
  producer belongs to a different room, was already closed, or never
  existed), respond `{reqId, ok:false, error:{code:404, message:'Unknown
  transport/producer/consumer'}}` — same error shape as a tier-1 miss, so a
  client can't distinguish "wrong room" from "doesn't exist" (no
  cross-room existence oracle).
- **Per-router, not global**: each channel's router owns exactly one
  `ChannelProducerRegistry`, stored alongside the router (e.g. in the same
  `channelRouters: Map<channelId, {router, registry, peerCount}>`
  structure implied by "Router-per-channel..." above) — never a single
  process-wide map keyed by `producerId` alone, which would let a peer in
  room A resolve a producer id it happened to observe/guess from room B.

Net effect: a peer cannot resolve or operate on another peer's
transport/consumer (tier 1, unchanged), but *can* resolve and consume
another peer's producer *if and only if* both are members of the same
voice channel (tier 2, new) — which is what `consume` requires to function
at all, while still rejecting a peer in a different room or an
unauthorized user.

### AC3 test plan
A third, unrelated account sends a `join` request for the spike's voice
channel. Expected: `requireChannel` throws, `apps/media` responds with an
error and creates no `Transport`/`Producer`. Covered by (a) an automated
test in `apps/media`'s test suite asserting no transport is created, and
(b) Apollo repeating this with a real third authenticated browser session,
not mocked.

### Explicit gap, named not hidden
Mid-call permission *level changes that don't fully revoke the session* —
e.g. a moderator removing just `SPEAK` (not `CONNECT`, not logging the user
out) from a still-logged-in peer — are **not** caught by the session
re-verification above, which only catches session invalidation, not a
permission-bits change while the session stays valid. Continuous
permission-bit re-checking (as opposed to continuous *session* validity
checking, which is now handled) remains out of scope for this spike. Must
appear in the final report's known-gaps section.

---

## Docker topology (finding 6 fix)

The original plan said to add `media` to Compose without specifying values;
Themis correctly flagged that this repo's existing defaults
(`.env.example`: `DATABASE_URL=postgresql://vexa:vexa_local_only@127.0.0.1:5432/vexa`,
`REDIS_URL=redis://127.0.0.1:6379`, `HOST=127.0.0.1`) are host-side
loopback values that do **not** work from inside a container — `127.0.0.1`
inside the `media` container resolves to the container itself, not to the
`postgres`/`redis` Compose services, and a WS listener bound to
`127.0.0.1` inside the container is unreachable via a published port.

Concrete `docker-compose.yml` addition (new service, alongside the existing
`postgres`/`redis`/`minio` blocks — those stay unchanged):
```yaml
  media:
    build:
      context: .
      dockerfile: apps/media/Dockerfile
    environment:
      NODE_ENV: development
      DATABASE_URL: postgresql://vexa:vexa_local_only@postgres:5432/vexa
      REDIS_URL: redis://redis:6379
      WEB_ORIGIN: http://127.0.0.1:5173
      HOST: 0.0.0.0
      MEDIA_PORT: "3003"
      MEDIASOUP_ANNOUNCED_ADDRESS: 127.0.0.1
      MEDIASOUP_RTC_MIN_PORT: "40000"
      MEDIASOUP_RTC_MAX_PORT: "40099"
    ports:
      - "127.0.0.1:3003:3003"
      - "127.0.0.1:40000-40099:40000-40099/udp"
      - "127.0.0.1:40000-40099:40000-40099/tcp"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
```
Notes:
- `postgres`/`redis` as hostnames resolve via Compose's default network DNS
  (the same mechanism that already lets these services heathcheck each
  other) — no change needed to the `postgres`/`redis` blocks themselves.
- `HOST: 0.0.0.0` inside the container is required for the published port
  mapping to reach the WS server at all; this does not change
  `apps/api`/`apps/gateway`'s own `HOST` default (`127.0.0.1`), which stay
  native-host processes, not containerized, in this spike.
- `WEB_ORIGIN` stays the *browser's* origin (`http://127.0.0.1:5173`) since
  it's used for the same-origin check against the `Origin` header sent by
  the browser, not a value the container needs to reach.
- A new `apps/media/Dockerfile` (Node 22+ Linux base, matching root
  `package.json`'s `engines.node >=22`) is Track A scope, same pattern as
  a typical Node service Dockerfile in this stack (no existing Dockerfile
  to copy from — this is the repo's first one; keep it minimal:
  `pnpm install --frozen-lockfile`, build, `node dist/index.js`).

---

## mediasoup transport configuration (finding 7 fix)

Mapping the UDP port range in Compose (above) is necessary but not
sufficient — mediasoup needs to be told what *announced* address to put
into the ICE candidates it hands the browser, or the browser receives
candidates pointing at the container's private Docker-network IP, which is
never reachable from the host. For this spike's same-machine topology
(browser and Docker Desktop on the same Windows host), the reachable
address is `127.0.0.1` via the published port mappings above. Concrete
`mediasoup.Worker`/`Router`/`WebRtcTransport` configuration for
`apps/media`:
```ts
const worker = await mediasoup.createWorker({
  rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000),
  rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 40099),
});

// (round 2, finding 4 fix) — mediasoup's router has no usable codec until
// one is explicitly registered; there is no default. This spike needs
// exactly one: Opus, mediasoup's standard audio default. Router creation
// is per-channel (lazy, on first authorized join — see "Permission/
// security design" above), so this call sits where that router is created.
const router = await worker.createRouter({
  mediaCodecs: [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
  ],
});

// (round 2, finding 5 fix) — `enableUdp`/`enableTcp`/`preferUdp` are not
// part of the `listenInfos`-based `createWebRtcTransport` call; those flags
// belong to mediasoup's separate `WebRtcServer` pattern (a single shared
// UDP/TCP listener multiplexed across transports), which this spike does
// not use. With `listenInfos`, each entry's own `protocol` field is what
// enables that protocol for the transport — the two entries below already
// cover UDP and TCP, so no extra flags are needed; entry order does not by
// itself force a preference (ICE candidate priority, not array position,
// is what a client prioritizes during negotiation).
const transport = await router.createWebRtcTransport({
  listenInfos: [
    { protocol: 'udp', ip: '0.0.0.0', announcedAddress: process.env.MEDIASOUP_ANNOUNCED_ADDRESS ?? '127.0.0.1' },
    { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: process.env.MEDIASOUP_ANNOUNCED_ADDRESS ?? '127.0.0.1' },
  ],
});
```
(`listenInfos`/`announcedAddress` is the current mediasoup v3 API — the
older `listenIps`/`announcedIp` shape is deprecated; Track A should pin the
`mediasoup` version and confirm this field name, the `mediaCodecs` shape,
and the `listenInfos`/`WebRtcServer` split described above against the
installed version's type definitions as its first smoke check, since this
is exactly the kind of thing that silently breaks between minor versions.)
This is explicitly a same-machine-only configuration — the final report's
known-gaps section must state that cross-network testing needs a real
public/STUN-discovered announced address and TURN fallback, neither of
which this spike proves (already in brief's out-of-scope list; restated
here because it's the direct consequence of this config choice).

---

## Local run — single authoritative path (finding 8 fix)

The original plan's Phase 3 said to bring up Docker Compose "including new
`media`" and then separately run `pnpm dev:all` — but root `package.json`'s
`dev:all` is `pnpm -r --parallel dev`, which runs **every** workspace's
`dev` script, including `@vexa/media`'s if one exists, causing a second
process to try to bind port 3003 (and the mediasoup worker's port range)
that the Docker container already holds. This defeats the entire point of
running `media` in Docker.

**Single authoritative rule**: `apps/media` runs **only** via Docker
Compose, never via `pnpm dev:all`. Concretely:
- Root `package.json`'s `dev:all` script changes from `pnpm -r --parallel
  dev` to `pnpm --filter '!@vexa/media' -r --parallel dev` (pnpm's
  negated-filter syntax excludes the workspace by name).
- `apps/media/package.json` may still define a `dev` script (e.g. `tsx
  watch src/index.ts`) purely for the one-time native-prebuild check
  mentioned in the dependency decision above — but it is never invoked by
  `dev:all`, and Track A's handoff states explicitly: "do not add
  `@vexa/media` back into `dev:all`; the Docker Compose service is the only
  supported local run path."
- Full local dev sequence becomes: `docker compose up -d` (now includes
  `media`, `postgres`, `redis`, `minio`) → `pnpm db:migrate` → `pnpm
  dev:all` (api, gateway, web only, native as today). This is reflected in
  the rewritten Phase 3 below.

---

## Resource limits & cleanup (finding 9 fix)

The existing gateway already has a payload cap (`maxPayload: 16384`) and a
per-connection rate limit (30 messages/10s window, `apps/gateway/src/
index.ts:10,16`) — the original plan didn't carry either forward for
`apps/media`'s new public WS surface, which is a new, real resource-abuse
vector (a valid authenticated account could otherwise allocate unbounded
routers/transports/native worker resources). Concrete controls for
`apps/media`, mirroring the gateway's existing conventions:
- **Payload cap**: `maxPayload: 32768` (32KB) on the `WebSocketServer` —
  double the gateway's cap since RTP capabilities/parameters payloads run
  larger than chat gateway messages, but still an explicit bound, not
  unlimited.
- **Rate limit**: same window/counter pattern as the gateway (`apps/
  gateway/src/index.ts:10,16` — 30 messages per rolling 10s window per
  connection; exceeding it closes with `4008 'Rate limited'`).
- **Per-peer caps**: at most 1 `send` transport + 1 `recv` transport per
  peer per channel (this spike is audio-only, one mic in, one aggregate
  out), at most 1 producer per peer (one audio track), enforced by
  rejecting a second `createTransport`/`produce` for a direction/kind
  already present in that peer's maps with `{ok:false, error:{code:409,
  message:'Already exists'}}` rather than silently creating a second one.
- **Per-router cap**: at most 8 peers per channel's router (far above the
  2–3 needed to prove this spike, but an explicit, not implicit, ceiling —
  `join` beyond the cap responds `{ok:false, error:{code:429,
  message:'Room full'}}`).
- **Cleanup on every failure path, not just the happy path**: every
  signaling handler body is wrapped so that if any step after object
  creation throws (e.g. `transport.produce()` fails after
  `createWebRtcTransport()` succeeded), the handler closes whatever it
  just created before responding with the error — mirroring the pattern
  the gateway already uses for its own per-message `try/catch` around
  `queue()` (`apps/gateway/src/index.ts:10`). The WS `close`/`error`
  handlers (mirroring `apps/gateway/src/index.ts:27`), the periodic
  session-revalidation sweep (finding 2), and the per-request session
  check's failure path all call the single `teardownPeer(peer)` function
  defined under "Teardown idempotency" above — never their own inline
  cleanup logic. `teardownPeer` unconditionally iterates the peer's
  `transports`/`producers`/`consumers` maps and calls `.close()` on each
  (mediasoup's `transport.close()` cascades to close its own
  producers/consumers), then decrements the router's peer count and
  destroys the router if it reaches zero — but only does this once per
  peer, guarded by the `torndown` flag (round 2, finding 1), so the sweep
  closing a socket and the resulting WS `close` event firing for the same
  peer cannot double-decrement the router's peer count or double-close
  already-closed mediasoup objects. One function, multiple triggers, exactly
  one execution — which keeps AC4 ("no orphaned resources") true for every
  disconnect reason, not just a clean `leave` request, without the
  double-teardown race round 2 flagged.

---

## Builder track split

### Frozen contract (finding 3 fix — concrete Zod schemas, before either builder starts; pasted verbatim into both handoff prompts, not built by either builder unilaterally)

All defined in `packages/shared/src/media.ts`, re-exported from the package
root. Every request has a matching response `data` shape; `channelId`
reuses `snowflakeSchema`.

```ts
import { z } from 'zod';
import { snowflakeSchema } from './index.js';

// --- shared mediasoup-shaped sub-schemas ---
// These mirror mediasoup/mediasoup-client's own TS types closely enough to
// bound size/shape for parsing and DoS rejection; mediasoup's own runtime
// (transport.connect/produce/consume) performs the authoritative structural
// validation of these payloads — Zod's job here is "reject garbage early
// and pin the wire shape for Track B," not reimplement mediasoup's own checks.
const rtpCodecCapabilitySchema = z.object({
  kind: z.literal('audio'),
  mimeType: z.string().max(64),
  clockRate: z.number().int().positive(),
  channels: z.number().int().positive().optional(),
  preferredPayloadType: z.number().int().optional(),
  parameters: z.record(z.union([z.string(), z.number()])).optional(),
  rtcpFeedback: z.array(z.object({ type: z.string(), parameter: z.string().optional() })).optional(),
}).passthrough();
const rtpHeaderExtensionSchema = z.object({
  kind: z.literal('audio'),
  uri: z.string(),
  preferredId: z.number().int(),
  preferredEncrypt: z.boolean().optional(),
  direction: z.string().optional(),
}).passthrough();
export const rtpCapabilitiesSchema = z.object({
  codecs: z.array(rtpCodecCapabilitySchema).max(16),
  headerExtensions: z.array(rtpHeaderExtensionSchema).max(16).optional(),
}).passthrough();
const dtlsFingerprintSchema = z.object({ algorithm: z.string(), value: z.string() });
export const dtlsParametersSchema = z.object({
  role: z.enum(['auto', 'client', 'server']).optional(),
  fingerprints: z.array(dtlsFingerprintSchema).min(1).max(8),
});
// (round 2, finding 2 fix) — mediasoup's real `RtpParameters` type (used for
// produce/consume payloads) is NOT the same shape as `RtpCapabilities`
// (used for `rtpCapabilitiesSchema`/`rtpCodecCapabilitySchema` above): a
// capabilities codec entry describes what a device *can* do and has no
// top-level `kind` requirement issue, but a parameters codec entry
// describes what a specific producer/consumer *is actually sending*, and
// does not carry a `kind` field at all — `kind` lives one level up, on the
// `produce` request payload itself (`payload.kind` in `mediaRequestSchema`
// below), not inside each codec. Defining `rtpParametersSchema` by
// extending the capabilities codec schema (as the previous revision did)
// incorrectly forced a `kind` requirement into every codec entry. This is
// mediasoup v3's actual `RtpParameters` shape from its public TS types;
// Track A should still confirm field-for-field against the installed
// `mediasoup`/`mediasoup-client` type definitions as its first smoke check
// before writing signaling logic, since this is exactly the kind of thing
// that silently breaks between minor versions.
const rtpParametersCodecSchema = z.object({
  mimeType: z.string().max(64),
  payloadType: z.number().int(),
  clockRate: z.number().int().positive(),
  channels: z.number().int().positive().optional(),
  parameters: z.record(z.union([z.string(), z.number()])).optional(),
  rtcpFeedback: z.array(z.object({ type: z.string(), parameter: z.string().optional() })).optional(),
}).passthrough();
export const rtpParametersSchema = z.object({
  mid: z.string().optional(),
  codecs: z.array(rtpParametersCodecSchema).min(1).max(4),
  headerExtensions: z.array(z.object({
    uri: z.string(),
    id: z.number().int(),
    encrypt: z.boolean().optional(),
    parameters: z.record(z.union([z.string(), z.number()])).optional(),
  })).max(16).optional(),
  encodings: z.array(z.object({
    ssrc: z.number().int().optional(),
    rid: z.string().optional(),
    codecPayloadType: z.number().int().optional(),
    dtx: z.boolean().optional(),
    scalabilityMode: z.string().optional(),
  })).max(4).optional(),
  rtcp: z.object({ cname: z.string().optional(), reducedSize: z.boolean().optional() }).optional(),
}).passthrough();

// --- envelope ---
export const mediaRequestSchema = z.discriminatedUnion('type', [
  z.object({ reqId: z.string().uuid(), type: z.literal('join'), payload: z.object({ channelId: snowflakeSchema }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('createTransport'), payload: z.object({ direction: z.enum(['send', 'recv']) }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('connectTransport'), payload: z.object({ transportId: z.string().uuid(), dtlsParameters: dtlsParametersSchema }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('produce'), payload: z.object({ transportId: z.string().uuid(), kind: z.literal('audio'), rtpParameters: rtpParametersSchema }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('consume'), payload: z.object({ transportId: z.string().uuid(), producerId: z.string().uuid(), rtpCapabilities: rtpCapabilitiesSchema }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('resumeConsumer'), payload: z.object({ consumerId: z.string().uuid() }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('leave'), payload: z.object({}) }),
]);

// --- response data per request type (all wrapped as {reqId, ok:true, data} | {reqId, ok:false, error:{code,message}}) ---
export const joinResponseSchema = z.object({
  rtpCapabilities: rtpCapabilitiesSchema,
  existingProducers: z.array(z.object({ producerId: z.string().uuid(), userId: snowflakeSchema, kind: z.literal('audio') })),
});
export const createTransportResponseSchema = z.object({
  transportId: z.string().uuid(),
  iceParameters: z.object({ usernameFragment: z.string(), password: z.string(), iceLite: z.boolean().optional() }),
  // (round 2, finding 2 fix) mediasoup's actual `IceCandidate` type uses
  // `address`, not `ip` — the previous revision had this wrong.
  iceCandidates: z.array(z.object({ foundation: z.string(), priority: z.number(), address: z.string(), protocol: z.enum(['udp', 'tcp']), port: z.number(), type: z.literal('host'), tcpType: z.string().optional() })),
  dtlsParameters: dtlsParametersSchema,
});
export const connectTransportResponseSchema = z.object({});
export const produceResponseSchema = z.object({ producerId: z.string().uuid() });
export const consumeResponseSchema = z.object({
  consumerId: z.string().uuid(),
  producerId: z.string().uuid(),
  kind: z.literal('audio'),
  rtpParameters: rtpParametersSchema,
});
export const resumeConsumerResponseSchema = z.object({});
export const leaveResponseSchema = z.object({});

// --- server-initiated events (no reqId) ---
export const mediaEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('peerJoined'), payload: z.object({ userId: snowflakeSchema }) }),
  z.object({ type: z.literal('peerLeft'), payload: z.object({ userId: snowflakeSchema }) }),
  z.object({ type: z.literal('newProducer'), payload: z.object({ producerId: z.string().uuid(), userId: snowflakeSchema, kind: z.literal('audio') }) }),
  z.object({ type: z.literal('producerClosed'), payload: z.object({ producerId: z.string().uuid() }) }),
]);
```

Consumer create-then-resume sequence (explicit, per finding 3): mediasoup
requires consumers to be created **paused** on the server
(`router.canConsume` check, then `transport.consume({..., paused: true})`)
so the client has a chance to set up its `<audio>`/`MediaStreamTrack`
before RTP starts flowing. Sequence: client sends `consume` → server
creates the paused `Consumer`, responds with `consumeResponseSchema` data →
client attaches the track locally → client sends `resumeConsumer` →
server calls `consumer.resume()`, responds `resumeConsumerResponseSchema`
(empty `data`) → RTP starts arriving. Skipping the `resumeConsumer` step is
the single most common mediasoup-client integration bug; stated here
explicitly so Track B doesn't have to rediscover it.

**Malformed-request rule** (finding 3 fix): two distinct failure tiers —
1. The raw message fails to `JSON.parse` **or** fails
   `mediaRequestSchema.safeParse` (envelope-level: bad `type`, missing
   `reqId`, wrong payload shape) → close the socket, `4002 'Invalid
   payload'` — identical to the gateway's existing rule
   (`apps/gateway/src/index.ts:16`), because a `reqId` can't be trusted
   enough to reply to if the envelope itself didn't parse.
2. The envelope parses but a specific operation fails for a request-level
   reason (permission denied, wrong channel type, unknown
   transport/producer/consumer id, cap exceeded, mediasoup itself throws)
   → respond `{reqId, ok:false, error:{code, message}}` on that `reqId` and
   keep the connection open — the client can retry or recover without a
   full reconnect.

**Transport**: `apps/media` exposes its own WS endpoint on port `3003`
(next free slot after gateway's `3002`), same-origin + `vexa_session`
cookie auth as the gateway.

**Error shape on permission denial**: `{ok:false, error:{code:403,
message:'Channel access denied'|'Missing permission for this action'}}`,
mapped straight from `requireChannel`'s thrown `statusCode`; `{code:400,
message:'Not a voice channel'}` for the channel-type check (finding 1).

**Channel identity**: reuse the existing `channelId` (`snowflakeSchema`)
for voice channels — no new voice-specific schema/subtype, no persisted
participant table for the spike (in-memory router/producer state in
`apps/media` only, held in the per-peer maps described under "Ownership &
resource binding"). If this assumption breaks during implementation (state
needs to survive a restart, or cross-instance scaling is needed), that's a
new schema/migration decision requiring the standing approval gate — stop
and flag, don't add a table silently.

### Track A (Sonnet) — server-side, `apps/media`
- New `apps/media` service: HTTP health endpoints mirroring gateway's
  `/live`,`/ready` pattern; WS upgrade handler (auth as above, `HOST`
  configurable per the Docker topology section); mediasoup `Worker`/
  `Router` lifecycle (lazy per-channel router, `listenInfos` per the
  "mediasoup transport configuration" section); signaling handlers for
  `join`/`createTransport`/`connectTransport`/`produce`/`consume`/
  `resumeConsumer`/`leave`, each invoking `requireChannel` +
  channel-type check per the permission design above before any mediasoup
  object is created, and each enforcing the per-peer/per-router caps under
  "Resource limits & cleanup."
- The `authenticateSession` extraction in `apps/api` (small, shared — do
  this first, as Track A's opening commit, so Track B can reference it if
  needed).
- Session re-verification: per-request check + the 30s periodic sweep
  (see "Session re-verification" above).
- `apps/media/Dockerfile` + `docker-compose.yml` `media` service block (as
  specified above) + root `package.json`'s `dev:all` filter change (finding
  8) — this last one is a one-line, low-risk change but touches a file
  outside `apps/media`, so call it out explicitly in the PR description.
- Tests (`tsx --test`, matching gateway's style): permission-denial test
  (AC3, including the channel-type-check case specifically — a text
  channel with `CONNECT` granted must still be denied); transport-cleanup-
  on-disconnect test (AC4); a test that a guessed/observed transport or
  consumer ID belonging to another peer's connection is always rejected,
  regardless of room (tier 1, finding 5's ownership binding); and a
  two-part producer-registry test (tier 2, round 2 finding 3) confirming a
  peer *in the same* voice channel can resolve and consume another peer's
  producer, while a peer joined to a *different* channel (or not joined at
  all) gets the same 404 as an unknown ID when it names that producer.

### Track B (Codex) — client-side, `apps/web`
- `mediasoup-client` integration: WS connection to `apps/media` using the
  `reqId`-correlated request helper, device load via `join`'s
  `rtpCapabilities`, `createTransport`/`connectTransport`/`produce`(mic)/
  `consume`+`resumeConsumer`(remote peers) per the frozen contract above,
  including consuming every entry in `join`'s `existingProducers` (finding
  4) in addition to reacting to future `newProducer` events.
- Minimal voice UI in `ConnectedWorkspace.tsx`: join/leave affordance on
  `type==='voice'` channels (currently filtered out entirely), mute/deafen
  toggle, a simple connected-participants list driven by
  `peerJoined`/`peerLeft` events, `<audio>` elements for each remote
  consumer.
- Test approach: scripting two-peer real audio through Playwright e2e is
  likely awkward (headless Chromium fake-device audio, timing) — noted as
  a plan-level tradeoff rather than forcing a fragile e2e test. Primary
  AC1/AC2 verification is Apollo driving two real browser sessions, not
  automated e2e. A lighter unit test (client-side signaling
  request/response correlation logic, and that `existingProducers` from
  `join` triggers the same consume path as a live `newProducer` event) is
  still in scope for Track B.

Seam rationale: server (`apps/media`, `apps/api` extraction) vs. client
(`apps/web`) touches almost entirely disjoint files; the only shared
surface is the frozen contract in `packages/shared`, defined up front so
neither builder blocks on the other.

---

## Phased plan

**Phase 0 — contract freeze** (before parallel work starts): write the Zod
schemas above into `packages/shared/src/media.ts`, extract
`authenticateSession` into `apps/api`. Small, single-author, low risk.

**Phase 1 — parallel build**: Track A (Sonnet) and Track B (Codex) build
simultaneously per the split above.

**Phase 2 — cross-review**: Codex reviews Track A's diff as Themis; a
Sonnet subagent reviews Track B's diff as Themis. Each gets the brief,
acceptance criteria, and only the diff — not the other builder's own
self-report.

**Phase 3 — Apollo integration verification** (real, not mocked; single
authoritative local-run path per finding 8):
- `docker compose up -d` (brings up `postgres`, `redis`, `minio`, and now
  `media` — all four, one command, `media` built from its new Dockerfile).
- `pnpm db:migrate`.
- `pnpm dev:all` — now excludes `@vexa/media` (root `package.json` fix
  above), so this only starts `api`, `gateway`, `web` natively. **Do not**
  also run `pnpm --filter @vexa/media dev` alongside the Docker container —
  Docker is the only place `media` runs in this spike.
- Two real authenticated browser sessions join the same voice channel —
  confirm both show as connected producers/consumers (AC1) and real audio
  is exchanged, evidenced by an audio-level/activity signal on both sides
  (AC2).
- Third, unrelated real account denied a transport (AC3) — both the
  automated test and a manual repro; additionally confirm a text channel
  (not a voice channel) is denied even for an account with `CONNECT` on
  it (finding 1's channel-type check).
- Leaving the channel / closing a tab releases the transport — confirm no
  orphaned router/producer state remains (AC4); additionally confirm the
  30s session-revalidation sweep force-closes a peer whose session is
  invalidated mid-call (finding 2), by expiring/deleting that session row
  during a live call and observing cleanup without the client sending
  `leave`.
- `pnpm typecheck`, `pnpm build`, `pnpm -r test` (including any new
  `VEXA_INTEGRATION=1` suite for `apps/media`) all pass (AC5).

**Phase 4 — writeup**: `docs/tasks/audio-spike/verification.md` recording
what was/wasn't proven (ports incl. the 3003 WS port and 40000-40099
RTP/ICE UDP+TCP range, `announcedAddress` same-machine assumption, the
mid-call-permission-bits gap distinct from the now-handled session-
invalidation case) (AC6), plus the ADR-style mediasoup-vs-alternative
writeup the delivery plan requires. Open PR (feature branch, no direct push
to `main`), do not merge without explicit user confirmation.

## Acceptance criteria (brief's 6, refined to concrete checks — not softened)

1. Two real authenticated sessions join the same voice channel;
   `apps/media` reports both as producers/consumers — verified via
   server-side debug/log listing of the router's producers/consumers during
   Apollo's live session, not just client-side "connected" state.
2. Real audio exchanged — verified via an audio-level/activity signal (e.g.
   WebAudio `AnalyserNode` reading, or an audible/visual confirmation
   Apollo captures) on both sides.
3. Unrelated account denied a transport — automated test in `apps/media` +
   Apollo repro with a real third account; assert no `Transport`/`Producer`
   object exists afterward. Additionally: an authorized account targeting a
   *text* channel id is denied (channel-type check); a request naming
   another peer's transport or consumer id is always rejected regardless of
   room (tier 1 ownership binding); and a request naming another peer's
   producer id is rejected only when the requester is not a member of that
   producer's channel — a same-channel peer consuming it is the intended,
   working path (tier 2 producer registry, round 2 finding 3).
4. Leave/tab-close releases the transport — WS close handler triggers
   `transport.close()`/router cleanup; Apollo confirms no lingering
   producer after tab close. Additionally: a session invalidated mid-call
   (without a `leave` or disconnect) is caught and cleaned up within one
   30s sweep interval.
5. `pnpm typecheck`, `pnpm build`, `pnpm -r test` all pass with
   `apps/media` added, and `pnpm dev:all` no longer attempts to start
   `@vexa/media` natively.
6. `docs/tasks/audio-spike/verification.md` documents ports (media WS port
   3003, RTP/ICE UDP+TCP range 40000-40099), Docker-hosted
   `mediasoup-worker` with `announcedAddress=127.0.0.1`, and explicitly
   states cross-network/TURN and mid-call *permission-bits* revocation
   (distinct from session invalidation, which is handled) were not proven.

## Out-of-scope — confirmed as-is, with two additions

Brief's out-of-scope list (cross-network/TURN, video, Recall forwarding,
production hosting, participant limits/moderator controls, polished UI)
stands unchanged — investigation didn't surface anything that expands what
is realistic for a first spike.

**Additions**:
- Continuous *permission-bits* re-verification (revoking `SPEAK`/`CONNECT`
  from a still-logged-in, still-valid-session user mid-call) is explicitly
  out of scope — distinct from session-*validity* re-verification, which
  this revision now handles (finding 2).
- Horizontal scaling of `apps/media` (multiple instances sharing
  router/producer state) is out of scope — the in-memory, single-instance
  design in "Channel identity" above is a deliberate spike simplification,
  flagged for a future approval gate if it needs to change.

---

No implementation performed. This plan is not yet approved — per the
brief's approval gates and this project's Architecture-change workflow
tier, it needs (1) independent Themis review of this plan itself (this
revision responds to that review's 9 findings), then (2) the user's
explicit sign-off, before any builder work starts.
