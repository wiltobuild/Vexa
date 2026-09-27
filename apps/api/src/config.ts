import { isIP } from 'node:net';

type Environment = Record<string,string|undefined>;
const invalid=(key:string)=>new Error(`Invalid configuration: ${key}`);
export function databaseUrl(env:Environment){
 const value=env.DATABASE_URL??(env.NODE_ENV==='production'?'':'postgresql://vexa:vexa_local_only@127.0.0.1:5432/vexa');
 validateUrl(value,'DATABASE_URL',['postgres:','postgresql:']);
 if(env.NODE_ENV==='production'&&decodePassword(value)==='vexa_local_only')throw invalid('DATABASE_URL uses development credentials');
 return value;
}
function validateUrl(value:string,key:string,protocols:string[]){
 try{const url=new URL(value);if(!protocols.includes(url.protocol)||!url.hostname)throw invalid(key);return url;}catch{throw invalid(key);}
}
function decodePassword(value:string){try{return decodeURIComponent(new URL(value).password);}catch{return '';}}
function integer(env:Environment,key:string,fallback:number,max:number,min=1){
 const value=env[key];if(value!==undefined&&!/^\d+$/.test(value))throw invalid(key);
 const n=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(key);return n;
}
export function readConfig(env:Environment){
 const nodeEnv=env.NODE_ENV??'development';
 if(!['development','test','production'].includes(nodeEnv))throw invalid('NODE_ENV');
 const production=nodeEnv==='production';
 const dbUrl=databaseUrl({...env,NODE_ENV:nodeEnv});
 const redisUrl=env.REDIS_URL??(production?'':'redis://127.0.0.1:6379');validateUrl(redisUrl,'REDIS_URL',['redis:','rediss:']);
 const webOrigin=env.WEB_ORIGIN??(production?'':'http://127.0.0.1:5173');
 const parsedOrigin=validateUrl(webOrigin,'WEB_ORIGIN',production?['https:']:['http:','https:']);
 if(parsedOrigin.origin!==webOrigin||parsedOrigin.username||parsedOrigin.password)throw invalid('WEB_ORIGIN must be an exact origin');
 let trustProxy:boolean|string[]=false;
 const proxy=env.TRUST_PROXY??'false';
 if(proxy==='true'){if(production)throw invalid('TRUST_PROXY must name trusted addresses in production');trustProxy=true;}
 else if(proxy!=='false'){
  const entries=proxy.split(',').map(value=>value.trim());
  for(const entry of entries){
   if(['loopback','linklocal','uniquelocal'].includes(entry))continue;
   const [address,prefix,...extra]=entry.split('/'),family=isIP(address);
   if(!family||extra.length||(prefix!==undefined&&(!/^\d+$/.test(prefix)||Number(prefix)>(family===4?32:128))))throw invalid('TRUST_PROXY');
  }
  trustProxy=entries;
 }
 if(production&&env.WORKER_ID===undefined)throw invalid('WORKER_ID is required in production');
 const apiRateLimit=integer(env,'API_RATE_LIMIT_MAX',120,100000),registerRateLimit=integer(env,'AUTH_REGISTER_RATE_LIMIT_MAX',5,10000);
 if(production&&(apiRateLimit>120||registerRateLimit>5))throw invalid('test rate-limit overrides are forbidden in production');
 const host=env.HOST??'127.0.0.1';if(!host.trim()||/\s/.test(host))throw invalid('HOST');
 return {production,databaseUrl:dbUrl,redisUrl,webOrigin,trustProxy,host,workerId:integer(env,'WORKER_ID',1,1023,0),apiPort:integer(env,'API_PORT',3001,65535),gatewayPort:integer(env,'GATEWAY_PORT',3002,65535),apiRateLimit,registerRateLimit};
}
