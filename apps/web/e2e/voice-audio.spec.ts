import { test, expect, type Page } from '@playwright/test';
import net from 'node:net';

// This is intentionally gated like connected.spec.ts: it uses the real API,
// gateway, media service, Postgres, and Redis rather than mocked endpoints.
// Unlike connected.spec.ts, VEXA_INTEGRATION=1 alone isn't enough here --
// CI's ci.yml sets that flag and starts api+gateway, but doesn't (yet) bring
// up the Docker-hosted apps/media service (see docs/tasks/audio-spike/
// verification.md "CI wiring" follow-up). Without this extra check, CI would
// try to run this test against a media port nothing is listening on and fail
// with ECONNREFUSED instead of skipping cleanly.
const live = process.env.VEXA_INTEGRATION === '1';
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function mediaPortReachable(port = 3003, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function connect(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: /Connect account|About connected mode/ }).click();
  await page.getByRole('button', { name: 'Open connected workspace', exact: true }).click();
}

async function registerAccount(page: Page, username: string) {
  await page.getByRole('button', { name: 'New here? Create an account', exact: true }).click();
  await page.getByLabel('USERNAME').fill(username);
  await page.getByLabel('EMAIL').fill(`${username}@example.com`);
  await page.getByLabel('PASSWORD').fill('long-e2e-test-password-1!');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create server', exact: true })).toBeVisible();
}

async function inboundAudioStats(page: Page) {
  return page.evaluate(async () => {
    const client = (window as Window & { __vexaVoiceClientForTests?: { getInboundAudioStatsForTests(): Promise<{ packetsReceived: number; bytesReceived: number }[]> } }).__vexaVoiceClientForTests;
    return client ? client.getInboundAudioStatsForTests() : [];
  });
}

async function currentUserId(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/me', { credentials: 'include' });
    if (!response.ok) throw new Error(`current user lookup failed (${response.status})`);
    return (await response.json() as { id: string }).id;
  });
}

