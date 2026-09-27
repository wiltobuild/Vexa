import {describe,expect,it} from 'vitest';
import {MediaRequestError,MediaSignaling} from './signaling';
import {consumeExistingAndSubscribe} from './voiceClient';

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
