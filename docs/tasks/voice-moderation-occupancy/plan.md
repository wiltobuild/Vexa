# Plan: voice-moderation-occupancy

Condensed plan (orchestrating session, deep existing context — same
pattern as `device-network-handling`).

## Contract addition (already made, Phase-0 style, before either builder starts)

`packages/shared/src/media.ts`:
- `moderatorSetMute` request (`channelId`, `targetUserId`, `muted`) /
  `moderatorSetMuteResponseSchema` (empty).
- `moderatorDisconnect` request (`channelId`, `targetUserId`) /
  `moderatorDisconnectResponseSchema` (empty).
- `participantMuted` event (`userId`, `muted`) — broadcast to the whole
  room, including the muted participant (who uses it to lock their own
  toggle).
- `removedByModerator` event (empty payload) — sent only to the removed
  peer's own socket, immediately before closing it.

Verified: `pnpm --filter @vexa/shared/@vexa/media/@vexa/web typecheck` all
clean with the addition in place.

Occupancy does **not** go through this contract — it's a text-gateway
dispatch (`publish()` in `apps/api/src/db.ts`, type string
`'voice.occupancy'`, payload `{count: number}`, no schema change needed
since `Dispatch.d` is already `unknown` — same convention as
`typing.start`/`reaction.update`).

## Builder track split

### Track A (Sonnet) — server-side, `apps/media`

- **`moderatorSetMute` handler**: resolve `channelId` → `requireChannel`
  (to get `channel.guild_id`) → `requireGuild(callerId, guild_id,
  Permission.MODERATE_MEMBERS)` (both already exported from
  `@vexa/api/db`, add `requireGuild` to `apps/media`'s existing import
  list from that module). Find the target `Peer` within
  `channelRooms.get(channelId)!.peers` by `peer.userId === targetUserId`
  — 404 if not found (same error shape as every other unknown-target case
  in this codebase). If found and they have a live producer,
  `producer.pause()`/`.resume()` per the `muted` flag (mediasoup's real
  `Producer` API — confirm the exact method against the installed
  `mediasoup` types, same discipline every prior task in this repo has
  followed). Broadcast `participantMuted` to the room (reuse
  `broadcastToChannel`). Reply `{}` to the moderator.
- **`moderatorDisconnect` handler**: same permission check, same target
  resolution. Send `removedByModerator` directly to the target peer's own
  socket (`send(targetPeer, {type:'removedByModerator', payload:{}})`),
  then call the existing `teardownPeer(targetPeer)` — reuse it exactly as
  every other cleanup path does, don't duplicate its logic. Reply `{}` to
  the moderator.
- **Occupancy publishing**: call `publish('voice.occupancy', channelId,
  {count})` (import `publish` from `@vexa/api/db` alongside the other
  existing imports) whenever a channel room's peer count changes —
  on successful `join` (after the peer is actually added to
  `room.peers`), and in `teardownPeer` (after the peer is removed from
  `room.peers`, whether via `leave`, disconnect, moderator-disconnect, or
  the session sweep — reuse the single teardown path so occupancy stays
  accurate on every exit route, not just the happy one). Consider whether
  the router's teardown-to-zero path (destroying the room) needs its own
  final `count: 0` publish — it does, since a client watching occupancy
  shouldn't see a stale non-zero count after the last person leaves.
- Both new signaling ops go through the same per-request `checkSession`
  gate every other operation does (only `leave` skips it), and both apply
  the same post-await `torndown`-style re-check discipline this codebase
  has used consistently since the audio-spike task wherever a mediasoup
  call is awaited before a reply.
