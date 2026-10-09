import { describe, expect, it } from 'vitest';
import { buildPeriod, computeAnalytics } from '../src/lib/analytics';
import { demoData } from '../src/lib/demo';
import type { ListeningEvent, SourceStatus } from '../src/lib/types';

const zone = 'Europe/Berlin';
const later = new Date('2027-01-02T12:00:00Z');
const source: SourceStatus = {
  id: 'source-a', kind: 'csv', label: 'Meine Datei', username: null, enabled: true, intervalMinutes: 15,
  lastSuccessAt: '2026-10-08T20:00:00Z', earliestEventAt: '2023-01-01T12:00:00Z',
  latestEventAt: '2026-10-08T12:00:00Z', eventCount: 10, status: 'ready', error: null, coverageNote: '',
};
function event(playedAt: string, overrides: Partial<ListeningEvent> = {}): ListeningEvent {
  return { sourceId: source.id, sourceKind: 'csv', externalId: playedAt, playedAt,
    artist: 'Künstler A', track: 'Titel A', album: 'Album A', durationMs: null, durationKind: null,
    tags: [], nowPlaying: false, ...overrides };
}
const durationHours = (range: ReturnType<typeof buildPeriod>) => (Date.parse(range.end) - Date.parse(range.start)) / 3600000;

describe('local calendar boundaries', () => {
  it('uses the 23-hour spring day and the 25-hour autumn day in Berlin', () => {
    const spring = buildPeriod('day', '2026-03-29', zone, undefined, undefined, later);
    expect(spring.start).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.end).toBe('2026-03-29T22:00:00.000Z');
    expect(durationHours(spring)).toBe(23);
    expect(durationHours(buildPeriod('day', '2026-10-25', zone, undefined, undefined, later))).toBe(25);
  });

  it('begins weeks on Monday, including across a year boundary', () => {
    const week = buildPeriod('week', '2026-01-01', zone, undefined, undefined, later);
    expect(week.start).toBe('2025-12-28T23:00:00.000Z');
    expect(week.end).toBe('2026-01-04T23:00:00.000Z');
    expect(week.previousStart).toBe('2025-12-21T23:00:00.000Z');
    expect(week.label).toContain('KW 1');
  });

  it('compares full calendar months rather than a fixed number of seconds', () => {
    const march = buildPeriod('month', '2024-03-20', zone, undefined, undefined, later);
    expect(march.start).toBe('2024-02-29T23:00:00.000Z');
    expect(march.previousStart).toBe('2024-01-31T23:00:00.000Z');
    expect(march.previousEnd).toBe(march.start);
    expect(durationHours(march)).toBe(31 * 24 - 1);
  });

  it('includes leap day and compares the previous calendar year', () => {
    const leap = buildPeriod('year', '2024-08-10', 'UTC', undefined, undefined, later);
    expect(durationHours(leap)).toBe(366 * 24);
    expect(leap.previousStart).toBe('2023-01-01T00:00:00.000Z');
    expect(leap.previousEnd).toBe('2024-01-01T00:00:00.000Z');
  });

  it('makes the custom final date inclusive and uses previous local calendar days', () => {
    const custom = buildPeriod('custom', '2026-03-29', zone, '2026-03-28', '2026-03-29', later);
    expect(durationHours(custom)).toBe(47);
    expect(custom.start).toBe('2026-03-27T23:00:00.000Z');
    expect(custom.end).toBe('2026-03-29T22:00:00.000Z');
    expect(custom.previousStart).toBe('2026-03-25T23:00:00.000Z');
    expect(custom.previousEnd).toBe(custom.start);
  });

  it('aligns a partial spring day by local time instead of elapsed UTC hours', () => {
    const range = buildPeriod('day', '2026-03-29', zone, undefined, undefined, new Date('2026-03-29T10:00:00Z'));
    expect(range.incomplete).toBe(true);
    expect(range.end).toBe('2026-03-29T10:00:00.000Z');
    expect(range.previousEnd).toBe('2026-03-28T11:00:00.000Z');
  });

  it('clamps a partial month comparison to a valid date in the shorter month', () => {
    const range = buildPeriod('month', '2026-03-31', zone, undefined, undefined, new Date('2026-03-31T10:30:00Z'));
    expect(range.previousEnd).toBe('2026-02-28T11:30:00.000Z');
  });

  it('rejects impossible dates, inverted custom dates, and unknown timezones', () => {
    expect(() => buildPeriod('day', '2026-02-30', zone)).toThrow('ungültig');
    expect(() => buildPeriod('day', '2026-02-20', 'Not/A_Zone')).toThrow('Zeitzone');
    expect(() => buildPeriod('custom', '2026-02-20', zone, '2026-02-20', '2026-02-19')).toThrow('Enddatum');
    expect(() => buildPeriod('custom', '2026-02-20', zone, '0001-01-01', '9999-12-31')).toThrow('20 Jahre');
  });
});

