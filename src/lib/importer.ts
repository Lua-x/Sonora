import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { ImportPreview, ListeningEvent, SourceKind } from './types';
import { duration, eventId, fingerprint, object, textField, utcTimestamp } from './connectors/common';
import { listenBrainzEvent } from './connectors/listenbrainz';

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;
const SOURCE_KINDS: SourceKind[] = ['lastfm', 'listenbrainz', 'csv', 'json', 'spotify'];
const SPOTIFY_WARNING = 'Persönlicher Spotify-Datenexport: keine Spotify-API-Verbindung. Zeitstempel bezeichnet das Stream-Ende; Wiedergaben einschließlich kurzer/abgebrochener Streams. Nur eigene Daten lokal auswerten.';

function parseRows(text: string, format: ImportPreview['format']): {rows:unknown[];canonical?:Record<string,unknown>} {
  if (format === 'csv') {
    const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
    return {rows:parse(text, {
      bom: true, columns: true, skip_empty_lines: true, trim: true,
      delimiter: firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',',
      max_record_size: 100_000, relax_column_count: false,
    }) as unknown[]};
  }
  const clean = text.replace(/^\uFEFF/, '').trim();
  let data: unknown;
  try { data = JSON.parse(clean); }
  catch {
    // Official ListenBrainz exports use one JSON object per line.
    if (format !== 'json' || !clean.includes('\n')) throw new Error('Ungültiges JSON. Erwartet wird eine Liste von Hörereignissen.');
    return {rows:clean.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line) as unknown; }
      catch { throw new Error(`Ungültiges JSON in Zeile ${index + 1}.`); }
    })};
  }
  if (Array.isArray(data)) return {rows:data};
  const root = object(data);
  if (Array.isArray(root.events)) return {rows:root.events,...(root.schemaVersion===1||root.version===1?{canonical:root}:{})};
  if (Array.isArray(root.listens)) return {rows:root.listens};
  if (root.payload && Array.isArray(object(root.payload).listens)) return {rows:object(root.payload).listens as unknown[]};
  if (root.track_metadata && root.listened_at !== undefined) return {rows:[root]};
  throw new Error('JSON benötigt eine Liste, {"events": […]} oder einen ListenBrainz-Export.');
}

function boolean(value: unknown): boolean {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === undefined || value === null || value === '' || value === false || value === 'false' || value === '0' || value === 0) return false;
  throw new Error('nowPlaying muss true oder false sein.');
}

function tags(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const values = typeof value === 'string' ? value.split('|') : value;
  if (!Array.isArray(values) || values.length > 50) throw new Error('Tags müssen eine Liste mit höchstens 50 Texten sein (CSV: mit | trennen).');
  return [...new Set(values.map((tag) => textField(tag, 'Tag')).map((tag) => {
    if (tag.length > 64) throw new Error('Ein Tag darf höchstens 64 Zeichen enthalten.');
    return tag;
  }))];
}

function genericEvent(row: Record<string, unknown>, sourceId: string, format: 'csv' | 'json', warnings: Set<string>): ListeningEvent {
  if(row.sourceKind==='demo') throw new Error('Fiktive Demo-Ereignisse dürfen nicht in persönliche Hörverläufe importiert werden.');
  if(row.sourceKind!==undefined&&!SOURCE_KINDS.includes(row.sourceKind as SourceKind)) throw new Error('Unbekannte Herkunft sourceKind.');
  if (row.track_metadata && row.listened_at !== undefined) return listenBrainzEvent(row, sourceId);
  if ('ts' in row || 'endTime' in row) throw new Error('Spotify-Export erkannt. Bitte das separate Importformat „Spotify“ auswählen.');
  const durationMs = duration(row.durationMs ?? row.duration_ms);
  const rawKind = row.durationKind ?? row.duration_kind;
  if (rawKind !== undefined && rawKind !== null && rawKind !== '' && rawKind !== 'measured' && rawKind !== 'estimated') throw new Error('durationKind muss measured oder estimated sein.');
  if (durationMs === null && rawKind) throw new Error('durationKind benötigt eine durationMs-Angabe.');
  if (durationMs !== null && !rawKind) warnings.add('Dauern ohne durationKind werden vorsichtig als Schätzung behandelt. Für gemessene Wiedergabedauer measured angeben.');
  const sourceKind = SOURCE_KINDS.includes(row.sourceKind as SourceKind) ? row.sourceKind as SourceKind : format;
  let externalId = row.externalId === undefined || row.externalId === null || row.externalId === '' ? '' : textField(row.externalId, 'externalId');
  if (externalId.length > 256) throw new Error('externalId darf höchstens 256 Zeichen lang sein.');
  if (externalId && typeof row.sourceId === 'string' && row.sourceId !== sourceId) {
    externalId = `origin:${createHash('sha256').update(JSON.stringify([row.sourceId, externalId])).digest('hex')}`;
  }
  return {
    sourceId, sourceKind,
    externalId,
    playedAt: utcTimestamp(row.playedAt ?? row.played_at ?? row.timestamp),
    artist: textField(row.artist ?? row.artistName, 'Künstler'), track: textField(row.track ?? row.trackName ?? row.title, 'Song'),
    album: textField(row.album ?? row.albumName, 'Album', false) || null,
    durationMs, durationKind: durationMs === null ? null : rawKind === 'measured' ? 'measured' : 'estimated',
    tags: tags(row.tags), nowPlaying: boolean(row.nowPlaying),
  };
}

