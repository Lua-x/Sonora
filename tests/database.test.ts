import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {and,eq,or,sql} from 'drizzle-orm';
import {getDb,closeDb,migrate} from '../src/lib/db';
import {events,sources,jobs} from '../src/lib/schema';
import {insertEvents,allEvents,sourceStatuses,history} from '../src/lib/repository';
import {enqueueSync,runOneJob,scheduleSyncs} from '../src/lib/jobs';
import type {ListeningEvent} from '../src/lib/types';
import {connectors} from '../src/lib/connectors';
import {ConnectorError} from '../src/lib/connectors/http';
vi.mock('../src/lib/connectors',()=>({connectors:{lastfm:{fetchPage:vi.fn(async()=>({events:[play('sync-event','lastfm:test')],cursor:null,done:true,coverageNote:'Testquelle'}))}}}));
function play(externalId:string,sourceId='test'):ListeningEvent{return {sourceId,sourceKind:'csv',externalId,playedAt:'2026-03-29T00:30:00Z',artist:'Test Artist',track:'Track',album:null,durationMs:null,durationKind:null,tags:[],nowPlaying:false};}
beforeAll(async()=>{process.env.PGLITE_PATH=':memory:';const db=await getDb();await db.insert(sources).values({id:'test',kind:'csv',label:'Test',enabled:false});});
afterAll(async()=>{await closeDb();delete process.env.PGLITE_PATH;});
describe('persistente Daten und Hintergrundaufträge',()=>{
  it('wendet Migrationen wiederholbar an',async()=>{await migrate(await getDb());expect((await (await getDb()).execute(sql`SELECT * FROM sonora_migrations`)).rows).toHaveLength(1);});
  it('dedupliziert Quelle und Ereignis-ID und erhält echte Wiederholungen',async()=>{
    expect(await insertEvents([play('a'),play('b'),{...play('live'),nowPlaying:true}])).toBe(2);
    expect(await insertEvents([play('a'),play('b')])).toBe(0);
    expect(await allEvents('test')).toHaveLength(2);
    expect((await sourceStatuses())[0].eventCount).toBe(2);
  });
  it('liefert sichere Suche, Sortierung und Pagination',async()=>{
    const result=await history(new URLSearchParams({q:'Test',page:'1',pageSize:'1',sort:'oldest'}));
    expect(result.total).toBe(2);expect(result.items).toHaveLength(1);
    expect((await history(new URLSearchParams({q:"' OR 1=1 --"}))).total).toBe(0);
    expect((await history(new URLSearchParams({page:'Infinity',pageSize:'1.7'}))).items).toHaveLength(1);
  });
  it('erhält Ereignisse aus anderen Quellen',async()=>{
    await (await getDb()).insert(sources).values({id:'other',kind:'json',label:'Other',enabled:false});
    await insertEvents([play('a','other')]);expect(await allEvents()).toHaveLength(3);
  });
  it('übernimmt große Importe stückweise und setzt idempotent fort',async()=>{
    const db=await getDb(),now=new Date().toISOString();
    await db.insert(jobs).values({id:'import-test',type:'import',sourceId:'test',status:'queued',payload:{previewEvents:Array.from({length:520},(_,i)=>play(`batch-${i}`))},createdAt:now,updatedAt:now});
    expect(await runOneJob()).toBe(true);
    expect((await db.select().from(jobs).where(eq(jobs.id,'import-test')))[0].status).toBe('queued');
    await runOneJob();
    const [job]=await db.select().from(jobs).where(eq(jobs.id,'import-test'));
    expect(job.status).toBe('complete');expect(job.payload.inserted).toBe(520);expect(job.payload.previewEvents).toBeUndefined();
  });
  it('verhindert konkurrierende Sync-Aufträge derselben Quelle',async()=>{
    await (await getDb()).insert(sources).values({id:'lastfm:test',kind:'lastfm',label:'Last.fm',username:'test'});
    const [a,b]=await Promise.all([enqueueSync('lastfm:test'),enqueueSync('lastfm:test')]);expect(a).toBe(b);
    await runOneJob();expect(await allEvents('lastfm:test')).toHaveLength(1);
    await enqueueSync('lastfm:test');await runOneJob();expect(await allEvents('lastfm:test')).toHaveLength(1);
  });
  it('holt abgebrochene Aufträge zurück und schreibt Worker-Heartbeat',async()=>{
    const db=await getDb();
    await db.insert(jobs).values({id:'crashed',type:'import',sourceId:'test',status:'running',payload:{previewEvents:[play('after-crash')]},createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z'});
    await scheduleSyncs();expect((await db.select().from(jobs).where(eq(jobs.id,'crashed')))[0].status).toBe('queued');
    await runOneJob();expect((await db.execute(sql`SELECT value FROM system WHERE key='workerHeartbeat'`)).rows).toHaveLength(1);
  });
  it('behält nach einem Anbieterlimit Cursor und früheste erlaubte Wiederholung',async()=>{
    const db=await getDb(),now=new Date().toISOString();
    await db.insert(sources).values({id:'lastfm:limit',kind:'lastfm',label:'Rate limit',username:'limit'});
    const id=await enqueueSync('lastfm:limit');
    await db.update(jobs).set({payload:{cursor:'saved-page',since:now}}).where(eq(jobs.id,id!));
    vi.mocked(connectors.lastfm.fetchPage).mockRejectedValueOnce(new ConnectorError('Anbieterlimit',7200));
    await runOneJob();
    const [job]=await db.select().from(jobs).where(eq(jobs.id,id!));
    expect(job.status).toBe('queued');expect(job.payload.cursor).toBe('saved-page');
    expect(Date.parse(job.payload.retryAt!)).toBeGreaterThanOrEqual(Date.parse(now)+7200000);
    expect(await runOneJob()).toBe(false);
    await db.delete(sources).where(eq(sources.id,'lastfm:limit'));
  });
  it('verwirft eine laufende Provider-Antwort nach dem Trennen der Quelle',async()=>{
    const db=await getDb();
    await db.insert(sources).values({id:'lastfm:disconnect',kind:'lastfm',label:'Disconnect',username:'disconnect'});
    const id=await enqueueSync('lastfm:disconnect');
    vi.mocked(connectors.lastfm.fetchPage).mockImplementationOnce(async()=>{
      await db.transaction(async tx=>{
        await tx.update(sources).set({enabled:false,secret:null,nowPlaying:[],error:null}).where(eq(sources.id,'lastfm:disconnect'));
        await tx.update(jobs).set({status:'failed',error:'Quelle wurde getrennt.',payload:{}}).where(and(eq(jobs.sourceId,'lastfm:disconnect'),or(eq(jobs.status,'queued'),eq(jobs.status,'running'))));
      });
      return {events:[play('late-result','lastfm:disconnect')],cursor:null,done:true,coverageNote:'Too late'};
    });
    await runOneJob();
    expect(await allEvents('lastfm:disconnect')).toHaveLength(0);
    expect((await db.select().from(jobs).where(eq(jobs.id,id!)))[0].status).toBe('failed');
    expect((await db.select().from(sources).where(eq(sources.id,'lastfm:disconnect')))[0].error).toBeNull();
  });
  it('erzeugt nach Datenlöschung während eines Providerabrufs keine Ereignisse neu',async()=>{
    const db=await getDb();
    await db.insert(sources).values({id:'lastfm:delete',kind:'lastfm',label:'Delete',username:'delete'});
    await enqueueSync('lastfm:delete');
    vi.mocked(connectors.lastfm.fetchPage).mockImplementationOnce(async()=>{
      await db.delete(sources).where(eq(sources.id,'lastfm:delete'));
      return {events:[play('late-result','lastfm:delete')],cursor:null,done:true,coverageNote:'Too late'};
    });
    expect(await runOneJob()).toBe(true);
    expect(await allEvents('lastfm:delete')).toHaveLength(0);
  });
  it('löscht zugehörige Daten und Aufträge über Fremdschlüssel',async()=>{
    await (await getDb()).delete(sources).where(eq(sources.id,'test'));
    expect(await allEvents('test')).toHaveLength(0);
    expect(await (await getDb()).select().from(events).where(eq(events.sourceId,'test'))).toHaveLength(0);
    expect(await (await getDb()).select().from(jobs).where(eq(jobs.sourceId,'test'))).toHaveLength(0);
  });
});
