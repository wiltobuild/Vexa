import {test,expect} from '@playwright/test';

test('pinned history includes older messages and responds to live edits and deletion on mobile',async({page})=>{
 const message={id:'300',channel_id:'200',author_id:'123',username:'tester',content:'An older pinned plan',nonce:'fixture',created_at:new Date().toISOString()};
 let pins=[message],canManage=false;
 let dispatch:(data:string)=>void=()=>{};
 await page.routeWebSocket('**/gateway',ws=>{dispatch=data=>ws.send(data);ws.onMessage(data=>{if(JSON.parse(String(data)).op===1)ws.send(JSON.stringify({op:3,t:'session.ready',s:1,d:{sessionId:'fixture'}}));});ws.send(JSON.stringify({op:0,d:{heartbeatInterval:30000}}));});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;let data:unknown=[];
  if(path==='/api/me')data={id:'123',username:'tester'};
  else if(path==='/api/guilds')data=[{id:'100',name:'Squad',owner_id:'999'}];
  else if(path==='/api/guilds/100/channels')data=[{id:'200',name:'general',type:'text'},{id:'201',name:'other',type:'text'}];
  else if(path==='/api/guilds/100/permissions')data={bits:'3',owner:false};
  else if(path==='/api/relationships')data={friends:[],incoming:[],outgoing:[],blocked:[]};
  else if(path==='/api/channels/200/pins')data={messages:pins,canManage};
  else if(path==='/api/channels/201/pins')data={messages:[],canManage:false};
  await route.fulfill({status:200,json:data});
 });
 await page.goto('/');await page.getByRole('button',{name:'Connect account'}).click();await page.getByRole('button',{name:'Open connected workspace'}).click();
 await expect(page.getByRole('heading',{name:'general',exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Pinned messages',exact:true}).click();
 await expect(page.getByText('An older pinned plan',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Unpin message',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 message.content='Revised pinned plan';dispatch(JSON.stringify({op:3,t:'message.update',channelId:'200',s:2,d:message}));
 await expect(page.getByText('Revised pinned plan',{exact:true})).toBeVisible();
 pins=[];dispatch(JSON.stringify({op:3,t:'message.delete',channelId:'200',s:3,d:{id:'300'}}));
 await expect(page.getByText('No pins yet',{exact:true})).toBeVisible();
 pins=[message];canManage=true;dispatch(JSON.stringify({op:3,t:'pin.update',channelId:'200',s:4,d:{messageId:'300'}}));
 await expect(page.getByRole('button',{name:'Unpin message',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Open channels'}).click();await page.getByRole('button',{name:'other',exact:true}).click();
 await expect(page.getByRole('button',{name:'Pinned messages',exact:true})).toHaveAttribute('aria-pressed','false');
 await expect(page.getByText('Revised pinned plan',{exact:true})).toHaveCount(0);
});
