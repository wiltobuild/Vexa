import {readFile} from 'node:fs/promises';import {db,redis} from './db.js';
try {await db.query(await readFile(new URL('../../../infra/schema.sql',import.meta.url),'utf8'));console.log('Schema applied');}finally{await db.end();redis.disconnect();}