function spotifyEvent(row: Record<string, unknown>, sourceId: string, warnings: Set<string>): ListeningEvent | null {
  const extended = 'ts' in row;
  if (!extended && !('endTime' in row)) throw new Error('Kein unterstützter Spotify-Hörverlauf: erwartet ts/ms_played oder endTime/msPlayed.');
  if (extended && (row.episode_name || row.episode_show_name || row.audiobook_title || (!row.master_metadata_track_name && !row.master_metadata_album_artist_name))) {
    warnings.add('Podcast-, Hörbuch- und nicht zuordenbare Nicht-Musik-Einträge wurden ausgelassen.');
    return null;
  }
  let playedAt: string;
  if (extended) playedAt = utcTimestamp(row.ts);
  else {
    const value = row.endTime;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) throw new Error('Spotify endTime benötigt YYYY-MM-DD HH:mm (laut Exportdefinition UTC).');
    const date = DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm', { zone: 'UTC' });
    if (!date.isValid) throw new Error('Ungültiges Spotify-Enddatum.');
    playedAt = utcTimestamp(date.toISO()!);
    warnings.add('Einfacher Spotify-Export: endTime ist UTC und nur minutengenau. Zuordnung zu Stunde/Tag am Stream-Ende; Album fehlt. Erweiterter Export ist genauer.');
  }
  const durationMs = duration(extended ? row.ms_played : row.msPlayed);
  if (durationMs === null) throw new Error('Spotify-Eintrag benötigt die gemessene Wiedergabedauer ms_played bzw. msPlayed.');
  return {
    sourceId, sourceKind: 'spotify', externalId: '', playedAt,
    artist: textField(extended ? row.master_metadata_album_artist_name : row.artistName, 'Künstler'),
    track: textField(extended ? row.master_metadata_track_name : row.trackName, 'Song'),
    album: textField(extended ? row.master_metadata_album_album_name : undefined, 'Album', false) || null,
    durationMs, durationKind: 'measured', tags: [], nowPlaying: false,
  };
}

