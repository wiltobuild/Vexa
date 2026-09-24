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
 await expect(page.getByRole('status')).toHaveText('Checking your session…');
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
});
