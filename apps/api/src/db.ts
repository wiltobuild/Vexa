import pg from 'pg';import {Redis} from 'ioredis';import {permissionsFor,hasPermission,Permission,ALL_PERMISSIONS} from '@vexa/shared';
export const db=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://vexa:vexa_local_only@localhost:5432/vexa',max:20});
export const redis=new Redis(process.env.REDIS_URL??'redis://localhost:6379');
const forbid=(message:string)=>Object.assign(new Error(message),{statusCode:403});
// Guild-level permissions: the union of the @everyone role (id===guildId, see guild creation)
// and every role granted to this member, with no channel overwrites in play. Used for
// guild-scoped actions (role management, moderation) rather than per-channel access.
export async function guildPermissions(userId:string,guildId:string):Promise<{bits:bigint;owner:boolean;member:boolean}>{
 const {rows:[guild]}=await db.query('SELECT g.owner_id FROM guilds g JOIN guild_members m ON m.guild_id=g.id AND m.user_id=$2 WHERE g.id=$1',[guildId,userId]);
 if(!guild)return {bits:0n,owner:false,member:false};
 if(guild.owner_id===userId)return {bits:ALL_PERMISSIONS,owner:true,member:true};
 const {rows:roles}=await db.query('SELECT permissions FROM roles WHERE guild_id=$1 AND (id=$1 OR id IN (SELECT role_id FROM member_roles WHERE guild_id=$1 AND user_id=$2))',[guildId,userId]);
 return {bits:roles.reduce((v:bigint,r:{permissions:string})=>v|BigInt(r.permissions),0n),owner:false,member:true};
}
export async function requireGuild(userId:string,guildId:string,permission:bigint=0n){
 const result=await guildPermissions(userId,guildId);
 if(!result.member)throw forbid('Guild access denied');
 if(!result.owner&&!hasPermission(result.bits,permission))throw forbid('Missing permission for this action');
 return result;
}
export async function channelPermissions(userId:string,channelId:string){
 const {rows:[channel]}=await db.query('SELECT c.*,g.owner_id,m.timeout_until FROM channels c JOIN guilds g ON g.id=c.guild_id JOIN guild_members m ON m.guild_id=g.id AND m.user_id=$1 WHERE c.id=$2',[userId,channelId]);
 if(!channel)return {bits:0n,channel:null};
 const {rows:roles}=await db.query('SELECT r.* FROM roles r WHERE r.guild_id=$1 AND (r.id=$1 OR r.id IN (SELECT role_id FROM member_roles WHERE guild_id=$1 AND user_id=$2))',[channel.guild_id,userId]);
 const {rows:overwrites}=await db.query('SELECT * FROM permission_overwrites WHERE channel_id=$1',[channelId]);
 let bits=permissionsFor({owner:channel.owner_id===userId,userId,everyoneId:channel.guild_id,everyone:BigInt(roles.find(r=>r.id===channel.guild_id)?.permissions??0),roles:roles.filter(r=>r.id!==channel.guild_id).map(r=>({id:r.id,permissions:BigInt(r.permissions)})),overwrites:overwrites.map(o=>({targetId:o.target_id,targetType:o.target_type,allow:BigInt(o.allow_bits),deny:BigInt(o.deny_bits)}))});
 if(channel.timeout_until&&new Date(channel.timeout_until)>new Date())bits&=~(Permission.SEND_MESSAGES|Permission.SPEAK);
 return {bits,channel};
}
export async function requireChannel(userId:string,channelId:string,permission:bigint=Permission.VIEW_CHANNEL){const result=await channelPermissions(userId,channelId);if(!result.channel||!hasPermission(result.bits,permission|Permission.VIEW_CHANNEL))throw Object.assign(new Error('Channel access denied'),{statusCode:403});return result;}
// One Redis transaction establishes a total ordering shared by every gateway node.
export async function publish(type:string,channelId:string,data:unknown){await redis.eval("local s=redis.call('INCR','vexa:seq'); local e=cjson.decode(ARGV[1]); e.s=s; local payload=cjson.encode(e); redis.call('XADD','vexa:events','MAXLEN','~',10000,s..'-0','event',payload); redis.call('PUBLISH','vexa:dispatch',payload); return s",0,JSON.stringify({op:3,t:type,channelId,d:data}));}

