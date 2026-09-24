import pg from 'pg';import {Redis} from 'ioredis';import {permissionsFor,hasPermission,Permission} from '@vexa/shared';
export const db=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://vexa:vexa_local_only@localhost:5432/vexa',max:20});
export const redis=new Redis(process.env.REDIS_URL??'redis://localhost:6379');
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

