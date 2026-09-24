import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {WebSocket} from 'ws';
const api=process.env.API_URL??'http://localhost:3001';const origin=process.env.WEB_ORIGIN??'http://localhost:5173';
test('authenticated text flow, denied access, gateway delivery and replay',{skip:process.env.VEXA_INTEGRATION!=='1',timeout:30000},async()=>{
 async function register(){const r=await fetch(api+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({email:`test-${randomUUID()}@example.com`,username:'Integration tester',password:'long-test-password-123!'})});assert.equal(r.status,201);return r.headers.get('set-cookie')!.split(';')[0];}
 const cookie=await register(),stranger=await register();
 async function request(path:string,method='GET',body?:unknown,session=cookie){return fetch(api+path,{method,headers:{Cookie:session,Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});}
 const guildResponse=await request('/guilds','POST',{name:'Integration guild'});assert.equal(guildResponse.status,201);const guild=await guildResponse.json() as {id:string;channelId:string};const path=`/channels/${guild.channelId}/messages`;
 assert.equal((await request(path,'GET',undefined,stranger)).status,403);assert.equal((await request(path,'POST',{content:'Denied',nonce:randomUUID()},stranger)).status,403);
 assert.equal((await request(`/guilds/${guild.id}/invites`,'POST',undefined,stranger)).status,403);
 const inviteResponse=await request(`/guilds/${guild.id}/invites`,'POST');assert.equal(inviteResponse.status,201);const invite=await inviteResponse.json() as {code:string};assert.match(invite.code,/^[A-Za-z0-9_-]{24}$/);
 const memberCookie=await register();assert.equal((await request(`/invites/${invite.code}/join`,'POST',undefined,memberCookie)).status,201);assert.equal((await request(`/invites/${invite.code}/join`,'POST',undefined,memberCookie)).status,200);
 assert.equal((await (await request(`/invites/${invite.code}`)).json() as {uses:number}).uses,1);
 assert.equal((await request('/invites/'+('a'.repeat(24))+'/join','POST',undefined,memberCookie)).status,404);
 const sockets:WebSocket[]=[];
 async function connect(session=cookie){const ws=new WebSocket(process.env.GATEWAY_URL??'ws://localhost:3002',{headers:{Cookie:session,Origin:origin}});sockets.push(ws);const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});async function wait(type:string){const until=Date.now()+5000;while(Date.now()<until){const i=messages.findIndex(m=>m.t===type||(type==='heartbeat.ack'&&m.op===5));if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,10));}throw new Error(`Missing ${type}`);}return {ws,wait,messages};}
 try {const one=await connect(),two=await connect(memberCookie),outsider=await connect(stranger);for(const c of [one,two,outsider])c.ws.send(JSON.stringify({op:1,d:{channels:[guild.channelId]}}));const ready=await one.wait('session.ready');await two.wait('session.ready');assert.deepEqual((await outsider.wait('session.ready')).d.channels,[]);
 const nonce=randomUUID();const sent=await request(path,'POST',{content:'First message',nonce});assert.equal(sent.status,201);const message=await sent.json() as {id:string};const event=await one.wait('message.create');assert.equal((await two.wait('message.create')).d.id,message.id);assert.equal((await request(path,'POST',{content:'First message',nonce})).status,200);
 outsider.ws.send(JSON.stringify({op:2}));await outsider.wait('heartbeat.ack');assert.equal(outsider.messages.filter(m=>m.t==='message.create').length,0);
 for(const [route,method,body] of [
  [path+'/'+message.id,'PATCH',{content:'Unauthorized edit'}],
  [path+'/'+message.id,'DELETE',undefined],
  [`/channels/${guild.channelId}/typing`,'POST',undefined],
  [`/channels/${guild.channelId}/read-state`,'PUT',{messageId:message.id}],
  [`/channels/${guild.channelId}/search?q=message`,'GET',undefined],
  [`/guilds/${guild.id}/members`,'GET',undefined],
  [`/guilds/${guild.id}/channels`,'POST',{name:'unauthorized'}]
 ] as const)assert.equal((await request(route,method,body,stranger)).status,403,`${method} ${route}`);
 assert.deepEqual(await (await request(`/guilds/${guild.id}/channels`,'GET',undefined,stranger)).json(),[]);
 assert.equal((await request(path,'GET',undefined,'')).status,401);
 one.ws.close();await new Promise<void>(r=>one.ws.once('close',()=>r()));const missed=await request(path,'POST',{content:'During disconnect',nonce:randomUUID()});assert.equal(missed.status,201);const missedMessage=await missed.json() as {id:string};const resumed=await connect();resumed.ws.send(JSON.stringify({op:4,d:{sessionId:ready.d.sessionId,seq:event.s,channels:[guild.channelId]}}));assert.equal((await resumed.wait('message.create')).d.id,missedMessage.id);await resumed.wait('session.resumed');
 const page=await request(path+`?before=${missedMessage.id}&limit=1`);assert.equal((await page.json() as {id:string}[])[0].id,message.id);assert.equal((await request(path+'/'+message.id,'PATCH',{content:'Edited'})).status,200);assert.equal((await request(path+'/'+message.id,'DELETE')).status,204);
 }finally{for(const s of sockets)s.close();}
});

