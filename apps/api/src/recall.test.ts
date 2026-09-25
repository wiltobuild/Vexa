import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRecall, MAX_AUDIO_BYTES, type Transcript } from "./recall.js";

async function setup(options: { key?: string; provider?: typeof fetch } = {}) {
  const app = Fastify();
  const saved = new Map<string, { owner: string; record: Transcript }>();
  let calls = 0;
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req, reply) => {
    const owner = req.headers["x-test-user"];
    if (!owner) return reply.code(401).send({ error: "Sign in required" });
    req.userId = String(owner);
  });
  await registerRecall(app, {
    key: () => options.key,
    nextId: () => String(saved.size + 1),
    save: async (owner, record) => {
      saved.set(record.id, { owner, record });
    },
    list: async (owner) =>
      [...saved.values()].filter((r) => r.owner === owner).map((r) => r.record),
    remove: async (owner, id) =>
      saved.get(id)?.owner === owner && saved.delete(id),
    fetch: async (...args) => {
      calls++;
      if (options.provider) return options.provider(...args);
      const init = args[1]!;
      assert.equal(
        init.headers && new Headers(init.headers).get("Authorization"),
        "Bearer test-key",
      );
      const form = init.body as FormData;
      assert.equal(form.get("model"), "whisper-1");
      assert.equal(form.get("response_format"), "verbose_json");
      assert.equal((form.get("file") as File).name, "recording.wav");
      return Response.json({
        text: "Rotate together.",
        duration: 2,
        segments: [{ start: 0, end: 2, text: "Rotate together." }],
      });
    },
  });
  await app.ready();
  return { app, saved, calls: () => calls };
}
function upload(bytes = Buffer.from("RIFF0000WAVEaudio-data"), consent = true) {
  const boundary = "vexa-test-boundary";
  return {
    method: "POST" as const,
    url: "/me/transcriptions",
    headers: {
      "x-test-user": "alice",
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(consent ? { "x-vexa-consent": "microphone-transcription" } : {}),
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="test.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
test("Whisper receives validated audio and private history is owner-scoped", async (t) => {
  const { app, calls } = await setup({ key: "test-key" });
  t.after(() => app.close());
  assert.equal(
    (await app.inject({ url: "/me/transcriptions" })).statusCode,
    401,
  );
  const response = await app.inject(upload());
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().text, "Rotate together.");
  assert.equal(calls(), 1);
  const get = (owner: string) =>
    app.inject({
      url: "/me/transcriptions",
      headers: { "x-test-user": owner },
    });
  assert.equal((await get("alice")).json().length, 1);
  assert.equal((await get("bob")).json().length, 0);
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/me/transcriptions/1",
        headers: { "x-test-user": "bob" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/me/transcriptions/1",
        headers: { "x-test-user": "alice" },
      })
    ).statusCode,
    204,
  );
  assert.equal((await get("alice")).json().length, 0);
});
test("consent, signature and size failures never reach the provider", async (t) => {
  const { app, calls } = await setup({ key: "test-key" });
  t.after(() => app.close());
  assert.equal((await app.inject(upload(undefined, false))).statusCode, 400);
  assert.equal(
    (await app.inject(upload(Buffer.from("<script>not audio</script>"))))
      .statusCode,
    415,
  );
  assert.equal(
    (await app.inject(upload(Buffer.alloc(MAX_AUDIO_BYTES + 1)))).statusCode,
    413,
  );
  assert.equal(calls(), 0);
});
test("missing configuration and provider failures are actionable and do not save", async (t) => {
  const a = await setup();
  t.after(() => a.app.close());
  assert.equal((await a.app.inject(upload())).statusCode, 503);
  assert.equal(a.calls(), 0);
  const b = await setup({
    key: "test-key",
    provider: async () =>
      new Response("sensitive provider details", { status: 500 }),
  });
  t.after(() => b.app.close());
  const failed = await b.app.inject(upload());
  assert.equal(failed.statusCode, 502);
  assert.ok(!failed.body.includes("sensitive"));
  assert.equal(b.saved.size, 0);
  const c = await setup({
    key: "test-key",
    provider: async () => Response.json({ text: "", duration: 2 }),
  });
  t.after(() => c.app.close());
  assert.equal((await c.app.inject(upload())).statusCode, 422);
  assert.equal(c.saved.size, 0);
});
test("one in-flight transcription per account, releases after completion", async (t) => {
  let finish!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { app } = await setup({
    key: "test-key",
    provider: () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  t.after(() => app.close());
  const pending = app.inject(upload());
  await ready;
  assert.equal((await app.inject(upload())).statusCode, 429);
  finish(Response.json({ text: "Hello", duration: 1, segments: [] }));
  assert.equal((await pending).statusCode, 201);
});
