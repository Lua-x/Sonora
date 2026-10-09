import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { ListeningEvent } from '../types';

export function fingerprint(event: Pick<ListeningEvent, 'playedAt' | 'artist' | 'track'>): string {
  return createHash('sha256').update(JSON.stringify([event.playedAt, event.artist.normalize('NFC'), event.track.normalize('NFC')])).digest('hex');
}

export function eventId(event: Pick<ListeningEvent, 'playedAt' | 'artist' | 'track'>, occurrence: number): string {
  return `${fingerprint(event)}:${occurrence}`;
}

export function utcTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error('Zeitstempel benötigt ISO 8601 mit Zeitzone, z. B. 2026-10-08T20:15:00+02:00.');
  }
  const date = DateTime.fromISO(value, { setZone: true });
  if (!date.isValid || date.year < 1970 || date.toMillis() > Date.now() + 86_400_000) {
    throw new Error('Zeitstempel ist ungültig, liegt vor 1970 oder mehr als einen Tag in der Zukunft.');
  }
  return date.toUTC().toISO()!;
}

export function epochTimestamp(value: unknown): string {
  const epoch = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch * 1000 > Date.now() + 86_400_000) throw new Error('Ungültiger UTC-Zeitstempel der Quelle.');
  return new Date(epoch * 1000).toISOString();
}

export function textField(value: unknown, label: string, required = true): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if ((required && !result) || result.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
    throw new Error(`${label} fehlt oder ist ungültig (maximal 1.000 Zeichen).`);
  }
  return result;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Datensatz muss ein JSON-Objekt sein.');
  return value as Record<string, unknown>;
}

export function duration(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 0 || result > 2_073_600_000) throw new Error('Dauer muss eine nicht negative ganze Zahl in Millisekunden sein (höchstens 24 Tage).');
  return result;
}

export function validUsername(value: string): string {
  if (!value.trim() || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw new Error('Bitte einen gültigen Benutzernamen eingeben.');
  return value.trim();
}

export function cursorObject(cursor?: string | null): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 100_000) throw new Error();
    return object(JSON.parse(cursor));
  } catch {
    throw new Error('Ungültiger Synchronisationscursor. Synchronisation neu starten.');
  }
}

export function sinceEpoch(since?: string | null): number | null {
  return since ? Math.floor(new Date(utcTimestamp(since)).getTime() / 1000) : null;
}
