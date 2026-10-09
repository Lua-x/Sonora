import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {GET,POST,PATCH,DELETE} from '../src/app/api/[...path]/route';
import {closeDb,getDb} from '../src/lib/db';
import {runOneJob} from '../src/lib/jobs';
import {allEvents} from '../src/lib/repository';
import {sources} from '../src/lib/schema';
const origin='http://localhost:3000';let cookie='';
async function request(path:string,method='GET',data?:unknown,sendCookie=true,requestOrigin=origin){
  const handler={GET,POST,PATCH,DELETE}[method as 'GET'|'POST'|'PATCH'|'DELETE'];
  return handler(new Request(`${origin}/api/${path}`,{method,headers:{Origin:requestOrigin,'Content-Type':'application/json',...(sendCookie?{Cookie:cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)}));
}
beforeAll(()=>{process.env.PGLITE_PATH=':memory:';process.env.APP_URL=origin;process.env.SETUP_TOKEN='test-only-setup-token-not-a-real-credential';process.env.ENCRYPTION_KEY='ab'.repeat(32);});
afterAll(async()=>{await closeDb();for(const key of ['PGLITE_PATH','APP_URL','SETUP_TOKEN','ENCRYPTION_KEY'])delete process.env[key];});
describe('persönliche API vom Erstsetup bis zum Datenexport',()=>{
  it('schützt Daten und akzeptiert nur das gesicherte einmalige Setup',async()=>{
    expect((await request('dashboard')).status).toBe(401);
    expect((await request('auth/setup','POST',{displayName:'Test',password:'long-test-password',setupToken:'invalid'})).status).toBe(403);
    const result=await request('auth/setup','POST',{displayName:'Test',password:'long-test-password',setupToken:process.env.SETUP_TOKEN});
    expect(result.status).toBe(201);cookie=result.headers.get('set-cookie')!.split(';')[0];
    expect((await request('session')).status).toBe(200);
    expect((await request('auth/setup','POST',{displayName:'Other',password:'long-test-password',setupToken:process.env.SETUP_TOKEN})).status).toBe(409);
    expect((await request('settings','PATCH',{displayName:'Attack'},true,'https://unrelated.example')).status).toBe(403);
  });
  it('importiert nach Vorschau und hält einen vollständigen Export bei Reimport duplikatfrei',async()=>{
    const events=[{externalId:'api-1',playedAt:'2026-03-29T00:30:00Z',artist:'Test',track:'Ein Lied'},{externalId:'api-2',playedAt:'2026-03-29T01:30:00Z',artist:'Test',track:'Ein Lied'}];
    let preview=await (await request('import/preview','POST',{text:JSON.stringify(events),format:'json'})).json();
    expect(preview.errors).toEqual([]);expect(await allEvents()).toHaveLength(0);
    expect((await request('import/commit','POST',{previewId:preview.previewId})).status).toBe(202);
    expect((await request('import/commit','POST',{previewId:preview.previewId})).status).toBe(409);
    await runOneJob();expect(await allEvents()).toHaveLength(2);
    const exported=await (await request('export')).json();
    preview=await (await request('import/preview','POST',{text:JSON.stringify(exported),format:'json'})).json();
    expect(preview.errors).toEqual([]);await request('import/commit','POST',{previewId:preview.previewId});await runOneJob();
    expect(await allEvents()).toHaveLength(2);
    expect((await (await request('dashboard?period=day&date=2026-03-29')).json()).counts.plays).toBe(2);
  });
  it('verlangt eine explizite ListenBrainz-Zuordnung und erhält die gewählte Herkunft',async()=>{
    await (await getDb()).insert(sources).values({id:'listenbrainz:tester',kind:'listenbrainz',label:'ListenBrainz',username:'tester',enabled:false});
    const listen={listened_at:1774740600,track_metadata:{artist_name:'Test',track_name:'Export Song'}};
    const preview=await (await request('import/preview','POST',{text:JSON.stringify([listen]),format:'json',sourceId:'listenbrainz:tester'})).json();
    expect(preview.errors).toEqual([]);expect(preview.sample[0].sourceId).toBe('listenbrainz:tester');
    await request('import/commit','POST',{previewId:preview.previewId});await runOneJob();expect(await allEvents('listenbrainz:tester')).toHaveLength(1);
    expect((await request('import/preview','POST',{text:JSON.stringify([{artist:'x',track:'y',playedAt:'2026-01-01T00:00:00Z'}]),format:'json',sourceId:'listenbrainz:tester'})).status).toBe(400);
  });
  it('zeigt Formatfehler und verhindert fiktive Demo-Herkunft im persönlichen Import',async()=>{
    const invalid=await (await request('import/preview','POST',{text:'{invalid',format:'json'})).json();expect(invalid.previewId).toBeNull();expect(invalid.errors.length).toBeGreaterThan(0);
    const fake=await (await request('import/preview','POST',{text:JSON.stringify([{artist:'x',track:'y',playedAt:'2026-01-01T00:00:00Z',sourceKind:'demo'}]),format:'json'})).json();expect(fake.previewId).toBeNull();
    expect((await request('dashboard?period=custom&date=2026-01-01&start=0001-01-01&end=9999-12-31')).status).toBe(400);
  });
  it('exportiert mehrere Quellen und stellt sie idempotent wieder her',async()=>{
    const exported=await (await request('export')).json();expect(exported.sources).toHaveLength(2);
    const preview=await (await request('import/preview','POST',{text:JSON.stringify(exported),format:'json'})).json();expect(preview.errors).toEqual([]);
    const committed=await (await request('import/commit','POST',{previewId:preview.previewId})).json();expect(committed.jobIds).toHaveLength(2);
    await runOneJob();await runOneJob();expect(await allEvents()).toHaveLength(3);
  });
  it('löscht nur bei ausdrücklicher Bestätigung und beendet die Sitzung beim Logout',async()=>{
    expect((await request('data','DELETE',{confirmation:'nein'})).status).toBe(400);
    expect((await request('data','DELETE',{confirmation:'MEINE DATEN LÖSCHEN'})).status).toBe(200);expect(await allEvents()).toHaveLength(0);
    expect((await request('auth/logout','POST')).status).toBe(200);
    expect((await request('export')).status).toBe(401);
  });
});
