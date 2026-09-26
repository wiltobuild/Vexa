import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

test('reactions persist, deliver live, stay idempotent, and enforce membership, timeout and DM blocks', { skip: process.env.VEXA_INTEGRATION !== '1', timeout: 30000 }, async () => {
 const api=process.env.API_URL??'http://localhost:3001', origin=process.env.WEB_ORIGIN??'http://localhost:5173';
 async function register(){const r=await fetch(api+'/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'react-'+randomUUID().slice(0,8),email:randomUUID()+'@example.com',password:'integration-password-123'})});assert.equal(r.status,201);return {...await r.json() as {id:string},cookie:r.headers.get('set-cookie')!.split(';')[0]};}
 const owner=await register(), member=await register(), stranger=await register();
 const request=(path:string,method='GET',body?:unknown,cookie=owner.cookie)=>fetch(api+path,{method,headers:{Origin:origin,Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const guild=await (await request('/guilds','POST',{name:'Reaction squad'})).json() as {id:string;channelId:string};
 const invite=await (await request(`/guilds/${guild.id}/invites`,'POST')).json() as {code:string};
 assert.equal((await request(`/invites/${invite.code}/join`,'POST',undefined,member.cookie)).status,201);
 const base=`/channels/${guild.channelId}`;
 const message=await (await request(base+'/messages','POST',{content:'React together',nonce:randomUUID()})).json() as {id:string};
 const path=base+'/messages/'+message.id+'/reactions/'+encodeURIComponent('🔥');
 const list=base+'/reactions?messages='+message.id;
 const ws=new WebSocket(process.env.GATEWAY_URL??'ws://localhost:3002',{headers:{Cookie:member.cookie,Origin:origin}}),events:any[]=[];
 ws.on('message',data=>events.push(JSON.parse(data.toString())));
 async function wait(type:string){const deadline=Date.now()+7000;while(Date.now()<deadline){const found=events.findIndex(e=>e.t===type);if(found>=0)return events.splice(found,1)[0];await new Promise(r=>setTimeout(r,20));}throw new Error('Missing '+type);}
 try{
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.send(JSON.stringify({op:1,d:{channels:[guild.channelId]}}));await wait('session.ready');
  assert.equal((await request(path,'PUT')).status,204);
  assert.equal((await wait('reaction.update')).d.messageId,message.id);
  const duplicate=await Promise.all([request(path,'PUT'),request(path,'PUT')]);assert.ok(duplicate.every(r=>r.status===204));
  assert.deepEqual(await (await request(list)).json(),[{message_id:message.id,emoji:'🔥',count:1,reacted:true}]);
  assert.deepEqual(await (await request(list,'GET',undefined,member.cookie)).json(),[{message_id:message.id,emoji:'🔥',count:1,reacted:false}]);
  assert.equal((await request(path,'PUT',undefined,member.cookie)).status,204);
  assert.equal((await request(path,'DELETE')).status,204);
  assert.deepEqual(await (await request(list)).json(),[{message_id:message.id,emoji:'🔥',count:1,reacted:false}]);
  assert.equal((await request(list,'GET',undefined,stranger.cookie)).status,403);
  for(const method of ['PUT','DELETE'])assert.equal((await request(path,method,undefined,stranger.cookie)).status,403);
  assert.equal((await request(base+'/messages/1/reactions/'+encodeURIComponent('🔥'),'PUT')).status,404);
  assert.equal((await request(base+'/messages/'+message.id+'/reactions/invalid','PUT')).status,400);
  assert.equal((await request(base+'/reactions?messages='+Array(101).fill(message.id).join(','))).status,400);
  assert.equal((await request(`/guilds/${guild.id}/members/${member.id}/timeout`,'PUT',{minutes:10})).status,200);
  assert.equal((await request(path,'PUT',undefined,member.cookie)).status,403);
  const other=await (await request(`/guilds/${guild.id}/channels`,'POST',{name:'other'})).json() as {id:string};
  assert.equal((await request(`/channels/${other.id}/messages/${message.id}/reactions/`+encodeURIComponent('🔥'),'PUT')).status,404);
  assert.deepEqual(await (await request(`/channels/${other.id}/reactions?messages=${message.id}`)).json(),[]);
  assert.equal((await request(base+'/messages/'+message.id,'DELETE')).status,204);
  assert.deepEqual(await (await request(list)).json(),[]);
  const dm=await (await request('/dms','POST',{userId:member.id})).json() as {id:string};
  const dmMessage=await (await request(`/channels/${dm.id}/messages`,'POST',{content:'Private',nonce:randomUUID()})).json() as {id:string};
  const dmPath=`/channels/${dm.id}/messages/${dmMessage.id}/reactions/`+encodeURIComponent('👍');
  assert.equal((await request(dmPath,'PUT',undefined,member.cookie)).status,204);
  assert.equal((await request(`/relationships/${member.id}/block`,'POST')).status,204);
  assert.equal((await request(dmPath,'PUT',undefined,member.cookie)).status,403);
  assert.equal((await request(`/channels/${dm.id}/reactions?messages=${dmMessage.id}`,'GET',undefined,member.cookie)).status,403);
 }finally{ws.close();}
});
