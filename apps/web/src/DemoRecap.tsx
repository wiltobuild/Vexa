import { Bomb, Swords, Trophy, Gamepad2, Sparkles } from 'lucide-react';

const highlights = [
  { icon: Bomb, time: '00:24:16', duration: '1:42', title: 'The Great Stratagem Disaster', description: 'Three people give contradictory instructions. The entire team pays the price.' },
  { icon: Swords, time: '01:37:08', duration: '2:18', title: 'The Betrayal', description: 'Alex insists the friendly fire was an accident. Nobody believes him.' },
  { icon: Trophy, time: '02:46:30', duration: '3:06', title: 'One Last Mission', description: 'The group agrees to play one more round. It does not go according to plan.' },
];

export default function DemoRecap() {
  return <section className="demo-recap" aria-labelledby="recap-heading">
    <header className="recap-heading"><div><span className="eyebrow">VEXA RECALL · AI SUMMARY</span><h2 id="recap-heading">While You Were Gone</h2><p>Friday night VC · 4 participants · 3 hours, 12 minutes</p></div><Gamepad2 size={32} aria-hidden="true"/></header>
    <div className="recap-summary"><span className="eyebrow">YOUR SESSION RECAP</span><h3>Democracy Was Not Successfully Managed</h3><p>Your friends spent three hours attempting increasingly questionable Helldivers missions. There were several accidental team kills, one spectacularly bad extraction and a lengthy debate about whose fault everything was.</p><span className="recap-sample-label"><Sparkles size={14} aria-hidden="true"/>Illustrative AI-generated recap</span></div>
    <h3 className="recap-highlights-title">Tonight’s highlights</h3>
    <ol className="recap-highlights">{highlights.map(({icon:Icon,time,duration,title,description})=><li key={title}><span className="recap-highlight-icon"><Icon size={26} aria-hidden="true"/></span><div><p className="recap-time">{time} · {duration}</p><h4>{title}</h4><p>{description}</p></div></li>)}</ol>
    <dl className="recap-stats"><div><dt>Major moments</dt><dd>3</dd></div><div><dt>Topics discussed</dt><dd>12</dd></div><div><dt>Participants</dt><dd>4</dd></div></dl>
    <p className="recap-footnote">Sample session for the demo. Highlights are illustrative; no recorded clips are attached.</p>
  </section>;
}
