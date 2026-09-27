import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {applyMigrations,readMigrations,type Migration} from './migrations.js';
import {databaseUrl} from './config.js';
const directory=new URL('../../../infra/migrations/',import.meta.url);
const migration=(name:string,sql:string):Migration=>({name,sql,checksum:createHash('sha256').update(sql).digest('hex')});
test('migration inventory is ordered, named and checksummed',async()=>{
 const files=await readMigrations(directory);assert.equal(files[0].name,'0001_baseline.sql');assert.equal(files[0].checksum.length,64);
 assert.deepEqual(files.map(m=>m.name),files.map(m=>m.name).sort());assert.ok(files.every(m=>m.sql.length));
});
test('real migrations preserve legacy data, serialize runners and roll back failed upgrades',{skip:process.env.VEXA_INTEGRATION!=='1',timeout:30000},async()=>{
 const connectionString=databaseUrl(process.env),admin=new pg.Pool({connectionString,max:1});
 const schema='migration_'+randomUUID().replaceAll('-','');
 const fresh=schema+'_fresh';
 const pool=new pg.Pool({connectionString,max:2,options:`-c search_path=${schema}`});
 const freshPool=new pg.Pool({connectionString,max:2,options:`-c search_path=${fresh}`});
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`CREATE SCHEMA ${fresh}`);
  await pool.query(await readFile(new URL('../../../infra/schema.sql',import.meta.url),'utf8'));
  await pool.query("INSERT INTO users(id,email,username,password_hash) VALUES(1,'legacy@example.com','legacy','existing-hash')");
  const files=await readMigrations(directory);
  const results=await Promise.all([applyMigrations(pool,files),applyMigrations(pool,files)]);
  assert.equal(results.flat().length,files.length);
  assert.equal((await pool.query('SELECT username FROM users WHERE id=1')).rows[0].username,'legacy');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count,files.length);
  assert.deepEqual(await applyMigrations(pool,files),[]);
  const changed=files.map((m,i)=>i===0?{...m,checksum:'changed'}:m);
  await assert.rejects(applyMigrations(pool,changed),/modified/);
  await assert.rejects(applyMigrations(pool,[]),/history diverges/);
  const bad=migration('9999_failure.sql','CREATE TABLE failed_upgrade(id int); SELECT missing_upgrade_column FROM users;');
  await assert.rejects(applyMigrations(pool,[...files,bad]));
  assert.equal((await pool.query("SELECT to_regclass('failed_upgrade') AS name")).rows[0].name,null);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count,files.length);
  const good=migration('9999_success.sql','CREATE TABLE successful_upgrade(id int);');
  assert.deepEqual(await applyMigrations(pool,[...files,good]),['9999_success.sql']);
  assert.equal((await pool.query('SELECT username FROM users WHERE id=1')).rows[0].username,'legacy');
  assert.equal((await applyMigrations(freshPool,files)).length,files.length);
  for(const table of ['users','messages','message_pins','reactions','personal_transcripts','message_outbox'])assert.ok((await freshPool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name,table);
 }finally{
  await pool.end();await freshPool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);await admin.end();
 }
});
