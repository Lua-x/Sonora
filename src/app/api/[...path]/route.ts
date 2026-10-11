import {randomUUID} from 'node:crypto';
import {and,desc,eq,or,sql} from 'drizzle-orm';
import {z} from 'zod';
import {getDb} from '@/lib/db';
import {users,sessions,sources,jobs} from '@/lib/schema';
import {allEvents,findEventConflicts,history,pageNumber,sourceStatuses} from '@/lib/repository';
import {assertSameOrigin,authenticated,clearAuthenticationLimit,createSession,encrypt,equalSecret,getUser,hash,hashPassword,HttpError,limitAuthentication,requestToken,requireAuth,sessionCookie,verifyPassword} from '@/lib/security';
import {buildPeriod,computeAnalytics} from '@/lib/analytics';
import {demoData} from '@/lib/demo';
import {MAX_IMPORT_BYTES,parseImport} from '@/lib/importer';
import {enqueueSync,startLocalWorker} from '@/lib/jobs';
import type {PeriodKind,UserSettings} from '@/lib/types';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const defaultSettings:UserSettings={displayName:'Du',timezone:'Europe/Berlin',theme:'dark'};
const demo=()=>process.env.DEMO_MODE==='true';
const json=(value:unknown,status=200,headers:HeadersInit={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store',...headers}});

async function body(request:Request,limit=100000) {
  if(!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415,'Bitte JSON senden.');
  if(Number(request.headers.get('content-length')||0)>limit) throw new HttpError(413,'Die Anfrage ist zu groß.');
  const reader=request.body?.getReader();if(!reader) throw new HttpError(400,'Anfragedaten fehlen.');
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new HttpError(413,'Die Anfrage ist zu groß.');}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new HttpError(400,'Die JSON-Datei ist ungültig.');}
}
const settingsSchema=z.object({displayName:z.string().trim().min(1).max(80),timezone:z.string().refine(value=>{try{new Intl.DateTimeFormat('de',{timeZone:value});return true;}catch{return false;}},'Unbekannte Zeitzone'),theme:z.enum(['dark','light','system'])});

