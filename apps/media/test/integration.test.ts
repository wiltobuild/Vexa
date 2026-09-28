import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test(
  'a duplicate consume request for the same producer is rejected, not a second native consumer',
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
      const memberJoin = await memberPeer.req('join', { channelId: voice.id });
      assert.equal(memberJoin.ok, true);

      const sendTransport = await ownerPeer.req('createTransport', { direction: 'send' });
      const transportId = (sendTransport.data as { transportId: string }).transportId;
      await ownerPeer.req('connectTransport', { transportId, dtlsParameters: fakeDtlsParameters() });
      const produced = await ownerPeer.req('produce', { transportId, kind: 'audio', rtpParameters: opusRtpParameters() });
      assert.equal(produced.ok, true);
      const producerId = (produced.data as { producerId: string }).producerId;

      const recvTransport = await memberPeer.req('createTransport', { direction: 'recv' });
      const recvTransportId = (recvTransport.data as { transportId: string }).transportId;
      const rtpCapabilities = (memberJoin.data as { rtpCapabilities: unknown }).rtpCapabilities;

      const firstConsume = await memberPeer.req('consume', { transportId: recvTransportId, producerId, rtpCapabilities });
      assert.equal(firstConsume.ok, true);
      const consumerId = (firstConsume.data as { consumerId: string }).consumerId;

      // Same peer, same producer, second request: Finding 2 fix -- must be
      // rejected as a duplicate rather than allocating an unbounded second
      // native Consumer for the same (peer, producerId) pair.
      const secondConsume = await memberPeer.req('consume', { transportId: recvTransportId, producerId, rtpCapabilities });
      assert.equal(secondConsume.ok, false);
      assert.equal(secondConsume.error?.code, 409);

      // The original consumer is still the only one that works: resuming it
      // must still succeed, proving the duplicate request never displaced or
      // duplicated live state.
      const resumed = await memberPeer.req('resumeConsumer', { consumerId });
      assert.equal(resumed.ok, true);
    } finally {
      ownerPeer.ws.close();
      memberPeer.ws.close();
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

test(
  'restartIce is denied (404) for a transport belonging to another connection, and succeeds with real iceParameters for the requester\'s own transport',
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

      // Tier 1 ownership: a peer in the same room can never restartIce for a
      // transport it didn't create itself, mirroring the existing
      // connectTransport/produce/resumeConsumer ownership test above.
      const stolenRestart = await memberPeer.req('restartIce', { transportId: ownerTransportId });
      assert.equal(stolenRestart.ok, false);
      assert.equal(stolenRestart.error?.code, 404);

      // The real path, against the live mediasoup worker: the owner
      // restarting ICE on its own transport gets fresh, usable iceParameters.
      const restarted = await ownerPeer.req('restartIce', { transportId: ownerTransportId });
      assert.equal(restarted.ok, true);
      const iceParameters = (restarted.data as { iceParameters: { usernameFragment: string; password: string } }).iceParameters;
      assert.equal(typeof iceParameters.usernameFragment, 'string');
      assert.ok(iceParameters.usernameFragment.length > 0);
      assert.equal(typeof iceParameters.password, 'string');
      assert.ok(iceParameters.password.length > 0);

      // An unknown transport id (never created by anyone) gets the same 404.
      const unknownRestart = await ownerPeer.req('restartIce', { transportId: randomUUID() });
      assert.equal(unknownRestart.ok, false);
      assert.equal(unknownRestart.error?.code, 404);
    } finally {
      ownerPeer.ws.close();
      memberPeer.ws.close();
    }
  },
);

