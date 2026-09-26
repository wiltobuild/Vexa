import { test, expect } from '@playwright/test';

test('demo picker adds and removes a reaction, persists it, and fits mobile',async({page})=>{
 await page.goto('/');await page.evaluate(()=>localStorage.clear());await page.reload();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('textbox',{name:'Message',exact:true}).fill('Celebrate the next build');await page.getByRole('button',{name:'Send message',exact:true}).click();
 const row=page.locator('article').filter({hasText:'Celebrate the next build'});
 await row.getByRole('button',{name:'Add reaction',exact:true}).click();
 await expect(row.getByRole('group',{name:'Choose a reaction'}).getByRole('button')).toHaveCount(12);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await row.getByRole('button',{name:'React with party',exact:true}).click();
 await expect(row.getByRole('button',{name:'React 🎉',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.reload();await expect(row.getByRole('button',{name:'React 🎉',exact:true})).toContainText('1');
 await row.getByRole('button',{name:'React 🎉',exact:true}).click();await expect(row.getByRole('button',{name:'React 🎉',exact:true})).toHaveCount(0);
});

test('connected reactions update from gateway, remove only your reaction, and report denied writes',async({page})=>{
 let count=1,reacted=false,deny=false;
 let dispatch:(data:string)=>void=()=>{};
 await page.routeWebSocket('**/gateway',ws=>{dispatch=data=>ws.send(data);ws.onMessage(data=>{if(JSON.parse(String(data)).op===1)ws.send(JSON.stringify({op:3,t:'session.ready',d:{sessionId:'fixture'},s:1}));});ws.send(JSON.stringify({op:0,d:{heartbeatInterval:30000}}));});
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  let data:unknown=[];
  if(path==='/api/me')data={id:'123',username:'tester'};
  else if(path==='/api/guilds')data=[{id:'100',name:'Test squad',owner_id:'123'}];
  else if(path==='/api/guilds/100/channels')data=[{id:'200',name:'general',type:'text'}];
  else if(path==='/api/guilds/100/permissions')data={bits:'255',owner:true};
  else if(path==='/api/relationships')data={friends:[],incoming:[],outgoing:[],blocked:[]};
  else if(path==='/api/channels/200/messages')data=[{id:'300',channel_id:'200',author_id:'123',username:'tester',content:'Connected celebration',nonce:'fixture',created_at:new Date().toISOString()}];
  else if(path==='/api/channels/200/reactions')data=count?[{message_id:'300',emoji:'🎉',count,reacted}]:[];
  else if(path.includes('/reactions/')){
   if(deny){await route.fulfill({status:403,json:{error:'Channel access denied'}});return;}
   reacted=req.method()==='PUT';count+=reacted?1:-1;await route.fulfill({status:204});return;
  }
  await route.fulfill({status:200,json:data});
 });
 await page.goto('/');await page.getByRole('button',{name:'Connect account'}).click();await page.getByRole('button',{name:'Open connected workspace'}).click();
 const row=page.locator('article').filter({hasText:'Connected celebration'}),reaction=row.getByRole('button',{name:'React 🎉',exact:true});
 await expect(reaction).toContainText('1');await expect(reaction).toHaveAttribute('aria-pressed','false');
 await reaction.click();await expect(reaction).toContainText('2');await expect(reaction).toHaveAttribute('aria-pressed','true');
 await reaction.click();await expect(reaction).toContainText('1');await expect(reaction).toHaveAttribute('aria-pressed','false');
 count=3;dispatch(JSON.stringify({op:3,t:'reaction.update',channelId:'200',s:2,d:{messageId:'300'}}));await expect(reaction).toContainText('3');
 deny=true;await reaction.click();await expect(page.getByRole('alert')).toContainText('Channel access denied');await expect(reaction).toContainText('3');await expect(reaction).toHaveAttribute('aria-pressed','false');
});
