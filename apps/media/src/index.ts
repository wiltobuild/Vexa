import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createWorker, type types as MediasoupTypes } from 'mediasoup';
import {
  db,
  redis,
  requireChannel,
  requireGuild,
  publish,
  config,
  authenticateSession,
  sessionStillValid,
} from '@vexa/api/db';
import { Permission, mediaRequestSchema, MALFORMED_REQUEST_CLOSE_CODE, type MediaEvent } from '@vexa/shared';

// apps/media -- server-side mediasoup signaling service for the audio-spike.
// Frozen wire contract: packages/shared/src/media.ts. Design: docs/tasks/audio-spike/plan.md.

const host = process.env.HOST ?? '127.0.0.1';
const mediaPort = Number(process.env.MEDIA_PORT ?? 3003);
const rtcMinPort = Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000);
const rtcMaxPort = Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 40099);
const announcedAddress = process.env.MEDIASOUP_ANNOUNCED_ADDRESS ?? '127.0.0.1';

const worker = await createWorker({ rtcMinPort, rtcMaxPort });
worker.on('died', () => {
  console.error('mediasoup worker died, exiting');
  process.exit(1);
});

// --- per-channel room state -------------------------------------------------
// Tier 2 of "Ownership & resource binding": a room-scoped producer registry,
// keyed by producerId, alongside the router. Never a single process-wide map
// keyed by producerId alone -- see plan.md "Ownership & resource binding".
type ProducerRegistryEntry = {
  ownerUserId: string;
  channelId: string;
  transportId: string;
  producer: MediasoupTypes.Producer;
};
type ChannelRoom = {
  router: MediasoupTypes.Router;
  registry: Map<string, ProducerRegistryEntry>;
  peers: Set<Peer>;
  // voice-moderation-occupancy fix (cross-review finding 4): userIds
  // currently moderator-muted in this room. Same lifecycle as `registry`
  // above -- created with the room, NOT cleared on an individual peer's
  // disconnect/reconnect, only implicitly discarded when the whole room is
  // destroyed (decrementRoom deletes the room once the last peer leaves).
  // This is what lets a moderator-imposed mute survive a full
  // teardown-and-rejoin reconnect, and lets a late joiner learn who's
  // already muted via handleJoin's `mutedParticipants` response field.
  mutedUserIds: Set<string>;
};
const channelRooms = new Map<string, ChannelRoom>();
// Guards concurrent join requests for the same not-yet-created channel from
// creating two routers for the same channel (Map.get/Map.set around an
// `await worker.createRouter(...)` is not atomic).
const roomCreationPromises = new Map<string, Promise<ChannelRoom>>();

const MAX_PEERS_PER_ROUTER = 8;

async function getOrCreateRoom(channelId: string): Promise<ChannelRoom> {
  const existing = channelRooms.get(channelId);
  if (existing) return existing;
  const pending = roomCreationPromises.get(channelId);
  if (pending) return pending;
  const promise = (async () => {
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
    const room: ChannelRoom = { router, registry: new Map(), peers: new Set(), mutedUserIds: new Set() };
    channelRooms.set(channelId, room);
    return room;
  })();
  roomCreationPromises.set(channelId, promise);
  try {
    return await promise;
  } finally {
    roomCreationPromises.delete(channelId);
  }
}

function decrementRoom(channelId: string) {
  const room = channelRooms.get(channelId);
  if (!room) return;
  if (room.peers.size === 0) {
    channelRooms.delete(channelId);
    room.router.close();
  }
}

function broadcastToChannel(channelId: string, event: MediaEvent, exclude?: Peer) {
  const room = channelRooms.get(channelId);
  if (!room) return;
  const payload = JSON.stringify(event);
  for (const other of room.peers) {
    if (other === exclude) continue;
    if (other.ws.readyState === WebSocket.OPEN) other.ws.send(payload);
  }
}

// device-network-handling: unlike broadcastToChannel, this reaches every
// connected peer across every room -- used only for the one-time
// serverShuttingDown notice broadcast at the start of graceful shutdown.
function broadcastToAllPeers(event: MediaEvent) {
  const payload = JSON.stringify(event);
  for (const peer of allPeers) {
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(payload);
  }
}

// --- per-connection peer state ----------------------------------------------
// Tier 1 of "Ownership & resource binding": transports/consumers a peer
// creates for itself live ONLY in that connection's own maps -- never a
// global Map<id, object> keyed just by the mediasoup-generated id.
type Peer = {
  ws: WebSocket;
  userId: string;
  tokenHash: string;
  channelId: string | null;
  torndown: boolean;
  transports: Map<string, { transport: MediasoupTypes.WebRtcTransport; direction: 'send' | 'recv' }>;
  producers: Map<string, MediasoupTypes.Producer>;
  consumers: Map<string, MediasoupTypes.Consumer>;
  // per-connection message queue/rate-limit state, mirroring apps/gateway
  queue: Promise<void>;
  pending: number;
  window: number;
  messages: number;
};
const allPeers = new Set<Peer>();

function statusCodeOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

// Teardown idempotency (plan.md "Teardown idempotency"): a single function is
// the only place cleanup logic lives. The `torndown` check-and-set pair has no
// `await` between them, so it is effectively atomic on Node's single-threaded
// event loop -- whichever of the four triggers (WS close, WS error, periodic
// sweep, `leave` handler) reaches this first runs cleanup exactly once.
function teardownPeer(peer: Peer) {
  if (peer.torndown) return;
  peer.torndown = true;
  allPeers.delete(peer);
  const channelId = peer.channelId;
  const room = channelId ? channelRooms.get(channelId) : undefined;
  if (room && channelId) {
    for (const producerId of peer.producers.keys()) {
      room.registry.delete(producerId);
      broadcastToChannel(channelId, { type: 'producerClosed', payload: { producerId } }, peer);
    }
  }
  for (const { transport } of peer.transports.values()) {
    try {
      transport.close();
    } catch {
      // already closed / native worker gone -- nothing to do
    }
  }
  peer.transports.clear();
  peer.producers.clear();
  peer.consumers.clear();
  if (room && channelId) {
    room.peers.delete(peer);
    broadcastToChannel(channelId, { type: 'peerLeft', payload: { userId: peer.userId } }, peer);
    // voice-moderation-occupancy: publish the post-removal count for this
    // specific channel through the text-gateway's existing dispatch
    // mechanism (same publish() every other live update uses), so clients
    // browsing the channel list (not connected to apps/media at all) see
    // occupancy update live. Computed from room.peers.size AFTER the delete
    // above, so the last peer leaving always reports count:0 here -- this
    // runs before decrementRoom() below deletes the room/closes the router,
    // but room.peers.size is already accurate at this point regardless.
    void publish('voice.occupancy', channelId, { count: room.peers.size }).catch((error) => {
      console.error('Failed to publish voice.occupancy', error instanceof Error ? error.message : 'unknown');
    });
  }
  if (channelId) decrementRoom(channelId);
}

// --- HTTP health endpoints, mirroring apps/gateway/src/index.ts -------------
const server = createServer((req, res) => {
  const sendHealth = (status: number, ok: boolean) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ service: 'vexa-media', ok }));
  };
  if (req.url === '/live' || req.url === '/') {
    sendHealth(200, true);
    return;
  }
  if (req.url === '/ready' || req.url === '/health') {
    void Promise.all([db.query('SELECT 1'), redis.ping()])
      .then(() => sendHealth(200, true))
      .catch(() => sendHealth(503, false));
    return;
  }
  // voice-moderation-occupancy: test-only introspection of the real
  // mediasoup Producer.paused state, so an integration test can assert a
  // moderatorSetMute call actually paused/resumed the live native producer
  // -- not just that the WS request replied ok:true. Inert unless
  // MEDIA_TEST_DEBUG=1 is explicitly set (never set for the normal
  // docker-compose media service or in production), and even then only
  // reads state, never mutates anything.
  //
  // Cross-review fix 3 (defense-in-depth): the env-var gate alone has no
  // other access control -- if MEDIA_TEST_DEBUG=1 were ever accidentally set
  // in a real deployment, any HTTP caller could read arbitrary users'
  // producer/mute state. Also require the request to originate from
  // loopback (127.0.0.1/::1), matching how the test itself only ever talks
  // to a locally-spawned scratch instance -- so even an accidental
  // MEDIA_TEST_DEBUG=1 wouldn't expose this over the network, only from
  // inside the container/host itself.
  if (process.env.MEDIA_TEST_DEBUG === '1' && req.url?.startsWith('/__test/producer-paused')) {
    const remoteAddress = req.socket.remoteAddress;
    // ::ffff:127.0.0.1 is the IPv4-mapped-IPv6 form Node reports for a
    // loopback connection on a dual-stack socket.
    const isLoopback =
      remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
    if (!isLoopback) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    const url = new URL(req.url, 'http://internal');
    const channelId = url.searchParams.get('channelId');
    const userId = url.searchParams.get('userId');
    const room = channelId ? channelRooms.get(channelId) : undefined;
    const target = room && userId ? [...room.peers].find((p) => p.userId === userId) : undefined;
    const [producer] = target ? target.producers.values() : [];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ found: Boolean(producer), paused: producer ? producer.paused : null }));
    return;
  }
  sendHealth(404, false);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });

function send(peer: Peer, data: unknown) {
  if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(data));
}
function reply(peer: Peer, reqId: string, data: unknown) {
  send(peer, { reqId, ok: true, data });
}
function fail(peer: Peer, reqId: string, code: number, message: string) {
  send(peer, { reqId, ok: false, error: { code, message } });
}

// Session re-verification (plan.md "Session re-verification"): every
// signaling request re-checks session validity before doing anything else. On
// failure: close 4001 and tear the peer down -- same as the periodic sweep.
async function checkSession(peer: Peer): Promise<boolean> {
  if (await sessionStillValid(peer.tokenHash, peer.userId)) return true;
  peer.ws.close(4001, 'Session expired');
  teardownPeer(peer);
  return false;
}

function iceCandidatesOf(transport: MediasoupTypes.WebRtcTransport) {
  return transport.iceCandidates.map((c) => ({
    foundation: c.foundation,
    priority: c.priority,
    address: c.address,
    protocol: c.protocol,
    port: c.port,
    type: c.type,
    tcpType: c.tcpType,
  }));
}

// Root cause of the `consume` hang: mediasoup's Router#rtpCapabilities is
// NOT filtered to the kinds actually configured in `mediaCodecs` -- even for
// this audio-only router, `headerExtensions` includes mediasoup's full
// built-in extension list, which mixes `kind: 'audio'` and `kind: 'video'`
// entries and commonly totals ~18 items. The frozen wire contract
// (packages/shared/src/media.ts rtpCapabilitiesSchema) requires every
// headerExtensions entry to have `kind: 'audio'` and caps the array at 16.
// The client in this spike simply echoes the `join` response's
// rtpCapabilities back verbatim as the `consume` request's rtpCapabilities
// (see docs/tasks/audio-spike/plan.md and test/integration.test.ts), so the
// raw router object failed schema validation on the way back in -- the
// message was silently treated as malformed and the socket was closed with
// no reply, which is indistinguishable from a hang to the client (it just
// never got a response for that reqId). Filtering to audio-only extensions
// here, once, keeps every downstream consumer of `join`'s response
// (client's stored capabilities, and this server's own `canConsume` check
// in handleConsume) working with a shape that satisfies the contract; the
// audio codec itself is unaffected since only audio was ever configured.
function audioOnlyRtpCapabilities(
  caps: MediasoupTypes.RtpCapabilities,
): MediasoupTypes.RtpCapabilities {
  return {
    ...caps,
    headerExtensions: (caps.headerExtensions ?? []).filter((ext) => ext.kind === 'audio'),
  };
}

async function handleJoin(peer: Peer, reqId: string, channelId: string) {
  if (peer.channelId !== null) {
    fail(peer, reqId, 409, 'Already joined');
    return;
  }
  let result: Awaited<ReturnType<typeof requireChannel>>;
  try {
    result = await requireChannel(peer.userId, channelId, Permission.CONNECT);
  } catch (error) {
    if (statusCodeOf(error) === 403) {
      fail(peer, reqId, 403, 'Channel access denied');
      return;
    }
    throw error;
  }
  // Finding 1 fix: requireChannel only proves permission/visibility, not
  // channel type -- a text channel must still be denied.
  if (result.channel?.type !== 'voice') {
    fail(peer, reqId, 400, 'Not a voice channel');
    return;
  }
  const room = await getOrCreateRoom(channelId);
  // Finding 1 fix: the WS may have closed (and teardownPeer already run)
  // while we were awaiting getOrCreateRoom above. Re-check before adding
  // this peer to the room -- otherwise a torn-down peer gets an orphaned
  // slot that nothing ever removes.
  if (peer.torndown) return;
  if (room.peers.size >= MAX_PEERS_PER_ROUTER) {
    fail(peer, reqId, 429, 'Room full');
    return;
  }
  peer.channelId = channelId;
  room.peers.add(peer);
  const existingProducers = [...room.registry.entries()].map(([producerId, entry]) => ({
    producerId,
    userId: entry.ownerUserId,
    kind: 'audio' as const,
  }));
  broadcastToChannel(channelId, { type: 'peerJoined', payload: { userId: peer.userId } }, peer);
  reply(peer, reqId, {
    rtpCapabilities: audioOnlyRtpCapabilities(room.router.rtpCapabilities),
    existingProducers,
    // Fix 4 (late joiner): current contents of the room's moderator-mute
    // set, so a peer that joins mid-call immediately knows who's already
    // muted without waiting for a future participantMuted broadcast.
    mutedParticipants: [...room.mutedUserIds],
  });
  // voice-moderation-occupancy: publish the new count once the peer is
  // actually in room.peers, mirroring the same publish() call in
  // teardownPeer -- fire-and-forget so a slow/failed Redis publish never
  // delays or fails the join reply itself.
  void publish('voice.occupancy', channelId, { count: room.peers.size }).catch((error) => {
    console.error('Failed to publish voice.occupancy', error instanceof Error ? error.message : 'unknown');
  });
}