- Tests (`apps/media/test/integration.test.ts`, matching its existing
  style and helpers): moderator with `MODERATE_MEMBERS` successfully
  mutes/unmutes a real target (assert via the target's own
  `getInboundAudioStatsForTests()`-equivalent server-side check, or by
  inspecting the mediasoup `Producer.paused` state directly if that's
  simpler and equally real — your judgment, but it must be a live
  assertion against the actual mediasoup object, not just "the request
  returned ok"); a member without the permission is denied (403); an
  unknown/not-in-room target is denied (404); `moderatorDisconnect`
  actually tears down the target (their transports/producers are closed,
  `channelRooms` no longer contains them) and the target receives
  `removedByModerator`; occupancy `publish()` calls happen with the right
  counts across join/leave/disconnect/moderator-disconnect (this part may
  be easier to verify by checking the Redis stream/pub-sub directly in a
  test, or by having a lightweight gateway-side subscriber in the test —
  use whatever's most practical and consistent with how this codebase
  already tests gateway dispatch, e.g. `apps/gateway/test/integration.test.ts`'s
  patterns, if applicable).

### Track B (Codex) — client-side, `apps/web`

- **Moderator controls UI**: in the voice channel's member list (or
  wherever participants are already shown in `ConnectedWorkspace.tsx`'s
  voice UI), show mute/disconnect action buttons next to each OTHER
  participant, gated on the viewer's own `MODERATE_MEMBERS` permission for
  that guild (the app already fetches per-guild permission bits elsewhere
  for other moderation UI — e.g. kick/ban/timeout buttons already exist
  somewhere in the text-channel member list; follow that exact existing
  pattern rather than inventing a new one). Clicking sends
  `moderatorSetMute`/`moderatorDisconnect` via the existing signaling
  client.
- **Mute-state reconciliation**: on receiving `participantMuted` where
  `userId` is the local user, lock the mute toggle to the server-imposed
  state — disable self-unmute (or show a distinct "muted by moderator,
  ask them to unmute you" state) until a subsequent `participantMuted`
  with `muted:false` for the local user arrives. For OTHER participants,
  reflect their `participantMuted` state in the UI (e.g. a mute icon next
  to their name in the connected-participants list) so the room's mute
  state stays visibly accurate, not just locally assumed.
- **`removedByModerator` handling**: on receiving this event, show a clear
  "you were disconnected by a moderator" state (distinct from a generic
  connection-lost/reconnect-failed state — do not trigger the existing
  auto-reconnect flow from the device-network-handling task for this
  case, since immediately auto-rejoining after being moderator-removed
  would defeat the point).
- **Occupancy display**: subscribe to `voice.occupancy` dispatches on the
  existing gateway WebSocket connection (the one already used for text/
  typing/reactions — check how the app already subscribes to a channel's
  dispatches and add this type to whatever handler already exists) and
  show a live count badge next to voice channels in the channel list,
  even for channels the viewer hasn't joined. Update it as counts change.
- Tests: unit tests (Vitest) for the mute-state-reconciliation logic
  (locking self-unmute when server-muted, unlocking on release) and the
  occupancy-count state management; an e2e test (Playwright, matching the
  existing `voice-audio.spec.ts` real-stack pattern) with three real
  accounts — an owner with default `MODERATE_MEMBERS` (server owner
  bypasses permission checks entirely per this codebase's existing
  `ALL_PERMISSIONS` owner-bypass convention) muting/disconnecting a real
  connected member, and confirming a fourth account watching the channel
  list (not in voice) sees the occupancy count change live.

Seam rationale: same as every prior track split in this repo — server
(`apps/media`) vs. client (`apps/web`) touch almost entirely disjoint
files; the frozen contract (already committed) is the only shared surface.

## Acceptance criteria

See `brief.md`'s 9 acceptance criteria — implemented directly, not
narrowed.

## Verification (Apollo, live Docker stack)

- All 9 acceptance criteria checked live wherever the brief specifies
  "verified live" — real accounts, real mediasoup worker, real gateway
  dispatch, not code-inspection-only.
- Full regression pass: every existing suite from the audio-spike and
  device-network-handling tasks (gateway integration, media integration,
  web unit, full `pnpm test:e2e`) still green.
- `pnpm typecheck`, `pnpm build`.

No implementation performed by this document — Track A and Track B build
next, in parallel.
