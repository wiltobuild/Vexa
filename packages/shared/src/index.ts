import { z } from 'zod';
export const Permission = { VIEW_CHANNEL:1n, SEND_MESSAGES:2n, MANAGE_MESSAGES:4n, MANAGE_CHANNELS:8n, MANAGE_GUILD:16n, CONNECT:32n, SPEAK:64n, ADMINISTRATOR:128n, KICK_MEMBERS:256n, BAN_MEMBERS:512n, MODERATE_MEMBERS:1024n } as const;
export const ALL_PERMISSIONS = Object.values(Permission).reduce((a,b)=>a|b,0n);
export const DEFAULT_PERMISSIONS = Permission.VIEW_CHANNEL|Permission.SEND_MESSAGES|Permission.CONNECT|Permission.SPEAK;
export type Overwrite = {targetType:'role'|'member'; targetId:string; allow:bigint; deny:bigint};
export function permissionsFor(input:{owner:boolean;userId:string;everyoneId:string;everyone:bigint;roles:{id:string;permissions:bigint}[];overwrites:Overwrite[]}):bigint {
 if(input.owner) return ALL_PERMISSIONS;
 let bits = input.roles.reduce((v,r)=>v|r.permissions,input.everyone);
 if(bits&Permission.ADMINISTRATOR) return ALL_PERMISSIONS;
 const apply=(items:Overwrite[])=>{let deny=0n,allow=0n;for(const o of items){deny|=o.deny;allow|=o.allow;} bits=(bits&~deny)|allow;};
 apply(input.overwrites.filter(o=>o.targetType==='role'&&o.targetId===input.everyoneId));
 apply(input.overwrites.filter(o=>o.targetType==='role'&&input.roles.some(r=>r.id===o.targetId)&&o.targetId!==input.everyoneId));
 apply(input.overwrites.filter(o=>o.targetType==='member'&&o.targetId===input.userId));
 return bits;
}
export const hasPermission=(bits:bigint,required:bigint)=>(bits&required)===required;
const EPOCH=1704067200000n;
export class Snowflake {
 private last=0n; private sequence=0n;
 constructor(private worker=0,private clock:()=>number=Date.now){if(worker<0||worker>1023||!Number.isInteger(worker))throw new Error('Invalid worker ID');}
 next():string {const now=BigInt(this.clock())-EPOCH;if(now<0n||now<this.last)throw new Error('Clock moved backwards');if(now===this.last){this.sequence++;if(this.sequence>4095n)throw new Error('Snowflake capacity exceeded this millisecond');}else this.sequence=0n;this.last=now;return ((now<<22n)|(BigInt(this.worker)<<12n)|this.sequence).toString();}
}
export const snowflakeSchema=z.string().regex(/^\d{1,20}$/).refine(v=>BigInt(v)<=9223372036854775807n);
export const credentialsSchema=z.object({email:z.string().email().max(254).transform(v=>v.toLowerCase()),password:z.string().min(12).max(128)});
export const registerSchema=credentialsSchema.extend({username:z.string().trim().min(2).max(32).regex(/^[\w .-]+$/)});
export const messageSchema=z.object({content:z.string().trim().min(1).max(4000),nonce:z.string().uuid(),replyTo:snowflakeSchema.optional()});
export const editMessageSchema=z.object({content:z.string().trim().min(1).max(4000)});
export const channelSchema=z.object({name:z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/),type:z.enum(['text','voice','category']).default('text'),parentId:snowflakeSchema.optional()});
export const guildSchema=z.object({name:z.string().trim().min(2).max(80)});
const permissionBitsSchema=z.string().regex(/^\d{1,20}$/).refine(v=>BigInt(v)<=ALL_PERMISSIONS).default('0');
export const roleCreateSchema=z.object({name:z.string().trim().min(1).max(100),permissions:permissionBitsSchema});
export const roleUpdateSchema=z.object({name:z.string().trim().min(1).max(100).optional(),permissions:permissionBitsSchema.optional()});
export const banSchema=z.object({userId:snowflakeSchema,reason:z.string().trim().max(300).optional()});
export const timeoutSchema=z.object({minutes:z.number().int().min(0).max(10080)});
export const GatewayOpcode={HELLO:0,IDENTIFY:1,HEARTBEAT:2,DISPATCH:3,RESUME:4,HEARTBEAT_ACK:5,INVALID_SESSION:6,SUBSCRIBE:7} as const;
export const gatewayInputSchema=z.discriminatedUnion('op',[
 z.object({op:z.literal(1),d:z.object({channels:z.array(snowflakeSchema).max(100).default([])})}),
 z.object({op:z.literal(2)}),
 z.object({op:z.literal(4),d:z.object({sessionId:z.string().uuid(),seq:z.number().int().nonnegative(),channels:z.array(snowflakeSchema).max(100).default([])})}),
 z.object({op:z.literal(7),d:z.object({channels:z.array(snowflakeSchema).max(100)})})
]);
export type Dispatch={op:3;s:number;t:string;channelId:string;d:unknown};
