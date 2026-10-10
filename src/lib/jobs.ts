import {randomUUID} from 'node:crypto';
import {and,eq,lt,lte,or,sql} from 'drizzle-orm';
import {getDb} from './db';
import {jobs,sources,system} from './schema';
import {insertEvents} from './repository';
import {decrypt,HttpError} from './security';
import {connectors,fetchListenBrainzNowPlaying} from './connectors';
import {ConnectorError} from './connectors/http';
import type {ListeningEvent} from './types';

export async function enqueueSync(sourceId:string) {
  const db=await getDb();
  const [source]=await db.select().from(sources).where(eq(sources.id,sourceId));
  if(!source||!source.enabled||!['lastfm','listenbrainz'].includes(source.kind)) throw new HttpError(400,'Diese Quelle ist nicht zur Synchronisation verbunden.');
  const now=new Date().toISOString();
  const [job]=await db.insert(jobs).values({id:randomUUID(),sourceId,type:'sync',status:'queued',payload:{since:source.lastSuccessAt},createdAt:now,updatedAt:now}).onConflictDoNothing().returning({id:jobs.id});
  if(job) return job.id;
  const [active]=await db.select().from(jobs).where(and(eq(jobs.sourceId,sourceId),eq(jobs.type,'sync'),or(eq(jobs.status,'queued'),eq(jobs.status,'running'))));
  return active?.id;
}
export async function scheduleSyncs() {
  const db=await getDb(),now=new Date().toISOString();
  const due=await db.select().from(sources).where(and(eq(sources.enabled,true),or(eq(sources.kind,'lastfm'),eq(sources.kind,'listenbrainz')),or(sql`${sources.nextSyncAt} IS NULL`,lte(sources.nextSyncAt,now))));
  for(const source of due) await enqueueSync(source.id);
  await db.update(jobs).set({status:'queued',updatedAt:now}).where(and(eq(jobs.status,'running'),lt(jobs.updatedAt,new Date(Date.now()-600000).toISOString())));
  await db.delete(jobs).where(and(eq(jobs.status,'preview'),lt(jobs.createdAt,new Date(Date.now()-86400000).toISOString())));
  await db.insert(system).values({key:'workerHeartbeat',value:now}).onConflictDoUpdate({target:system.key,set:{value:now}});
}
export async function runOneJob() {
  const db=await getDb();
  const claim=await db.execute(sql`UPDATE jobs SET status='running',updated_at=now() WHERE id=(SELECT id FROM jobs WHERE status='queued' AND (payload->>'retryAt' IS NULL OR (payload->>'retryAt')::timestamptz<=now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`);
  if(!claim.rows.length) return false;
  const id=String(claim.rows[0].id);
  const [job]=await db.select().from(jobs).where(eq(jobs.id,id));
  if(!job) return true; // A concurrent data deletion cascades to its jobs.
  const [source]=await db.select().from(sources).where(eq(sources.id,job.sourceId));
  if(!source) return true;
  // Lock in the same order as disconnect/delete. No in-flight provider response can
  // insert rows or revive a cancelled job after that transaction has completed.
  async function withActiveJob(action:(tx:Parameters<Parameters<typeof db.transaction>[0]>[0])=>Promise<void>) {
    await db.transaction(async tx=>{
      const [currentSource]=await tx.select().from(sources).where(eq(sources.id,job.sourceId)).for('update');
      if(!currentSource) return;
      const [currentJob]=await tx.select().from(jobs).where(and(eq(jobs.id,id),eq(jobs.status,'running'))).for('update');
      if(!currentJob||(job.type==='sync'&&!currentSource.enabled)) return;
      await action(tx);
    });
  }
  try {
    if(job.type==='import') {
      const input=job.payload.previewEvents||[],processed=job.payload.processed||0;
      await withActiveJob(async tx=>{
        const inserted=await insertEvents(input.slice(processed,processed+500),tx);
        const next=Math.min(input.length,processed+500),done=next>=input.length;
        const totalInserted=(job.payload.inserted||0)+inserted;
        await tx.update(jobs).set({status:done?'complete':'queued',progress:done?100:Math.floor(next/Math.max(1,input.length)*100),payload:done?{processed:next,inserted:totalInserted}:{...job.payload,processed:next,inserted:totalInserted},updatedAt:new Date().toISOString()}).where(eq(jobs.id,id));
        if(done) await tx.update(sources).set({error:null,...(!['lastfm','listenbrainz'].includes(source.kind)?{lastSuccessAt:new Date().toISOString()}:{} )}).where(eq(sources.id,source.id));
      });
    } else {
      if(!source.enabled) throw new HttpError(400,'Quelle wurde getrennt.');
      const connector=connectors[source.kind as 'lastfm'|'listenbrainz'];
      if(!connector||!source.username) throw new HttpError(400,'Quelle ist ungültig.');
      const config={sourceId:source.id,username:source.username,apiKey:source.secret?decrypt(source.secret):undefined,cursor:job.payload.cursor,since:job.payload.since};
      const page=await connector.fetchPage(config);
      // Last.fm reports playing-now on the first page. Historical pages must not
      // erase it; the repository independently expires transient events.
      let nowPlaying:ListeningEvent[]|undefined=source.kind==='lastfm'&&!job.payload.cursor?page.events.filter(e=>e.nowPlaying):undefined;
      let coverageNote=page.coverageNote;
      if(source.kind==='listenbrainz'&&page.done) {
        try { nowPlaying=await fetchListenBrainzNowPlaying(config); }
        catch {
          nowPlaying=[];
          coverageNote+=' Aktuelle Wiedergabe vorübergehend nicht verfügbar; der Hörverlauf wurde erfolgreich synchronisiert.';
        }
      }
      await withActiveJob(async tx=>{
        const inserted=await insertEvents(page.events,tx);
        const now=new Date().toISOString();
        await tx.update(sources).set({coverageNote,...(nowPlaying===undefined?{}:{nowPlaying}),error:null,
          ...(page.done?{lastSuccessAt:now,nextSyncAt:new Date(Date.now()+source.intervalMinutes*60000).toISOString()}:{})}).where(eq(sources.id,source.id));
        await tx.update(jobs).set({status:page.done?'complete':'queued',error:null,progress:page.done?100:Math.min(95,job.progress+1),payload:{cursor:page.cursor,since:job.payload.since,processed:(job.payload.processed||0)+page.events.length,inserted:(job.payload.inserted||0)+inserted},updatedAt:now}).where(eq(jobs.id,id));
      });
    }
  } catch(error) {
    const message=error instanceof HttpError||error instanceof ConnectorError?error.message:'Verarbeitung fehlgeschlagen. Quelleneinstellungen, Erreichbarkeit und Datenformat prüfen; erneut synchronisieren oder importieren.';
    const retrySeconds=error instanceof ConnectorError&&Number.isFinite(error.retryAfterSeconds)?Math.max(0,error.retryAfterSeconds):0;
    const retryAt=new Date(Date.now()+Math.max(retrySeconds*1000,Math.max(30,source.intervalMinutes)*60000)).toISOString();
    await withActiveJob(async tx=>{
      await tx.update(jobs).set({status:retrySeconds?'queued':'failed',error:message,...(retrySeconds?{payload:{...job.payload,retryAt}}:{}),updatedAt:new Date().toISOString()}).where(eq(jobs.id,id));
      await tx.update(sources).set({error:message,nextSyncAt:retryAt}).where(eq(sources.id,job.sourceId));
    });
  }
  return true;
}
let localWorker:ReturnType<typeof setInterval>|undefined;
let localBusy=false;
export function startLocalWorker() {
  if(process.env.LOCAL_WORKER!=='true'||localWorker) return;
  localWorker=setInterval(async()=>{
    if(localBusy)return;localBusy=true;
    try{await scheduleSyncs();await runOneJob();}catch{console.error('Lokaler Worker: Datenbank vorübergehend nicht erreichbar.');}finally{localBusy=false;}
  },1500);
  localWorker.unref();
}