/** Pure server-side preview. No row is persisted until the user confirms this preview. */
export function parseImport(text: string, format: ImportPreview['format'], sourceId: string): ImportPreview {
  const result: ImportPreview = { format, events: [], eventRows: [], errors: [], warnings: [], totalRows: 0 };
  const warnings = new Set<string>();
  try {
    if (!['csv', 'json', 'spotify'].includes(format)) throw new Error('Unbekanntes Importformat.');
    if (!sourceId || sourceId.length > 256) throw new Error('Eine gültige Importquelle ist erforderlich.');
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new Error('Datei ist größer als 20 MiB. Bitte in kleinere Dateien aufteilen.');
    if (!text.trim()) throw new Error('Die Datei ist leer.');
    const {rows,canonical} = parseRows(text, format);
    result.totalRows = rows.length;
    if (rows.length > MAX_IMPORT_ROWS) throw new Error('Datei enthält mehr als 100.000 Zeilen. Bitte aufteilen.');
    if (!rows.length) throw new Error('Die Datei enthält keine Hörereignisse.');
    result.listenBrainzExport=format==='json'&&!canonical&&rows.every(row=>!!row&&typeof row==='object'&&'track_metadata' in row&&'listened_at' in row);
    const restoredSources=new Map<string,{id:string;kind:SourceKind;label:string}>();
    if(canonical&&Array.isArray(canonical.sources)) for(const raw of canonical.sources) {
      const source=object(raw),id=textField(source.id,'Quellen-ID');
      if(id.length>256||!SOURCE_KINDS.includes(source.kind as SourceKind)) throw new Error('Sonora-Export enthält eine ungültige oder fiktive Quelle.');
      const kind=source.kind as SourceKind;
      if(restoredSources.has(id)) throw new Error('Sonora-Export enthält dieselbe Quellen-ID mehrfach.');
      restoredSources.set(id,{id,kind,label:textField(source.label,'Quellenname',false)||kind});
    }
    if (format === 'spotify') warnings.add(SPOTIFY_WARNING);
    const counts = new Map<string, number>();
    const explicitIds = new Map<string, string>();
    for (let index = 0; index < rows.length; index++) {
      try {
        const row = object(rows[index]);
        const targetSourceId=canonical?textField(row.sourceId,'Ursprüngliche Quellen-ID'):sourceId;
        if(targetSourceId.length>256) throw new Error('Quellen-ID darf höchstens 256 Zeichen enthalten.');
        if(canonical&&!row.externalId) throw new Error('Sonora-Export benötigt die ursprüngliche externalId.');
        const event = format === 'spotify' ? spotifyEvent(row, targetSourceId, warnings) : genericEvent(row, targetSourceId, format, warnings);
        if (!event) continue;
        if (event.nowPlaying) { warnings.add('Laufende Wiedergaben wurden ausgelassen; es werden nur abgeschlossene Ereignisse importiert.'); continue; }
        if(canonical) {
          const definition=restoredSources.get(event.sourceId);
          if(Array.isArray(canonical.sources)&&!definition) throw new Error('Für dieses Ereignis fehlt die Quelle im Sonora-Export.');
          if(definition&&['lastfm','listenbrainz','spotify'].includes(definition.kind)&&definition.kind!==event.sourceKind) throw new Error('Ereignis und ursprüngliche Quelle haben unterschiedliche Herkunft.');
          if(!definition) restoredSources.set(event.sourceId,{id:event.sourceId,kind:event.sourceKind,label:event.sourceKind});
        }
        const key = fingerprint(event), scopedKey=JSON.stringify([event.sourceId,key]);
        const occurrence = (counts.get(scopedKey) ?? 0) + 1;
        counts.set(scopedKey, occurrence);
        if (event.externalId) {
          if (event.externalId.length > 256) throw new Error('externalId darf höchstens 256 Zeichen lang sein.');
          const scopedId=JSON.stringify([event.sourceId,event.externalId]);
          const existing = explicitIds.get(scopedId);
          if (existing && existing !== key) throw new Error('Eine externalId wird für verschiedene Hörereignisse verwendet.');
          if (existing) { warnings.add('Wiederholte Datensätze mit derselben externalId wurden bereits in der Vorschau zusammengeführt.'); continue; }
          explicitIds.set(scopedId, key);
        } else event.externalId = eventId(event, occurrence);
        result.events.push(event);
        result.eventRows.push(index + (format === 'csv' ? 2 : 1));
      } catch (error) {
        result.errors.push({ row: index + (format === 'csv' ? 2 : 1), message: error instanceof Error ? error.message : 'Ungültiger Datensatz.' });
      }
    }
    if(canonical) {
      result.restoredSources=[...restoredSources.values()].filter(source=>result.events.some(event=>event.sourceId===source.id));
      warnings.add('Sonora-Export: ursprüngliche Quellen und Ereignis-IDs bleiben erhalten. Wiederhergestellte Verbindungen bleiben getrennt; Zugangsdaten werden nicht importiert.');
    }
    if ([...counts.values()].some((count) => count > 1)) warnings.add('Mehrere Wiedergaben desselben Songs zum gleichen Zeitpunkt bleiben als Vorkommen erhalten. Ohne stabile externalId sind identische Ereignisse über aufgeteilte Dateien nicht eindeutig unterscheidbar; vollständige Originaldateien zusammenhängend importieren.');
    if (result.events.some((event) => event.sourceKind === 'listenbrainz')) warnings.add('ListenBrainz-Export erkannt. Für Abgleich mit automatischer Synchronisation dieselbe ListenBrainz-Quelle auswählen. Tracklängen sind Schätzwerte.');
  } catch (error) {
    // CSV parser messages can echo complete input lines; only expose our validation text.
    const isCsvParserError = error && typeof error === 'object' && 'code' in error;
    result.errors.push({ row: 0, message: isCsvParserError ? 'Ungültiges CSV. Kopfzeile, Anzahl der Spalten und doppelte Anführungszeichen prüfen.' : error instanceof Error ? error.message : 'Die Datei konnte nicht gelesen werden.' });
  }
  result.warnings = [...warnings];
  return result;
}

/** Canonical export retains external IDs and provenance for lossless re-import. */
export function exportEventsJson(events: ListeningEvent[]): string {
  return JSON.stringify({ schemaVersion: 1, events: events.filter((event) => !event.nowPlaying) }, null, 2);
}
