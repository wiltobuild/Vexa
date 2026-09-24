import { test, expect, type Page } from '@playwright/test';
// These drive the real ConnectedWorkspace (accounts, Postgres, gateway) through the browser, not
// the local demo store — unlike workspace.spec.ts. They require the API, gateway, Postgres and
// Redis to be running (set VEXA_INTEGRATION=1; see docs/BACKEND.md). CI starts that stack before
// running this suite; skip locally unless you've done the same.
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
 // The "Checking your session…" status is transient (the /me probe often resolves before we'd
 // ever observe it) — wait for the sign-in form itself instead of that fleeting status text.
 await page.getByRole('button', { name: 'New here? Create an account', exact: true }).click();
 await page.getByLabel('USERNAME').fill(username);
 await page.getByLabel('EMAIL').fill(`${username}@example.com`);
 await page.getByLabel('PASSWORD').fill('long-e2e-test-password-1!');
 await page.getByRole('button', { name: 'Create account', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Create server', exact: true })).toBeVisible();
}

test.describe('connected workspace (real backend)', () => {
 test('registers, creates a server, sends a message, and keeps it after reload', async ({ page }) => {
  test.skip(!live, 'set VEXA_INTEGRATION=1 with the API/gateway/Postgres/Redis stack running');
  const username = `e2e-${unique()}`;
  await connect(page);
  await registerAccount(page, username);
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await page.getByLabel('SERVER NAME').fill('E2E Squad');
  await page.getByRole('dialog').getByRole('button', { name: 'Create server', exact: true }).click();
  await expect(page.getByRole('button', { name: 'E2E Squad', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello from Playwright');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Hello from Playwright', { exact: true })).toBeVisible();
  await page.reload();
  await connect(page);
  await expect(page.getByRole('button', { name: 'E2E Squad', exact: true })).toBeVisible();
  await expect(page.getByText('Hello from Playwright', { exact: true })).toBeVisible();
 });

 test('an invite lets a second account join and see live messages', async ({ page, browser }) => {
  test.skip(!live, 'set VEXA_INTEGRATION=1 with the API/gateway/Postgres/Redis stack running');
  const owner = `e2e-owner-${unique()}`, guest = `e2e-guest-${unique()}`;
  await connect(page);
  await registerAccount(page, owner);
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await page.getByLabel('SERVER NAME').fill('Invite Squad');
  await page.getByRole('dialog').getByRole('button', { name: 'Create server', exact: true }).click();
  await page.getByRole('button', { name: 'Invite people', exact: true }).click();
  const link = await page.getByLabel('INVITE LINK').inputValue();
  const code = new URL(link).searchParams.get('invite')!;
  expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  try {
   await connect(guestPage);
   await registerAccount(guestPage, guest);
   await guestPage.getByRole('button', { name: 'Join a server', exact: true }).click();
   await guestPage.getByLabel('INVITE LINK OR CODE').fill(code);
   await guestPage.getByRole('button', { name: 'Join server', exact: true }).click();
   await expect(guestPage.getByRole('button', { name: 'Invite Squad', exact: true })).toBeVisible();

   await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Welcome to the squad');
   await page.getByRole('button', { name: 'Send message', exact: true }).click();
   await expect(guestPage.getByText('Welcome to the squad', { exact: true })).toBeVisible({ timeout: 10000 });
  } finally {
   await guestContext.close();
  }
 });

 test('a friend request, once accepted, opens a DM with live delivery', async ({ page, browser }) => {
  test.skip(!live, 'set VEXA_INTEGRATION=1 with the API/gateway/Postgres/Redis stack running');
  const alice = `e2e-alice-${unique()}`, bob = `e2e-bob-${unique()}`;
  await connect(page);
  await registerAccount(page, alice);

  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  try {
   await connect(bobPage);
   await registerAccount(bobPage, bob);

   await page.getByRole('button', { name: 'Friends and direct messages', exact: true }).click();
   await page.getByPlaceholder('Add a friend by username').fill(bob);
   await page.getByRole('button', { name: 'Send', exact: true }).click();
   await expect(page.getByText('Request sent', { exact: true })).toBeVisible();

   await bobPage.getByRole('button', { name: 'Friends and direct messages', exact: true }).click();
   await expect(bobPage.getByText('Wants to be friends', { exact: true })).toBeVisible();
   await bobPage.getByRole('button', { name: `Accept ${alice}'s request`, exact: true }).click();
   await expect(bobPage.getByText('Friend', { exact: true })).toBeVisible();

   // Friend/DM state isn't pushed over the gateway (only messages are) — reload to refetch it.
   await page.reload();
   await connect(page);
   await page.getByRole('button', { name: 'Friends and direct messages', exact: true }).click();
   await expect(page.getByText(bob, { exact: true })).toBeVisible();
   await page.getByRole('button', { name: `Message ${bob}`, exact: true }).click();
   await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hi from Playwright DM');
   await page.getByRole('button', { name: 'Send message', exact: true }).click();
   await expect(page.getByText('Hi from Playwright DM', { exact: true })).toBeVisible();

   await bobPage.reload();
   await connect(bobPage);
   await bobPage.getByRole('button', { name: 'Friends and direct messages', exact: true }).click();
   await bobPage.getByRole('button', { name: alice, exact: true }).click();
   await expect(bobPage.getByText('Hi from Playwright DM', { exact: true })).toBeVisible();

   await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Second DM message, live');
   await page.getByRole('button', { name: 'Send message', exact: true }).click();
   await expect(bobPage.getByText('Second DM message, live', { exact: true })).toBeVisible({ timeout: 10000 });
  } finally {
   await bobContext.close();
  }
 });
});
