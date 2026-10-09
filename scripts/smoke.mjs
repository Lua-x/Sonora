import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout } from 'node:timers/promises';

// Run only against a disposable installation. Setup refuses existing accounts.
// Private test credentials stay in ignored work/ and are never printed.
const mode = process.argv[2];
assert.ok(['seed', 'verify', 'demo'].includes(mode), 'Usage: node scripts/smoke.mjs seed|verify|demo');
let env = {};
try { env = parseEnv(await readFile('.env', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const base = new URL(process.env.SMOKE_URL || (mode === 'demo' ? 'http://localhost:3001' : env.APP_URL || 'http://localhost:3000'));
const stateFile = resolve(process.env.SMOKE_STATE_FILE || 'work/smoke-state.json');
let cookie = '';

async function request(path, { method = 'GET', data, status = 200, authenticated = true, origin = base.origin } = {}) {
  const response = await fetch(new URL(`/api/${path}`, base), {
    method,
    headers: {
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  // Do not include response bodies, cookies or supplied credentials in failures.
  assert.equal(response.status, status, `${method} /api/${path}: expected ${status}, got ${response.status}`);
  assert.match(response.headers.get('cache-control') || '', /no-store/, `${path}: missing private cache policy`);
  return { data: await response.json(), headers: response.headers };
}

function takeCookie(headers) {
  const value = headers.get('set-cookie') || '';
  assert.ok(/HttpOnly/i.test(value), 'Session must be HTTP-only');
  assert.ok(/SameSite=Strict/i.test(value), 'Session must reject cross-site use');
  if (base.protocol === 'https:') assert.ok(/; Secure/i.test(value), 'HTTPS sessions must be secure');
  const match = value.match(/^sonora_session=[a-f\d]{64}(?=;)/);
  assert.ok(match, 'Missing session cookie');
  cookie = match[0];
}

const fixture = [
  ['2024-03-18T10:00:00Z', 'Wolkenlinie'],
  ['2024-03-18T12:00:00Z', 'Abendlicht'],
  ['2024-03-19T10:00:00Z', 'Wolkenlinie'],
  ['2024-03-01T10:00:00Z', 'Frühling'],
  ['2024-01-01T10:00:00Z', 'Neuanfang'],
  ['2023-12-31T10:00:00Z', 'Jahresende'],
].map(([playedAt, track], i) => ({
  externalId: `sonora-ci-${i}`, playedAt, artist: 'Fiktive CI-Musik', track,
  album: 'Prüfdaten', durationMs: 180000, durationKind: 'measured', tags: ['Testdaten'],
}));

async function importFixture() {
  const { data: preview } = await request('import/preview', {
    method: 'POST', data: { format: 'json', filename: 'sonora-ci-fixture.json', text: JSON.stringify(fixture) },
  });
  assert.deepEqual(preview.errors, [], 'Fixture preview must be valid');
  assert.equal(preview.validRows, fixture.length);
  assert.ok(preview.previewId, 'Fixture preview must be committable');
  const { data: committed } = await request('import/commit', { method: 'POST', data: { previewId: preview.previewId }, status: 202 });
  // A committed preview cannot be scheduled twice.
  await request('import/commit', { method: 'POST', data: { previewId: preview.previewId }, status: 409 });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const { data } = await request('jobs');
    const job = data.jobs.find(item => item.id === committed.jobId);
    assert.ok(job, 'Queued import must remain visible');
    assert.notEqual(job.status, 'failed', 'Worker import failed');
    if (job.status === 'complete') {
      assert.equal(job.progress, 100);
      assert.equal(data.workerHealthy, true, 'Worker heartbeat must be current');
      return;
    }
    await setTimeout(750);
  }
  throw new Error('Worker did not complete fixture import within 60 seconds');
}

async function checkStoredData() {
  const { data: history } = await request('history');
  assert.equal(history.total, fixture.length, 'History count must survive deduplication and restart');
  assert.equal(history.items.length, fixture.length);
  for (const [period, count] of [['day', 2], ['week', 3], ['month', 4], ['year', 5]]) {
    const { data } = await request(`dashboard?period=${period}&date=2024-03-18`);
    assert.equal(data.counts.plays, count, `${period}: wrong calendar count`);
    assert.equal(data.listeningTime.measuredMs, count * 180000, `${period}: wrong listening time`);
    assert.equal(data.period.timezone, 'Europe/Berlin');
  }
  const { data: exported } = await request('export');
  assert.equal(exported.events.length, fixture.length);
  assert.equal(exported.settings.displayName, 'CI-Prüfung');
  assert.ok(exported.sources.every(source => !('secret' in source) && !('apiKey' in source)), 'Export must exclude source secrets');
}

await request('health');
const { data: initialSession } = await request('session', { authenticated: false });
if (mode === 'demo') {
  assert.equal(initialSession.demo, true);
  assert.equal(initialSession.authenticated, true);
  const { data } = await request('dashboard?period=year');
  assert.ok(data.counts.plays > 0, 'Demo must provide fictional sample events');
  await request('settings', { method: 'PATCH', data: { displayName: 'Not allowed' }, status: 403 });
  console.log('Demo smoke passed: fictional dashboard and read-only API.');
} else if (mode === 'seed') {
  assert.equal(initialSession.demo, false);
  assert.equal(initialSession.setupRequired, true, 'Smoke setup requires a fresh disposable installation');
  for (const endpoint of ['dashboard', 'history', 'sources', 'jobs', 'settings', 'export']) {
    await request(endpoint, { authenticated: false, status: 401 });
  }
  await request('auth/setup', { method: 'POST', data: {}, origin: 'https://other.example', status: 403 });
  const setupToken = process.env.SETUP_TOKEN || env.SETUP_TOKEN;
  assert.ok(setupToken && setupToken.length >= 32, 'SETUP_TOKEN must be available in process environment or .env');
  const password = randomBytes(32).toString('hex');
  const setup = await request('auth/setup', { method: 'POST', data: { setupToken, password, displayName: 'CI-Prüfung' }, status: 201 });
  takeCookie(setup.headers);
  await request('auth/setup', { method: 'POST', data: { setupToken, password, displayName: 'Overwrite forbidden' }, status: 409 });
  await request('settings', { method: 'PATCH', data: { theme: 'light' }, origin: 'https://other.example', status: 403 });
  await request('settings', { method: 'PATCH', data: { timezone: 'Europe/Berlin', theme: 'light' } });
  await importFixture();
  await importFixture();
  await checkStoredData();
  await request('auth/logout', { method: 'POST', data: {} });
  await request('history', { status: 401 });
  assert.equal((await request('session')).data.authenticated, false);
  await request('auth/login', { method: 'POST', data: { password: 'a-definitely-incorrect-password' }, status: 401 });
  takeCookie((await request('auth/login', { method: 'POST', data: { password } })).headers);
  await mkdir(resolve(stateFile, '..'), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ cookie, origin: base.origin }), { mode: 0o600, flag: 'wx' });
  console.log('Personal smoke passed: setup, authentication, CSRF, worker import, deduplication, four periods and export.');
} else {
  assert.equal(initialSession.setupRequired, false, 'Account must persist across container recreation');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.origin, base.origin, 'Saved smoke state belongs to a different installation');
  cookie = state.cookie;
  const { data: session } = await request('session');
  assert.equal(session.authenticated, true, 'Session must persist across container recreation');
  assert.equal(session.settings.theme, 'light', 'Settings must persist across container recreation');
  await checkStoredData();
  await importFixture();
  await checkStoredData();
  await request('auth/logout', { method: 'POST', data: {} });
  await request('export', { status: 401 });
  console.log('Persistence smoke passed: account, session, settings, history, statistics and resumed worker.');
}