test('roles cannot grant permissions the actor lacks, and moderation enforces them',{skip:process.env.VEXA_INTEGRATION!=='1',timeout:30000},async()=>{
 async function register(){const r=await fetch(api+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({email:`test-${randomUUID()}@example.com`,username:'Integration tester',password:'long-test-password-123!'})});assert.equal(r.status,201);const user=await r.json() as {id:string};return {cookie:r.headers.get('set-cookie')!.split(';')[0],id:user.id};}
 async function request(path:string,method='GET',body?:unknown,session?:string){return fetch(api+path,{method,headers:{...(session?{Cookie:session}:{}),Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});}
 const owner=await register(),member=await register(),victim=await register();
 const guild=await (await request('/guilds','POST',{name:'Mod guild'},owner.cookie)).json() as {id:string};
 const invite=await (await request(`/guilds/${guild.id}/invites`,'POST',undefined,owner.cookie)).json() as {code:string};
 assert.equal((await request(`/invites/${invite.code}/join`,'POST',undefined,member.cookie)).status,201);
 assert.equal((await request(`/invites/${invite.code}/join`,'POST',undefined,victim.cookie)).status,201);
 // A plain member has no MANAGE_GUILD bit and cannot create roles at all.
 assert.equal((await request(`/guilds/${guild.id}/roles`,'POST',{name:'nope',permissions:'16'},member.cookie)).status,403);
 // Owner grants member MANAGE_GUILD (16) + KICK_MEMBERS (256) via a role — enough to moderate, not enough to ban.
 const modRole=await (await request(`/guilds/${guild.id}/roles`,'POST',{name:'Mod',permissions:'272'},owner.cookie)).json() as {id:string};
 assert.equal((await request(`/guilds/${guild.id}/members/${member.id}/roles/${modRole.id}`,'PUT',undefined,owner.cookie)).status,204);
 // Escalation guard: member now has MANAGE_GUILD but still cannot mint a role with bits (e.g. BAN_MEMBERS=512) they don't hold.
 assert.equal((await request(`/guilds/${guild.id}/roles`,'POST',{name:'escalate',permissions:'512'},member.cookie)).status,403);
 // Member can grant a role using only bits they do hold (KICK_MEMBERS=256).
 const subRole=await (await request(`/guilds/${guild.id}/roles`,'POST',{name:'Kicker',permissions:'256'},member.cookie)).json() as {id:string};
 assert.ok(subRole.id);
 // Member can now use their granted KICK_MEMBERS to remove the victim.
 assert.equal((await request(`/guilds/${guild.id}/members/${victim.id}`,'DELETE',undefined,member.cookie)).status,204);
 assert.deepEqual(await (await request(`/guilds/${guild.id}/channels`,'GET',undefined,victim.cookie)).json(),[]);
 // Owner bans a fresh stranger; they cannot rejoin, and unbanning restores that ability.
 const stranger=await register();
 assert.equal((await request(`/guilds/${guild.id}/bans`,'POST',{userId:stranger.id,reason:'testing'},owner.cookie)).status,204);
 const bans=await (await request(`/guilds/${guild.id}/bans`,'GET',undefined,owner.cookie)).json() as {user_id:string}[];
 assert.ok(bans.some(b=>b.user_id===stranger.id));
 assert.equal((await request(`/invites/${invite.code}/join`,'POST',undefined,stranger.cookie)).status,403);
 assert.equal((await request(`/guilds/${guild.id}/bans/${stranger.id}`,'DELETE',undefined,owner.cookie)).status,204);
 assert.equal((await request(`/invites/${invite.code}/join`,'POST',undefined,stranger.cookie)).status,201);
 // Timeout strips SEND_MESSAGES immediately (no reconnect needed); clearing it restores access.
 const channels=await (await request(`/guilds/${guild.id}/channels`,'GET',undefined,owner.cookie)).json() as {id:string}[];
 const channelId=channels[0].id;
 assert.equal((await request(`/guilds/${guild.id}/members/${member.id}/timeout`,'PUT',{minutes:10},owner.cookie)).status,200);
 assert.equal((await request(`/channels/${channelId}/messages`,'POST',{content:'muted',nonce:randomUUID()},member.cookie)).status,403);
 assert.equal((await request(`/guilds/${guild.id}/members/${member.id}/timeout`,'PUT',{minutes:0},owner.cookie)).status,200);
 assert.equal((await request(`/channels/${channelId}/messages`,'POST',{content:'unmuted',nonce:randomUUID()},member.cookie)).status,201);
 // Deleting the granting role revokes the derived permission immediately.
 assert.equal((await request(`/guilds/${guild.id}/roles/${modRole.id}`,'DELETE',undefined,owner.cookie)).status,204);
 assert.equal((await request(`/guilds/${guild.id}/roles`,'POST',{name:'blocked',permissions:'0'},member.cookie)).status,403);
 const auditLog=await (await request(`/guilds/${guild.id}/audit-log`,'GET',undefined,owner.cookie)).json() as {action:string}[];
 assert.ok(auditLog.some(e=>e.action==='member.kick'));
 assert.ok(auditLog.some(e=>e.action==='member.ban'));
 assert.ok(auditLog.some(e=>e.action==='member.timeout'));
});

