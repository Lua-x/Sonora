import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastfm } from '../src/lib/connectors/lastfm';
import { listenbrainz, fetchListenBrainzNowPlaying } from '../src/lib/connectors/listenbrainz';
import { parseImport } from '../src/lib/importer';

let clock = Date.UTC(2026, 9, 8, 12);
const apiKey = '0123456789abcdef0123456789abcdef';
const config = { sourceId: 'music', username: 'listener', apiKey };
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const lastTrack = (ts = 1791450000, name = 'Track') => ({ name, artist: { '#text': 'Artist' }, album: { '#text': 'Album' }, date: { uts: String(ts) } });
const lbListen = (ts: number, name = 'Track') => ({ listened_at: ts, track_metadata: { artist_name: 'Artist', track_name: name, additional_info: { duration_ms: 120000 } } });

async function settle<T>(promise: Promise<T>): Promise<T> {
  // Attach a handler before advancing timers so intentionally rejected requests are not unhandled.
  const result = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const resolved = await result;
  if ('error' in resolved) throw resolved.error;
  return resolved.value;
}

beforeEach(() => { clock += 86_400_000; vi.useFakeTimers(); vi.setSystemTime(clock); });
afterEach(() => vi.useRealTimers());

describe('Last.fm connector', () => {
  it('freezes historical snapshot, uses page cursor, and keeps now playing separate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ recenttracks: { track: [{ ...lastTrack(), '@attr': { nowplaying: 'true' } }, lastTrack()], '@attr': { totalPages: '2' } } })).mockResolvedValueOnce(response({ recenttracks: { track: [lastTrack()], '@attr': { totalPages: '2' } } }));
    const first = await settle(lastfm.fetchPage(config, fetcher));
    expect(first.events[0].nowPlaying).toBe(true);
    expect(first.events[1].durationMs).toBeNull();
    expect(first.done).toBe(false);
    const second = await settle(lastfm.fetchPage({ ...config, cursor: first.cursor }, fetcher));
    const url1 = fetcher.mock.calls[0][0] as URL;
    const url2 = fetcher.mock.calls[1][0] as URL;
    expect(url2.searchParams.get('to')).toBe(url1.searchParams.get('to'));
    expect(url2.searchParams.get('page')).toBe('2');
    expect(second.events[0].externalId).not.toBe(first.events[1].externalId);
    expect(second.done).toBe(true);
  });

  it('overlaps incremental window and retains reproducible IDs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ recenttracks: { track: [lastTrack(), lastTrack()], '@attr': { totalPages: '1' } } }));
    const first = await settle(lastfm.fetchPage({ ...config, since: '2026-10-08T10:00:00Z' }, fetcher));
    const second = await settle(lastfm.fetchPage({ ...config, since: '2026-10-08T10:00:00Z' }, fetcher));
    expect(first.events).toEqual(second.events);
    expect((fetcher.mock.calls[0][0] as URL).searchParams.get('from')).toBe(String(Date.parse('2026-10-07T10:00:00Z') / 1000));
    expect(first.events[0].externalId).not.toBe(first.events[1].externalId);
  });

  it('retries rate limits but redacts provider and network errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ error: 29, message: apiKey })).mockResolvedValueOnce(response({ recenttracks: { track: [], '@attr': { totalPages: '0' } } }));
    expect((await settle(lastfm.fetchPage(config, fetcher))).done).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const unauthorized = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 10, message: apiKey }));
    await expect(settle(lastfm.fetchPage(config, unauthorized))).rejects.toThrow('API-Schlüssel');
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error(`secret=${apiKey}`));
    await expect(settle(lastfm.fetchPage(config, network))).rejects.not.toThrow(apiKey);
  });

  it('marks malformed provider rows as a gap', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ recenttracks: { track: [{ ...lastTrack(), date: { uts: 'invalid' } }], '@attr': { totalPages: '1' } } }));
    const page = await settle(lastfm.fetchPage(config, fetcher));
    expect(page.events).toHaveLength(0);
    expect(page.coverageNote).toContain('Datenlücke');
  });

  it('retains the accumulated gap warning through later valid pages and completion', async () => {
    const invalidTrack = { ...lastTrack(), date: { uts: 'invalid' } };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ recenttracks: { track: [invalidTrack, lastTrack()], '@attr': { totalPages: '3' } } }))
      .mockResolvedValueOnce(response({ recenttracks: { track: [invalidTrack, lastTrack()], '@attr': { totalPages: '3' } } }))
      .mockResolvedValueOnce(response({ recenttracks: { track: [lastTrack()], '@attr': { totalPages: '3' } } }));
    const first = await settle(lastfm.fetchPage(config, fetcher));
    expect(JSON.parse(first.cursor!).invalid).toBe(1);
    const second = await settle(lastfm.fetchPage({ ...config, cursor: first.cursor }, fetcher));
    expect(JSON.parse(second.cursor!).invalid).toBe(2);
    const final = await settle(lastfm.fetchPage({ ...config, cursor: second.cursor }, fetcher));
    expect(final.done).toBe(true);expect(final.cursor).toBeNull();
    expect(final.coverageNote).toContain('2 ungültige Einträge während dieser Synchronisation');
    expect(final.coverageNote).toContain('Datenlücke');
  });
});

