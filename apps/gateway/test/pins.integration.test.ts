import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

test('pins enforce permissions, stream changes, clean up, and cap concurrent writes', {skip:process.env.VEXA_INTEGRATION!=='1',timeout:45000},async()=>{
 const api=process.env.API_URL??'http://localhost:3001',origin=process.env.WEB_ORIGIN??'http://localhost:5173';
 async function register(){const r=await fetch(api+'/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'pins-'+randomUUID().slice(0,8),email:randomUUID()+'@example.com',password:'integration-password-123'})});assert.equal(r.status,201);return {...await r.json() as {id:string},cookie:r.headers.get('set-cookie')!.split(';')[0]};}
 const owner=await register(),member=await register(),stranger=await register();
 const request=(path:string,method='GET',body?:unknown,cookie=owner.cookie)=>fetch(api+path,{method,headers:{Origin:origin,Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const guild=await(await request('/guilds','POST',{name:'Pinned plans'})).json() as {id:string;channelId:string};
 const invite=await(await request(`/guilds/${guild.id}/invites`,'POST')).json() as {code:string};
 await request(`/invites/${invite.code}/join`,'POST',undefined,member.cookie);
 const base=`/channels/${guild.channelId}`;
 const message=await(await request(base+'/messages','POST',{content:'Squad plan',nonce:randomUUID()})).json() as {id:string};
 const pins=()=>request(base+'/pins').then(r=>r.json()) as Promise<{messages:{id:string;content:string}[];canManage:boolean}>;
 const path=base+'/pins/'+message.id;
 const ws=new WebSocket(process.env.GATEWAY_URL??'ws://localhost:3002',{headers:{Cookie:member.cookie,Origin:origin}}),events:any[]=[];
 ws.on('message',data=>events.push(JSON.parse(data.toString())));
 async function wait(type:string){const deadline=Date.now()+7000;while(Date.now()<deadline){const i=events.findIndex(e=>e.t===type);if(i>=0)return events.splice(i,1)[0];await new Promise(r=>setTimeout(r,20));}throw new Error('Missing '+type);}
 try{
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});ws.send(JSON.stringify({op:1,d:{channels:[guild.channelId]}}));await wait('session.ready');
  assert.equal((await request(path,'PUT',undefined,member.cookie)).status,403);
  assert.equal((await request(base+'/pins','GET',undefined,stranger.cookie)).status,403);
  assert.equal((await request(path,'PUT',undefined,stranger.cookie)).status,403);
  assert.equal((await request(path,'DELETE',undefined,member.cookie)).status,403);
  assert.equal((await request(path,'PUT')).status,204);
  assert.equal((await wait('pin.update')).d.messageId,message.id);
  assert.ok((await Promise.all([request(path,'PUT'),request(path,'PUT')])).every(r=>r.status===204));
  assert.equal((await pins()).messages.length,1);
  assert.equal((await pins()).canManage,true);
  assert.equal((await(await request(base+'/pins','GET',undefined,member.cookie)).json() as {canManage:boolean}).canManage,false);
  await request(base+'/messages/'+message.id,'PATCH',{content:'Updated plan'});
  assert.equal((await pins()).messages[0].content,'Updated plan');
  const other=await(await request(`/guilds/${guild.id}/channels`,'POST',{name:'other'})).json() as {id:string};
  assert.equal((await request(`/channels/${other.id}/pins/${message.id}`,'PUT')).status,404);
  const role=await(await request(`/guilds/${guild.id}/roles`,'POST',{name:'Pin manager',permissions:'4'})).json() as {id:string};
  await request(`/guilds/${guild.id}/members/${member.id}/roles/${role.id}`,'PUT');
  assert.equal((await request(path,'DELETE',undefined,member.cookie)).status,204);
  assert.equal((await pins()).messages.length,0);
  await request(path,'PUT',undefined,member.cookie);
  await request(`/guilds/${guild.id}/members/${member.id}/timeout`,'PUT',{minutes:10});
  assert.equal((await request(path,'DELETE',undefined,member.cookie)).status,403);
  await request(base+'/messages/'+message.id,'DELETE');assert.equal((await pins()).messages.length,0);
  const ids:string[]=[];
  for(let i=0;i<51;i++){const r=await request(base+'/messages','POST',{content:'Plan '+i,nonce:randomUUID()});assert.equal(r.status,201);ids.push((await r.json() as {id:string}).id);}
  for(const id of ids.slice(0,49))assert.equal((await request(base+'/pins/'+id,'PUT')).status,204);
  const race=await Promise.all(ids.slice(49).map(id=>request(base+'/pins/'+id,'PUT')));
  assert.deepEqual(race.map(r=>r.status).sort(),[204,409]);assert.equal((await pins()).messages.length,50);
  assert.equal((await request(base+'/pins/'+ids[0],'PUT')).status,204,'existing pin succeeds even at cap');
  const dm=await(await request('/dms','POST',{userId:member.id})).json() as {id:string};
  const dmMessage=await(await request(`/channels/${dm.id}/messages`,'POST',{content:'Private plan',nonce:randomUUID()})).json() as {id:string};
  const dmPath=`/channels/${dm.id}/pins/${dmMessage.id}`;
  assert.equal((await request(dmPath,'PUT',undefined,member.cookie)).status,204);
  assert.equal((await request(dmPath,'DELETE')).status,204);
  await request(`/relationships/${member.id}/block`,'POST');
  assert.equal((await request(dmPath,'PUT',undefined,member.cookie)).status,403);
  assert.equal((await request(`/channels/${dm.id}/pins`,'GET',undefined,member.cookie)).status,403);
 }finally{ws.close();}
});
