import { createHash, randomBytes, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, lt, sql } from 'drizzle-orm';
import { getDb } from './db';
import { users, sessions, authAttempts } from './schema';
const scryptAsync=promisify(scrypt);
export class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function equalSecret(a:string,b:string) {return timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));}
export async function hashPassword(password:string) {
  const salt=randomBytes(16).toString('hex');
  const key=await scryptAsync(password,salt,64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password:string,encoded:string) {
  const [algorithm,salt,key]=encoded.split(':');
  if(algorithm!=='scrypt'||!salt||!key) return false;
  const actual=await scryptAsync(password,salt,64) as Buffer;
  const expected=Buffer.from(key,'hex');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
function encryptionKey() {
  const key=process.env.ENCRYPTION_KEY;
  if(!key||!/^[a-f\d]{64}$/i.test(key)) throw new HttpError(503,'ENCRYPTION_KEY muss serverseitig als 64 Hex-Zeichen konfiguriert sein.');
  return Buffer.from(key,'hex');
}
export function encrypt(value:string) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv.toString('hex'),cipher.getAuthTag().toString('hex'),encrypted.toString('hex')].join(':');
}
export function decrypt(value:string) {
  const [iv,tag,data]=value.split(':');
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'hex'));
  decipher.setAuthTag(Buffer.from(tag,'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data,'hex')),decipher.final()]).toString('utf8');
}
export function appOrigin() {
  const raw=process.env.APP_URL||'http://localhost:3000';
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol)) throw new Error('APP_URL ungültig.');
  return url.origin;
}
export function assertSameOrigin(request:Request) {
  if(request.headers.get('origin')!==appOrigin()) throw new HttpError(403,'Die Anfrage stammt nicht von der konfigurierten Sonora-Adresse (APP_URL).');
  if(request.headers.get('sec-fetch-site')==='cross-site') throw new HttpError(403,'Seitenübergreifende Anfrage blockiert.');
}
export function sessionCookie(token:string,maxAge=604800) {
  return `sonora_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${appOrigin().startsWith('https:')?'; Secure':''}`;
}
export function requestToken(request:Request) {
  return request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('sonora_session='))?.slice(15)||'';
}
export async function authenticated(request:Request) {
  const token=requestToken(request);
  if(!/^[a-f\d]{64}$/.test(token)) return false;
  const db=await getDb();
  const [session]=await db.select().from(sessions).where(eq(sessions.tokenHash,hash(token)));
  return !!session&&new Date(session.expiresAt)>new Date();
}
export async function requireAuth(request:Request) {
  if(!await authenticated(request)) throw new HttpError(401,'Bitte melde dich an.');
}
export async function createSession() {
  const db=await getDb(),token=randomBytes(32).toString('hex');
  await db.delete(sessions).where(lt(sessions.expiresAt,new Date().toISOString()));
  await db.insert(sessions).values({tokenHash:hash(token),expiresAt:new Date(Date.now()+604800000).toISOString()});
  return token;
}
export async function getUser() {return (await (await getDb()).select().from(users).where(eq(users.id,1)))[0];}
export async function limitAuthentication() {
  const db=await getDb();
  const result=await db.execute(sql`INSERT INTO auth_attempts (key,count,resets_at) VALUES ('personal',1,now()+interval '15 minutes')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_attempts.resets_at < now() THEN 1 ELSE auth_attempts.count+1 END,
    resets_at=CASE WHEN auth_attempts.resets_at < now() THEN now()+interval '15 minutes' ELSE auth_attempts.resets_at END RETURNING count`);
  if(Number(result.rows[0].count)>10) throw new HttpError(429,'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.');
}
export async function clearAuthenticationLimit() {await (await getDb()).delete(authAttempts).where(eq(authAttempts.key,'personal'));}