// participant-limits-and-moderation: resolves targetUserId to a connected
// Peer within a specific channel's room. Deliberately takes channelId (not
// peer.channelId) since the caller here is a moderator acting on ANOTHER
// peer's connection -- this is the one place in this codebase that looks up
// a peer by something other than the requesting connection's own state,
// which is exactly why it's gated on requireGuild(MODERATE_MEMBERS) above
// every call site, unlike every tier-1 lookup elsewhere in this file.
function findConnectedPeer(channelId: string, targetUserId: string): Peer | undefined {
  const room = channelRooms.get(channelId);
  if (!room) return undefined;
  for (const candidate of room.peers) {
    if (candidate.userId === targetUserId) return candidate;
  }
  return undefined;
}

async function requireModerator(peer: Peer, reqId: string, channelId: string): Promise<boolean> {
  let result: Awaited<ReturnType<typeof requireChannel>>;
  try {
    result = await requireChannel(peer.userId, channelId);
  } catch (error) {
    if (statusCodeOf(error) === 403) {
      fail(peer, reqId, 403, 'Channel access denied');
      return false;
    }
    throw error;
  }
  const guildId = result.channel?.guild_id as string | undefined;
  if (!guildId) {
    // A channel with no guild_id (e.g. a DM) can never have a voice-call
    // moderator -- same 404 shape as any other "doesn't exist here" case.
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return false;
  }
  try {
    await requireGuild(peer.userId, guildId, Permission.MODERATE_MEMBERS);
  } catch (error) {
    if (statusCodeOf(error) === 403) {
      fail(peer, reqId, 403, 'Missing permission for this action');
      return false;
    }
    throw error;
  }
  // Finding 1-style re-check: teardownPeer may have run on the calling
  // (moderator's own) connection while the two awaits above were in flight.
  // Nothing below touches the moderator's own resources, but this mirrors
  // every other awaited-then-reply path in this file.
  if (peer.torndown) return false;
  // Cross-review fix 1: the guild-level MODERATE_MEMBERS check above proves
  // permission, but never proves the caller is actually in THIS room. A
  // moderator connected to a completely different voice channel (or holding
  // a media WS without having joined any room at all) must not be able to
  // mute/disconnect people in a room they're not even in -- the brief scopes
  // moderator actions to "another connected participant in the SAME voice
  // channel". Same 403 "access denied" phrasing as every other authorization
  // failure in this file.
  if (peer.channelId !== channelId) {
    fail(peer, reqId, 403, 'Channel access denied');
    return false;
  }
  return true;
}

async function handleModeratorSetMute(
  peer: Peer,
  reqId: string,
  channelId: string,
  targetUserId: string,
  muted: boolean,
) {
  if (!(await requireModerator(peer, reqId, channelId))) return;
  const target = findConnectedPeer(channelId, targetUserId);
  if (!target) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  // requireModerator (fix 1) already proved peer.channelId === channelId,
  // and a peer's channelId is only ever set once its room exists (handleJoin),
  // so this room is guaranteed to exist here.
  const room = channelRooms.get(channelId)!;
  // Resource limits elsewhere in this file cap a peer at 1 producer, so
  // there's at most one to act on here.
  const [producer] = target.producers.values();
  if (producer) {
    try {
      if (muted) await producer.pause();
      else await producer.resume();
    } catch (error) {
      // Cross-review fix 2: a genuine pause()/resume() rejection here means
      // the live media state did NOT change as intended -- broadcasting
      // participantMuted anyway would tell every client (including the
      // target) a mute state that doesn't match reality. Fail the request
      // instead of reporting success. (Note: `!producer` above -- a target
      // with no producer at all, e.g. muted before they ever started
      // speaking -- is not this case; that's handled by the `if (producer)`
      // guard and still succeeds, since there's simply nothing to pause.)
      console.error('Failed to set producer pause state', error instanceof Error ? error.message : 'unknown');
      fail(peer, reqId, 500, 'Failed to set mute state');
      return;
    }
  }
  // Cross-review fix 4: persist the moderator-imposed mute state at the
  // room level (survives the target's own disconnect/reconnect, unlike the
  // live producer.paused flag which resets with a brand-new Producer -- see
  // handleProduce's re-application of this set on reconnect, and handleJoin's
  // mutedParticipants for late joiners).
  if (muted) room.mutedUserIds.add(targetUserId);
  else room.mutedUserIds.delete(targetUserId);
  broadcastToChannel(channelId, { type: 'participantMuted', payload: { userId: targetUserId, muted } });
  reply(peer, reqId, {});
}

