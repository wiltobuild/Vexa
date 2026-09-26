import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test(
  "profiles, transcript ownership/expiry and transactional message outbox",
  { skip: process.env.VEXA_INTEGRATION !== "1", timeout: 30000 },
  async () => {
    const { db, redis } = await import("@vexa/api/db");
    const api = process.env.API_URL ?? "http://localhost:3001",
      origin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
    async function register() {
      const response = await fetch(api + "/auth/register", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "recall-" + randomUUID().slice(0, 8),
          email: randomUUID() + "@example.com",
          password: "integration-password-123",
        }),
      });
      assert.equal(response.status, 201);
      return {
        ...((await response.json()) as { id: string; username: string }),
        cookie: response.headers.get("set-cookie")!.split(";")[0],
      };
    }
    const client = await db.connect();
    try {
      const alice = await register(),
        bob = await register();
      const request = (
        path: string,
        method = "GET",
        body?: unknown,
        cookie = alice.cookie,
      ) =>
        fetch(api + path, {
          method,
          headers: {
            Origin: origin,
            Cookie: cookie,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      assert.equal(
        (
          await request("/me", "PATCH", {
            avatar: "vexa:8:123",
            bio: "Squad captain",
          })
        ).status,
        200,
      );
      assert.equal(
        ((await (await request("/me")).json()) as { avatar_url: string })
          .avatar_url,
        "vexa:8:123",
      );
      assert.equal(
        (
          await request("/me", "PATCH", {
            avatar: "https://untrusted.invalid/image.svg",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/me", "PATCH", {
            avatar: "vexa:8:123",
            userId: bob.id,
          })
        ).status,
        400,
      );
      await db.query(
        "INSERT INTO personal_transcripts(id,user_id,text,segments,created_at) VALUES($1,$1,'Private callout','[]',now()),($2,$1,'Expired note','[]',now()-interval '31 days')",
        [alice.id, bob.id],
      );
      assert.deepEqual(
        (
          (await (await request("/me/transcriptions")).json()) as {
            text: string;
          }[]
        ).map((r) => r.text),
        ["Private callout"],
      );
      assert.deepEqual(
        await (
          await request("/me/transcriptions", "GET", undefined, bob.cookie)
        ).json(),
        [],
      );
      assert.equal(
        (
          await request(
            "/me/transcriptions/" + alice.id,
            "DELETE",
            undefined,
            bob.cookie,
          )
        ).status,
        404,
      );
      assert.equal(
        (await request("/me/transcriptions/" + alice.id, "DELETE")).status,
        204,
      );
      assert.equal((await fetch(api + "/me/transcriptions")).status, 401);

      const guild = (await (
        await request("/guilds", "POST", { name: "Durable delivery" })
      ).json()) as { channelId: string };
      // Hold the publisher lock: writes must still commit and return success without Redis delivery.
      await client.query("SELECT pg_advisory_lock(8675309)");
      const response = await request(
        `/channels/${guild.channelId}/messages`,
        "POST",
        { content: "Durable hello", nonce: randomUUID() },
      );
      assert.equal(response.status, 201);
      const message = (await response.json()) as { id: string };
      await request(
        `/channels/${guild.channelId}/messages/${message.id}`,
        "PATCH",
        { content: "Durable edit" },
      );
      await request(
        `/channels/${guild.channelId}/messages/${message.id}`,
        "DELETE",
      );
      const { rows } = await client.query(
        "SELECT event_type,payload FROM message_outbox WHERE channel_id=$1 ORDER BY id",
        [guild.channelId],
      );
      assert.deepEqual(
        rows.map((r) => r.event_type),
        ["message.create", "message.update", "message.delete"],
      );
      assert.equal(rows[0].payload.id, message.id);
      assert.equal(rows[0].payload.avatar_url, "vexa:8:123");
      await client.query("SELECT pg_advisory_unlock(8675309)");
      const deadline = Date.now() + 7000;
      let count = 3;
      while (count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        count = Number(
          (
            await client.query(
              "SELECT count(*) FROM message_outbox WHERE channel_id=$1",
              [guild.channelId],
            )
          ).rows[0].count,
        );
      }
      assert.equal(
        count,
        0,
        "publisher drains the durable queue once the lock is released",
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock_all()");
      client.release();
      await db.end();
      redis.disconnect();
    }
  },
);
