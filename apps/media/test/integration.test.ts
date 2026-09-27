import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

// Real Postgres/Redis + a live apps/api + apps/media, per apps/gateway's own
// integration-test convention (see apps/gateway/test/integration.test.ts).
// Requires VEXA_INTEGRATION=1 and API_URL/WEB_ORIGIN/MEDIA_URL pointed at a
// running stack (see docs/tasks/audio-spike/plan.md "Local run").
const api = process.env.API_URL ?? 'http://localhost:3001';
const origin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const mediaUrl = process.env.MEDIA_URL ?? 'ws://localhost:3003';

async function register() {
  const username = `media-${randomUUID().slice(0, 8)}`;
  const r = await fetch(api + '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: `${username}@example.com`, username, password: 'long-test-password-123!' }),
  });
  assert.equal(r.status, 201);
  const user = (await r.json()) as { id: string };
  return { cookie: r.headers.get('set-cookie')!.split(';')[0], id: user.id };
}

async function request(path: string, method = 'GET', body?: unknown, cookie?: string) {
  return fetch(api + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createGuild(ownerCookie: string) {
  const r = await request('/guilds', 'POST', { name: 'Media test guild ' + randomUUID().slice(0, 8) }, ownerCookie);
  assert.equal(r.status, 201);
  return (await r.json()) as { id: string; channelId: string };
}

async function createChannel(ownerCookie: string, guildId: string, type: 'voice' | 'text') {
  const r = await request(`/guilds/${guildId}/channels`, 'POST', { name: `${type}-${randomUUID().slice(0, 6)}`, type }, ownerCookie);
  assert.equal(r.status, 201);
  return (await r.json()) as { id: string; type: string };
}

async function inviteAndJoin(ownerCookie: string, guildId: string, joinerCookie: string) {
  const invite = await (await request(`/guilds/${guildId}/invites`, 'POST', undefined, ownerCookie)).json() as { code: string };
  const joined = await request(`/invites/${invite.code}/join`, 'POST', undefined, joinerCookie);
  assert.equal(joined.status, 201);
}

function opusRtpParameters() {
  return {
    mid: '0',
    codecs: [
      {
        mimeType: 'audio/opus',
        payloadType: 100,
        clockRate: 48000,
        channels: 2,
        parameters: { useinbandfec: 1 },
        rtcpFeedback: [],
      },
    ],
    encodings: [{ ssrc: Math.floor(Math.random() * 1_000_000_000) }],
    rtcp: { cname: 'media-test-' + randomUUID().slice(0, 8) },
  };
}

function fakeDtlsParameters() {
  return {
    role: 'client' as const,
    fingerprints: [{ algorithm: 'sha-256' as const, value: randomBytes(32).toString('hex').match(/../g)!.join(':').toUpperCase() }],
  };
}

type Envelope = { reqId?: string; ok?: boolean; data?: unknown; error?: { code: number; message: string }; type?: string; payload?: unknown };

async function connectMedia(cookie: string) {
  const ws = new WebSocket(mediaUrl, { headers: { Cookie: cookie, Origin: origin } });
  const messages: Envelope[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  async function req(type: string, payload: unknown, timeoutMs = 7000): Promise<Envelope> {
    const reqId = randomUUID();
    ws.send(JSON.stringify({ reqId, type, payload }));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const i = messages.findIndex((m) => m.reqId === reqId);
      if (i >= 0) return messages.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out waiting for response to ${type}`);
  }
  async function waitEvent(type: string, timeoutMs = 7000): Promise<Envelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const i = messages.findIndex((m) => m.type === type);
      if (i >= 0) return messages.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out waiting for event ${type}`);
  }
  return { ws, req, waitEvent };
}

test(
  'unrelated account denied a voice transport; a text channel is denied even with CONNECT',
  { skip: process.env.VEXA_INTEGRATION !== '1', timeout: 30000 },
  async () => {
    const owner = await register();
    const stranger = await register();
    const guild = await createGuild(owner.cookie);
    const voice = await createChannel(owner.cookie, guild.id, 'voice');

    const strangerPeer = await connectMedia(stranger.cookie);
    try {
      const denied = await strangerPeer.req('join', { channelId: voice.id });
      assert.equal(denied.ok, false);
      assert.equal(denied.error?.code, 403);
      // No transport should exist for this connection: createTransport must
      // fail as "not joined" since join never succeeded.
      const notJoined = await strangerPeer.req('createTransport', { direction: 'send' });
      assert.equal(notJoined.ok, false);
      assert.equal(notJoined.error?.code, 400);
    } finally {
      strangerPeer.ws.close();
    }

    // A guild member with CONNECT still can't join a *text* channel as voice.
    const member = await register();
    await inviteAndJoin(owner.cookie, guild.id, member.cookie);
    const memberPeer = await connectMedia(member.cookie);
    try {
      const deniedType = await memberPeer.req('join', { channelId: guild.channelId });
      assert.equal(deniedType.ok, false);
      assert.equal(deniedType.error?.code, 400);
      assert.match(deniedType.error?.message ?? '', /voice channel/i);
    } finally {
      memberPeer.ws.close();
    }
  },
);

test(
  'leaving/disconnecting releases the transport and producer, no orphaned resources',
  { skip: process.env.VEXA_INTEGRATION !== '1', timeout: 30000 },
  async () => {
    const owner = await register();
    const member = await register();
    const guild = await createGuild(owner.cookie);
    const voice = await createChannel(owner.cookie, guild.id, 'voice');
    await inviteAndJoin(owner.cookie, guild.id, member.cookie);

    const ownerPeer = await connectMedia(owner.cookie);
    const memberPeer = await connectMedia(member.cookie);
    try {
      const ownerJoin = await ownerPeer.req('join', { channelId: voice.id });
      assert.equal(ownerJoin.ok, true);
      const sendTransport = await ownerPeer.req('createTransport', { direction: 'send' });
      assert.equal(sendTransport.ok, true);
      const transportId = (sendTransport.data as { transportId: string }).transportId;
      await ownerPeer.req('connectTransport', { transportId, dtlsParameters: fakeDtlsParameters() });
      const produced = await ownerPeer.req('produce', { transportId, kind: 'audio', rtpParameters: opusRtpParameters() });
      assert.equal(produced.ok, true);
      const producerId = (produced.data as { producerId: string }).producerId;

      const memberJoin = await memberPeer.req('join', { channelId: voice.id });
      assert.equal(memberJoin.ok, true);
      const existing = (memberJoin.data as { existingProducers: { producerId: string }[] }).existingProducers;
      assert.ok(existing.some((p) => p.producerId === producerId));

      // Owner disconnects without sending `leave` -- WS close handler must
      // tear down the transport/producer.
      ownerPeer.ws.close();
      const closedEvent = await memberPeer.waitEvent('producerClosed');
      assert.equal((closedEvent.payload as { producerId: string }).producerId, producerId);

      // The producer is gone from the room's registry: a fresh consume
      // attempt for it must now 404, exactly like an unknown id.
      const recvTransport = await memberPeer.req('createTransport', { direction: 'recv' });
      assert.equal(recvTransport.ok, true);
      const recvTransportId = (recvTransport.data as { transportId: string }).transportId;
      const routerCaps = (memberJoin.data as { rtpCapabilities: unknown }).rtpCapabilities;
      const consumeAfterClose = await memberPeer.req('consume', {
        transportId: recvTransportId,
        producerId,
        rtpCapabilities: routerCaps,
      });
      assert.equal(consumeAfterClose.ok, false);
      assert.equal(consumeAfterClose.error?.code, 404);
    } finally {
      ownerPeer.ws.close();
      memberPeer.ws.close();
    }
  },
);

test(
  'a peer can never operate on another connection\'s transport/consumer id, even within the same room (tier 1 ownership)',
  { skip: process.env.VEXA_INTEGRATION !== '1', timeout: 30000 },
  async () => {
    const owner = await register();
    const member = await register();
    const guild = await createGuild(owner.cookie);
    const voice = await createChannel(owner.cookie, guild.id, 'voice');
    await inviteAndJoin(owner.cookie, guild.id, member.cookie);

    const ownerPeer = await connectMedia(owner.cookie);
    const memberPeer = await connectMedia(member.cookie);
    try {
      await ownerPeer.req('join', { channelId: voice.id });
      await memberPeer.req('join', { channelId: voice.id });

      const ownerTransport = await ownerPeer.req('createTransport', { direction: 'send' });
      assert.equal(ownerTransport.ok, true);
      const ownerTransportId = (ownerTransport.data as { transportId: string }).transportId;

      // member, in the SAME room, guesses/observes owner's transport id.
      const stolenConnect = await memberPeer.req('connectTransport', { transportId: ownerTransportId, dtlsParameters: fakeDtlsParameters() });
      assert.equal(stolenConnect.ok, false);
      assert.equal(stolenConnect.error?.code, 404);

      const stolenProduce = await memberPeer.req('produce', { transportId: ownerTransportId, kind: 'audio', rtpParameters: opusRtpParameters() });
      assert.equal(stolenProduce.ok, false);
      assert.equal(stolenProduce.error?.code, 404);

      const randomConsumerId = randomUUID();
      const stolenResume = await memberPeer.req('resumeConsumer', { consumerId: randomConsumerId });
      assert.equal(stolenResume.ok, false);
      assert.equal(stolenResume.error?.code, 404);
    } finally {
      ownerPeer.ws.close();
      memberPeer.ws.close();
    }
  },
);

test(
  'a producer is consumable by a same-channel peer, and rejected for a different-channel peer (tier 2 registry)',
  { skip: process.env.VEXA_INTEGRATION !== '1', timeout: 30000 },
  async () => {
    const ownerA = await register();
    const memberA = await register();
    const guildA = await createGuild(ownerA.cookie);
    const voiceA = await createChannel(ownerA.cookie, guildA.id, 'voice');
    await inviteAndJoin(ownerA.cookie, guildA.id, memberA.cookie);

    const ownerB = await register();
    const guildB = await createGuild(ownerB.cookie);
    const voiceB = await createChannel(ownerB.cookie, guildB.id, 'voice');

    const ownerAPeer = await connectMedia(ownerA.cookie);
    const memberAPeer = await connectMedia(memberA.cookie);
    const ownerBPeer = await connectMedia(ownerB.cookie);
    try {
      await ownerAPeer.req('join', { channelId: voiceA.id });
      const memberAJoin = await memberAPeer.req('join', { channelId: voiceA.id });
      const ownerBJoin = await ownerBPeer.req('join', { channelId: voiceB.id });
      assert.equal(memberAJoin.ok, true);
      assert.equal(ownerBJoin.ok, true);

      const sendTransport = await ownerAPeer.req('createTransport', { direction: 'send' });
      const transportId = (sendTransport.data as { transportId: string }).transportId;
      await ownerAPeer.req('connectTransport', { transportId, dtlsParameters: fakeDtlsParameters() });
      const produced = await ownerAPeer.req('produce', { transportId, kind: 'audio', rtpParameters: opusRtpParameters() });
      assert.equal(produced.ok, true);
      const producerId = (produced.data as { producerId: string }).producerId;

      // Same-channel peer: consume succeeds (this is the intended working path).
      const memberARecv = await memberAPeer.req('createTransport', { direction: 'recv' });
      const memberARtpCaps = (memberAJoin.data as { rtpCapabilities: unknown }).rtpCapabilities;
      const sameChannelConsume = await memberAPeer.req('consume', {
        transportId: (memberARecv.data as { transportId: string }).transportId,
        producerId,
        rtpCapabilities: memberARtpCaps,
      });
      assert.equal(sameChannelConsume.ok, true);
      assert.equal((sameChannelConsume.data as { producerId: string }).producerId, producerId);

      // Different-channel peer: same 404 as an unknown id -- no cross-room
      // existence oracle.
      const ownerBRecv = await ownerBPeer.req('createTransport', { direction: 'recv' });
      const ownerBRtpCaps = (ownerBJoin.data as { rtpCapabilities: unknown }).rtpCapabilities;
      const differentChannelConsume = await ownerBPeer.req('consume', {
        transportId: (ownerBRecv.data as { transportId: string }).transportId,
        producerId,
        rtpCapabilities: ownerBRtpCaps,
      });
      assert.equal(differentChannelConsume.ok, false);
      assert.equal(differentChannelConsume.error?.code, 404);
    } finally {
      ownerAPeer.ws.close();
      memberAPeer.ws.close();
      ownerBPeer.ws.close();
    }
  },
);

test('media service exposes separate unauthenticated liveness and dependency readiness', { skip: process.env.VEXA_INTEGRATION !== '1' }, async () => {
  const base = mediaUrl.replace(/^ws/, 'http');
  for (const path of ['/live', '/ready']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ok: boolean }).ok, true);
  }
});
