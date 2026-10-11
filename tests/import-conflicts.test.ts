import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {POST} from '../src/app/api/[...path]/route';
import {closeDb,getDb} from '../src/lib/db';
import {createSession,HttpError} from '../src/lib/security';
import {allEvents,insertEvents} from '../src/lib/repository';
import {exportEventsJson} from '../src/lib/importer';
import {runOneJob} from '../src/lib/jobs';
import {jobs,sources} from '../src/lib/schema';
import type {ListeningEvent} from '../src/lib/types';

const origin='http://localhost:3000';
let cookie='';
function play(externalId='shared',sourceId='import:json'):ListeningEvent {
  return {sourceId,sourceKind:'json',externalId,playedAt:'2026-03-29T01:30:00.000Z',artist:'Björk',track:'Jóga',album:null,durationMs:null,durationKind:null,tags:[],nowPlaying:false};
}
async function post(path:string,data:unknown) {
  return POST(new Request(`${origin}/api/${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)}));
}
async function preview(rows:unknown,format='json') {
  const response=await post('import/preview',{text:typeof rows==='string'?rows:JSON.stringify(rows),format});
  expect(response.status).toBe(200);
  return response.json();
}
async function commit(previewId:string) {
  const response=await post('import/commit',{previewId});
  expect(response.status).toBe(202);
  return response.json();
}
beforeAll(async()=>{
  process.env.PGLITE_PATH=':memory:';process.env.APP_URL=origin;
  cookie=`sonora_session=${await createSession()}`;
});
beforeEach(async()=>{await (await getDb()).delete(sources);});
afterAll(async()=>{await closeDb();delete process.env.PGLITE_PATH;delete process.env.APP_URL;});

describe('conflicting event IDs across personal imports',()=>{
  it.each([
    {track:'Another song'},
    {artist:'Another artist'},
    {playedAt:'2026-03-29T01:31:00.000Z'},
  ])('rejects an existing ID with changed identity %j in preview',async(change)=>{
    const first=await preview([play()]);
    await commit(first.previewId);await runOneJob();
    const second=await preview([play('skipped'),{...play('skipped'),nowPlaying:true},{...play(),...change}]);
    expect(second.previewId).toBeNull();
    expect(second.errors).toEqual([{row:3,message:expect.stringContaining('externalId')}]);
    expect(await (await getDb()).select().from(jobs)).toHaveLength(1);
    expect(await allEvents()).toEqual([expect.objectContaining(play())]);
  });

  it('reports the original CSV record number after a skipped record',async()=>{
    const db=await getDb();
    await db.insert(sources).values({id:'import:csv',kind:'csv',label:'CSV',enabled:false});
    await insertEvents([{...play('shared','import:csv'),sourceKind:'csv'}]);
    const result=await preview('externalId,playedAt,artist,track,nowPlaying\nignored,2026-03-29T01:30:00Z,Björk,Jóga,true\nshared,2026-03-29T01:30:00Z,Björk,Other,false','csv');
    expect(result.previewId).toBeNull();
    expect(result.errors).toEqual([{row:3,message:expect.stringContaining('externalId')}]);
  });

  it('keeps identical replay idempotent across timestamp and Unicode normalization and retains repeated plays',async()=>{
    const first=await preview([play(),play('repeat')]);
    await commit(first.previewId);await runOneJob();
    const replay=await preview([{...play(),playedAt:'2026-03-29T03:30:00+02:00',artist:'Bjo\u0308rk',track:'Jo\u0301ga'}]);
    expect(replay.errors).toEqual([]);
    const {jobId}=await commit(replay.previewId);await runOneJob();
    const [job]=await (await getDb()).select().from(jobs).where(eq(jobs.id,jobId));
    expect(job.status).toBe('complete');expect(job.payload.inserted).toBe(0);
    expect(await allEvents()).toHaveLength(2);
  });

  it('checks canonical restore IDs within their original source while permitting the same ID in another source',async()=>{
    const original=play('shared','original');
    const first=await preview(exportEventsJson([original]));
    await commit(first.previewId);await runOneJob();
    const conflict=await preview(exportEventsJson([{...original,track:'Changed'}]));
    expect(conflict.previewId).toBeNull();expect(conflict.errors[0].row).toBe(1);
    const restore=await preview(exportEventsJson([original,{...original,sourceId:'different-source',track:'Different source'}]));
    expect(restore.errors).toEqual([]);
    await commit(restore.previewId);await runOneJob();await runOneJob();
    expect(await allEvents('original')).toHaveLength(1);
    expect(await allEvents('different-source')).toHaveLength(1);
  });

  it('fails a stale preview visibly and rolls back all writes in its worker transaction',async()=>{
    const first=await preview([play()]);
    const conflictingRows=[...Array.from({length:201},(_,i)=>play(`new-${i}`)),{...play(),track:'Conflicting later file'}];
    const stale=await preview(conflictingRows);
    expect(stale.errors).toEqual([]);
    await commit(first.previewId);await runOneJob();
    const {jobId}=await commit(stale.previewId);await runOneJob();
    const db=await getDb(),[job]=await db.select().from(jobs).where(eq(jobs.id,jobId));
    const [source]=await db.select().from(sources).where(eq(sources.id,'import:json'));
    expect(job.status).toBe('failed');expect(job.error).toContain('externalId');
    expect(source.error).toBe(job.error);
    expect(await allEvents()).toEqual([expect.objectContaining(play())]);
  });

  it('guards direct repository calls and rejects conflicting IDs within a batch atomically',async()=>{
    const db=await getDb();
    await db.insert(sources).values({id:'import:json',kind:'json',label:'JSON',enabled:false});
    await expect(insertEvents([play(),{...play(),track:'Other'}])).rejects.toBeInstanceOf(HttpError);
    expect(await allEvents()).toHaveLength(0);
    expect(await insertEvents([play(),play()])).toBe(1);
    await expect(insertEvents([play('new'),{...play(),track:'Other'}])).rejects.toMatchObject({status:409});
    expect(await allEvents()).toHaveLength(1);
  });
});
