import { test, expect, type Page } from '@playwright/test';

// This is intentionally gated like connected.spec.ts: it uses the real API,
// gateway, media service, Postgres, and Redis rather than mocked endpoints.
const live = process.env.VEXA_INTEGRATION === '1';
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

test.describe('voice audio (real backend and native Chromium media)', () => {
  test('two authenticated browsers exchange fake-device audio over mediasoup', async ({ browser }) => {
    test.skip(!live, 'set VEXA_INTEGRATION=1 with the API, gateway, media, Postgres and Redis stack running');
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
});
