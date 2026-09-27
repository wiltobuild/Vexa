import { useState } from "react";
import { Bomb, Swords, Trophy, Gamepad2, Sparkles } from 'lucide-react';

const highlights = [
  { icon: Bomb, time: '00:24:16', duration: '1:42', title: 'The Great Stratagem Disaster', description: 'Three people give contradictory instructions. The entire team pays the price.' },
  { icon: Swords, time: '01:37:08', duration: '2:18', title: 'The Betrayal', description: 'Alex insists the friendly fire was an accident. Nobody believes him.' },
  { icon: Trophy, time: '02:46:30', duration: '3:06', title: 'One Last Mission', description: 'The group agrees to play one more round. It does not go according to plan.' },
];

const sessions = [
 {id:'friday', date:'Sep 25, 2026', name:'Friday night VC', game:'Helldivers', participants:4, duration:'3 hours, 12 minutes', topics:12,
 title:'Democracy Was Not Successfully Managed',
 summary:'Your friends spent three hours attempting increasingly questionable Helldivers missions. There were several accidental team kills, one spectacularly bad extraction and a lengthy debate about whose fault everything was.', highlights},
 {id:'thursday', date:'Sep 24, 2026', name:'Thursday ranked grind', game:'VALORANT', participants:5, duration:'2 hours, 8 minutes', topics:8,
 title:'One More Queue Became Five',
 summary:'The squad warmed up, changed the plan twice and somehow turned a losing streak into a comeback. A last-second defuse saved the night, while the debate about who should play support remained unresolved.',
 highlights:[
 {icon:Swords,time:'00:18:42',duration:'1:15',title:'The Warm-up That Counted',description:'Everyone thought it was a practice round. The scoreboard disagreed.'},
 {icon:Bomb,time:'01:06:10',duration:'0:48',title:'Half a Second to Spare',description:'Kira sticks the defuse while the rest of the squad forgets to breathe.'},
 {icon:Trophy,time:'01:54:22',duration:'2:04',title:'The Comeback Queue',description:'One final match ends with a win and a promise to stop while ahead.'}]},
 {id:'tuesday', date:'Sep 22, 2026', name:'Tuesday building club', game:'Minecraft', participants:3, duration:'1 hour, 46 minutes', topics:6,
 title:'A Cozy Cabin, Eventually',
 summary:'A quick cabin build grew into a riverside village. Nova supplied the blueprints, Pixel kept adding windows and an unexpected creeper forced everyone to rethink the front entrance. The squad finished with a sunset tour.',
 highlights:[
 {icon:Gamepad2,time:'00:09:30',duration:'1:30',title:'Just a Small Cabin',description:'The original four walls become a plan for an entire neighborhood.'},
 {icon:Bomb,time:'00:48:05',duration:'0:56',title:'Unplanned Open Floor Plan',description:'A creeper provides a dramatic architectural consultation.'},
 {icon:Trophy,time:'01:32:18',duration:'2:40',title:'The Sunset Tour',description:'Everyone takes a lap of the village and picks a room for next time.'}]},
];

export default function DemoRecap() {
 const [selected,setSelected]=useState(sessions[0].id);
 const session=sessions.find(item=>item.id===selected)??sessions[0];
 return <section className="demo-recap" aria-labelledby="recap-heading">
    <header className="recap-heading"><div><span className="eyebrow">VEXA RECALL · AI SUMMARY</span><h2 id="recap-heading">While You Were Gone</h2><p>Catch up on your squad’s past sessions.</p></div><Gamepad2 size={32} aria-hidden="true"/></header>
    <div className="recap-history" role="group" aria-label="Past summaries">{sessions.map(item=><button key={item.id} aria-pressed={selected===item.id} onClick={()=>setSelected(item.id)}><span>{item.date} · {item.game}</span><strong>{item.name}</strong><small>{item.title}</small></button>)}</div>
    <p className="recap-session-meta">{session.date} · {session.name} · {session.participants} participants · {session.duration}</p>
    <div className="recap-summary"><span className="eyebrow">YOUR SESSION RECAP</span><h3>{session.title}</h3><p>{session.summary}</p><span className="recap-sample-label"><Sparkles size={14} aria-hidden="true"/>Illustrative AI-generated recap</span></div>
    <h3 className="recap-highlights-title">Session highlights</h3>
    <ol className="recap-highlights">{session.highlights.map(({icon:Icon,time,duration,title,description})=><li key={title}><span className="recap-highlight-icon"><Icon size={26} aria-hidden="true"/></span><div><p className="recap-time">{time} · {duration}</p><h4>{title}</h4><p>{description}</p></div></li>)}</ol>
    <dl className="recap-stats"><div><dt>Major moments</dt><dd>{session.highlights.length}</dd></div><div><dt>Topics discussed</dt><dd>{session.topics}</dd></div><div><dt>Participants</dt><dd>{session.participants}</dd></div></dl>
    <p className="recap-footnote">Sample sessions for the demo. Highlights are illustrative; no recorded clips are attached.</p>
  </section>;
}
