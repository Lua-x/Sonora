import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2500, query_timeout: 3000, max: 1 });
try {
  const result = await pool.query<{ value: string }>('SELECT value FROM system WHERE key = $1', ['workerHeartbeat']);
  const heartbeat = Date.parse(result.rows[0]?.value ?? '');
  const age = Date.now() - heartbeat;
  if (!Number.isFinite(heartbeat) || age > 120000 || age < -30000) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
