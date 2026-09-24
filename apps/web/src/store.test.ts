import {beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const cache=new Map<string,string>();
vi.stubGlobal('window',new EventTarget());
vi.stubGlobal('localStorage',{getItem:(key:string)=>cache.get(key)??null,setItem:(key:string,value:string)=>cache.set(key,value),removeItem:(key:string)=>cache.delete(key)});
Object.defineProperty(window,'localStorage',{value:localStorage});
const {useStore,initialMessages}=await import('./store');
beforeAll(()=>useStore.persist.clearStorage());
beforeEach(()=>useStore.setState({messages:structuredClone(initialMessages),selectedGuild:'nexus',selectedChannel:'general'}));
describe('local demo conversations',()=>{
 it('persists a message with a reply and reconciles edits by stable ID',()=>{useStore.getState().send('hello','m1');const sent=useStore.getState().messages.at(-1)!;expect(sent.reply).toBe('m1');useStore.getState().edit(sent.id,'updated');expect(useStore.getState().messages.at(-1)).toMatchObject({id:sent.id,content:'updated',edited:true});});
 it('cannot edit or delete another demo member’s message',()=>{useStore.getState().edit('m1','spoof');useStore.getState().remove('m1');expect(useStore.getState().messages.find(m=>m.id==='m1')?.content).toBe(initialMessages[0].content);});
 it('toggles one reaction per user without duplicate counts',()=>{useStore.getState().react('m2','🔥');useStore.getState().react('m2','🔥');expect(useStore.getState().messages.find(m=>m.id==='m2')?.reactions['🔥']).toEqual([]);});
 it('isolates newly created servers and channel messages',()=>{useStore.getState().addGuild('Test squad');const {selectedGuild,selectedChannel}=useStore.getState();expect(selectedGuild).not.toBe('nexus');useStore.getState().send('first');expect(useStore.getState().messages.at(-1)?.channel).toBe(selectedChannel);});
 it('creates one DM conversation per member',()=>{useStore.getState().openDM('nova');useStore.getState().openDM('nova');expect(useStore.getState().channels.filter(c=>c.id==='dm-nova')).toHaveLength(1);expect(useStore.getState().selectedGuild).toBe('home');});
});
