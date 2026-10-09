import { describe, expect, it } from 'vitest';
import { exportEventsJson, MAX_IMPORT_BYTES, parseImport } from '../src/lib/importer';

const row = { playedAt: '2026-03-29T03:15:00+02:00', artist: 'Björk', track: 'Jóga', album: 'Homogenic', durationMs: 123456, durationKind: 'measured', tags: ['art pop'] };

describe('validated personal imports', () => {
  it('converts timestamps to UTC and keeps measured time and tags', () => {
    const result = parseImport(JSON.stringify([row]), 'json', 'mine');
    expect(result.errors).toEqual([]);
    expect(result.events[0]).toMatchObject({ playedAt: '2026-03-29T01:15:00.000Z', durationMs: 123456, durationKind: 'measured', tags: ['art pop'] });
  });

  it('supports CSV BOM, quoted commas, quotes and multiline fields', () => {
    const result = parseImport('\uFEFFplayedAt,artist,track,album,durationMs\r\n2026-01-01T12:00:00Z,"Artist, A","A ""great""\nsong",,60000', 'csv', 'mine');
    expect(result.errors).toEqual([]);
    expect(result.events[0]).toMatchObject({ artist: 'Artist, A', track: 'A "great"\nsong', album: null, durationKind: 'estimated' });
    expect(result.warnings.join(' ')).toContain('Schätzung');
  });

  it('rejects ambiguous dates, impossible dates, and invalid durations', () => {
    const rows = [
      { ...row, playedAt: '2026-10-25T02:30:00' },
      { ...row, playedAt: '2026-02-30T02:30:00Z' },
      { ...row, durationMs: -1 },
      { ...row, durationMs: 1.5 },
      { ...row, durationKind: 'actual' },
    ];
    const result = parseImport(JSON.stringify(rows), 'json', 'mine');
    expect(result.events).toHaveLength(0);
    expect(result.errors).toHaveLength(5);
    expect(result.errors[0].message).toContain('Zeitzone');
  });

  it('produces stable IDs for repeated import and preserves same-second repeats', () => {
    const result = parseImport(JSON.stringify([row, row, { ...row, playedAt: '2026-03-29T03:16:00+02:00' }]), 'json', 'mine');
    expect(new Set(result.events.map((event) => event.externalId)).size).toBe(3);
    expect(parseImport(JSON.stringify([row, row]), 'json', 'mine').events.map((event) => event.externalId)).toEqual(result.events.slice(0, 2).map((event) => event.externalId));
  });

  it('deduplicates stable IDs and rejects conflicting IDs', () => {
    const result = parseImport(JSON.stringify([{ ...row, externalId: 'event-1' }, { ...row, externalId: 'event-1' }, { ...row, externalId: 'event-1', track: 'Different' }]), 'json', 'mine');
    expect(result.events).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  it('round-trips canonical events including provenance and identifiers', () => {
    const original = parseImport(JSON.stringify([row, row]), 'json', 'mine').events;
    expect(parseImport(exportEventsJson(original), 'json', 'mine').events).toEqual(original);
    expect(parseImport(JSON.stringify(original), 'json', 'mine').events).toEqual(original);
  });

  it('never collapses different original sources in a combined canonical import', () => {
    const a = parseImport(JSON.stringify([row]), 'json', 'source-a').events[0];
    const b = { ...a, sourceId: 'source-b', sourceKind: 'lastfm' as const };
    const result = parseImport(exportEventsJson([a, b]), 'json', 'restored');
    expect(result.events).toHaveLength(2);
    expect(new Set(result.events.map((event) => `${event.sourceId}:${event.externalId}`)).size).toBe(2);
    expect(result.events.map((event) => event.sourceKind)).toEqual(['json', 'lastfm']);
    expect(parseImport(exportEventsJson(result.events), 'json', 'restored').events).toEqual(result.events);
  });

  it('preserves canonical source identity across different restore targets', () => {
    const original=parseImport(JSON.stringify([row]),'json','original').events;
    const first=parseImport(exportEventsJson(original),'json','restore-one');
    const second=parseImport(exportEventsJson(first.events),'json','restore-two');
    expect(first.errors).toEqual([]);
    expect(second.events).toEqual(original);
    expect(second.restoredSources).toEqual([{id:'original',kind:'json',label:'json'}]);
  });

  it('rejects demo provenance and oversized personal files', () => {
    expect(parseImport(JSON.stringify([{...row,sourceKind:'demo'}]),'json','mine').errors[0].message).toContain('Demo');
    expect(parseImport(' '.repeat(MAX_IMPORT_BYTES+1),'json','mine').errors[0].message).toContain('20 MiB');
  });

  it('does not identify generic ListenBrainz provenance as a verified official export', () => {
    expect(parseImport(JSON.stringify([{...row,sourceKind:'listenbrainz'}]),'json','mine').listenBrainzExport).toBe(false);
  });

  it('keeps missing duration unknown and excludes now-playing rows', () => {
    const result = parseImport(JSON.stringify([{ ...row, durationMs: null, durationKind: null }, { ...row, nowPlaying: true }]), 'json', 'mine');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].durationMs).toBeNull();
    expect(result.events[0].durationKind).toBeNull();
    expect(result.warnings.join(' ')).toContain('Laufende');
  });

  it('supports official ListenBrainz JSONL exports', () => {
    const listen = { listened_at: 1767225600, track_metadata: { artist_name: 'Artist', track_name: 'Track', additional_info: { duration_ms: 180000 } } };
    const result = parseImport(`${JSON.stringify(listen)}\n${JSON.stringify({ ...listen, listened_at: 1767225601 })}\n`, 'json', 'listenbrainz-account');
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ sourceKind: 'listenbrainz', durationMs: 180000, durationKind: 'estimated' });
  });

  it('imports extended Spotify measured time without extra private fields', () => {
    const data = [{ ts: '2026-01-01T12:01:00Z', ms_played: 151000, master_metadata_track_name: 'Track', master_metadata_album_artist_name: 'Artist', master_metadata_album_album_name: 'Album', ip_addr: '192.0.2.1', username: 'private' }];
    const result = parseImport(JSON.stringify(data), 'spotify', 'spotify-personal');
    expect(result.errors).toEqual([]);
    expect(result.events[0]).toMatchObject({ sourceKind: 'spotify', durationKind: 'measured', durationMs: 151000, playedAt: '2026-01-01T12:01:00.000Z' });
    expect(JSON.stringify(result.events)).not.toContain('192.0.2.1');
    expect(parseImport(JSON.stringify(data), 'json', 'wrong-format').errors[0].message).toContain('Spotify');
  });

  it('treats basic Spotify minute precision as documented UTC and keeps repeated streams', () => {
    const basic = { endTime: '2026-03-29 01:30', artistName: 'Artist', trackName: 'Track', msPlayed: 1234 };
    const result = parseImport(JSON.stringify([basic, basic]), 'spotify', 'spotify');
    expect(result.errors).toEqual([]);
    expect(result.events[0].playedAt).toBe('2026-03-29T01:30:00.000Z');
    expect(result.events[0].album).toBeNull();
    expect(result.events[0].externalId).not.toBe(result.events[1].externalId);
    expect(result.warnings.join(' ')).toContain('minutengenau');
  });

  it('skips non-music Spotify records with a visible warning', () => {
    const result = parseImport(JSON.stringify([{ ts: '2026-01-01T12:00:00Z', ms_played: 50, episode_name: 'Podcast', master_metadata_track_name: null }]), 'spotify', 'spotify');
    expect(result.events).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('Podcast');
  });

  it('returns human-readable structural errors without echoing private CSV contents', () => {
    const result = parseImport('playedAt,artist,track\n2026-01-01T12:00:00Z,private,track,unexpected', 'csv', 'mine');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).not.toContain('private');
    expect(parseImport('', 'json', 'mine').errors[0].message).toContain('leer');
    expect(parseImport('[broken', 'json', 'mine').errors[0].message).toContain('JSON');
  });
});
