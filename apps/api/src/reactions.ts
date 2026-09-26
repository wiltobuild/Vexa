import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Permission, snowflakeSchema } from '@vexa/shared';
import { db, requireChannel } from './db.js';

const emojiSchema = z.enum(['💜', '🔥', '🎮', '👀', '✨', '😂', '🙌', '🚀', '❤️', '👍', '⚡', '🎉']);
const channelParams = z.object({ channelId: snowflakeSchema });
const reactionParams = channelParams.extend({ messageId: snowflakeSchema, emoji: emojiSchema });

export function registerReactions(app: FastifyInstance) {
  // Fetch only the messages on screen/history, in bounded batches. Never expose reactor IDs.
  app.get('/channels/:channelId/reactions', async req => {
    const { channelId } = channelParams.parse(req.params);
    await requireChannel(req.userId, channelId);
    const { messages } = z.object({ messages: z.string().max(2100).transform(v => v.split(',')).pipe(z.array(snowflakeSchema).min(1).max(100)) }).parse(req.query);
    return (await db.query(`SELECT r.message_id,r.emoji,count(*)::int AS count,bool_or(r.user_id=$3) AS reacted
      FROM reactions r JOIN messages m ON m.id=r.message_id
      WHERE m.channel_id=$1 AND m.id=ANY($2::bigint[])
      GROUP BY r.message_id,r.emoji ORDER BY r.message_id,r.emoji`, [channelId, messages, req.userId])).rows;
  });

  for (const method of ['PUT', 'DELETE'] as const) {
    app.route({ method, url: '/channels/:channelId/messages/:messageId/reactions/:emoji', handler: async (req, reply) => {
      const { channelId, messageId, emoji } = reactionParams.parse(req.params);
      await requireChannel(req.userId, channelId, Permission.SEND_MESSAGES);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Keep the message alive until the reaction and its outbox event have committed.
        const message = await client.query('SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2 FOR KEY SHARE', [messageId, channelId]);
        if (!message.rowCount) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Message not found' }); }
        if (method === 'PUT') await client.query('INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [messageId, req.userId, emoji]);
        else await client.query('DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [messageId, req.userId, emoji]);
        await client.query('COMMIT');
        return reply.code(204).send();
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }});
  }
}