async function handleModeratorDisconnect(peer: Peer, reqId: string, channelId: string, targetUserId: string) {
  if (!(await requireModerator(peer, reqId, channelId))) return;
  const target = findConnectedPeer(channelId, targetUserId);
  if (!target) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  // Sent first, while the socket is still open, so it actually reaches the
  // target before anything below closes the connection.
  send(target, { type: 'removedByModerator', payload: {} });
  // Reuse the single teardown path exactly -- it already handles closing
  // transports/producers/consumers, removing the peer from the room,
  // decrementing/destroying the router, publishing the post-removal
  // occupancy count, and is guarded by `torndown` so it's safe even if the
  // target is mid-disconnect for some unrelated reason.
  teardownPeer(target);
  // Reply to the calling moderator BEFORE closing the target's socket
  // below. Nothing in the contract forbids a moderator targeting their own
  // connection (self-disconnect), in which case peer === target -- closing
  // the socket first would flip its readyState away from OPEN and silently
  // swallow this reply (send() only writes to an OPEN socket), leaving the
  // moderator's own request to hang forever with no response. Replying
  // first avoids that regardless of whether target is a third party or the
  // caller themselves.
  reply(peer, reqId, {});
  // teardownPeer itself never closes the WebSocket -- by design, since
  // every other caller (handleLeave, the periodic sweep before its own
  // explicit close, WS 'close'/'error' handlers reacting to an
  // already-closed socket) either wants the connection to stay open or has
  // already closed/is closing it for its own reason. A moderator-initiated
  // removal is the one path that must force the connection closed itself,
  // exactly like shutdown() does (teardownPeer(peer) then peer.ws.close(...)
  // for the same reason). Closed last, after both the removedByModerator
  // notice and the moderator's own reply have already been written to
  // their (possibly shared) socket.
  target.ws.close(4009, 'Removed by moderator');
}

async function handleCreateTransport(peer: Peer, reqId: string, direction: 'send' | 'recv') {
  if (peer.channelId === null) {
    fail(peer, reqId, 400, 'Not joined');
    return;
  }
  const room = channelRooms.get(peer.channelId);
  if (!room) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  // Resource limits: at most 1 send + 1 recv transport per peer.
  for (const existing of peer.transports.values()) {
    if (existing.direction === direction) {
      fail(peer, reqId, 409, 'Already exists');
      return;
    }
  }
  let transport: MediasoupTypes.WebRtcTransport;
  try {
    transport = await room.router.createWebRtcTransport({
      listenInfos: [
        { protocol: 'udp', ip: '0.0.0.0', announcedAddress },
        { protocol: 'tcp', ip: '0.0.0.0', announcedAddress },
      ],
    });
  } catch (error) {
    fail(peer, reqId, 500, 'Failed to create transport');
    return;
  }
  // Finding 1 fix: teardownPeer may have run while we were awaiting
  // createWebRtcTransport. Don't hand a torn-down peer a live transport that
  // nothing will ever close.
  if (peer.torndown) {
    transport.close();
    return;
  }
  peer.transports.set(transport.id, { transport, direction });
  reply(peer, reqId, {
    transportId: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: iceCandidatesOf(transport),
    dtlsParameters: transport.dtlsParameters,
  });
}

async function handleConnectTransport(
  peer: Peer,
  reqId: string,
  transportId: string,
  dtlsParameters: MediasoupTypes.DtlsParameters,
) {
  const entry = peer.transports.get(transportId);
  if (!entry) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  try {
    await entry.transport.connect({ dtlsParameters });
  } catch (error) {
    fail(peer, reqId, 500, 'Failed to connect transport');
    return;
  }
  // Finding 1 fix: teardownPeer may have run mid-await; the transport is
  // already closed in that case, so don't report success for it.
  if (peer.torndown) return;
  reply(peer, reqId, {});
}

