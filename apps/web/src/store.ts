import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Person = {id:string; name:string; color:string; initials:string; status:'online'|'idle'|'dnd'|'offline'; role:string; activity?:string};
export type Message = {id:string; channel:string; author:string; content:string; time:string; edited?:boolean; reply?:string; reactions:Record<string,string[]>; image?:string; attachment?:{name:string;data:string}; pinned?:boolean};
export type Channel = {id:string; guild:string; name:string; category:string; kind:'text'|'voice'|'dm'; description?:string};
export type Guild = {id:string;name:string;initials:string;color:string};
export const people:Person[] = [
 {id:'you',name:'wil',color:'#a18aff',initials:'W',status:'online',role:'Admin',activity:'Building something cool'},
 {id:'nova',name:'nova',color:'#cb9bf5',initials:'N',status:'online',role:'Admin',activity:'VALORANT'},
 {id:'ghost',name:'ghost.exe',color:'#7bcbbc',initials:'G',status:'online',role:'Moderator',activity:'In the lobby'},
 {id:'kira',name:'kira',color:'#f4a184',initials:'K',status:'online',role:'Member',activity:'Cyberpunk 2077'},
 {id:'pixel',name:'pixel',color:'#80b8ed',initials:'P',status:'online',role:'Member',activity:'Creating a new world'},
 {id:'ryu',name:'ryu',color:'#e5b776',initials:'R',status:'idle',role:'Member',activity:'Away from keyboard'},
 {id:'ash',name:'ash',color:'#d9a3bb',initials:'A',status:'dnd',role:'Member',activity:'Do not disturb'},
 {id:'orbit',name:'orbit',color:'#8e97c3',initials:'O',status:'offline',role:'Member'},
 {id:'zero',name:'zero',color:'#91a6a6',initials:'Z',status:'offline',role:'Member'}
];
const channels:Channel[] = [
 {id:'welcome',guild:'nexus',name:'welcome',category:'START HERE',kind:'text',description:'Your first checkpoint. Welcome to the squad.'},
 {id:'announcements',guild:'nexus',name:'announcements',category:'START HERE',kind:'text',description:'The latest from your community.'},
 {id:'general',guild:'nexus',name:'general',category:'THE COMMUNITY',kind:'text',description:'Good games. Better company.'},
 {id:'clips',guild:'nexus',name:'clips-and-highlights',category:'THE COMMUNITY',kind:'text'},
 {id:'setup',guild:'nexus',name:'battlestations',category:'THE COMMUNITY',kind:'text'},
 {id:'lfg',guild:'nexus',name:'looking-for-group',category:'THE COMMUNITY',kind:'text'},
 {id:'lounge',guild:'nexus',name:'The Lounge',category:'VOICE CHANNELS',kind:'voice'},
 {id:'ranked',guild:'nexus',name:'Ranked Grind',category:'VOICE CHANNELS',kind:'voice'},
 {id:'afk',guild:'nexus',name:'AFK',category:'VOICE CHANNELS',kind:'voice'},
 {id:'val-general',guild:'valorant',name:'general',category:'THE COMMUNITY',kind:'text'},
 {id:'forge-general',guild:'forge',name:'general',category:'THE COMMUNITY',kind:'text'}
];
const message=(id:string,author:string,content:string,time:string,extra:Partial<Message>={}):Message=>({id,channel:'general',author,content,time,reactions:{},...extra});
export const initialMessages:Message[] = [
 message('m1','nova','The squad is all here. Welcome to your new home. ✨','18:32',{reactions:{'💜':['ghost','kira','pixel','you'],'🔥':['ryu','ash']}}),
 message('m2','ghost','Anyone down for a few games tonight? Finally finished dialing in the new setup.','18:34'),
 message('m3','kira','Count me in! But first… this new world looks absolutely unreal.','18:35',{image:`${import.meta.env.BASE_URL}nebula.png`,reactions:{'🔥':['nova','ghost','you'],'👀':['pixel','ryu']}}),
 message('m4','pixel','The lighting is actually insane. Screenshot or wallpaper material?','18:36',{reply:'m3'}),
 message('m5','nova','Both. Obviously. 😂\nJump into **The Lounge** when you’re ready. Let’s get the team together.','18:38'),
 message('w1','nova','Welcome to **Nexus Collective**. Grab a role, find your people, and make yourself at home. Be kind, respect boundaries, and keep it fun.','18:00',{channel:'welcome'}),
 message('a1','nova','**Community night • Friday, 8 PM**\nBring your squad. We’re running customs, sharing clips, and hanging out in The Lounge.','18:10',{channel:'announcements',pinned:true}),
 message('l1','ghost','Looking for two more for ranked tonight. All skill levels welcome!','18:20',{channel:'lfg'}),
 message('s1','pixel','What’s the one upgrade that made the biggest difference to your setup?','18:21',{channel:'setup'}),
 message('c1','kira','Drop your best plays here. Even the questionable ones. Especially those.','18:22',{channel:'clips'}),
 message('d1','nova','Hey! Glad you made it. Ready for community night?','18:30',{channel:'dm-nova'})
];
type State = {
 guilds:Guild[];channels:Channel[];messages:Message[];selectedGuild:string;selectedChannel:string;read:string[];friends:string[];profile:Person;
 select:(guild:string,channel?:string)=>void;send:(content:string,reply?:string,attachment?:Message['attachment'])=>void;edit:(id:string,content:string)=>void;remove:(id:string)=>void;react:(id:string,emoji:string)=>void;pin:(id:string)=>void;
 addGuild:(name:string)=>void;addChannel:(name:string,kind:Channel['kind'])=>void;openDM:(id:string)=>void;addFriend:(id:string)=>void;updateProfile:(p:Partial<Person>)=>void;
};
export const useStore=create<State>()(persist((set,get)=>({
 guilds:[{id:'nexus',name:'Nexus Collective',initials:'NX',color:'#9a7aff'},{id:'valorant',name:'Valorant HQ',initials:'VL',color:'#ec667a'},{id:'forge',name:'The Forge',initials:'FG',color:'#68b8a2'}],channels,messages:initialMessages,selectedGuild:'nexus',selectedChannel:'general',read:['general'],friends:['nova','ghost','kira','pixel'],profile:people[0],
 select:(guild,channel)=>set(s=>{const ch=channel??s.channels.find(c=>c.guild===guild&&c.kind==='text')?.id??'general';return {selectedGuild:guild,selectedChannel:ch,read:[...new Set([...s.read,ch])]};}),
 send:(content,reply,attachment)=>set(s=>({messages:[...s.messages,{id:crypto.randomUUID(),channel:s.selectedChannel,author:'you',content,time:new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),reply,attachment,reactions:{}}]})),
 edit:(id,content)=>set(s=>({messages:s.messages.map(m=>m.id===id&&m.author==='you'?{...m,content,edited:true}:m)})),
 remove:(id)=>set(s=>({messages:s.messages.filter(m=>m.id!==id||m.author!=='you')})),
 react:(id,emoji)=>set(s=>({messages:s.messages.map(m=>{if(m.id!==id)return m;const a=m.reactions[emoji]??[];return {...m,reactions:{...m.reactions,[emoji]:a.includes('you')?a.filter(x=>x!=='you'):[...a,'you']}};})})),
 pin:(id)=>set(s=>({messages:s.messages.map(m=>m.id===id?{...m,pinned:!m.pinned}:m)})),
 addGuild:(name)=>{const id=crypto.randomUUID();const cid=crypto.randomUUID();set(s=>({guilds:[...s.guilds,{id,name,initials:name.slice(0,2).toUpperCase(),color:'#9a7aff'}],channels:[...s.channels,{id:cid,guild:id,name:'general',category:'THE COMMUNITY',kind:'text'}],selectedGuild:id,selectedChannel:cid}));},
 addChannel:(name,kind)=>{const id=crypto.randomUUID();set(s=>({channels:[...s.channels,{id,guild:s.selectedGuild,name:kind==='text'?name.toLowerCase().replace(/\s+/g,'-'):name,kind,category:kind==='voice'?'VOICE CHANNELS':'THE COMMUNITY'}],...(kind==='text'?{selectedChannel:id}:{})}));},
 openDM:(id)=>{const cid=`dm-${id}`;if(!get().channels.some(c=>c.id===cid))set(s=>({channels:[...s.channels,{id:cid,guild:'home',name:people.find(p=>p.id===id)?.name??id,kind:'dm',category:'DIRECT MESSAGES'}]}));set({selectedGuild:'home',selectedChannel:cid});},
 addFriend:(id)=>set(s=>({friends:s.friends.includes(id)?s.friends.filter(x=>x!==id):[...s.friends,id]})),
 updateProfile:(profile)=>set(s=>({profile:{...s.profile,...profile}}))
}),{name:'vexa-demo-v1',version:1}));
window.addEventListener('storage',e=>{if(e.key==='vexa-demo-v1')void useStore.persist.rehydrate();});
