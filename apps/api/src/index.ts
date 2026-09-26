import {registerReactions} from './reactions.js';
import {flushOutbox} from './outbox.js';
import {registerRecall} from './recall.js';
import Fastify from 'fastify';import cookie from '@fastify/cookie';import cors from '@fastify/cors';import rateLimit from '@fastify/rate-limit';import argon2 from 'argon2';import {randomBytes,createHash} from 'node:crypto';import {z,ZodError} from 'zod';
import {Snowflake,registerSchema,credentialsSchema,guildSchema,channelSchema,messageSchema,editMessageSchema,snowflakeSchema,DEFAULT_PERMISSIONS,Permission,hasPermission,roleCreateSchema,roleUpdateSchema,banSchema,timeoutSchema,friendRequestSchema,dmCreateSchema} from '@vexa/shared';import {db,redis,requireChannel,requireGuild,publish} from './db.js';
declare module 'fastify' {interface FastifyRequest {userId:string}}
// trustProxy: behind a reverse proxy/CDN (Vercel, Fly, Render, nginx), req.ip is otherwise the
// proxy's own IP for every request, collapsing the per-IP rate limiter into one shared bucket
// for all users. Set TRUST_PROXY to a specific hop count/CIDR list in production if the default
// (trust the whole X-Forwarded-For chain) is too permissive for your deployment topology.
const app=Fastify({logger:true,bodyLimit:32768,trustProxy:process.env.TRUST_PROXY!=='false'});const ids=new Snowflake(Number(process.env.WORKER_ID??1));const origin=process.env.WEB_ORIGIN??'http://localhost:5173';
await app.register(cookie);await app.register(cors,{origin,credentials:true});await app.register(rateLimit,{redis,max:Number(process.env.API_RATE_LIMIT_MAX??120),timeWindow:'1 minute'});
app.decorateRequest('userId','');
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
app.addHook('onRequest',async(req,reply)=>{
 if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin!==origin)return reply.code(403).send({error:'Invalid request origin'});
 if(req.url==='/health'||req.url.startsWith('/auth/')||req.method==='OPTIONS')return;
 const token=req.cookies.vexa_session;if(!token)return reply.code(401).send({error:'Sign in required'});
 const {rows:[session]}=await db.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()',[hash(token)]);if(!session)return reply.code(401).send({error:'Session expired'});req.userId=session.user_id;
});
app.setErrorHandler((error,req,reply)=>{if(error instanceof ZodError)return reply.code(400).send({error:'Invalid request',issues:error.issues});const e=error as Error&{code?:string;statusCode?:number};if(e.code==='23505')return reply.code(409).send({error:'Already exists'});if(e.code==='23503')return reply.code(400).send({error:'Referenced resource does not exist'});if(e.statusCode&&e.statusCode<500)return reply.code(e.statusCode).send({error:e.message});req.log.error(error);return reply.code(503).send({error:'Service temporarily unavailable'});});
async function createSession(userId:string,reply:import('fastify').FastifyReply){const token=randomBytes(32).toString('hex');await db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '30 days')",[hash(token),userId]);reply.setCookie('vexa_session',token,{path:'/',httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:2592000});}
const params=(value:unknown,key:string)=>snowflakeSchema.parse((value as Record<string,unknown>)[key]);
registerReactions(app);
app.get('/health',async()=>{await db.query('SELECT 1');await redis.ping();return {ok:true};});
// Default stays a strict 5/min against credential-stuffing/account-farming; override only for a
// test harness that legitimately registers many accounts back to back (see ci.yml).
app.post('/auth/register',{config:{rateLimit:{max:Number(process.env.AUTH_REGISTER_RATE_LIMIT_MAX??5),timeWindow:'1 minute'}}},async(req,reply)=>{const body=registerSchema.parse(req.body);const id=ids.next();await db.query('INSERT INTO users(id,email,username,password_hash) VALUES($1,$2,$3,$4)',[id,body.email,body.username,await argon2.hash(body.password,{type:argon2.argon2id})]);await createSession(id,reply);return reply.code(201).send({id,username:body.username,email:body.email});});
app.post('/auth/login',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{const body=credentialsSchema.parse(req.body);const {rows:[user]}=await db.query('SELECT * FROM users WHERE email=$1',[body.email]);if(!user||!await argon2.verify(user.password_hash,body.password))return reply.code(401).send({error:'Invalid credentials'});await createSession(user.id,reply);return {id:user.id,username:user.username,email:user.email,avatar_url:user.avatar_url,bio:user.bio};});
app.post('/auth/logout',async(req,reply)=>{if(req.cookies.vexa_session)await db.query('DELETE FROM sessions WHERE token_hash=$1',[hash(req.cookies.vexa_session)]);reply.clearCookie('vexa_session',{path:'/'});return {ok:true};});
app.get('/me',async(req)=>{const {rows:[user]}=await db.query('SELECT id,username,email,avatar_url,bio FROM users WHERE id=$1',[req.userId]);return user;});
app.patch('/me',async(req)=>{const body=z.object({avatar:z.string().regex(/^vexa:(\d|1[01]):\d{1,10}$/),bio:z.string().trim().max(160).default('')}).strict().parse(req.body);const {rows:[user]}=await db.query('UPDATE users SET avatar_url=$1,bio=$2 WHERE id=$3 RETURNING id,username,email,avatar_url,bio',[body.avatar,body.bio,req.userId]);return user;});
await registerRecall(app,{
 key:()=>process.env.OPENAI_API_KEY,nextId:()=>ids.next(),
 save:async(userId,r)=>{await db.query('INSERT INTO personal_transcripts(id,user_id,text,segments,created_at) VALUES($1,$2,$3,$4,$5)',[r.id,userId,r.text,JSON.stringify(r.segments),r.created_at]);},
 list:async userId=>(await db.query("SELECT id,text,segments,created_at FROM personal_transcripts WHERE user_id=$1 AND created_at>now()-interval '30 days' ORDER BY id DESC LIMIT 100",[userId])).rows,
 remove:async(userId,id)=>!!(await db.query('DELETE FROM personal_transcripts WHERE user_id=$1 AND id=$2',[userId,id])).rowCount
});
const purgeTranscripts=()=>db.query("DELETE FROM personal_transcripts WHERE created_at<=now()-interval '30 days'").catch(error=>app.log.error(error,'Transcript retention cleanup failed'));
await purgeTranscripts();const retentionTimer=setInterval(()=>void purgeTranscripts(),60*60*1000);retentionTimer.unref();app.addHook('onClose',async()=>clearInterval(retentionTimer));
// Relationships are stored as directed rows (user_id -> target_id). A 'pending' row is that
// user's own outgoing request; the other side's incoming request is the same row seen from
// target_id's perspective, so it is never duplicated — only ever queried from the other angle.
app.get('/relationships',async(req)=>{
 const uid=req.userId;
 const [friends,outgoing,incoming,blocked]=await Promise.all([
  db.query("SELECT u.id,u.username,u.avatar_url FROM relationships r JOIN users u ON u.id=r.target_id WHERE r.user_id=$1 AND r.kind='friend' ORDER BY u.username",[uid]),
  db.query("SELECT u.id,u.username,u.avatar_url FROM relationships r JOIN users u ON u.id=r.target_id WHERE r.user_id=$1 AND r.kind='pending' ORDER BY u.username",[uid]),
  db.query("SELECT u.id,u.username,u.avatar_url FROM relationships r JOIN users u ON u.id=r.user_id WHERE r.target_id=$1 AND r.kind='pending' AND NOT EXISTS(SELECT 1 FROM relationships r2 WHERE r2.user_id=$1 AND r2.target_id=r.user_id) ORDER BY u.username",[uid]),
  db.query("SELECT u.id,u.username,u.avatar_url FROM relationships r JOIN users u ON u.id=r.target_id WHERE r.user_id=$1 AND r.kind='blocked' ORDER BY u.username",[uid]),
 ]);
 return {friends:friends.rows,outgoing:outgoing.rows,incoming:incoming.rows,blocked:blocked.rows};
});
app.post('/relationships/requests',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(req,reply)=>{
 const body=friendRequestSchema.parse(req.body);
 const {rows:[target]}=await db.query('SELECT id FROM users WHERE lower(username)=lower($1)',[body.username]);
 if(!target)return reply.code(404).send({error:'No user with that username'});
 if(target.id===req.userId)return reply.code(400).send({error:'You cannot friend yourself'});
 if((await db.query("SELECT 1 FROM relationships WHERE user_id=$1 AND target_id=$2 AND kind='blocked'",[req.userId,target.id])).rowCount)return reply.code(403).send({error:'Unblock this user first'});
 if((await db.query("SELECT 1 FROM relationships WHERE user_id=$1 AND target_id=$2 AND kind='blocked'",[target.id,req.userId])).rowCount)return reply.code(403).send({error:'Cannot send a friend request to this user'});
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  // If they already sent us a pending request, accepting it beats leaving two rows pointing
  // past each other — this call just completes the friendship instead of adding a duplicate.
  const {rowCount:theirs}=await client.query("SELECT 1 FROM relationships WHERE user_id=$1 AND target_id=$2 AND kind='pending' FOR UPDATE",[target.id,req.userId]);
  if(theirs){
   await client.query("UPDATE relationships SET kind='friend' WHERE user_id=$1 AND target_id=$2",[target.id,req.userId]);
   await client.query("INSERT INTO relationships(user_id,target_id,kind) VALUES($1,$2,'friend') ON CONFLICT(user_id,target_id) DO UPDATE SET kind='friend'",[req.userId,target.id]);
   await client.query('COMMIT');
   return {status:'friend',id:target.id};
  }
  await client.query("INSERT INTO relationships(user_id,target_id,kind) VALUES($1,$2,'pending') ON CONFLICT(user_id,target_id) DO UPDATE SET kind='pending'",[req.userId,target.id]);
  await client.query('COMMIT');
  return reply.code(201).send({status:'pending',id:target.id});
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/relationships/:userId/accept',async(req,reply)=>{
 const targetId=params(req.params,'userId');
 const {rowCount}=await db.query("UPDATE relationships SET kind='friend' WHERE user_id=$1 AND target_id=$2 AND kind='pending'",[targetId,req.userId]);
 if(!rowCount)return reply.code(404).send({error:'No pending request from this user'});
 await db.query("INSERT INTO relationships(user_id,target_id,kind) VALUES($1,$2,'friend') ON CONFLICT(user_id,target_id) DO UPDATE SET kind='friend'",[req.userId,targetId]);
 return {ok:true};
});
// Declines an incoming request, cancels an outgoing one, or unfriends — whichever applies. Never
// touches a block; that has its own endpoint below so a block can't be undone by mistake here.
app.delete('/relationships/:userId',async(req,reply)=>{
 const targetId=params(req.params,'userId');
 await db.query("DELETE FROM relationships WHERE ((user_id=$1 AND target_id=$2) OR (user_id=$2 AND target_id=$1)) AND kind<>'blocked'",[req.userId,targetId]);
 return reply.code(204).send();
});
app.post('/relationships/:userId/block',async(req,reply)=>{
 const targetId=params(req.params,'userId');
 if(targetId===req.userId)return reply.code(400).send({error:'You cannot block yourself'});
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  await client.query('DELETE FROM relationships WHERE user_id=$1 AND target_id=$2',[targetId,req.userId]);
  await client.query("INSERT INTO relationships(user_id,target_id,kind) VALUES($1,$2,'blocked') ON CONFLICT(user_id,target_id) DO UPDATE SET kind='blocked'",[req.userId,targetId]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 return reply.code(204).send();
});
app.delete('/relationships/:userId/block',async(req,reply)=>{
 const targetId=params(req.params,'userId');
 const {rowCount}=await db.query("DELETE FROM relationships WHERE user_id=$1 AND target_id=$2 AND kind='blocked'",[req.userId,targetId]);
 if(!rowCount)return reply.code(404).send({error:'Not blocked'});
 return reply.code(204).send();
});
app.get('/dms',async(req)=>(await db.query("SELECT c.id,u.id AS user_id,u.username,u.avatar_url FROM channels c JOIN dm_members d ON d.channel_id=c.id AND d.user_id=$1 JOIN dm_members d2 ON d2.channel_id=c.id AND d2.user_id<>$1 JOIN users u ON u.id=d2.user_id WHERE c.type='dm' ORDER BY c.id DESC",[req.userId])).rows);
app.post('/dms',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(req,reply)=>{
 const body=dmCreateSchema.parse(req.body);
 if(body.userId===req.userId)return reply.code(400).send({error:'You cannot open a DM with yourself'});
 if(!(await db.query('SELECT 1 FROM users WHERE id=$1',[body.userId])).rowCount)return reply.code(404).send({error:'User not found'});
 if((await db.query("SELECT 1 FROM relationships WHERE ((user_id=$1 AND target_id=$2) OR (user_id=$2 AND target_id=$1)) AND kind='blocked'",[req.userId,body.userId])).rowCount)return reply.code(403).send({error:'Cannot message this user'});
 const {rows:[existing]}=await db.query("SELECT c.id FROM channels c WHERE c.type='dm' AND EXISTS(SELECT 1 FROM dm_members WHERE channel_id=c.id AND user_id=$1) AND EXISTS(SELECT 1 FROM dm_members WHERE channel_id=c.id AND user_id=$2) AND (SELECT COUNT(*) FROM dm_members WHERE channel_id=c.id)=2",[req.userId,body.userId]);
 if(existing)return {id:existing.id};
 const id=ids.next(),client=await db.connect();
 try{
  await client.query('BEGIN');
  await client.query("INSERT INTO channels(id,name,type) VALUES($1,'','dm')",[id]);
  await client.query('INSERT INTO dm_members(channel_id,user_id) VALUES($1,$2),($1,$3)',[id,req.userId,body.userId]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 return reply.code(201).send({id});
});
app.get('/guilds',async(req)=>(await db.query('SELECT g.* FROM guilds g JOIN guild_members m ON m.guild_id=g.id WHERE m.user_id=$1 ORDER BY g.id',[req.userId])).rows);
const inviteCodeSchema=z.string().regex(/^[A-Za-z0-9_-]{24}$/);
app.post('/guilds/:guildId/invites',{config:{rateLimit:{max:15,timeWindow:'1 minute'}}},async(req,reply)=>{
 const guildId=params(req.params,'guildId');const {rowCount}=await db.query('SELECT 1 FROM guilds WHERE id=$1 AND owner_id=$2',[guildId,req.userId]);
 if(!rowCount)return reply.code(403).send({error:'Only the server owner can create invites'});
 const code=randomBytes(18).toString('base64url');const {rows:[invite]}=await db.query("INSERT INTO invites(code,guild_id,created_by,expires_at,max_uses) VALUES($1,$2,$3,now()+interval '7 days',100) RETURNING code,expires_at,max_uses",[code,guildId,req.userId]);
 return reply.code(201).send(invite);
});
app.get('/invites/:code',async(req,reply)=>{const code=inviteCodeSchema.parse((req.params as {code:string}).code);const {rows:[invite]}=await db.query('SELECT g.id,g.name,i.expires_at,i.max_uses,i.uses FROM invites i JOIN guilds g ON g.id=i.guild_id WHERE i.code=$1 AND i.expires_at>now()',[code]);if(!invite)return reply.code(404).send({error:'Invite is invalid or expired'});return invite;});
app.post('/invites/:code/join',{config:{rateLimit:{max:15,timeWindow:'1 minute'}}},async(req,reply)=>{
 const code=inviteCodeSchema.parse((req.params as {code:string}).code),client=await db.connect();
 try {await client.query('BEGIN');const {rows:[invite]}=await client.query('SELECT * FROM invites WHERE code=$1 FOR UPDATE',[code]);
  if(!invite||!invite.expires_at||new Date(invite.expires_at)<=new Date())throw Object.assign(new Error('Invite is invalid or expired'),{statusCode:404});
  if((await client.query('SELECT 1 FROM bans WHERE guild_id=$1 AND user_id=$2',[invite.guild_id,req.userId])).rowCount)throw Object.assign(new Error('You cannot join this server'),{statusCode:403});
  const alreadyJoined=(await client.query('SELECT 1 FROM guild_members WHERE guild_id=$1 AND user_id=$2',[invite.guild_id,req.userId])).rowCount;
  if(!alreadyJoined){if(invite.max_uses!==null&&invite.uses>=invite.max_uses)throw Object.assign(new Error('Invite has reached its use limit'),{statusCode:409});const joined=await client.query('INSERT INTO guild_members(guild_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[invite.guild_id,req.userId]);if(joined.rowCount)await client.query('UPDATE invites SET uses=uses+1 WHERE code=$1',[code]);}
  const {rows:[guild]}=await client.query('SELECT id,name,owner_id FROM guilds WHERE id=$1',[invite.guild_id]);await client.query('COMMIT');return reply.code(alreadyJoined?200:201).send(guild);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
app.post('/guilds',async(req,reply)=>{const body=guildSchema.parse(req.body),id=ids.next(),channelId=ids.next();const client=await db.connect();try{await client.query('BEGIN');await client.query('INSERT INTO guilds(id,name,owner_id) VALUES($1,$2,$3)',[id,body.name,req.userId]);await client.query('INSERT INTO guild_members(guild_id,user_id) VALUES($1,$2)',[id,req.userId]);await client.query("INSERT INTO roles(id,guild_id,name,permissions) VALUES($1,$1,'@everyone',$2)",[id,DEFAULT_PERMISSIONS.toString()]);await client.query("INSERT INTO channels(id,guild_id,name,type) VALUES($1,$2,'general','text')",[channelId,id]);await client.query('COMMIT');return reply.code(201).send({id,name:body.name,owner_id:req.userId,channelId});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}});
app.get('/guilds/:guildId/channels',async(req)=>{const guildId=params(req.params,'guildId');const {rows}=await db.query('SELECT c.* FROM channels c JOIN guild_members m ON m.guild_id=c.guild_id WHERE c.guild_id=$1 AND m.user_id=$2 ORDER BY c.position,c.id',[guildId,req.userId]);const visible=[];for(const c of rows){try{await requireChannel(req.userId,c.id);visible.push(c);}catch(error){if((error as {statusCode?:number}).statusCode!==403)throw error;}}return visible;});
app.get('/guilds/:guildId/members',async(req,reply)=>{const id=params(req.params,'guildId');const {rowCount}=await db.query('SELECT 1 FROM guild_members WHERE guild_id=$1 AND user_id=$2',[id,req.userId]);if(!rowCount)return reply.code(403).send({error:'Guild access denied'});return (await db.query("SELECT u.id,u.username,u.avatar_url,m.nickname,m.timeout_until,COALESCE(array_agg(mr.role_id::text) FILTER (WHERE mr.role_id IS NOT NULL),'{}') AS role_ids FROM guild_members m JOIN users u ON u.id=m.user_id LEFT JOIN member_roles mr ON mr.guild_id=m.guild_id AND mr.user_id=m.user_id WHERE m.guild_id=$1 GROUP BY u.id,u.username,u.avatar_url,m.nickname,m.timeout_until ORDER BY u.username LIMIT 100",[id])).rows;});
app.get('/guilds/:guildId/permissions',async(req)=>{const id=params(req.params,'guildId');const actor=await requireGuild(req.userId,id);return {bits:actor.bits.toString(),owner:actor.owner};});
app.get('/guilds/:guildId/roles',async(req)=>{const id=params(req.params,'guildId');await requireGuild(req.userId,id);return (await db.query('SELECT id,name,permissions,position FROM roles WHERE guild_id=$1 ORDER BY position,id',[id])).rows;});
// A non-owner with MANAGE_GUILD can create/assign roles, but never with bits they don't already
// hold themselves — otherwise MANAGE_GUILD alone would be a path to self-granted ADMINISTRATOR.
app.post('/guilds/:guildId/roles',async(req,reply)=>{const id=params(req.params,'guildId');const actor=await requireGuild(req.userId,id,Permission.MANAGE_GUILD);const body=roleCreateSchema.parse(req.body);if(!actor.owner&&(BigInt(body.permissions)&~actor.bits)!==0n)return reply.code(403).send({error:'Cannot grant permissions you do not have'});const roleId=ids.next();const {rows:[role]}=await db.query('INSERT INTO roles(id,guild_id,name,permissions) VALUES($1,$2,$3,$4) RETURNING id,name,permissions,position',[roleId,id,body.name,body.permissions]);return reply.code(201).send(role);});
app.patch('/guilds/:guildId/roles/:roleId',async(req,reply)=>{const id=params(req.params,'guildId'),roleId=params(req.params,'roleId');const actor=await requireGuild(req.userId,id,Permission.MANAGE_GUILD);const body=roleUpdateSchema.parse(req.body);if(body.permissions!==undefined&&!actor.owner&&(BigInt(body.permissions)&~actor.bits)!==0n)return reply.code(403).send({error:'Cannot grant permissions you do not have'});const {rows:[role]}=await db.query('UPDATE roles SET name=COALESCE($1,name),permissions=COALESCE($2,permissions) WHERE id=$3 AND guild_id=$4 RETURNING id,name,permissions,position',[body.name??null,body.permissions??null,roleId,id]);if(!role)return reply.code(404).send({error:'Role not found'});return role;});
app.delete('/guilds/:guildId/roles/:roleId',async(req,reply)=>{const id=params(req.params,'guildId'),roleId=params(req.params,'roleId');await requireGuild(req.userId,id,Permission.MANAGE_GUILD);if(roleId===id)return reply.code(400).send({error:'The @everyone role cannot be deleted'});const {rowCount}=await db.query('DELETE FROM roles WHERE id=$1 AND guild_id=$2',[roleId,id]);if(!rowCount)return reply.code(404).send({error:'Role not found'});return reply.code(204).send();});
app.put('/guilds/:guildId/members/:userId/roles/:roleId',async(req,reply)=>{const id=params(req.params,'guildId'),targetId=params(req.params,'userId'),roleId=params(req.params,'roleId');const actor=await requireGuild(req.userId,id,Permission.MANAGE_GUILD);const {rows:[role]}=await db.query('SELECT permissions FROM roles WHERE id=$1 AND guild_id=$2',[roleId,id]);if(!role)return reply.code(404).send({error:'Role not found'});if(!actor.owner&&(BigInt(role.permissions)&~actor.bits)!==0n)return reply.code(403).send({error:'Cannot grant a role with permissions you do not have'});const {rowCount:isMember}=await db.query('SELECT 1 FROM guild_members WHERE guild_id=$1 AND user_id=$2',[id,targetId]);if(!isMember)return reply.code(404).send({error:'Member not found'});await db.query('INSERT INTO member_roles(guild_id,user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,targetId,roleId]);return reply.code(204).send();});
app.delete('/guilds/:guildId/members/:userId/roles/:roleId',async(req,reply)=>{const id=params(req.params,'guildId'),targetId=params(req.params,'userId'),roleId=params(req.params,'roleId');await requireGuild(req.userId,id,Permission.MANAGE_GUILD);const {rowCount}=await db.query('DELETE FROM member_roles WHERE guild_id=$1 AND user_id=$2 AND role_id=$3',[id,targetId,roleId]);if(!rowCount)return reply.code(404).send({error:'Member does not have this role'});return reply.code(204).send();});
async function audit(guildId:string,actorId:string,action:string,targetId?:string,details?:unknown){await db.query('INSERT INTO audit_log(id,guild_id,actor_id,action,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',[ids.next(),guildId,actorId,action,targetId??null,details===undefined?null:JSON.stringify(details)]);}
app.delete('/guilds/:guildId/members/:userId',async(req,reply)=>{const id=params(req.params,'guildId'),targetId=params(req.params,'userId');await requireGuild(req.userId,id,Permission.KICK_MEMBERS);const {rows:[guild]}=await db.query('SELECT owner_id FROM guilds WHERE id=$1',[id]);if(guild?.owner_id===targetId)return reply.code(400).send({error:'Cannot kick the server owner'});const {rowCount}=await db.query('DELETE FROM guild_members WHERE guild_id=$1 AND user_id=$2',[id,targetId]);if(!rowCount)return reply.code(404).send({error:'Member not found'});await audit(id,req.userId,'member.kick',targetId);return reply.code(204).send();});
app.get('/guilds/:guildId/bans',async(req)=>{const id=params(req.params,'guildId');await requireGuild(req.userId,id,Permission.BAN_MEMBERS);return (await db.query('SELECT b.user_id,b.reason,u.username FROM bans b JOIN users u ON u.id=b.user_id WHERE b.guild_id=$1',[id])).rows;});
app.post('/guilds/:guildId/bans',async(req,reply)=>{const id=params(req.params,'guildId');await requireGuild(req.userId,id,Permission.BAN_MEMBERS);const body=banSchema.parse(req.body);const {rows:[guild]}=await db.query('SELECT owner_id FROM guilds WHERE id=$1',[id]);if(guild?.owner_id===body.userId)return reply.code(400).send({error:'Cannot ban the server owner'});await db.query('INSERT INTO bans(guild_id,user_id,reason) VALUES($1,$2,$3) ON CONFLICT(guild_id,user_id) DO UPDATE SET reason=EXCLUDED.reason',[id,body.userId,body.reason??null]);await db.query('DELETE FROM guild_members WHERE guild_id=$1 AND user_id=$2',[id,body.userId]);await audit(id,req.userId,'member.ban',body.userId,body.reason?{reason:body.reason}:undefined);return reply.code(204).send();});
app.delete('/guilds/:guildId/bans/:userId',async(req,reply)=>{const id=params(req.params,'guildId'),targetId=params(req.params,'userId');await requireGuild(req.userId,id,Permission.BAN_MEMBERS);const {rowCount}=await db.query('DELETE FROM bans WHERE guild_id=$1 AND user_id=$2',[id,targetId]);if(!rowCount)return reply.code(404).send({error:'Ban not found'});await audit(id,req.userId,'member.unban',targetId);return reply.code(204).send();});
app.put('/guilds/:guildId/members/:userId/timeout',async(req,reply)=>{const id=params(req.params,'guildId'),targetId=params(req.params,'userId');await requireGuild(req.userId,id,Permission.MODERATE_MEMBERS);const {rows:[guild]}=await db.query('SELECT owner_id FROM guilds WHERE id=$1',[id]);if(guild?.owner_id===targetId)return reply.code(400).send({error:'Cannot time out the server owner'});const body=timeoutSchema.parse(req.body);const until=body.minutes>0?new Date(Date.now()+body.minutes*60000):null;const {rowCount}=await db.query('UPDATE guild_members SET timeout_until=$1 WHERE guild_id=$2 AND user_id=$3',[until,id,targetId]);if(!rowCount)return reply.code(404).send({error:'Member not found'});await audit(id,req.userId,body.minutes>0?'member.timeout':'member.timeout_clear',targetId,{minutes:body.minutes});return {timeout_until:until};});
app.get('/guilds/:guildId/audit-log',async(req)=>{const id=params(req.params,'guildId');await requireGuild(req.userId,id,Permission.MANAGE_GUILD);return (await db.query('SELECT a.id,a.action,a.target_id,a.details,a.created_at,u.username AS actor_username FROM audit_log a JOIN users u ON u.id=a.actor_id WHERE a.guild_id=$1 ORDER BY a.id DESC LIMIT 50',[id])).rows;});
app.post('/guilds/:guildId/channels',async(req,reply)=>{const guildId=params(req.params,'guildId'),body=channelSchema.parse(req.body);const {rows:[guild]}=await db.query('SELECT * FROM guilds WHERE id=$1 AND owner_id=$2',[guildId,req.userId]);if(!guild)return reply.code(403).send({error:'Only the guild owner can create channels in this release'});if(body.parentId){const {rows:[parent]}=await db.query("SELECT id FROM channels WHERE id=$1 AND guild_id=$2 AND type='category'",[body.parentId,guildId]);if(!parent)return reply.code(400).send({error:'Invalid category'});}const id=ids.next();const {rows:[channel]}=await db.query('INSERT INTO channels(id,guild_id,name,type,parent_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,guildId,body.name,body.type,body.parentId??null]);return reply.code(201).send(channel);});
app.get('/channels/:channelId/messages',async(req)=>{const id=params(req.params,'channelId');await requireChannel(req.userId,id);const query=z.object({before:snowflakeSchema.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);return (await db.query('SELECT m.*,u.username,u.avatar_url FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 AND ($2::bigint IS NULL OR m.id<$2) ORDER BY m.id DESC LIMIT $3',[id,query.before??null,query.limit])).rows;});
app.post('/channels/:channelId/messages',async(req,reply)=>{const id=params(req.params,'channelId'),body=messageSchema.parse(req.body);const {channel}=await requireChannel(req.userId,id,Permission.SEND_MESSAGES);if(!['text','dm','group_dm'].includes(channel.type))return reply.code(400).send({error:'Messages require a text or DM channel'});if(body.replyTo){const {rowCount}=await db.query('SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2',[body.replyTo,id]);if(!rowCount)return reply.code(400).send({error:'Reply must refer to this channel'});}const {rows:[message]}=await db.query('INSERT INTO messages(id,channel_id,author_id,content,nonce,reply_to) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(author_id,nonce) DO NOTHING RETURNING *',[ids.next(),id,req.userId,body.content,body.nonce,body.replyTo??null]);if(!message){const {rows:[existing]}=await db.query('SELECT * FROM messages WHERE author_id=$1 AND nonce=$2 AND channel_id=$3',[req.userId,body.nonce,id]);if(!existing)return reply.code(409).send({error:'Nonce already used'});return existing;}return reply.code(201).send(message);});
app.patch('/channels/:channelId/messages/:messageId',async(req,reply)=>{const id=params(req.params,'channelId'),messageId=params(req.params,'messageId'),body=editMessageSchema.parse(req.body);await requireChannel(req.userId,id,Permission.SEND_MESSAGES);const {rows:[message]}=await db.query('UPDATE messages SET content=$1,edited_at=now() WHERE id=$2 AND channel_id=$3 AND author_id=$4 RETURNING *',[body.content,messageId,id,req.userId]);if(!message)return reply.code(404).send({error:'Message not found'});return message;});
app.delete('/channels/:channelId/messages/:messageId',async(req,reply)=>{const id=params(req.params,'channelId'),messageId=params(req.params,'messageId');const {bits}=await requireChannel(req.userId,id);const {rowCount}=await db.query('DELETE FROM messages WHERE id=$1 AND channel_id=$2 AND (author_id=$3 OR $4)',[messageId,id,req.userId,hasPermission(bits,Permission.MANAGE_MESSAGES)]);if(!rowCount)return reply.code(404).send({error:'Message not found'});return reply.code(204).send();});
app.post('/channels/:channelId/typing',async(req)=>{const id=params(req.params,'channelId');await requireChannel(req.userId,id,Permission.SEND_MESSAGES);await publish('typing.start',id,{userId:req.userId,expiresAt:Date.now()+8000});return {ok:true};});
app.put('/channels/:channelId/read-state',async(req,reply)=>{const id=params(req.params,'channelId');await requireChannel(req.userId,id);const body=z.object({messageId:snowflakeSchema}).parse(req.body);const {rowCount}=await db.query('SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2',[body.messageId,id]);if(!rowCount)return reply.code(400).send({error:'Message not in channel'});await db.query('INSERT INTO read_states(user_id,channel_id,last_read_message_id) VALUES($1,$2,$3) ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_message_id=GREATEST(read_states.last_read_message_id,EXCLUDED.last_read_message_id),mention_count=0',[req.userId,id,body.messageId]);return {ok:true};});
app.get('/channels/:channelId/search',async(req)=>{const id=params(req.params,'channelId');await requireChannel(req.userId,id);const {q}=z.object({q:z.string().trim().min(2).max(200)}).parse(req.query);return (await db.query("SELECT id,channel_id,author_id,content,created_at FROM messages WHERE channel_id=$1 AND to_tsvector('english',content) @@ plainto_tsquery('english',$2) ORDER BY id DESC LIMIT 50",[id,q])).rows;});
let outboxStopped=false;let outboxTimer:ReturnType<typeof setTimeout>|undefined;let pendingOutbox:Promise<void>=Promise.resolve();
function scheduleOutbox(delay=250){outboxTimer=setTimeout(()=>{pendingOutbox=flushOutbox(db,publish).then(()=>{if(!outboxStopped)scheduleOutbox();}).catch(error=>{app.log.error(error,'Outbox delivery failed; will retry');if(!outboxStopped)scheduleOutbox(5000);});},delay);outboxTimer.unref();}
scheduleOutbox();app.addHook('onClose',async()=>{outboxStopped=true;clearTimeout(outboxTimer);await pendingOutbox;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void app.close().then(async()=>{await db.end();redis.disconnect();process.exit(0);}));
await app.listen({port:Number(process.env.API_PORT??3001),host:process.env.HOST??'127.0.0.1'});