async function handleProduce(
  peer: Peer,
  reqId: string,
  transportId: string,
  kind: 'audio',
  rtpParameters: MediasoupTypes.RtpParameters,
) {
  if (peer.channelId === null) {
    fail(peer, reqId, 400, 'Not joined');
    return;
  }
  const entry = peer.transports.get(transportId);
  if (!entry) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  if (entry.direction !== 'send') {
    fail(peer, reqId, 400, 'Wrong transport direction');
    return;
  }
  // Resource limits: at most 1 producer per peer (audio-only spike, one mic in).
  if (peer.producers.size >= 1) {
    fail(peer, reqId, 409, 'Already exists');
    return;
  }
  try {
    await requireChannel(peer.userId, peer.channelId, Permission.SPEAK);
  } catch (error) {
    if (statusCodeOf(error) === 403) {
      fail(peer, reqId, 403, 'Missing permission for this action');
      return;
    }
    throw error;
  }
  // Finding 1 fix: the requireChannel await above may have outlasted
  // teardownPeer (e.g. the socket closed mid-check). Bail before touching
  // room/registry state for a peer that no longer has a home.
  if (peer.torndown) return;
  const room = channelRooms.get(peer.channelId);
  if (!room) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  let producer: MediasoupTypes.Producer;
  try {
    producer = await entry.transport.produce({ kind, rtpParameters });
  } catch (error) {
    fail(peer, reqId, 500, 'Failed to produce');
    return;
  }
  // Finding 1 fix: same race, this time across the transport.produce()
  // await -- if the peer was torn down while that was in flight, close the
  // freshly-created producer instead of inserting it into any map/registry.
  if (peer.torndown) {
    producer.close();
    return;
  }
  peer.producers.set(producer.id, producer);
  room.registry.set(producer.id, {
    ownerUserId: peer.userId,
    channelId: peer.channelId,
    transportId,
    producer,
  });
  // Cross-review fix 4 (reconnect half): the room's moderator-mute set
  // survives a peer's own disconnect/reconnect (see the ChannelRoom type and
  // handleModeratorSetMute), but a fresh Producer always starts unpaused --
  // if this peer was moderator-muted before they reconnected, pause the new
  // producer immediately, before it's usable, so they come back muted
  // rather than briefly (or indefinitely, if no further mute action fires)
  // audible. Best-effort: if pause() itself throws here, log and continue --
  // the producer was still validly created and the request should still
  // succeed; there's no client-facing action to fail on their own produce
  // call for a moderator's earlier mute.
  if (room.mutedUserIds.has(peer.userId)) {
    try {
      await producer.pause();
    } catch (error) {
      console.error(
        'Failed to re-apply moderator mute to reconnected producer',
        error instanceof Error ? error.message : 'unknown',
      );
    }
    // Finding 1-style re-check: teardownPeer may have run (closing this very
    // producer via its transport) while the pause() await above was in
    // flight -- it already handled cleanup/broadcast for that case, so don't
    // also broadcast newProducer / reply success for a peer that's gone.
    if (peer.torndown) return;
  }
  broadcastToChannel(
    peer.channelId,
    { type: 'newProducer', payload: { producerId: producer.id, userId: peer.userId, kind: 'audio' } },
    peer,
  );
  reply(peer, reqId, { producerId: producer.id });
}

async function handleConsume(
  peer: Peer,
  reqId: string,
  transportId: string,
  producerId: string,
  rtpCapabilities: MediasoupTypes.RtpCapabilities,
) {
  if (peer.channelId === null) {
    fail(peer, reqId, 400, 'Not joined');
    return;
  }
  const entry = peer.transports.get(transportId);
  if (!entry) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  if (entry.direction !== 'recv') {
    fail(peer, reqId, 400, 'Wrong transport direction');
    return;
  }
  // Tier 2 ownership: producerId is resolved ONLY via the joined channel's own
  // registry, keyed by the requester's own peer.channelId -- never a global map.
  const room = channelRooms.get(peer.channelId);
  const producerEntry = room?.registry.get(producerId);
  if (!room || !producerEntry) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    fail(peer, reqId, 400, 'Cannot consume');
    return;
  }
  // Finding 2 fix: cap consumers at one per (peer, producerId) -- otherwise a
  // joined peer can call `consume` for the same producer repeatedly and grow
  // an unbounded number of native Consumers (the existing rate limit only
  // bounds allocation *rate*, not total count). Mirrors the plan's other
  // explicit per-peer/per-producer caps (409-style rejection).
  for (const existing of peer.consumers.values()) {
    if (existing.producerId === producerId) {
      fail(peer, reqId, 409, 'Already consuming this producer');
      return;
    }
  }
  let consumer: MediasoupTypes.Consumer;
  try {
    consumer = await entry.transport.consume({ producerId, rtpCapabilities, paused: true });
  } catch (error) {
    fail(peer, reqId, 500, 'Failed to consume');
    return;
  }
  // Finding 1 fix: re-check after the consume() await -- if teardownPeer ran
  // while we awaited, close the freshly-created consumer instead of handing
  // it to a peer/registry that no longer exists.
  if (peer.torndown) {
    consumer.close();
    return;
  }
  // Finding 2 fix (race companion): another `consume` for the same
  // producerId may have completed and been inserted while this one awaited
  // transport.consume() above -- re-check right before inserting so two
  // concurrent requests can't both win the race and leave two consumers.
  for (const existing of peer.consumers.values()) {
    if (existing.producerId === producerId && existing.id !== consumer.id) {
      consumer.close();
      fail(peer, reqId, 409, 'Already consuming this producer');
      return;
    }
  }
  peer.consumers.set(consumer.id, consumer);
  reply(peer, reqId, {
    consumerId: consumer.id,
    producerId: consumer.producerId,
    kind: 'audio',
    rtpParameters: consumer.rtpParameters,
  });
}