describe('ListenBrainz connector', () => {
  it('starts with a bounded seven-day window and marks track duration as estimated', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ payload: { listens: [lbListen(now - 30), lbListen(now - 9 * 86400)] } }));
    const page = await settle(listenbrainz.fetchPage(config, fetcher));
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ durationMs: 120000, durationKind: 'estimated' });
    expect(page.coverageNote).toContain('7 Tage');
    expect(page.done).toBe(true);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ 'User-Agent': expect.stringContaining('Sonora/') });
  });

  it('re-requests the boundary second and preserves same-second records across pages', async () => {
    const now = Math.floor(Date.now() / 1000);
    const firstRows = Array.from({ length: 999 }, (_, index) => lbListen(now - index - 1));
    firstRows.push(lbListen(now - 1000));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ payload: { listens: firstRows } })).mockResolvedValueOnce(response({ payload: { listens: [lbListen(now - 1000), lbListen(now - 1000), lbListen(now - 1001)] } }));
    const first = await settle(listenbrainz.fetchPage(config, fetcher));
    expect(first.events).toHaveLength(999);
    const next = await settle(listenbrainz.fetchPage({ ...config, cursor: first.cursor }, fetcher));
    expect(next.events).toHaveLength(3);
    expect(next.events[0].externalId).not.toBe(next.events[1].externalId);
    expect((fetcher.mock.calls[1][0] as URL).searchParams.get('max_ts')).toBe(String(now - 999));
    expect(next.done).toBe(true);
  });

  it('does not silently lose a saturated second', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ payload: { listens: Array.from({ length: 1000 }, () => lbListen(now)) } }));
    await expect(settle(listenbrainz.fetchPage(config, fetcher))).rejects.toThrow('offiziellen Export');
  });

  it('matches IDs of official export and sync for one source', async () => {
    const raw = lbListen(Math.floor(Date.now() / 1000) - 60);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ payload: { listens: [raw, raw] } }));
    const page = await settle(listenbrainz.fetchPage(config, fetcher));
    const imported = parseImport(JSON.stringify([raw, raw]), 'json', config.sourceId);
    expect(imported.events).toEqual(page.events);
  });

  it('keeps playing-now data transient', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ payload: { listens: [{ track_metadata: { artist_name: 'Artist', track_name: 'Track' } }] } }));
    const events = await settle(fetchListenBrainzNowPlaying(config, fetcher));
    expect(events).toHaveLength(1);
    expect(events[0].nowPlaying).toBe(true);
    expect((fetcher.mock.calls[0][0] as URL).pathname).toContain('/playing-now');
  });

  it('obeys Retry-After and does not retry early when delay is long', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, 429, { 'Retry-After': '120' }));
    await expect(settle(listenbrainz.fetchPage(config, fetcher))).rejects.toMatchObject({ retryAfterSeconds: 120 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
