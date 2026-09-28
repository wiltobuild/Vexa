import {describe,expect,it,vi} from 'vitest';
import {MediaRequestError,MediaSignaling} from './signaling';
import {consumeExistingAndSubscribe,finishJoinWithMicrophone,nextReconnectDelay,reconnectDelay} from './voiceClient';

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
});
