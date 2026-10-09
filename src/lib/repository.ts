import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {getDb} from './db';
import {events,sources,jobs} from './schema';
import type {ListeningEvent,SourceStatus} from './types';

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
export async function insertEvents(input:ListeningEvent[],database?:Pick<Awaited<ReturnType<typeof getDb>>,'insert'>) {
  const db=database||await getDb();let inserted=0;
  for(let i=0;i<input.length;i+=200) {
    const batch=input.slice(i,i+200).filter(e=>!e.nowPlaying).map(e=>({id:randomUUID(),sourceId:e.sourceId,sourceKind:e.sourceKind,externalId:e.externalId,playedAt:e.playedAt,artist:e.artist,track:e.track,album:e.album,durationMs:e.durationMs,durationKind:e.durationKind,tags:e.tags}));
    if(batch.length) inserted+=(await db.insert(events).values(batch).onConflictDoNothing({target:[events.sourceId,events.externalId]}).returning({id:events.id})).length;
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
