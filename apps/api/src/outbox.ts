import type { Pool } from "pg";

// A database trigger writes events in the same transaction as each message mutation.
// The advisory lock gives concurrent API instances one ordered publisher. Failed batches
// roll back; already-published events can be delivered again and clients reconcile by ID.
export async function flushOutbox(
  pool: Pool,
  publish: (type: string, channelId: string, data: unknown) => Promise<void>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      rows: [lock],
    } = await client.query(
      "SELECT pg_try_advisory_xact_lock(8675309) AS acquired",
    );
    if (!lock.acquired) {
      await client.query("ROLLBACK");
      return 0;
    }
    const { rows } = await client.query(
      "SELECT id,event_type,channel_id,payload FROM message_outbox ORDER BY id LIMIT 100 FOR UPDATE",
    );
    for (const event of rows) {
      await publish(event.event_type, event.channel_id, event.payload);
      await client.query("DELETE FROM message_outbox WHERE id=$1", [event.id]);
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