async function dispatch(request:Request) {
  const url=new URL(request.url),path=url.pathname.replace(/^\/api\//,'').replace(/\/$/,''),method=request.method;
  if(!['GET','HEAD'].includes(method)) assertSameOrigin(request);
  if(path==='health'&&method==='GET') {
    if(!demo()) await (await getDb()).execute(sql`SELECT 1`);
    return json({ok:true,mode:demo()?'demo':'personal'});
  }
  if(path==='session'&&method==='GET') {
    if(demo())return json({authenticated:true,setupRequired:false,demo:true,settings:{...defaultSettings,displayName:'Demo'}});
    const user=await getUser(),auth=await authenticated(request);
    return json({authenticated:auth,setupRequired:!user,demo:false,...(auth?{settings:user.settings}:{})});
  }
  if(path==='auth/setup'&&method==='POST') {
    if(demo())throw new HttpError(403,'Im Demo-Modus ist die Einrichtung deaktiviert.');
    await limitAuthentication();
    if(await getUser())throw new HttpError(409,'Sonora wurde bereits eingerichtet. Bitte anmelden.');
    const input=z.object({setupToken:z.string().max(200),password:z.string().min(12,'Das Passwort benötigt mindestens 12 Zeichen.').max(200),displayName:z.string().trim().min(1).max(80)}).parse(await body(request));
    if(!process.env.SETUP_TOKEN||process.env.SETUP_TOKEN.length<32)throw new HttpError(503,'Ein sicherer SETUP_TOKEN muss zunächst in der Serverkonfiguration hinterlegt werden.');
    if(!equalSecret(input.setupToken,process.env.SETUP_TOKEN))throw new HttpError(403,'Der Einrichtungstoken ist ungültig.');
    const inserted=await (await getDb()).insert(users).values({id:1,passwordHash:await hashPassword(input.password),settings:{...defaultSettings,displayName:input.displayName}}).onConflictDoNothing().returning({id:users.id});
    if(!inserted.length)throw new HttpError(409,'Sonora wurde bereits eingerichtet.');
    await clearAuthenticationLimit();
    return json({ok:true},201,{'Set-Cookie':sessionCookie(await createSession())});
  }
  if(path==='auth/login'&&method==='POST') {
    if(demo())return json({ok:true});
    await limitAuthentication();
    const input=z.object({password:z.string().min(1).max(200)}).parse(await body(request));
    const user=await getUser();
    if(!user||!await verifyPassword(input.password,user.passwordHash))throw new HttpError(401,'Das Passwort ist nicht korrekt.');
    await clearAuthenticationLimit();
    return json({ok:true},200,{'Set-Cookie':sessionCookie(await createSession())});
  }
  if(demo()&&!['GET','HEAD'].includes(method))throw new HttpError(403,'Der Demo-Modus verwendet ausschließlich fiktive Daten und ist schreibgeschützt.');
  if(!demo()){await requireAuth(request);startLocalWorker();}
  if(path==='auth/logout'&&method==='POST') {
    await (await getDb()).delete(sessions).where(eq(sessions.tokenHash,hash(requestToken(request))));
    return json({ok:true},200,{'Set-Cookie':sessionCookie('',0)});
  }
  if(path==='dashboard'&&method==='GET') {
    const kind=z.enum(['day','week','month','year','custom']).parse(url.searchParams.get('period')||'week') as PeriodKind;
    const settings=demo()?defaultSettings:(await getUser()).settings;
    const date=url.searchParams.get('date')||new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const period=buildPeriod(kind,date,settings.timezone,url.searchParams.get('start')||undefined,url.searchParams.get('end')||undefined);
    const selected=url.searchParams.get('source'),sourceId=selected&&selected!=='all'?selected:undefined;
    const data=demo()?demoData():{events:await allEvents(),sources:await sourceStatuses()};
    return json(computeAnalytics(data.events.filter(e=>!sourceId||e.sourceId===sourceId),data.sources.filter(s=>!sourceId||s.id===sourceId),period,new Date(),data.events));
  }
  if(path==='history'&&method==='GET') {
    if(!demo())return json(await history(url.searchParams));
    const q=(url.searchParams.get('q')||'').toLocaleLowerCase('de');
    let items=demoData().events.filter(e=>!e.nowPlaying&&(!q||`${e.artist} ${e.track} ${e.album}`.toLocaleLowerCase('de').includes(q)));
    const source=url.searchParams.get('source');if(source&&source!=='all')items=items.filter(e=>e.sourceId===source);
    const sort=url.searchParams.get('sort');
    items.sort((a,b)=>sort==='artist'?a.artist.localeCompare(b.artist):sort==='track'?a.track.localeCompare(b.track):sort==='oldest'?a.playedAt.localeCompare(b.playedAt):b.playedAt.localeCompare(a.playedAt));
    const total=items.length,page=pageNumber(url.searchParams.get('page'),1,100000),pageSize=pageNumber(url.searchParams.get('pageSize'),25,100);
    return json({items:items.slice((page-1)*pageSize,page*pageSize),total,page,pageSize});
  }
  if(path==='sources'&&method==='GET')return json({sources:demo()?demoData().sources:await sourceStatuses()});
  if(path==='sources'&&method==='POST') {
    const input=z.object({kind:z.enum(['lastfm','listenbrainz']),username:z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_\-.]+$/,'Der Benutzername enthält unzulässige Zeichen.'),apiKey:z.string().trim().max(200).optional(),intervalMinutes:z.number().int().min(5).max(1440).default(Number(process.env.SYNC_INTERVAL_MINUTES)||30)}).parse(await body(request));
    const db=await getDb(),id=`${input.kind}:${input.username.toLowerCase()}`;
    const [existing]=await db.select().from(sources).where(eq(sources.id,id));
    if(input.kind==='lastfm'&&!input.apiKey&&!existing?.secret)throw new HttpError(400,'Für Last.fm ist dein persönlicher API-Schlüssel erforderlich.');
    const source={id,kind:input.kind,label:input.kind==='lastfm'?'Last.fm':'ListenBrainz',username:input.username,secret:input.apiKey?encrypt(input.apiKey):existing?.secret||null,enabled:true,intervalMinutes:input.intervalMinutes,error:null,nextSyncAt:new Date().toISOString()};
    await db.insert(sources).values(source).onConflictDoUpdate({target:sources.id,set:source});
    const jobId=await enqueueSync(id);
    return json({ok:true,id,jobId},201);
  }
  const syncMatch=path.match(/^sources\/([^/]+)\/sync$/);
  if(syncMatch&&method==='POST')return json({jobId:await enqueueSync(decodeURIComponent(syncMatch[1]))},202);
  const sourceMatch=path.match(/^sources\/([^/]+)$/);
  if(sourceMatch&&method==='DELETE') {
    const id=decodeURIComponent(sourceMatch[1]),db=await getDb();
    await db.transaction(async tx=>{
      if(url.searchParams.get('deleteData')==='true') {await tx.delete(sources).where(eq(sources.id,id));return;}
      await tx.update(sources).set({enabled:false,secret:null,nowPlaying:[],error:null}).where(eq(sources.id,id));
      await tx.update(jobs).set({status:'failed',error:'Quelle wurde getrennt.',payload:{},updatedAt:new Date().toISOString()}).where(and(eq(jobs.sourceId,id),or(eq(jobs.status,'queued'),eq(jobs.status,'running'))));
    });
    return json({ok:true});
  }
  if(path==='import/preview'&&method==='POST') {
    // JSON escaping can double a valid file's wire size; enforce the file limit separately.
    const input=z.object({text:z.string().min(1),format:z.enum(['csv','json','spotify']),filename:z.string().max(255).optional(),sourceId:z.string().min(1).max(256).optional()}).parse(await body(request,MAX_IMPORT_BYTES*2+10000));
    if(Buffer.byteLength(input.text,'utf8')>MAX_IMPORT_BYTES)throw new HttpError(413,'Dateien dürfen maximal 20 MiB groß sein.');
    const db=await getDb();let sourceId=`import:${input.format}`;
    let preview=parseImport(input.text,input.format,sourceId);
    if(input.sourceId) {
      if(!preview.listenBrainzExport)throw new HttpError(400,'Eine ListenBrainz-Quelle kann nur einem offiziellen ListenBrainz-Export zugeordnet werden.');
      const [target]=await db.select().from(sources).where(eq(sources.id,input.sourceId));
      if(!target||target.kind!=='listenbrainz')throw new HttpError(400,'Die ausgewählte ListenBrainz-Quelle ist nicht vorhanden.');
      sourceId=target.id;preview=parseImport(input.text,input.format,sourceId);
    } else if(preview.listenBrainzExport) {
      preview.warnings.push('ListenBrainz-Export wird separat gespeichert. Für belastbaren Abgleich mit einem synchronisierten Konto muss dessen Quelle ausdrücklich als Importziel ausgewählt werden.');
    }
    if(preview.totalRows>100000)throw new HttpError(413,'Maximal 100.000 Zeilen pro Datei. Bitte die Datei aufteilen.');
    const conflicts=await findEventConflicts(preview.events,db);
    preview.errors.push(...conflicts.map(conflict=>({row:preview.eventRows[conflict.index],message:conflict.message})));
    const previewId=randomUUID(),now=new Date().toISOString();
    if(!preview.errors.length&&preview.events.length)await db.transaction(async tx=>{
      const definitions=preview.restoredSources||[{id:sourceId,kind:input.sourceId?'listenbrainz' as const:input.format,label:input.format==='spotify'?'Spotify-Dateiexport':`${input.format.toUpperCase()}-Import`}];
      for(const definition of definitions.sort((a,b)=>a.id.localeCompare(b.id))) {
        const [existing]=await tx.select().from(sources).where(eq(sources.id,definition.id)).for('update');
        if(existing&&existing.kind!==definition.kind)throw new HttpError(409,'Eine Quellen-ID aus dem Export gehört bereits zu einem anderen Quellentyp.');
        if(input.sourceId&&!existing)throw new HttpError(409,'Die ausgewählte Quelle wurde inzwischen gelöscht. Bitte die Vorschau erneut erstellen.');
        await tx.insert(sources).values({...definition,enabled:false,coverageNote:'Vom Nutzer importierte Datei. Zeitraum und Vollständigkeit hängen vom Export ab; fehlende Ereignisse sind nicht erkennbar.'}).onConflictDoNothing();
        const previewEvents=preview.events.filter(event=>event.sourceId===definition.id);
        await tx.insert(jobs).values({id:randomUUID(),type:'import',sourceId:definition.id,status:'preview',payload:{previewGroupId:previewId,previewEvents},createdAt:now,updatedAt:now});
      }
    });
    const dates=preview.events.map(event=>event.playedAt).sort();
    return json({previewId:!preview.errors.length&&preview.events.length?previewId:null,totalRows:preview.totalRows,validRows:preview.events.length,errors:preview.errors,warnings:preview.warnings,sample:preview.events.slice(0,8),earliestEventAt:dates[0]||null,latestEventAt:dates.at(-1)||null});
  }
  if(path==='import/commit'&&method==='POST') {
    const input=z.object({previewId:z.string().uuid()}).parse(await body(request));
    const db=await getDb(),now=new Date().toISOString();
    const queued=await db.update(jobs).set({status:'queued',updatedAt:now}).where(and(or(eq(jobs.id,input.previewId),sql`${jobs.payload}->>'previewGroupId'=${input.previewId}`),eq(jobs.status,'preview'),sql`${jobs.createdAt}>now()-interval '24 hours'`)).returning({id:jobs.id});
    if(!queued.length)throw new HttpError(409,'Diese Vorschau wurde bereits übernommen oder ist abgelaufen. Bitte Datei erneut prüfen.');
    return json({jobId:queued[0].id,jobIds:queued.map(job=>job.id)},202);
  }
  if(path==='jobs'&&method==='GET') {
    if(demo())return json({jobs:[]});
    const db=await getDb();
    const rows=await db.select({id:jobs.id,type:jobs.type,status:jobs.status,progress:jobs.progress,error:jobs.error,createdAt:jobs.createdAt}).from(jobs).where(sql`${jobs.status}<>'preview'`).orderBy(desc(jobs.createdAt)).limit(20);
    const heartbeat=await db.execute(sql`SELECT value FROM system WHERE key='workerHeartbeat'`);
    return json({jobs:rows,workerHealthy:heartbeat.rows.length>0&&Date.now()-Date.parse(String(heartbeat.rows[0].value))<120000});
  }
  if(path==='settings'&&method==='GET')return json(demo()?defaultSettings:(await getUser()).settings);
  if(path==='settings'&&method==='PATCH') {
    const input=settingsSchema.partial().parse(await body(request));
    const user=await getUser();const settings={...user.settings,...input};
    await (await getDb()).update(users).set({settings}).where(eq(users.id,1));return json(settings);
  }
  if(path==='export'&&method==='GET') {
    const data=demo()?demoData():{events:await allEvents(),sources:await sourceStatuses()};
    const payload={version:1,exportedAt:new Date().toISOString(),settings:demo()?defaultSettings:(await getUser()).settings,sources:data.sources,events:data.events.filter(e=>!e.nowPlaying)};
    return new Response(JSON.stringify(payload,null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="sonora-export.json"','Cache-Control':'no-store'}});
  }
  if(path==='data'&&method==='DELETE') {
    const input=z.object({confirmation:z.literal('MEINE DATEN LÖSCHEN')}).parse(await body(request));void input;
    await (await getDb()).transaction(async tx=>{await tx.delete(sources);await tx.update(users).set({settings:defaultSettings}).where(eq(users.id,1));});
    return json({ok:true});
  }
  throw new HttpError(404,'Dieser Endpunkt ist nicht verfügbar.');
}
async function handle(request:Request) {
  try{return await dispatch(request);}
  catch(error){
    if(error instanceof HttpError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError)return json({error:error.issues.map(i=>i.message).join(' ')},400);
    if(error instanceof RangeError)return json({error:'Ungültiger Zeitraum oder ungültige Zeitzone.'},400);
    // Never return database/provider exceptions: they may contain credentials or personal rows.
    console.error('Sonora: Anfrage konnte nicht verarbeitet werden.');
    return json({error:'Die Anfrage konnte nicht verarbeitet werden. Bitte Datenbank, Konfiguration und Eingaben prüfen.'},500);
  }
}
export {handle as GET,handle as POST,handle as PATCH,handle as DELETE};
