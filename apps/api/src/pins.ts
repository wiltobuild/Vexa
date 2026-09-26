import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Permission, hasPermission, snowflakeSchema } from '@vexa/shared';
import { db, requireChannel } from './db.js';

const channelParams=z.object({channelId:snowflakeSchema});
const pinParams=channelParams.extend({messageId:snowflakeSchema});
const canPin=(bits:bigint,type:string)=>hasPermission(bits,Permission.SEND_MESSAGES)&&(['dm','group_dm'].includes(type)||hasPermission(bits,Permission.MANAGE_MESSAGES));

export function registerPins(app:FastifyInstance){
 app.get('/channels/:channelId/pins',async req=>{
  const {channelId}=channelParams.parse(req.params);
  const {bits,channel}=await requireChannel(req.userId,channelId);
  const {rows}=await db.query(`SELECT m.*,u.username,u.avatar_url,p.created_at AS pinned_at
   FROM message_pins p JOIN messages m ON m.id=p.message_id JOIN users u ON u.id=m.author_id
   WHERE m.channel_id=$1 ORDER BY p.created_at DESC,m.id DESC LIMIT 50`,[channelId]);
  return {messages:rows,canManage:canPin(bits,channel.type)};
 });
 for(const method of ['PUT','DELETE'] as const)app.route({method,url:'/channels/:channelId/pins/:messageId',handler:async(req,reply)=>{
  const {channelId,messageId}=pinParams.parse(req.params);
  const {bits,channel}=await requireChannel(req.userId,channelId);
  if(!canPin(bits,channel.type))return reply.code(403).send({error:'Pinning requires permission to send and manage messages'});
  const client=await db.connect();
  try{
   await client.query('BEGIN');
   // Serialize pin changes per channel so concurrent inserts cannot exceed the cap.
   await client.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE',[channelId]);
   const message=await client.query('SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2 FOR KEY SHARE',[messageId,channelId]);
   if(!message.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Message not found'});}
   if(method==='PUT'){
    const existing=await client.query('SELECT 1 FROM message_pins WHERE message_id=$1',[messageId]);
    if(!existing.rowCount){
     const {rows:[count]}=await client.query('SELECT count(*)::int AS total FROM message_pins p JOIN messages m ON m.id=p.message_id WHERE m.channel_id=$1',[channelId]);
     if(count.total>=50){await client.query('ROLLBACK');return reply.code(409).send({error:'This conversation has 50 pins. Unpin a message first.'});}
     await client.query('INSERT INTO message_pins(message_id,pinned_by) VALUES($1,$2)',[messageId,req.userId]);
    }
   }else await client.query('DELETE FROM message_pins WHERE message_id=$1',[messageId]);
   await client.query('COMMIT');return reply.code(204).send();
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }});
}