async function handleResumeConsumer(peer: Peer, reqId: string, consumerId: string) {
  const consumer = peer.consumers.get(consumerId);
  if (!consumer) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  try {
    await consumer.resume();
  } catch (error) {
    fail(peer, reqId, 500, 'Failed to resume consumer');
    return;
  }
  reply(peer, reqId, {});
}

// device-network-handling: tier-1 ownership, same rule as connectTransport/
// produce -- transportId is resolved ONLY via the requesting peer's own
// transports map, never a global map. mediasoup's WebRtcTransport#restartIce()
// (confirmed against the installed mediasoup@3.27.1 types in
// WebRtcTransportTypes.d.ts) returns `Promise<IceParameters>` directly, not a
// wrapper object -- candidates/dtlsParameters are unchanged by an ICE restart
// and are not part of its return value.
async function handleRestartIce(peer: Peer, reqId: string, transportId: string) {
  const entry = peer.transports.get(transportId);
  if (!entry) {
    fail(peer, reqId, 404, 'Unknown transport/producer/consumer');
    return;
  }
  let iceParameters: MediasoupTypes.IceParameters;
  try {
    iceParameters = await entry.transport.restartIce();
  } catch (error) {
    fail(peer, reqId, 500, 'Failed to restart ICE');
    return;
  }
  // Finding 1 fix pattern (see handleConnectTransport/handleProduce): the
  // peer may have been torn down while the restartIce() await was in
  // flight, in which case the transport is already closed -- don't report
  // success for it.
  if (peer.torndown) return;
  reply(peer, reqId, { iceParameters });
}

// leave's entire implementation is teardownPeer + an ok reply -- no session
// re-check (plan.md "Teardown idempotency"): tearing down your own peer is
// always safe, even with an expired session.
function handleLeave(peer: Peer, reqId: string) {
  teardownPeer(peer);
  reply(peer, reqId, {});
}

async function handleMessage(peer: Peer, raw: string) {
  // Rate limit: 30 messages / rolling 10s window per connection, mirroring
  // apps/gateway/src/index.ts.
  if (Date.now() - peer.window > 10000) {
    peer.window = Date.now();
    peer.messages = 0;
  }
  if (++peer.messages > 30) {
    peer.ws.close(4008, 'Rate limited');
    return;
  }
  let parsed;
  try {
    parsed = mediaRequestSchema.parse(JSON.parse(raw));
  } catch {
    peer.ws.close(MALFORMED_REQUEST_CLOSE_CODE, 'Invalid payload');
    return;
  }
  // `leave` intentionally skips the per-request session check (see
  // handleLeave above); every other operation re-verifies first.
  if (parsed.type !== 'leave' && !(await checkSession(peer))) return;
  switch (parsed.type) {
    case 'join':
      await handleJoin(peer, parsed.reqId, parsed.payload.channelId);
      return;
    case 'createTransport':
      await handleCreateTransport(peer, parsed.reqId, parsed.payload.direction);
      return;
    case 'connectTransport':
      await handleConnectTransport(
        peer,
        parsed.reqId,
        parsed.payload.transportId,
        parsed.payload.dtlsParameters as MediasoupTypes.DtlsParameters,
      );
      return;
    case 'produce':
      await handleProduce(
        peer,
        parsed.reqId,
        parsed.payload.transportId,
        parsed.payload.kind,
        parsed.payload.rtpParameters as MediasoupTypes.RtpParameters,
      );
      return;
    case 'consume':
      await handleConsume(
        peer,
        parsed.reqId,
        parsed.payload.transportId,
        parsed.payload.producerId,
        parsed.payload.rtpCapabilities as MediasoupTypes.RtpCapabilities,
      );
      return;
    case 'resumeConsumer':
      await handleResumeConsumer(peer, parsed.reqId, parsed.payload.consumerId);
      return;
    case 'restartIce':
      await handleRestartIce(peer, parsed.reqId, parsed.payload.transportId);
      return;
    case 'leave':
      handleLeave(peer, parsed.reqId);
      return;
    case 'moderatorSetMute':
      await handleModeratorSetMute(
        peer,
        parsed.reqId,
        parsed.payload.channelId,
        parsed.payload.targetUserId,
        parsed.payload.muted,
      );
      return;
    case 'moderatorDisconnect':
      await handleModeratorDisconnect(peer, parsed.reqId, parsed.payload.channelId, parsed.payload.targetUserId);
      return;
  }
}

function queue(peer: Peer, fn: () => Promise<void>) {
  if (++peer.pending > 500) {
    peer.ws.close(4008, 'Backpressure');
    return;
  }
  peer.queue = peer.queue
    .then(fn)
    .catch((error) => {
      console.error('Media operation failed', error instanceof Error ? error.message : 'unknown');
      peer.ws.close(1011, 'Service unavailable');
    })
    .finally(() => {
      peer.pending--;
    });
}

