import { useState } from 'react';
import { Smile, X } from 'lucide-react';

export type Reaction = { emoji: string; count: number; reacted: boolean };
const choices = [
  ['💜', 'Purple heart'], ['🔥', 'Fire'], ['🎮', 'Game controller'], ['👀', 'Eyes'],
  ['✨', 'Sparkles'], ['😂', 'Laughing'], ['🙌', 'Raised hands'], ['🚀', 'Rocket'],
  ['❤️', 'Heart'], ['👍', 'Thumbs up'], ['⚡', 'Lightning'], ['🎉', 'Party'],
] as const;

export default function MessageReactions({ reactions, onToggle, disabled = false }: {
  reactions: Reaction[]; onToggle: (emoji: string, reacted: boolean) => void | Promise<void>; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  async function toggle(emoji: string) {
    setOpen(false); setPending(true);
    try { await onToggle(emoji, reactions.some(r => r.emoji === emoji && r.reacted)); }
    finally { setPending(false); }
  }
  return <div className="reaction-control" onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
    <div className="reactions">
      {reactions.filter(r => r.count > 0).map(r => <button key={r.emoji} type="button" aria-label={`React ${r.emoji}`} aria-pressed={r.reacted} disabled={disabled || pending} className={r.reacted ? 'reacted' : ''} onClick={() => void toggle(r.emoji)}><span>{r.emoji}</span>{r.count}</button>)}
      <button type="button" className="add-reaction" aria-label={open ? 'Close reactions' : 'Add reaction'} aria-expanded={open} disabled={disabled || pending} onClick={() => setOpen(!open)}>{open ? <X size={15}/> : <Smile size={15}/>}</button>
    </div>
    {open && <div className="reaction-choices" role="group" aria-label="Choose a reaction">{choices.map(([emoji, name]) => <button key={emoji} type="button" title={name} aria-label={`React with ${name.toLowerCase()}`} onClick={() => void toggle(emoji)}>{emoji}</button>)}</div>}
  </div>;
}