describe('honest listening metrics', () => {
  const period = buildPeriod('day', '2026-10-08', zone, undefined, undefined, later);
  it('counts half-open boundaries and keeps now playing out of all historical metrics', () => {
    const result = computeAnalytics([
      event(period.start), event('2026-10-08T12:00:00Z'), event(period.end),
      event('2026-10-08T13:00:00Z', { nowPlaying: true, artist: 'Nur live' }),
    ], [source], period, later);
    expect(result.counts.plays).toBe(2);
    expect(result.counts.artists).toBe(1);
    expect(result.nowPlaying).toHaveLength(1);
    expect(result.newArtists).not.toContain('Nur live');
  });

  it('separates measured, estimated and unknown durations without inventing zero hours', () => {
    const result = computeAnalytics([
      event('2026-10-08T10:00:00Z', { durationMs: 120000, durationKind: 'measured' }),
      event('2026-10-08T11:00:00Z', { durationMs: 200000, durationKind: 'estimated' }),
      event('2026-10-08T12:00:00Z'),
      event('2026-10-08T13:00:00Z', { durationMs: 300000, durationKind: null }),
    ], [source], period, later);
    expect(result.listeningTime).toEqual({ measuredMs: 120000, estimatedMs: 200000, measuredEvents: 1, estimatedEvents: 1, missingEvents: 2 });
    const missing = computeAnalytics([event('2026-10-08T12:00:00Z')], [source], period, later);
    expect(missing.listeningTime.measuredMs).toBeNull();
    expect(missing.listeningTime.estimatedMs).toBeNull();
    expect(missing.counts.changePercent).toBeNull();
  });

  it('uses artist/title identities, excludes unknown albums and preserves repeated plays', () => {
    const result = computeAnalytics([
      event('2026-10-08T10:00:00Z'),
      event('2026-10-08T10:03:00Z'),
      event('2026-10-08T10:06:00Z', { artist: 'Künstler B' }),
      event('2026-10-08T10:09:00Z', { album: null }),
      event('2026-10-08T10:12:00Z', { album: '  ' }),
    ], [source], period, later);
    expect(result.counts).toMatchObject({ plays: 5, tracks: 2, artists: 2, albums: 2, albumsUnknown: 2 });
    expect(result.topTracks[0].count).toBe(4);
  });

  it('retains a known measured duration of zero as distinct from a missing duration', () => {
    const result = computeAnalytics([event('2026-10-08T10:00:00Z', { durationMs: 0, durationKind: 'measured' })], [source], period, later);
    expect(result.listeningTime).toEqual({ measuredMs: 0, estimatedMs: null, measuredEvents: 1, estimatedEvents: 0, missingEvents: 0 });
  });

  it('defines new artists and songs against all available history, not just the previous day', () => {
    const result = computeAnalytics([
      event('2023-01-01T12:00:00Z'),
      event('2026-10-08T10:00:00Z', { artist: ' künstler A ', track: 'TITEL A' }),
      event('2026-10-08T11:00:00Z', { artist: 'Neu', track: 'Titel A' }),
      event('2026-10-08T12:00:00Z', { track: 'Neuer Titel' }),
    ], [source], period, later);
    expect(result.newArtists).toEqual(['Neu']);
    expect(result.newTracks).toEqual(expect.arrayContaining([{ name: 'Titel A', artist: 'Neu' }, { name: 'Neuer Titel', artist: 'Künstler A' }]));
    expect(result.newTracks).toHaveLength(2);
  });

  it('flags cross-source pairs within two seconds, without merging any events', () => {
    const result = computeAnalytics([
      event('2026-10-08T10:00:00Z'),
      event('2026-10-08T10:00:02Z', { sourceId: 'source-b' }),
      event('2026-10-08T10:00:03Z'),
      event('2026-10-08T10:05:00Z'),
    ], [source], period, later);
    expect(result.possibleOverlaps).toBe(2);
    expect(result.counts.plays).toBe(4);
    expect(result.warnings.join(' ')).toContain('nicht automatisch zusammengeführt');
  });

  it('localizes activity and combines both occurrences of the repeated autumn hour', () => {
    const autumn = buildPeriod('day', '2026-10-25', zone, undefined, undefined, later);
    const result = computeAnalytics([
      event('2026-10-24T22:30:00Z'),
      event('2026-10-25T00:30:00Z'),
      event('2026-10-25T01:30:00Z'),
    ], [source], autumn, later);
    expect(result.activity).toEqual([{ date: '2026-10-25', count: 3 }]);
    expect(result.weekdays[6]).toEqual({ label: 'So', count: 3 });
    expect(result.hours[2].count).toBe(2);
  });

  it('counts tags once per play and uses stable rankings independent of input order', () => {
    const events = [
      event('2026-10-08T10:00:00Z', { artist: 'Zebra', tags: ['Indie', 'indie', 'Ambient'] }),
      event('2026-10-08T11:00:00Z', { artist: 'Alpha', tags: ['Indie'] }),
    ];
    const result = computeAnalytics(events, [source], period, later);
    expect(result.tags).toEqual([{ name: 'Indie', count: 2 }, { name: 'Ambient', count: 1 }]);
    expect(result.topArtists.map(item => item.name)).toEqual(['Alpha', 'Zebra']);
    expect(computeAnalytics([...events].reverse(), [source], period, later).topTracks).toEqual(result.topTracks);
  });

  it('compares only the matched elapsed part of a running period and warns about gaps', () => {
    const now = new Date('2026-10-08T10:00:00Z');
    const partial = buildPeriod('day', '2026-10-08', zone, undefined, undefined, now);
    const result = computeAnalytics([
      event('2026-10-07T08:00:00Z'), event('2026-10-07T16:00:00Z'),
      event('2026-10-08T08:00:00Z'), event('2026-10-08T09:00:00Z'),
    ], [source], partial, now);
    expect(result.counts.previousPlays).toBe(1);
    expect(result.counts.changePercent).toBe(100);
    expect(result.warnings.join(' ')).toContain('Kalenderfortschritt');
    expect(result.warnings.join(' ')).toContain('lückenlose');
  });
});

describe('explicit deterministic demo', () => {
  it('contains plausible fictional history, no future plays, and a separate live example', () => {
    const now = new Date('2026-10-08T20:00:00Z');
    const first = demoData(now);
    expect(first).toEqual(demoData(now));
    expect(first.events.length).toBeGreaterThan(1100);
    expect(first.events.length).toBeLessThan(1500);
    expect(first.events.every(item => Date.parse(item.playedAt) <= now.getTime())).toBe(true);
    expect(first.sources[0].kind).toBe('demo');
    expect(first.sources[0].label).toContain('fiktiv');
    expect(first.sources[0].eventCount).toBe(first.events.filter(item => !item.nowPlaying).length);
    expect(first.events.filter(item => item.nowPlaying)).toHaveLength(1);
  });
});
