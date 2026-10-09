import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;
const globalDb = globalThis as unknown as { sonoraDb?: Promise<Database>; sonoraClose?: ()=>Promise<void> };
export async function getDb(): Promise<Database> {
  if (!globalDb.sonoraDb) globalDb.sonoraDb = (async()=>{
    if (process.env.PGLITE_PATH) {
      if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_LOCAL_DATABASE) throw new Error('PGlite ist nur für lokale Entwicklung und Tests vorgesehen.');
      const {PGlite} = await import('@electric-sql/pglite');
      const {drizzle: drizzleLite} = await import('drizzle-orm/pglite');
      const client = new PGlite(process.env.PGLITE_PATH === ':memory:' ? undefined : process.env.PGLITE_PATH);
      globalDb.sonoraClose = ()=>client.close();
      const db = drizzleLite(client,{schema}) as unknown as Database;
      await migrate(db);
      return db;
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL fehlt.');
    const pool = new Pool({connectionString:process.env.DATABASE_URL,max:8,connectionTimeoutMillis:10000});
    pool.on('error',()=>console.error('Datenbankverbindung unterbrochen.'));
    globalDb.sonoraClose = ()=>pool.end();
    return drizzle(pool,{schema});
  })();
  return globalDb.sonoraDb;
}
export async function closeDb() { await globalDb.sonoraClose?.(); delete globalDb.sonoraDb; delete globalDb.sonoraClose; }
export async function migrate(db:Database) {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS sonora_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const name='0001_initial.sql';
  const source=await readFile(path.join(process.cwd(),'migrations',name),'utf8');
  const checksum=createHash('sha256').update(source).digest('hex');
  await db.transaction(async tx=>{
    await tx.execute(sql`LOCK TABLE sonora_migrations IN EXCLUSIVE MODE`);
    const existing=await tx.execute(sql`SELECT checksum FROM sonora_migrations WHERE name=${name}`);
    if(existing.rows.length) {
      if(existing.rows[0].checksum!==checksum) throw new Error('Bereits angewendete Migration wurde verändert. Neue Migration anlegen.');
      return;
    }
    for(const statement of source.split(';').map(s=>s.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
    await tx.execute(sql`INSERT INTO sonora_migrations(name,checksum) VALUES(${name},${checksum})`);
  });
}