test.describe('voice audio (real backend and native Chromium media)', () => {
  test('owner moderation locks and removes a member while a non-joined viewer receives occupancy', async ({ browser }) => {
    test.skip(!live, 'set VEXA_INTEGRATION=1 with the API, gateway, media, Postgres and Redis stack running');
    test.skip(live && !(await mediaPortReachable()), 'apps/media (port 3003) is not reachable -- start it with `docker compose up -d media` (see docs/tasks/audio-spike/verification.md)');
    test.setTimeout(90_000);
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const memberPage = await memberContext.newPage();
    const viewerPage = await viewerContext.newPage();
    const owner = `e2e-moderator-owner-${unique()}`;
    const member = `e2e-moderator-member-${unique()}`;
    const viewer = `e2e-moderator-viewer-${unique()}`;

    try {
      await connect(ownerPage);
      await registerAccount(ownerPage, owner);
      await ownerPage.getByRole('button', { name: 'Create server', exact: true }).click();
      await ownerPage.getByLabel('SERVER NAME').fill('Voice Moderation E2E Squad');
      await ownerPage.getByRole('dialog').getByRole('button', { name: 'Create server', exact: true }).click();
      const voiceChannel = await ownerPage.evaluate(async () => {
        const guild = await (await fetch('/api/guilds', { credentials: 'include' })).json() as { id: string }[];
        const response = await fetch(`/api/guilds/${guild[0].id}/channels`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'moderation-voice', type: 'voice' }) });
        if (!response.ok) throw new Error(`voice channel creation failed (${response.status})`);
        return response.json() as Promise<{ id: string; name: string }>;
      });
      await ownerPage.reload();
      await connect(ownerPage);
      await ownerPage.getByRole('button', { name: voiceChannel.name, exact: true }).click();
      await ownerPage.getByRole('button', { name: 'Invite people', exact: true }).click();
      const code = new URL(await ownerPage.getByLabel('INVITE LINK').inputValue()).searchParams.get('invite')!;
      await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

      for (const [page, username] of [[memberPage, member], [viewerPage, viewer]] as const) {
        await connect(page);
        await registerAccount(page, username);
        await page.getByRole('button', { name: 'Join a server', exact: true }).click();
        await page.getByLabel('INVITE LINK OR CODE').fill(code);
        await page.getByRole('button', { name: 'Join server', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Voice Moderation E2E Squad', exact: true })).toBeVisible();
      }
      await memberPage.getByRole('button', { name: voiceChannel.name, exact: true }).click();
      const memberId = await currentUserId(memberPage);

      await ownerPage.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(ownerPage.getByRole('button', { name: 'Leave', exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(viewerPage.getByLabel('1 people connected')).toBeVisible({ timeout: 20_000 });

      await memberPage.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(memberPage.getByRole('button', { name: 'Leave', exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(viewerPage.getByLabel('2 people connected')).toBeVisible({ timeout: 20_000 });

      await ownerPage.getByRole('button', { name: `Mute ${memberId}` }).click();
      await expect(memberPage.getByRole('button', { name: 'Muted by moderator', exact: true })).toBeDisabled({ timeout: 20_000 });

      await ownerPage.getByRole('button', { name: `Disconnect ${memberId}` }).click();
      await expect(memberPage.getByText('You were disconnected by a moderator.', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(memberPage.getByRole('button', { name: 'Join voice', exact: true })).toBeVisible();
      await expect(viewerPage.getByLabel('1 people connected')).toBeVisible({ timeout: 20_000 });
    } finally {
      await Promise.allSettled([
        ownerPage.getByRole('button', { name: 'Leave', exact: true }).click({ timeout: 1_000 }),
        memberPage.getByRole('button', { name: 'Leave', exact: true }).click({ timeout: 1_000 }),
      ]);
      await ownerContext.close();
      await memberContext.close();
      await viewerContext.close();
    }
  });

  test('two authenticated browsers exchange fake-device audio over mediasoup', async ({ browser }) => {
    test.skip(!live, 'set VEXA_INTEGRATION=1 with the API, gateway, media, Postgres and Redis stack running');
    test.skip(live && !(await mediaPortReachable()), 'apps/media (port 3003) is not reachable -- start it with `docker compose up -d media` (see docs/tasks/audio-spike/verification.md)');
    test.setTimeout(90_000);
    const ownerContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    const owner = `e2e-voice-owner-${unique()}`;
    const guest = `e2e-voice-guest-${unique()}`;

    try {
      await connect(ownerPage);
      await registerAccount(ownerPage, owner);
      await ownerPage.getByRole('button', { name: 'Create server', exact: true }).click();
      await ownerPage.getByLabel('SERVER NAME').fill('Voice E2E Squad');
      await ownerPage.getByRole('dialog').getByRole('button', { name: 'Create server', exact: true }).click();
      await expect(ownerPage.getByRole('button', { name: 'Voice E2E Squad', exact: true })).toBeVisible();

      const voiceChannel = await ownerPage.evaluate(async () => {
        const guild = await (await fetch('/api/guilds', { credentials: 'include' })).json();
        const response = await fetch(`/api/guilds/${guild[0].id}/channels`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e-voice', type: 'voice' }) });
        if (!response.ok) throw new Error(`voice channel creation failed (${response.status})`);
        return response.json() as Promise<{ id: string; name: string }>;
      });
      await ownerPage.reload();
      await connect(ownerPage);
      await ownerPage.getByRole('button', { name: voiceChannel.name, exact: true }).click();

      await ownerPage.getByRole('button', { name: 'Invite people', exact: true }).click();
      const code = new URL(await ownerPage.getByLabel('INVITE LINK').inputValue()).searchParams.get('invite')!;
      await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

      await connect(guestPage);
      await registerAccount(guestPage, guest);
      await guestPage.getByRole('button', { name: 'Join a server', exact: true }).click();
      await guestPage.getByLabel('INVITE LINK OR CODE').fill(code);
      await guestPage.getByRole('button', { name: 'Join server', exact: true }).click();
      await expect(guestPage.getByRole('button', { name: 'Voice E2E Squad', exact: true })).toBeVisible();
      await guestPage.getByRole('button', { name: voiceChannel.name, exact: true }).click();

      await ownerPage.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(ownerPage.getByRole('button', { name: 'Leave', exact: true })).toBeVisible({ timeout: 20_000 });
      await guestPage.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(guestPage.getByRole('button', { name: 'Leave', exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(ownerPage.getByText('CONNECTED — 2', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(guestPage.getByText('CONNECTED — 2', { exact: true })).toBeVisible({ timeout: 20_000 });

      await expect.poll(async () => (await inboundAudioStats(guestPage)).some(stat => stat.packetsReceived > 0 && stat.bytesReceived > 0), { timeout: 15_000, message: 'guest should receive real inbound audio RTP from the owner fake microphone' }).toBe(true);
    } finally {
      await Promise.allSettled([
        ownerPage.getByRole('button', { name: 'Leave', exact: true }).click({ timeout: 1_000 }),
        guestPage.getByRole('button', { name: 'Leave', exact: true }).click({ timeout: 1_000 }),
      ]);
      await ownerContext.close();
      await guestContext.close();
    }
  });

  test('a microphone-denied browser joins listen-only and receives fake-device audio', async ({ browser }) => {
    test.skip(!live, 'set VEXA_INTEGRATION=1 with the API, gateway, media, Postgres and Redis stack running');
    test.skip(live && !(await mediaPortReachable()), 'apps/media (port 3003) is not reachable -- start it with `docker compose up -d media` (see docs/tasks/audio-spike/verification.md)');
    test.setTimeout(90_000);
    const ownerContext = await browser.newContext();
    const guestContext = await browser.newContext();
    // Keep the owner on Chromium's fake microphone, but simulate a real
    // permission denial for the listener after the app has loaded.
    await guestContext.addInitScript(() => {
      const mediaDevices = navigator.mediaDevices;
      Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) });
    });
    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    const owner = `e2e-voice-owner-${unique()}`;
    const guest = `e2e-voice-guest-${unique()}`;

    try {
      await connect(ownerPage);
      await registerAccount(ownerPage, owner);
      await ownerPage.getByRole('button', { name: 'Create server', exact: true }).click();
      await ownerPage.getByLabel('SERVER NAME').fill('Voice E2E Squad');
      await ownerPage.getByRole('dialog').getByRole('button', { name: 'Create server', exact: true }).click();
      await expect(ownerPage.getByRole('button', { name: 'Voice E2E Squad', exact: true })).toBeVisible();

      const voiceChannel = await ownerPage.evaluate(async () => {
        const guild = await (await fetch('/api/guilds', { credentials: 'include' })).json();
        const response = await fetch(`/api/guilds/${guild[0].id}/channels`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e-voice', type: 'voice' }) });
        if (!response.ok) throw new Error(`voice channel creation failed (${response.status})`);
        return response.json() as Promise<{ id: string; name: string }>;
      });
      await ownerPage.reload();
      await connect(ownerPage);
      await ownerPage.getByRole('button', { name: voiceChannel.name, exact: true }).click();

      await ownerPage.getByRole('button', { name: 'Invite people', exact: true }).click();
      const code = new URL(await ownerPage.getByLabel('INVITE LINK').inputValue()).searchParams.get('invite')!;
      await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

      await connect(guestPage);
      await registerAccount(guestPage, guest);
      await guestPage.getByRole('button', { name: 'Join a server', exact: true }).click();
      await guestPage.getByLabel('INVITE LINK OR CODE').fill(code);
      await guestPage.getByRole('button', { name: 'Join server', exact: true }).click();
      await expect(guestPage.getByRole('button', { name: 'Voice E2E Squad', exact: true })).toBeVisible();
      await guestPage.getByRole('button', { name: voiceChannel.name, exact: true }).click();

      await ownerPage.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(ownerPage.getByRole('button', { name: 'Leave', exact: true })).toBeVisible({ timeout: 20_000 });
      await guestPage.getByRole('button', { name: 'Join voice', exact: true }).click();
      await expect(guestPage.getByRole('button', { name: 'Leave', exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(guestPage.getByText('Microphone unavailable — you can still listen.', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(ownerPage.getByText('CONNECTED — 2', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(guestPage.getByText('CONNECTED — 2', { exact: true })).toBeVisible({ timeout: 20_000 });

      await expect.poll(async () => (await inboundAudioStats(guestPage)).some(stat => stat.packetsReceived > 0 && stat.bytesReceived > 0), { timeout: 15_000, message: 'guest should receive real inbound audio RTP from the owner fake microphone' }).toBe(true);
    } finally {
      await Promise.allSettled([
        ownerPage.getByRole('button', { name: 'Leave', exact: true }).click({ timeout: 1_000 }),
        guestPage.getByRole('button', { name: 'Leave', exact: true }).click({ timeout: 1_000 }),
      ]);
      await ownerContext.close();
      await guestContext.close();
    }
  });
});
