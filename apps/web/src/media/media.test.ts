import {describe,expect,it,vi} from 'vitest';
import {MediaRequestError,MediaSignaling} from './signaling';
import {consumeExistingAndSubscribe,finishJoinWithMicrophone,nextReconnectDelay,reconnectDelay,VoiceClient} from './voiceClient';
import {isMutedByModerator,reconcileParticipantMuted,reconcileVoiceOccupancy} from './voiceModeration';

class MockSocket extends EventTarget {
 static readonly OPEN=1;
 readonly OPEN=1;
 readyState=1;
 sent:string[]=[];
 send(data:string){this.sent.push(data);}
 close(){this.readyState=3;const event=new Event('close');Object.defineProperty(event,'code',{value:1000});this.dispatchEvent(event);}
 message(data:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
}

describe('media signaling',()=>{
 it('correlates responses by reqId, rejects errors, and leaves events out of the pending map',async()=>{
  const socket=new MockSocket();const signaling=new MediaSignaling(socket as unknown as WebSocket);
  let event='';signaling.onEvent(packet=>{event=packet.type;});
  const first=signaling.request<{value:string}>('join',{channelId:'1'});
  const firstRequest=JSON.parse(socket.sent[0]);
  socket.message({type:'peerJoined',payload:{userId:'2'}});
  expect(event).toBe('peerJoined');
  socket.message({reqId:firstRequest.reqId,ok:true,data:{value:'matched'}});
  await expect(first).resolves.toEqual({value:'matched'});
  const second=signaling.request('leave',{});const secondRequest=JSON.parse(socket.sent[1]);
  socket.message({reqId:secondRequest.reqId,ok:false,error:{code:403,message:'Denied'}});
  await expect(second).rejects.toEqual(expect.objectContaining<Partial<MediaRequestError>>({code:403,message:'Denied'}));
 });
});

describe('voice producer discovery',()=>{
 it('subscribes before consuming existing producers so concurrent producers are not lost',async()=>{
  const consumed:string[]=[];let listener:(producer:{producerId:string;userId:string;kind:'audio'})=>void=()=>{};let releaseExisting!:()=>void;
  const existingConsumed=new Promise<void>(resolve=>{releaseExisting=resolve;});
  const discovery=consumeExistingAndSubscribe([{producerId:'existing',userId:'1',kind:'audio'}],next=>{listener=next;return()=>{};},async producer=>{if(producer.producerId==='existing')await existingConsumed;consumed.push(producer.producerId);});
  listener({producerId:'concurrent',userId:'2',kind:'audio'});
  await Promise.resolve();
  expect(consumed).toEqual(['concurrent']);
  releaseExisting();
  (await discovery)();
  expect(consumed).toEqual(['concurrent','existing']);
 });

 it('uses the same consume callback for join existingProducers and newProducer events',async()=>{
  const consumed:string[]=[];let listener:(producer:{producerId:string;userId:string;kind:'audio'})=>void=()=>{};
  const unsubscribe=await consumeExistingAndSubscribe([{producerId:'existing',userId:'1',kind:'audio'}],next=>{listener=next;return()=>{};},async producer=>{consumed.push(producer.producerId);});
  listener({producerId:'live',userId:'2',kind:'audio'});
  await Promise.resolve();
  expect(consumed).toEqual(['existing','live']);unsubscribe();
 });
});

describe('device and reconnect resilience',()=>{
 it('continues as listen-only when microphone acquisition is denied',async()=>{
  const denied=vi.fn().mockRejectedValue(new DOMException('Denied','NotAllowedError'));
  const attach=vi.fn(),listenOnly=vi.fn();
  await expect(finishJoinWithMicrophone(denied,attach,listenOnly)).resolves.toBeUndefined();
  expect(denied).toHaveBeenCalledWith({audio:true});
  expect(attach).not.toHaveBeenCalled();expect(listenOnly).toHaveBeenCalledOnce();
 });
 it('uses bounded exponential reconnect delays',()=>{
  expect([0,1,2,3,4,9].map(reconnectDelay)).toEqual([500,1000,2000,4000,8000,8000]);
  expect([1,2,3,4,5].map(nextReconnectDelay)).toEqual([500,1000,2000,4000,null]);
 });
 it('cleans up when leave wins a reconnect already establishing',async()=>{
  vi.useFakeTimers();
  try {
   let resolveEstablish!:((state:'connected')=>void);const established=new Promise<'connected'>(resolve=>{resolveEstablish=resolve;});
   const stateChanged=vi.fn();const client=Reflect.construct(VoiceClient,['ws://example.test','channel',{peerJoined:vi.fn(),peerLeft:vi.fn(),remoteAudio:vi.fn(),remoteAudioRemoved:vi.fn(),stateChanged}]) as VoiceClient;
   const internals=client as unknown as {intentionalClose:boolean;signaling:{request:ReturnType<typeof vi.fn>};establish:ReturnType<typeof vi.fn>;cleanup:ReturnType<typeof vi.fn>;startReconnect:(serverRestarting:boolean)=>void};
   internals.signaling={request:vi.fn().mockResolvedValue(undefined)};
   internals.cleanup=vi.fn();
   internals.establish=vi.fn().mockImplementation(()=>{internals.intentionalClose=false;return established;});
   internals.startReconnect(false);
   await vi.advanceTimersByTimeAsync(500);
   expect(internals.establish).toHaveBeenCalledOnce();
   await client.leave();
   resolveEstablish('connected');
   await Promise.resolve();
   expect(internals.cleanup).toHaveBeenCalledTimes(3);
   expect(stateChanged).not.toHaveBeenCalledWith('connected');
  } finally {vi.useRealTimers();}
 });
});

describe('voice moderation state reconciliation',()=>{
 it('locks local self-unmute while server-muted and restores it when released',()=>{
  let muted:Record<string,boolean>={};
  muted=reconcileParticipantMuted(muted,'self',true);
  expect(isMutedByModerator(muted,'self')).toBe(true);
  muted=reconcileParticipantMuted(muted,'self',false);
  expect(isMutedByModerator(muted,'self')).toBe(false);
 });
 it('tracks moderator mute state for other participants independently',()=>{
  let muted:Record<string,boolean>={};
  muted=reconcileParticipantMuted(muted,'one',true);
  muted=reconcileParticipantMuted(muted,'two',false);
  expect(isMutedByModerator(muted,'one')).toBe(true);
  expect(isMutedByModerator(muted,'two')).toBe(false);
 });
});

describe('voice occupancy state reconciliation',()=>{
 it('updates occupancy by channel without replacing other visible channels',()=>{
  let occupancy=reconcileVoiceOccupancy({},'voice-one',2);
  occupancy=reconcileVoiceOccupancy(occupancy,'voice-two',1);
  occupancy=reconcileVoiceOccupancy(occupancy,'voice-one',0);
  expect(occupancy).toEqual({'voice-one':0,'voice-two':1});
 });
});