// Graceful-shutdown test: the rest of this suite talks to a single
// already-running apps/media instance (started by docker compose, per this
// project's integration-test convention -- see the module header). That
// instance can't be SIGTERM'd without killing every other test in this file
// along with it. So this test spawns its OWN short-lived apps/media process
// (real `tsx src/index.ts`, real mediasoup worker, on a scratch port and RTC
// port range so it can't collide with the shared instance) purely to send it
// a real SIGTERM and observe the real behavior -- not a mock of shutdown().
// This is judged more practical than exporting shutdown() for a direct unit
// test: index.ts is a run-on-import script (top-level `await createWorker`,
// `server.listen` at the bottom) with no module boundary that would let a
// test import just the shutdown function without also starting a whole
// second server as a side effect -- so spawning it as a subprocess and doing
// exactly that on purpose, deliberately, is the less awkward of the two
// options, and it also happens to be the closest automated approximation of
// AC7's real "send SIGTERM to the running process" requirement.
//
// Skipped on win32: confirmed by actually running this test on a Windows
// dev host -- Node's own docs note Windows has no real POSIX signal
// delivery, so `child.kill('SIGTERM')` there just force-terminates the
// child (like SIGKILL) without ever invoking the child's own
// `process.on('SIGTERM', ...)` handler. The child process was left running
// (orphaned, still listening) with the socket never closing, which is a
// Windows child_process limitation, not a bug in shutdown() itself. Real,
// live proof that shutdown() itself is correct: this task manually sent a
// genuine SIGTERM to the actual running `vexa-media-1` Docker container
// (Linux, real signals) with a connected client and observed, in order,
// the `serverShuttingDown` event, a 1001 close, and the container exiting
// with code 0 -- see this task's report for the exact transcript. On Linux
// (this suite's CI target and Docker's own OS), `child.kill('SIGTERM')`
// sends a real signal and this test exercises the same code path faithfully.
test(
  'SIGTERM triggers graceful shutdown: connected peers get serverShuttingDown before their socket closes, and the process exits within the grace bound',
  { skip: process.env.VEXA_INTEGRATION !== '1' || process.platform === 'win32', timeout: 30000 },
  async () => {
    const mediaDir = path.resolve(fileURLToPath(import.meta.url), '../..');
    const scratchPort = 39103;
    const scratchRtcMin = 41000;
    const scratchRtcMax = 41099;
    const scratchUrl = `http://127.0.0.1:${scratchPort}`;

    // Resolve the workspace-local tsx binary directly rather than going
    // through `pnpm exec`/`npx` -- avoids depending on pnpm being resolvable
    // on PATH inside a spawned shell (it may only be available via corepack
    // in some environments), since apps/media already depends on tsx
    // directly (see package.json's "dev"/"start" scripts).
    const tsxBin = path.join(mediaDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.CMD' : 'tsx');
    const child = spawn(tsxBin, ['src/index.ts'], {
      cwd: mediaDir,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        MEDIA_PORT: String(scratchPort),
        MEDIASOUP_RTC_MIN_PORT: String(scratchRtcMin),
        MEDIASOUP_RTC_MAX_PORT: String(scratchRtcMax),
        MEDIASOUP_ANNOUNCED_ADDRESS: '127.0.0.1',
        WEB_ORIGIN: origin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      // Wait for the scratch instance's own /live to answer, rather than a
      // fixed sleep -- worker startup time can vary under load.
      const deadline = Date.now() + 15000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const r = await fetch(scratchUrl + '/live');
          if (r.status === 200) ready = true;
        } catch {
          // not up yet
        }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, `scratch apps/media instance never became ready; stderr so far: ${stderr}`);

      const user = await register();
      const ws = new WebSocket(`ws://127.0.0.1:${scratchPort}`, { headers: { Cookie: user.cookie, Origin: origin } });
      const events: Array<{ type?: string }> = [];
      ws.on('message', (data) => events.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      const closedCode = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      const exitCode = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

      child.kill('SIGTERM');

      const code = await Promise.race([
        closedCode,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error('socket never closed')), 10000)),
      ]);
      assert.equal(code, 1001);
      assert.ok(
        events.some((e) => e.type === 'serverShuttingDown'),
        `expected a serverShuttingDown event before close, got: ${JSON.stringify(events)}`,
      );

      // Bounded shutdown: the process must actually exit, not hang -- give it
      // real headroom over the server's own SHUTDOWN_GRACE_MS (2000ms) for
      // process teardown overhead, but this still proves it terminates
      // rather than running forever.
      const finalExitCode = await Promise.race([
        exitCode,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error('process never exited')), 10000)),
      ]);
      assert.equal(finalExitCode, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  },
);
