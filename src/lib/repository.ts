import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {getDb} from './db';
import {events,sources,jobs} from './schema';
import type {ListeningEvent,SourceStatus} from './types';
import {fingerprint} from './connectors/common';
import {HttpError} from './security';

export async function sourceStatuses():Promise<SourceStatus[]> {
  const db=await getDb();
  const rows=await db.select().from(sources).orderBy(asc(sources.label));
  const counts=await db.select({sourceId:events.sourceId,count:sql<number>`count(*)::integer`,earliest:sql<string>`min(played_at)`,latest:sql<string>`max(played_at)`}).from(events).groupBy(events.sourceId);
  const busy=await db.select({sourceId:jobs.sourceId}).from(jobs).where(or(eq(jobs.status,'queued'),eq(jobs.status,'running')));
  return rows.map(s=>{
    const stats=counts.find(x=>x.sourceId===s.id);
    return {id:s.id,kind:s.kind,label:s.label,username:s.username,enabled:s.enabled,intervalMinutes:s.intervalMinutes,lastSuccessAt:s.lastSuccessAt,
      earliestEventAt:stats?.earliest?new Date(stats.earliest).toISOString():null,latestEventAt:stats?.latest?new Date(stats.latest).toISOString():null,eventCount:stats?.count||0,
      status:busy.some(x=>x.sourceId===s.id)?'syncing':s.error?'error':s.enabled?'ready':'disconnected',error:s.error,coverageNote:s.coverageNote};
  });
}
export async function allEvents(sourceId?:string):Promise<ListeningEvent[]> {
  const db=await getDb();
  const rows=await db.select().from(events).where(sourceId?eq(events.sourceId,sourceId):undefined).orderBy(asc(events.playedAt));
  const active=await db.select({nowPlaying:sources.nowPlaying}).from(sources).where(sourceId?eq(sources.id,sourceId):undefined);
  return [...rows.map(row=>({...row,playedAt:new Date(row.playedAt).toISOString(),nowPlaying:false})),...active.flatMap(s=>s.nowPlaying).filter(e=>Date.now()-Date.parse(e.playedAt)<600000)];
}
type Database=Awaited<ReturnType<typeof getDb>>;
type Transaction=Parameters<Parameters<Database['transaction']>[0]>[0];
const eventConflictMessage='Diese externalId gehört in derselben Quelle bereits zu einem anderen Hörereignis. Bitte eindeutige IDs verwenden oder die Datei korrigieren.';
const scopedEventId=(event:Pick<ListeningEvent,'sourceId'|'externalId'>)=>JSON.stringify([event.sourceId,event.externalId]);
// PostgreSQL may return the same instant with a different UTC offset/precision.
const eventIdentity=(event:Pick<ListeningEvent,'playedAt'|'artist'|'track'>)=>fingerprint({...event,playedAt:new Date(event.playedAt).toISOString()});

export async function findEventConflicts(input:ListeningEvent[],database?:Pick<Database,'select'>) {
  const db=database||await getDb(),conflicts:{index:number;message:string}[]=[];
  for(let offset=0;offset<input.length;offset+=200) {
    const batch=input.slice(offset,offset+200);
    const existing=await db.select({sourceId:events.sourceId,externalId:events.externalId,playedAt:events.playedAt,artist:events.artist,track:events.track}).from(events)
      .where(or(...batch.map(event=>and(eq(events.sourceId,event.sourceId),eq(events.externalId,event.externalId)))));
    const identities=new Map(existing.map(event=>[scopedEventId(event),eventIdentity(event)]));
    batch.forEach((event,index)=>{
      const identity=identities.get(scopedEventId(event));
      if(identity!==undefined&&identity!==eventIdentity(event))conflicts.push({index:offset+index,message:eventConflictMessage});
    });
  }
  return conflicts;
}

export async function insertEvents(input:ListeningEvent[],database?:Transaction):Promise<number> {
  if(!database)return (await getDb()).transaction(tx=>insertEvents(input,tx));
  let inserted=0;
  for(let i=0;i<input.length;i+=200) {
    const batch=input.slice(i,i+200).filter(e=>!e.nowPlaying).map(e=>({id:randomUUID(),sourceId:e.sourceId,sourceKind:e.sourceKind,externalId:e.externalId,playedAt:e.playedAt,artist:e.artist,track:e.track,album:e.album,durationMs:e.durationMs,durationKind:e.durationKind,tags:e.tags}));
    if(!batch.length)continue;
    inserted+=(await database.insert(events).values(batch).onConflictDoNothing({target:[events.sourceId,events.externalId]}).returning({id:events.id})).length;
    // Check after the INSERT: a concurrent insert may win after preview validation.
    // The enclosing transaction rolls this batch back instead of silently losing a play.
    const conflicts=await findEventConflicts(batch.map(event=>({...event,nowPlaying:false})),database);
    if(conflicts.length)throw new HttpError(409,eventConflictMessage);
  }
  return inserted;
}
export async function history(query:URLSearchParams) {
  const db=await getDb();
  const page=pageNumber(query.get('page'),1,100000);
  const pageSize=pageNumber(query.get('pageSize'),25,100);
  const q=(query.get('q')||'').slice(0,200).replace(/[\\%_]/g,'\\$&');
  const source=query.get('source');
  const filter=and(q?or(ilike(events.artist,`%${q}%`),ilike(events.track,`%${q}%`),ilike(events.album,`%${q}%`)):undefined,source&&source!=='all'?eq(events.sourceId,source):undefined);
  const sort=query.get('sort');
  const order=sort==='oldest'?asc(events.playedAt):sort==='artist'?asc(events.artist):sort==='track'?asc(events.track):desc(events.playedAt);
  const [count]=await db.select({total:sql<number>`count(*)::integer`}).from(events).where(filter);
  const items=await db.select().from(events).where(filter).orderBy(order,asc(events.id)).limit(pageSize).offset((page-1)*pageSize);
  return {items:items.map(e=>({...e,playedAt:new Date(e.playedAt).toISOString(),nowPlaying:false})),total:count.total,page,pageSize};
}
export function pageNumber(value:string|null,fallback:number,max:number) {
  const parsed=Number(value);
  return Number.isFinite(parsed)&&parsed>0?Math.max(1,Math.min(max,Math.floor(parsed))):fallback;
}
