import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { flushOutbox } from "./outbox.js";
test("outbox rolls back a failed publish and retries the pending batch in order", async () => {
  let pending = [
    {
      id: "1",
      event_type: "message.create",
      channel_id: "10",
      payload: { id: "100" },
    },
    {
      id: "2",
      event_type: "message.update",
      channel_id: "10",
      payload: { id: "100" },
    },
  ];
  let transaction = structuredClone(pending);
  let releases = 0;
  const pool = {
    connect: async () => ({
      query: async (sql: string, args?: string[]) => {
        if (sql === "BEGIN") transaction = structuredClone(pending);
        if (sql.includes("pg_try_advisory"))
          return { rows: [{ acquired: true }] };
        if (sql.startsWith("SELECT id"))
          return { rows: structuredClone(transaction) };
        if (sql.startsWith("DELETE"))
          transaction = transaction.filter((e) => e.id !== args![0]);
        if (sql === "COMMIT") pending = transaction;
        return { rows: [] };
      },
      release: () => {
        releases++;
      },
    }),
  } as unknown as Pool;
  const seen: string[] = [];
  await assert.rejects(
    flushOutbox(pool, async (type) => {
      seen.push(type);
      throw new Error("Redis down");
    }),
  );
  assert.equal(pending.length, 2);
  await flushOutbox(pool, async (type) => {
    seen.push(type);
  });
  assert.deepEqual(seen, [
    "message.create",
    "message.create",
    "message.update",
  ]);
  assert.equal(pending.length, 0);
  assert.equal(releases, 2);
});
test("outbox leaves delivery to the other API instance when the lock is held", async () => {
  const queries: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ acquired: false }] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  assert.equal(
    await flushOutbox(pool, async () => {
      assert.fail("Must not publish");
    }),
    0,
  );
  assert.deepEqual(queries, [
    "BEGIN",
    "SELECT pg_try_advisory_xact_lock(8675309) AS acquired",
    "ROLLBACK",
  ]);
});
