import {Device} from 'mediasoup-client';
import type {Consumer,Producer,Transport,TransportOptions,RtpCapabilities,RtpParameters} from 'mediasoup-client/types';
import {MediaSignaling,type MediaEvent} from './signaling';

type ProducerInfo={producerId:string;userId:string;kind:'audio'};
type JoinResponse={rtpCapabilities:RtpCapabilities;existingProducers:ProducerInfo[]};
type TransportResponse={transportId:string;iceParameters:TransportOptions['iceParameters'];iceCandidates:TransportOptions['iceCandidates'];dtlsParameters:TransportOptions['dtlsParameters']};
type ConsumeResponse={consumerId:string;producerId:string;kind:'audio';rtpParameters:RtpParameters};
export type VoiceClientEvents={peerJoined:(userId:string)=>void;peerLeft:(userId:string)=>void;remoteAudio:(audio:HTMLAudioElement,userId:string)=>void;remoteAudioRemoved:(consumerId:string)=>void};

// This keeps late-join producers and live producer events on one consume path.
export async function consumeExistingAndSubscribe(existing:ProducerInfo[],subscribe:(listener:(producer:ProducerInfo)=>void)=>()=>void,consume:(producer:ProducerInfo)=>Promise<void>):Promise<()=>void>{
 const unsubscribe=subscribe(producer=>{void consume(producer);});
 await Promise.all(existing.map(consume));
 return unsubscribe;
}

export class VoiceClient {
 private sendTransport!:Transport;
 private recvTransport!:Transport;
 private producer:Producer|null=null;
 private stream:MediaStream|null=null;
 private readonly consumers=new Map<string,{consumer:Consumer;audio:HTMLAudioElement;userId:string;producerId:string}>();
 private readonly producerConsumers=new Map<string,string>();
 private unsubscribe=()=>{};

 private constructor(private readonly signaling:MediaSignaling,private readonly device:Device,private readonly events:VoiceClientEvents){}

 static async join(url:string,channelId:string,events:VoiceClientEvents):Promise<VoiceClient>{
  const signaling=await MediaSignaling.connect(url);
  try{
   const joined=await signaling.request<JoinResponse>('join',{channelId});
   const device=new Device();await device.load({routerRtpCapabilities:joined.rtpCapabilities});
   const client=new VoiceClient(signaling,device,events);
   await client.createTransports();
   client.listenForRoomEvents();
   client.unsubscribe=await consumeExistingAndSubscribe(joined.existingProducers,listener=>client.subscribeNewProducers(listener),producer=>client.consume(producer));
   const stream=await navigator.mediaDevices.getUserMedia({audio:true});
   client.stream=stream;
   client.producer=await client.sendTransport.produce({track:stream.getAudioTracks()[0]});
   return client;
  }catch(error){signaling.close();throw error;}
 }

 private async createTransports(){
  const send=await this.signaling.request<TransportResponse>('createTransport',{direction:'send'});
  this.sendTransport=this.device.createSendTransport({id:send.transportId,iceParameters:send.iceParameters,iceCandidates:send.iceCandidates,dtlsParameters:send.dtlsParameters});
  this.wireTransport(this.sendTransport);
  this.sendTransport.on('produce',({kind,rtpParameters},callback,errback)=>{void this.signaling.request<{producerId:string}>('produce',{transportId:this.sendTransport.id,kind,rtpParameters}).then(({producerId})=>callback({id:producerId})).catch(errback);});
  const recv=await this.signaling.request<TransportResponse>('createTransport',{direction:'recv'});
  this.recvTransport=this.device.createRecvTransport({id:recv.transportId,iceParameters:recv.iceParameters,iceCandidates:recv.iceCandidates,dtlsParameters:recv.dtlsParameters});
  this.wireTransport(this.recvTransport);
 }
 private wireTransport(transport:Transport){transport.on('connect',({dtlsParameters},callback,errback)=>{void this.signaling.request('connectTransport',{transportId:transport.id,dtlsParameters}).then(()=>callback()).catch(errback);});}
 private listenForRoomEvents(){this.signaling.onEvent(event=>{if(event.type==='peerJoined')this.events.peerJoined(event.payload.userId);if(event.type==='peerLeft'){this.events.peerLeft(event.payload.userId);this.removeConsumersForUser(event.payload.userId);}if(event.type==='producerClosed')this.removeProducer(event.payload.producerId);});}
 private subscribeNewProducers(listener:(producer:ProducerInfo)=>void){return this.signaling.onEvent(event=>{if(event.type==='newProducer')listener(event.payload);});}
 private async consume(producer:ProducerInfo){
  if(this.producerConsumers.has(producer.producerId))return;
  const data=await this.signaling.request<ConsumeResponse>('consume',{transportId:this.recvTransport.id,producerId:producer.producerId,rtpCapabilities:this.device.rtpCapabilities});
  const consumer=await this.recvTransport.consume({id:data.consumerId,producerId:data.producerId,kind:data.kind,rtpParameters:data.rtpParameters});
  const audio=new Audio();audio.autoplay=true;audio.srcObject=new MediaStream([consumer.track]);
  this.consumers.set(data.consumerId,{consumer,audio,userId:producer.userId,producerId:data.producerId});this.producerConsumers.set(data.producerId,data.consumerId);
  this.events.remoteAudio(audio,producer.userId);
  await this.signaling.request('resumeConsumer',{consumerId:data.consumerId});
  void audio.play().catch(()=>{});
 }
 setMuted(muted:boolean){if(this.producer)this.producer.pause?.();if(!muted)this.producer?.resume?.();}
 setDeafened(deafened:boolean){for(const {audio} of this.consumers.values())audio.muted=deafened;}
 async leave(){this.unsubscribe();try{await this.signaling.request('leave',{});}catch{}this.producer?.close();this.stream?.getTracks().forEach(track=>track.stop());this.stream=null;this.sendTransport?.close();this.recvTransport?.close();for(const id of [...this.consumers.keys()])this.removeConsumer(id);this.signaling.close();}
 private removeConsumersForUser(userId:string){for(const [id,entry] of this.consumers)if(entry.userId===userId)this.removeConsumer(id);}
 private removeProducer(producerId:string){const consumerId=this.producerConsumers.get(producerId);if(consumerId)this.removeConsumer(consumerId);}
 private removeConsumer(consumerId:string){const entry=this.consumers.get(consumerId);if(!entry)return;entry.consumer.close();entry.audio.srcObject=null;this.consumers.delete(consumerId);this.producerConsumers.delete(entry.producerId);this.events.remoteAudioRemoved(consumerId);}
}
