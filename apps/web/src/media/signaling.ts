export type MediaEvent=
 | {type:'peerJoined';payload:{userId:string}}
 | {type:'peerLeft';payload:{userId:string}}
 | {type:'newProducer';payload:{producerId:string;userId:string;kind:'audio'}}
 | {type:'producerClosed';payload:{producerId:string}}
 | {type:'serverShuttingDown';payload:{}};

type MediaResponse={reqId:string;ok:true;data:unknown}|{reqId:string;ok:false;error:{code:number;message:string}};
type Pending={resolve:(data:unknown)=>void;reject:(error:Error)=>void};
export type WebSocketFactory=(url:string)=>WebSocket;

export class MediaRequestError extends Error {
 constructor(public readonly code:number,message:string){super(message);this.name='MediaRequestError';}
}

export class MediaSignaling {
 private readonly pending=new Map<string,Pending>();
 private readonly listeners=new Set<(event:MediaEvent)=>void>();
 private readonly closeListeners=new Set<(event:CloseEvent)=>void>();
 private readonly opened:Promise<void>;
 private resolveOpened!:()=>void;
 private rejectOpened!:(error:Error)=>void;

 constructor(private readonly socket:WebSocket) {
  this.opened=new Promise<void>((resolve,reject)=>{this.resolveOpened=resolve;this.rejectOpened=reject;});
  socket.addEventListener('open',()=>this.resolveOpened());
  socket.addEventListener('message',event=>this.handleMessage(event));
  socket.addEventListener('close',event=>{this.closePending(new Error(`Media signaling closed (${event.code}${event.reason?`: ${event.reason}`:''})`));for(const listener of this.closeListeners)listener(event);});
  socket.addEventListener('error',()=>this.closePending(new Error('Media signaling connection failed')));
  if(socket.readyState===WebSocket.OPEN)this.resolveOpened();
 }

 static async connect(url:string,factory:WebSocketFactory=(address)=>new WebSocket(address)):Promise<MediaSignaling> {
  const signaling=new MediaSignaling(factory(url));
  await signaling.opened;
  return signaling;
 }

 request<T>(type:string,payload:unknown):Promise<T> {
  if(this.socket.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Media signaling is not connected'));
  const reqId=crypto.randomUUID();
  return new Promise<T>((resolve,reject)=>{
   this.pending.set(reqId,{resolve:resolve as (data:unknown)=>void,reject});
   this.socket.send(JSON.stringify({reqId,type,payload}));
  });
 }

 onEvent(listener:(event:MediaEvent)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 onClose(listener:(event:CloseEvent)=>void){this.closeListeners.add(listener);return()=>this.closeListeners.delete(listener);}
 sendBestEffort(type:string,payload:unknown){if(this.socket.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({reqId:crypto.randomUUID(),type,payload}));}
 close(){this.socket.close();}

 private handleMessage(message:MessageEvent){
  let packet:unknown;
  try{packet=JSON.parse(String(message.data));}catch{return;}
  if(!packet||typeof packet!=='object')return;
  const value=packet as Partial<MediaResponse>&Partial<MediaEvent>;
  if(typeof value.reqId==='string'&&typeof value.ok==='boolean'){
   const pending=this.pending.get(value.reqId);if(!pending)return;
   this.pending.delete(value.reqId);
   if(value.ok)pending.resolve(value.data);
   else {const error=(value as {error?:{code:number;message:string}}).error;pending.reject(new MediaRequestError(error?.code??500,error?.message??'Media request failed'));}
   return;
  }
  if(!('reqId' in value)&&isMediaEvent(value))for(const listener of this.listeners)listener(value);
 }
 private closePending(error:Error){this.rejectOpened(error);for(const pending of this.pending.values())pending.reject(error);this.pending.clear();}
}

function isMediaEvent(value:Partial<MediaEvent>):value is MediaEvent {
 return value.type==='peerJoined'||value.type==='peerLeft'||value.type==='newProducer'||value.type==='producerClosed'||value.type==='serverShuttingDown';
}
