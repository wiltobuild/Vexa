import {createServer} from 'node:http';import {createHash,randomUUID} from 'node:crypto';import {WebSocketServer,WebSocket} from 'ws';import {db,redis,requireChannel} from '@vexa/api/db';import {gatewayInputSchema,type Dispatch} from '@vexa/shared';
const origin=process.env.WEB_ORIGIN??'http://localhost:5173';const wss=new WebSocketServer({noServer:true,maxPayload:16384});const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"service":"vexa-gateway"}');});
type Client={ws:WebSocket;userId:string;tokenHash:string;sessionId?:string;channels:Set<string>;seq:number;heartbeat:number;queue:Promise<void>;pending:number;window:number;messages:number};const clients=new Set<Client>();
const send=(c:Client,data:unknown)=>{if(c.ws.readyState===WebSocket.OPEN){if(c.ws.bufferedAmount>1024*1024)c.ws.close(4008,'Slow client');else c.ws.send(JSON.stringify(data));}};
const queue=(c:Client,fn:()=>Promise<void>)=>{if(++c.pending>500){c.ws.close(4008,'Backpressure');return;}c.queue=c.queue.then(fn).catch(e=>{console.error('Gateway operation failed',e instanceof Error?e.message:'unknown');c.ws.close(1011,'Service unavailable');}).finally(()=>{c.pending--;});};
async function authorized(c:Client){return Boolean((await db.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',[c.tokenHash,c.userId])).rowCount);}
async function dispatch(c:Client,event:Dispatch){if(!c.sessionId||event.s<=c.seq)return;c.seq=event.s;if(!c.channels.has(event.channelId))return;if(!await authorized(c)){c.ws.close(4001,'Session expired');return;}try{await requireChannel(c.userId,event.channelId);}catch(error){if((error as {statusCode?:number}).statusCode!==403)throw error;c.channels.delete(event.channelId);return;}send(c,event);}
const sub=redis.duplicate();await sub.subscribe('vexa:dispatch');sub.on('message',(_topic,payload)=>{const event=JSON.parse(payload) as Dispatch;for(const c of clients)queue(c,()=>dispatch(c,event));});
server.on('upgrade',(req,socket,head)=>{void(async()=>{if(req.headers.origin!==origin){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('vexa_session='))?.slice(13);if(!token){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}const tokenHash=createHash('sha256').update(token).digest('hex');const {rows:[session]}=await db.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()',[tokenHash]);if(!session){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
 wss.handleUpgrade(req,socket,head,ws=>{const c:Client={ws,userId:session.user_id,tokenHash,channels:new Set(),seq:0,heartbeat:Date.now(),queue:Promise.resolve(),pending:0,window:Date.now(),messages:0};clients.add(c);send(c,{op:0,d:{heartbeatInterval:25000,protocolVersion:1}});
 ws.on('message',raw=>queue(c,async()=>{if(Date.now()-c.window>10000){c.window=Date.now();c.messages=0;}if(++c.messages>30){ws.close(4008,'Rate limited');return;}let input;try{input=gatewayInputSchema.parse(JSON.parse(raw.toString()));}catch{ws.close(4002,'Invalid payload');return;}
 if(input.op===2){if(!await authorized(c)){ws.close(4001,'Session expired');return;}c.heartbeat=Date.now();send(c,{op:5});if(c.sessionId)await redis.expire(`vexa:gateway:${c.sessionId}`,3600);return;}
 if(input.op===7&&!c.sessionId){ws.close(4003,'Identify first');return;}
 if((input.op===1||input.op===4)&&c.sessionId){ws.close(4003,'Already identified');return;}
 const allowed=new Set<string>();for(const id of input.d.channels){try{await requireChannel(c.userId,id);allowed.add(id);}catch(error){if((error as {statusCode?:number}).statusCode!==403)throw error;}}
 c.channels=allowed;
 if(input.op===7)return;
 if(input.op===1){c.seq=Number(await redis.get('vexa:seq')??0);c.sessionId=randomUUID();await redis.set(`vexa:gateway:${c.sessionId}`,c.userId,'EX',3600);send(c,{op:3,s:c.seq,t:'session.ready',d:{sessionId:c.sessionId,userId:c.userId,channels:[...allowed]}});return;}
 const saved=await redis.get(`vexa:gateway:${input.d.sessionId}`);const latest=Number(await redis.get('vexa:seq')??0);const oldest=await redis.xrange('vexa:events','-','+','COUNT',1);const first=oldest.length?Number(oldest[0][0].split('-')[0]):latest;
 if(saved!==c.userId||input.d.seq>latest||input.d.seq<first-1){send(c,{op:6,d:{reason:'Session or replay window expired; identify and refetch'}});return;}
 c.sessionId=input.d.sessionId;c.seq=input.d.seq;const missed=await redis.xrange('vexa:events',`${c.seq+1}-0`,`${latest}-0`);for(const [,fields]of missed)await dispatch(c,JSON.parse(fields[1]) as Dispatch);c.seq=latest;send(c,{op:3,s:c.seq,t:'session.resumed',d:{sessionId:c.sessionId}});
 }));ws.on('close',()=>clients.delete(c));ws.on('error',()=>clients.delete(c));});
 })().catch(()=>socket.destroy());});
const timer=setInterval(()=>{for(const c of clients)if(Date.now()-c.heartbeat>60000)c.ws.close(4009,'Heartbeat timeout');},10000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);for(const c of clients)c.ws.close(1001,'Restarting');server.close();void Promise.all([db.end(),redis.quit(),sub.quit()]).then(()=>process.exit(0));});
server.listen(Number(process.env.GATEWAY_PORT??3002),process.env.HOST??'127.0.0.1',()=>console.log('Vexa gateway listening'));

