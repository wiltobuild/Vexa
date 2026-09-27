import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Pool } from 'pg';

export type Migration = { name: string; sql: string; checksum: string };
export async function readMigrations(directory: URL): Promise<Migration[]> {
 const files=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
 if(!files.length)throw new Error('No migration files found');
 const versions=new Set<string>();
 return Promise.all(files.map(async name=>{
  if(!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)||versions.has(name.slice(0,4)))throw new Error('Invalid or duplicate migration version');
  versions.add(name.slice(0,4));
  const sql=(await readFile(new URL(name,directory),'utf8')).replace(/\r\n/g,'\n');
  return {name,sql,checksum:createHash('sha256').update(sql).digest('hex')};
 }));
}

export async function applyMigrations(pool: Pool, migrations: Migration[]): Promise<string[]> {
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='15s'");
  await client.query("SET LOCAL statement_timeout='120s'");
  await client.query('SELECT pg_advisory_xact_lock(8675310)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const {rows:history}=await client.query<{name:string;checksum:string}>('SELECT name,checksum FROM schema_migrations ORDER BY name');
  for(let i=0;i<history.length;i++){
   if(migrations[i]?.name!==history[i].name)throw new Error('Migration history diverges from this checkout; use the matching release');
   if(migrations[i].checksum!==history[i].checksum)throw new Error(`Applied migration was modified: ${history[i].name}`);
  }
  const applied:string[]=[];
  for(const migration of migrations.slice(history.length)){
   await client.query(migration.sql);
   await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[migration.name,migration.checksum]);
   applied.push(migration.name);
  }
  await client.query('COMMIT');return applied;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
