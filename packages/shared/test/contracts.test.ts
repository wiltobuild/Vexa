import {test} from 'node:test';import assert from 'node:assert/strict';import {Snowflake,permissionsFor,Permission as P,DEFAULT_PERMISSIONS,ALL_PERMISSIONS,messageSchema,gatewayInputSchema} from '../src/index.js';
test('snowflakes sort, separate workers and reject backwards clocks',()=>{let time=1800000000000;const a=new Snowflake(1,()=>time),b=new Snowflake(2,()=>time);const first=a.next();assert(BigInt(a.next())>BigInt(first));assert.notEqual(first,b.next());time--;assert.throws(()=>a.next(),/backwards/);});
test('snowflake rejects sequence exhaustion',()=>{const s=new Snowflake(0,()=>1800000000000);for(let i=0;i<4096;i++)s.next();assert.throws(()=>s.next(),/capacity/);});
const base={owner:false,userId:'u',everyoneId:'g',everyone:DEFAULT_PERMISSIONS,roles:[{id:'r',permissions:0n}],overwrites:[]};
for(const [name,patch,wanted] of [
 ['owner bypass',{owner:true},ALL_PERMISSIONS],['administrator bypass',{roles:[{id:'r',permissions:P.ADMINISTRATOR}]},ALL_PERMISSIONS],
 ['everyone deny',{overwrites:[{targetType:'role',targetId:'g',deny:P.SEND_MESSAGES,allow:0n}]},DEFAULT_PERMISSIONS&~P.SEND_MESSAGES],
 ['role allow follows everyone deny',{overwrites:[{targetType:'role',targetId:'g',deny:P.SEND_MESSAGES,allow:0n},{targetType:'role',targetId:'r',deny:0n,allow:P.SEND_MESSAGES}]},DEFAULT_PERMISSIONS],
 ['member deny wins',{overwrites:[{targetType:'role',targetId:'r',deny:0n,allow:P.SEND_MESSAGES},{targetType:'member',targetId:'u',deny:P.SEND_MESSAGES,allow:0n}]},DEFAULT_PERMISSIONS&~P.SEND_MESSAGES],
 ['unrelated overwrite ignored',{overwrites:[{targetType:'member',targetId:'other',deny:P.SEND_MESSAGES,allow:0n}]},DEFAULT_PERMISSIONS]
] as const)test(`permissions: ${name}`,()=>assert.equal(permissionsFor({...base,...patch} as Parameters<typeof permissionsFor>[0]),wanted));
test('contracts reject oversized messages and subscriptions',()=>{assert(!messageSchema.safeParse({content:'x'.repeat(4001),nonce:'bad'}).success);assert(!gatewayInputSchema.safeParse({op:7,d:{channels:Array(101).fill('1')}}).success);});
test('role allows aggregate after role denies regardless of role order',()=>{
 const input={...base,roles:[{id:'deny-role',permissions:0n},{id:'allow-role',permissions:0n}],overwrites:[{targetType:'role' as const,targetId:'allow-role',allow:P.SEND_MESSAGES,deny:0n},{targetType:'role' as const,targetId:'deny-role',allow:0n,deny:P.SEND_MESSAGES}]};
 assert.equal(permissionsFor(input),DEFAULT_PERMISSIONS);assert.equal(permissionsFor({...input,overwrites:[...input.overwrites].reverse()}),DEFAULT_PERMISSIONS);
});
test('member allow follows aggregated role deny',()=>assert.equal(permissionsFor({...base,overwrites:[{targetType:'role',targetId:'r',allow:0n,deny:P.VIEW_CHANNEL},{targetType:'member',targetId:'u',allow:P.VIEW_CHANNEL,deny:0n}]}),DEFAULT_PERMISSIONS));
