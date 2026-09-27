import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createWorker, type types as MediasoupTypes } from 'mediasoup';
import {
  db,
  redis,
  requireChannel,
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
    const room: ChannelRoom = { router, registry: new Map(), peers: new Set() };
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
  });
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
    case 'leave':
      handleLeave(peer, parsed.reqId);
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

server.on('upgrade', (req, socket, head) => {
  void (async () => {
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweepTimer);
    for (const peer of allPeers) {
      teardownPeer(peer);
      peer.ws.close(1001, 'Restarting');
    }
    server.close();
    void Promise.all([db.end(), redis.quit(), worker.close()]).then(() => process.exit(0));
  });
}

server.listen(mediaPort, host, () => console.log('Vexa media service listening'));
