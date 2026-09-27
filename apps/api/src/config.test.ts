import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readConfig,databaseUrl} from './config.js';
const production={NODE_ENV:'production',DATABASE_URL:'postgresql://app:secret@database.internal/vexa',REDIS_URL:'rediss://cache.internal:6379',WEB_ORIGIN:'https://vexa.example',WORKER_ID:'1',TRUST_PROXY:'127.0.0.1,10.0.0.0/24'};
test('development defaults and production proxy ranges are explicit',()=>{
 assert.equal(readConfig({}).webOrigin,'http://127.0.0.1:5173');assert.equal(readConfig({}).trustProxy,false);
 assert.deepEqual(readConfig(production).trustProxy,['127.0.0.1','10.0.0.0/24']);
 assert.equal(readConfig({...production,WORKER_ID:'0'}).workerId,0);
 assert.equal(readConfig({...production,TRUST_PROXY:'false'}).trustProxy,false);
});
test('configuration errors fail closed without printing secret values',()=>{
 for(const [key,value] of Object.entries({DATABASE_URL:'not-a-url-secret',REDIS_URL:'https://secret.example',WEB_ORIGIN:'http://vexa.example',WORKER_ID:'1024',API_PORT:'0',GATEWAY_PORT:'3002oops',TRUST_PROXY:'true',API_RATE_LIMIT_MAX:'1000',AUTH_REGISTER_RATE_LIMIT_MAX:'100',HOST:' '})){
  assert.throws(()=>readConfig({...production,[key]:value}),error=>error instanceof Error&&error.message.startsWith('Invalid configuration:')&&!error.message.includes(value.trim()||'not-a-url-secret'));
 }
 for(const key of ['DATABASE_URL','REDIS_URL','WEB_ORIGIN','WORKER_ID'])assert.throws(()=>readConfig({...production,[key]:undefined}));
 assert.throws(()=>readConfig({...production,DATABASE_URL:'postgresql://vexa:vexa_local_only@localhost/vexa'}));
 for(const value of ['https://vexa.example/path','https://vexa.example/','https://user:secret@vexa.example','https://vexa.example?x=1'])assert.throws(()=>readConfig({...production,WEB_ORIGIN:value}));
 for(const value of ['10.0.0.0/33','::1/129','10.0.0.1,','unknown','1','0.0.0.0/no'])assert.throws(()=>readConfig({...production,TRUST_PROXY:value}));
 assert.throws(()=>readConfig({NODE_ENV:'prod'}));
});
test('migration configuration needs only a database, not running application services',()=>{
 assert.equal(databaseUrl({NODE_ENV:'production',DATABASE_URL:production.DATABASE_URL}),production.DATABASE_URL);
});
