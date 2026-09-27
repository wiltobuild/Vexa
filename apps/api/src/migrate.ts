import pg from 'pg';
import { databaseUrl } from './config.js';
import { applyMigrations, readMigrations } from './migrations.js';
const pool=new pg.Pool({connectionString:databaseUrl(process.env),max:1});
try{
 const applied=await applyMigrations(pool,await readMigrations(new URL('../../../infra/migrations/',import.meta.url)));
 console.log(applied.length?`Applied migrations: ${applied.join(', ')}`:'Database is up to date');
}catch(error){console.error(error instanceof Error?error.message:'Migration failed');process.exitCode=1;}finally{await pool.end();}
