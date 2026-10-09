import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {closeDb} from '../src/lib/db';
import {assertSameOrigin,authenticated,createSession,decrypt,encrypt,hashPassword,limitAuthentication,verifyPassword,sessionCookie,clearAuthenticationLimit} from '../src/lib/security';
beforeAll(()=>{process.env.PGLITE_PATH=':memory:';process.env.ENCRYPTION_KEY='ab'.repeat(32);process.env.APP_URL='https://sonora.example';});
afterAll(async()=>{await closeDb();delete process.env.PGLITE_PATH;delete process.env.ENCRYPTION_KEY;delete process.env.APP_URL;});
describe('Zugang und Geheimnisse',()=>{
  it('speichert gesalzene Passwort-Hashes und prüft Passwörter',async()=>{
    const hash=await hashPassword('a-long-private-password');expect(hash).not.toContain('private');
    expect(await verifyPassword('a-long-private-password',hash)).toBe(true);
    expect(await verifyPassword('wrong',hash)).toBe(false);
    expect(await hashPassword('a-long-private-password')).not.toBe(hash);
  });
  it('verschlüsselt Tokens und erkennt manipulierte Geheimtexte',()=>{
    const encrypted=encrypt('provider-token');expect(encrypted).not.toContain('provider-token');expect(decrypt(encrypted)).toBe('provider-token');
    const [iv,tag,value]=encrypted.split(':');expect(()=>decrypt(`${iv}:${tag}:${value.startsWith('00')?'01':'00'}${value.slice(2)}`)).toThrow();
  });
  it('blockiert fremde und fehlende Origin-Header',()=>{
    expect(()=>assertSameOrigin(new Request('https://sonora.example/api/data',{method:'DELETE',headers:{Origin:'https://attacker.example'}}))).toThrow();
    expect(()=>assertSameOrigin(new Request('https://sonora.example/api/data',{method:'DELETE'}))).toThrow();
    expect(()=>assertSameOrigin(new Request('https://sonora.example/api/data',{method:'DELETE',headers:{Origin:'https://sonora.example'}}))).not.toThrow();
  });
  it('verwendet sichere, serverseitige und ablaufende Sitzungen',async()=>{
    const token=await createSession();
    expect(sessionCookie(token)).toContain('HttpOnly; SameSite=Strict');expect(sessionCookie(token)).toContain('Secure');
    expect(await authenticated(new Request('https://sonora.example',{headers:{Cookie:`sonora_session=${token}`}}))).toBe(true);
    expect(await authenticated(new Request('https://sonora.example',{headers:{Cookie:`sonora_session=${'0'.repeat(64)}`}}))).toBe(false);
  });
  it('begrenzt Anmeldeversuche persistent',async()=>{
    for(let i=0;i<10;i++)await limitAuthentication();
    await expect(limitAuthentication()).rejects.toThrow('Zu viele');
    await clearAuthenticationLimit();await expect(limitAuthentication()).resolves.toBeUndefined();
  });
});
