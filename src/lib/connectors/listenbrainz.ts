import type { Connector, ConnectorConfig, ListeningEvent } from '../types';
import { cursorObject, duration, epochTimestamp, eventId, object, sinceEpoch, textField, validUsername } from './common';
import { ConnectorError, requestJson } from './http';

export function listenBrainzEvent(raw: unknown, sourceId: string, nowPlaying = false): ListeningEvent {
  const row = object(raw);
  const metadata = object(row.track_metadata);
  const info = metadata.additional_info ? object(metadata.additional_info) : {};
  const durationMs = info.duration_ms !== undefined ? duration(info.duration_ms) : info.duration !== undefined ? duration(Number(info.duration) * 1000) : null;
  return {
    sourceId, sourceKind: 'listenbrainz', externalId: '',
    playedAt: nowPlaying ? new Date().toISOString() : epochTimestamp(row.listened_at),
    artist: textField(metadata.artist_name, 'Künstler'), track: textField(metadata.track_name, 'Song'),
    album: textField(metadata.release_name, 'Album', false) || null,
    durationMs, durationKind: durationMs === null ? null : 'estimated', tags: [], nowPlaying,
  };
}

export const listenbrainz: Connector = {
  kind: 'listenbrainz',
  async fetchPage(config, fetcher) {
    const username = validUsername(config.username);
    const now = Math.floor(Date.now() / 1000);
    const since = sinceEpoch(config.since);
    const saved = cursorObject(config.cursor);
    const state = saved ?? { kind: 'listenbrainz', max: now + 1, lower: Math.max(now - 14 * 86_400, since === null ? now - 7 * 86_400 : since - 86_400), page: 1, boundary: null, gap: since !== null && since - 86_400 < now - 14 * 86_400 };
    if (state.kind !== 'listenbrainz' || !Number.isSafeInteger(state.max) || !Number.isSafeInteger(state.lower) || !Number.isSafeInteger(state.page) || Number(state.page) < 1) throw new ConnectorError('Ungültiger ListenBrainz-Synchronisationscursor.');
    const url = new URL(`https://api.listenbrainz.org/1/user/${encodeURIComponent(username)}/listens`);
    url.search = new URLSearchParams({ count: '1000', max_ts: String(state.max) }).toString();
    const data = object(await requestJson(url, fetcher));
    const payload = object(data.payload);
    if (!Array.isArray(payload.listens) || payload.listens.length > 1000) throw new ConnectorError('ListenBrainz lieferte ungültige Hörverlaufsdaten.');
    const all: ListeningEvent[] = [];
    let invalid = 0;
    for (const raw of payload.listens) {
      try { all.push(listenBrainzEvent(raw, config.sourceId)); } catch { invalid++; }
    }
    if (invalid) throw new ConnectorError('ListenBrainz lieferte ungültige Einträge. Synchronisation angehalten, damit keine Zeitgrenze übersprungen wird.');
    if (all.some((event) => Date.parse(event.playedAt) / 1000 >= Number(state.max))) throw new ConnectorError('ListenBrainz lieferte Daten außerhalb der angeforderten Zeitgrenze.');
    const oldest = all.length ? Math.min(...all.map((event) => Date.parse(event.playedAt) / 1000)) : null;
    // Delay the entire final second of a full page. Request it inclusively via max_ts=second+1.
    // This avoids losing same-second listens when they straddle pages with an exclusive cursor.
    const full = all.length === 1000;
    if (full && oldest !== null && oldest === Number(state.max) - 1) throw new ConnectorError('ListenBrainz liefert mindestens 1.000 Ereignisse in derselben Sekunde. Für lückenlose Daten bitte den offiziellen Export importieren.');
    const reachedLower = oldest !== null && oldest < Number(state.lower);
    const capped = full && !reachedLower && Number(state.page) >= 10;
    const done = !full || reachedLower || capped;
    const events = all.filter((event) => {
      const epoch = Date.parse(event.playedAt) / 1000;
      return epoch >= Number(state.lower) && (!full || reachedLower || epoch !== oldest);
    });
    const counts = new Map<string, number>();
    for (const event of events) {
      const base = eventId(event, 0);
      const occurrence = (counts.get(base) ?? 0) + 1;
      counts.set(base, occurrence);
      event.externalId = eventId(event, occurrence);
    }
    return {
      events, done,
      cursor: done ? null : JSON.stringify({ ...state, page: Number(state.page) + 1, max: oldest! + 1 }),
      coverageNote: `ListenBrainz: ${since === null ? 'Erster automatischer Abruf umfasst nur die letzten 7 Tage.' : 'Inkrementeller Abruf mit 24 Stunden Überlappung.'} Vollständige Historie über den offiziellen Export als JSONL importieren. Tracklängen sind ausschließlich Schätzwerte.${state.gap || capped ? ' Datenlücke: Der Zeitraum überschreitet 14 Tage oder 10 Seiten; fehlenden Bereich per Export ergänzen.' : ''}`,
    };
  },
};

/** A separate request; this result is transient and must never be inserted as a completed listen. */
export async function fetchListenBrainzNowPlaying(config: ConnectorConfig, fetcher?: typeof fetch): Promise<ListeningEvent[]> {
  const url = new URL(`https://api.listenbrainz.org/1/user/${encodeURIComponent(validUsername(config.username))}/playing-now`);
  const payload = object(object(await requestJson(url, fetcher)).payload);
  if (!Array.isArray(payload.listens)) return [];
  return payload.listens.slice(0, 1).map((row) => {
    const event = listenBrainzEvent(row, config.sourceId, true);
    event.externalId = `now:${eventId(event, 1)}`;
    return event;
  });
}
