import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});
test("on-device Whisper transcribes real audio without an API", async ({
  page,
}) => {
  test.skip(
    !process.env.VEXA_LOCAL_WHISPER_AUDIO,
    "Set VEXA_LOCAL_WHISPER_AUDIO to a spoken English WAV fixture to download and test the real model.",
  );
  test.setTimeout(300000);
  await page.getByRole("button", { name: /Voice history/ }).click();
  await page
    .getByRole("button", { name: "Try my microphone", exact: true })
    .click();
  await page.getByRole("checkbox").check();
  await page
    .getByLabel("Upload audio", { exact: true })
    .setInputFiles(process.env.VEXA_LOCAL_WHISPER_AUDIO!);
  await expect(
    page.locator(".transcript-line, .recall-error").first(),
  ).toBeVisible({ timeout: 280000 });
  await expect(page.locator(".recall-error")).toHaveCount(0);
  await expect(page.locator(".transcript-lines")).toContainText(
    /squad|objective/i,
  );
});
test("recording consent withdrawal and leaving Recall stop microphone tracks", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        const audio = new AudioContext(),
          destination = audio.createMediaStreamDestination();
        const oscillator = audio.createOscillator();
        oscillator.connect(destination);
        oscillator.start();
        (window as any).testStream = destination.stream;
        return destination.stream;
      },
    });
  });
  await page.reload();
  await page.getByRole("button", { name: /Voice history/ }).click();
  await page
    .getByRole("button", { name: "Try my microphone", exact: true })
    .click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Record voice note" }).click();
  await expect(
    page.getByRole("button", { name: /Stop & transcribe/ }),
  ).toBeVisible();
  await page.getByRole("checkbox").uncheck();
  expect(
    await page.evaluate(() =>
      (window as any).testStream
        .getTracks()
        .every((t: MediaStreamTrack) => t.readyState === "ended"),
    ),
  ).toBe(true);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Record voice note" }).click();
  await expect(
    page.getByRole("button", { name: /Stop & transcribe/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "general", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).testStream
        .getTracks()
        .every((t: MediaStreamTrack) => t.readyState === "ended"),
    ),
  ).toBe(true);
});
test("all sample members have distinct characters and avatar changes survive reload", async ({
  page,
}) => {
  const avatars = await page
    .locator(".members-sidebar .avatar-art")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-avatar")));
  expect(avatars.length).toBe(9);
  expect(new Set(avatars).size).toBe(9);
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page.getByRole("button", { name: "Lunar bat", exact: true }).click();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Your profile" }).getByRole("img"),
  ).toHaveAttribute("aria-label", "Lunar bat avatar");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Your profile" }).getByRole("img"),
  ).toHaveAttribute("aria-label", "Lunar bat avatar");
});
test("sample replay, search, download and mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle channels" }).click();
  await page.getByRole("button", { name: /Voice history/ }).click();
  await page.getByRole("button", { name: "Sample showcase", exact: true }).click();
  await page.getByRole("button", { name: "Replay transcription demo" }).click();
  await expect(page.locator(".transcript-line")).toHaveCount(5, {
    timeout: 10000,
  });
  await page.getByLabel("Search transcript").fill("rotate");
  await expect(page.locator(".transcript-line")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("vexa-recall-sample.txt");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("connected profile and Recall upload, history and deletion with API fixtures", async ({
  page,
}) => {
  let avatar = "vexa:0:123";
  let records: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    let data: unknown = [];
    if (path === "/api/me") {
      if (req.method() === "PATCH") avatar = req.postDataJSON().avatar;
      data = { id: "123", username: "tester", avatar_url: avatar };
    } else if (path === "/api/me/transcriptions/status")
      data = { available: true };
    else if (path === "/api/me/transcriptions") {
      if (req.method() === "POST") {
        expect(req.headers()["x-vexa-consent"]).toBe(
          "microphone-transcription",
        );
        data = {
          id: "456",
          text: "Hold the objective.",
          segments: [{ start: 0, end: 2, text: "Hold the objective." }],
          created_at: new Date().toISOString(),
        };
        records = [data];
      } else data = records;
    } else if (path === "/api/me/transcriptions/456") {
      records = [];
      await route.fulfill({ status: 204 });
      return;
    } else if (path === "/api/relationships")
      data = { friends: [], incoming: [], outgoing: [], blocked: [] };
    await route.fulfill({ status: 200, json: data });
  });
  await page.getByRole("button", { name: "Connect account" }).click();
  await page.getByRole("button", { name: "Open connected workspace" }).click();
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page.getByRole("button", { name: "Nova squid", exact: true }).click();
  await page.getByRole("button", { name: "Save profile" }).click();
  expect(avatar).toBe("vexa:8:123");
  await page.getByRole("button", { name: "Voice Recall", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voice note" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page
    .getByLabel("Upload audio", { exact: true })
    .setInputFiles({
      name: "note.wav",
      mimeType: "audio/wav",
      buffer: Buffer.from("RIFF0000WAVEaudio-data"),
    });
  await expect(page.locator(".transcript-line")).toContainText(
    "Hold the objective.",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Voice Recall", exact: true }).click();
  await expect(page.locator(".transcript-line")).toContainText(
    "Hold the objective.",
  );
  await page.getByRole("button", { name: "Delete transcript" }).click();
  await expect(
    page.getByText("Your transcript will appear here."),
  ).toBeVisible();
});