// device-network-handling: set true at the start of shutdown() below so the
// upgrade handler stops accepting new WS connections immediately, before any
// of the slower teardown steps (broadcasting, closing peers, closing the
// worker) even begin.
let shuttingDown = false;

server.on('upgrade', (req, socket, head) => {
  void (async () => {
    if (shuttingDown) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    if (req.headers.origin !== config.webOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const session = await authenticateSession(req.headers.cookie);
    if (!session) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const peer: Peer = {
        ws,
        userId: session.userId,
        tokenHash: session.tokenHash,
        channelId: null,
        torndown: false,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        queue: Promise.resolve(),
        pending: 0,
        window: Date.now(),
        messages: 0,
      };
      allPeers.add(peer);
      ws.on('message', (raw) => queue(peer, () => handleMessage(peer, raw.toString())));
      ws.on('close', () => teardownPeer(peer));
      ws.on('error', () => teardownPeer(peer));
    });
  })().catch(() => socket.destroy());
});

// Periodic sweep (plan.md "Session re-verification"): catches a peer who
// stops signaling but keeps their WebRTC transport open after their session
// is invalidated -- per-request checks alone never fire for that peer.
const sweepTimer = setInterval(() => {
  for (const peer of allPeers) {
    if (peer.torndown) continue;
    void sessionStillValid(peer.tokenHash, peer.userId)
      .then((valid) => {
        if (valid || peer.torndown) return;
        peer.ws.close(4001, 'Session expired');
        teardownPeer(peer);
      })
      .catch((error) => {
        // Finding 3 fix: a transient DB failure here must not become an
        // unhandled rejection (which can crash the process under Node's
        // default behavior) and must not force-close a peer on a false
        // positive -- just log and skip this peer for this sweep iteration.
        console.error(
          'Session sweep check failed, skipping this peer for this iteration',
          error instanceof Error ? error.message : 'unknown',
        );
      });
  }
}, 30000);

// Graceful shutdown (plan.md "Graceful shutdown"): broadcast a warning to
// every connected peer, stop taking new connections, tear every peer down
// through the same single teardownPeer path everything else uses (closes
// their transports/producers/consumers and decrements/destroys routers),
// close the WS/HTTP servers and the mediasoup worker, and exit. Bounded by
// SHUTDOWN_GRACE_MS so one client that never disconnects cleanly (or a
// hung db/redis close) can't keep the process alive indefinitely.
const SHUTDOWN_GRACE_MS = 2000;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sweepTimer);
  // Sent before any peer is torn down so every currently-connected client
  // gets the notice (and a chance to show a "server restarting" state)
  // instead of just seeing their socket close unexplained.
  broadcastToAllPeers({ type: 'serverShuttingDown', payload: {} });
  for (const peer of [...allPeers]) {
    teardownPeer(peer);
    peer.ws.close(1001, 'Restarting');
  }

  const forceExit = () => process.exit(0);
  const graceTimer = setTimeout(forceExit, SHUTDOWN_GRACE_MS);

  // Worker#close() is synchronous (void), unlike db.end()/redis.quit(). Run
  // it up front -- before awaiting db/redis -- so a hung db/redis close
  // can't skip it on the forced-exit (grace timer) path.
  try {
    worker.close();
  } catch {
    // already closed -- nothing to do
  }

  // Only exit normally once the WS/HTTP servers have actually finished
  // closing (their callbacks fire) *and* db/redis have settled -- not just
  // as soon as db/redis settle. Racing ahead of wss.close()/server.close()
  // risked truncating the already-queued serverShuttingDown message / 1001
  // close frames before they flushed. graceTimer remains the hard ceiling:
  // if any of these hang, it force-exits regardless.
  let exited = false;
  const finishExit = () => {
    if (exited) return;
    exited = true;
    clearTimeout(graceTimer);
    forceExit();
  };

  let pendingClose = 2; // wss.close callback + server.close callback
  let dbRedisSettled = false;
  const maybeFinishExit = () => {
    if (pendingClose === 0 && dbRedisSettled) finishExit();
  };

  wss.close(() => {
    pendingClose -= 1;
    maybeFinishExit();
  });
  server.close(() => {
    pendingClose -= 1;
    maybeFinishExit();
  });

  void Promise.all([db.end(), redis.quit()])
    .catch((error) => {
      console.error('Error closing db/redis during shutdown', error instanceof Error ? error.message : 'unknown');
    })
    .finally(() => {
      dbRedisSettled = true;
      maybeFinishExit();
    });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdown);
}

server.listen(mediaPort, host, () => console.log('Vexa media service listening'));
