import type { Connector, ListeningEvent } from '../types';
import { cursorObject, epochTimestamp, eventId, fingerprint, object, sinceEpoch, textField, validUsername } from './common';
import { ConnectorError, requestJson } from './http';

export const lastfm: Connector = {
  kind: 'lastfm',
  async fetchPage(config, fetcher) {
    const username = validUsername(config.username);
    if (!config.apiKey || !/^[a-zA-Z0-9]{16,128}$/.test(config.apiKey)) throw new ConnectorError('Für Last.fm ist ein gültiger API-Schlüssel erforderlich.');
    const saved = cursorObject(config.cursor);
    const since = sinceEpoch(config.since);
    const state = saved ?? { kind: 'lastfm', page: 1, to: Math.floor(Date.now() / 1000), from: since === null ? null : Math.max(0, since - 86_400), boundary: {} };
    if (state.kind !== 'lastfm' || !Number.isSafeInteger(state.page) || Number(state.page) < 1 || !Number.isSafeInteger(state.to) || (state.from !== null && !Number.isSafeInteger(state.from)) || (state.invalid !== undefined && (!Number.isSafeInteger(state.invalid) || Number(state.invalid) < 0))) throw new ConnectorError('Ungültiger Last.fm-Synchronisationscursor.');
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    url.search = new URLSearchParams({ method: 'user.getRecentTracks', user: username, api_key: config.apiKey, format: 'json', limit: '200', page: String(state.page), to: String(state.to) }).toString();
    if (state.from !== null) url.searchParams.set('from', String(state.from));
    const data = object(await requestJson(url, fetcher));
    const recent = object(data.recenttracks);
    const tracks = recent.track === undefined ? [] : Array.isArray(recent.track) ? recent.track : [recent.track];
    const attributes = object(recent['@attr']);
    const totalPages = Number(attributes.totalPages);
    if (!Number.isSafeInteger(totalPages) || totalPages < 0 || tracks.length > 201) throw new ConnectorError('Last.fm lieferte ungültige Seitendaten.');
    const counts = new Map<string, number>(Object.entries(object(state.boundary)).map(([key, value]) => [key, Number(value)]));
    const events: ListeningEvent[] = [];
    let invalid = Number(state.invalid ?? 0);
    for (const value of tracks) {
      try {
        const row = object(value);
        const nowPlaying = row['@attr'] && object(row['@attr']).nowplaying === 'true';
        const event: ListeningEvent = {
          sourceId: config.sourceId, sourceKind: 'lastfm', externalId: '',
          playedAt: nowPlaying ? new Date().toISOString() : epochTimestamp(object(row.date).uts),
          artist: textField(typeof row.artist === 'string' ? row.artist : object(row.artist)['#text'], 'Künstler'),
          track: textField(row.name, 'Song'), album: row.album ? textField(typeof row.album === 'string' ? row.album : object(row.album)['#text'], 'Album', false) || null : null,
          durationMs: null, durationKind: null, tags: [], nowPlaying: Boolean(nowPlaying),
        };
        const key = fingerprint(event);
        const occurrence = (counts.get(key) ?? 0) + 1;
        counts.set(key, occurrence);
        event.externalId = nowPlaying ? `now:${key}` : eventId(event, occurrence);
        events.push(event);
      } catch { invalid++; }
    }
    const completed = events.filter((event) => !event.nowPlaying);
    const lastTimestamp = completed.at(-1)?.playedAt;
    const boundary = Object.fromEntries(completed.filter((event) => event.playedAt === lastTimestamp).map((event) => [fingerprint(event), counts.get(fingerprint(event))]));
    const done = Number(state.page) >= totalPages;
    if (!done && tracks.length === 0) throw new ConnectorError('Last.fm lieferte vor Ende der Historie eine leere Seite. Erneut synchronisieren.');
    return {
      events, done,
      cursor: done ? null : JSON.stringify({ ...state, page: Number(state.page) + 1, boundary, invalid }),
      coverageNote: `Scrobbles über Last.fm; keine gemessene Hörzeit. Nur tatsächlich an Last.fm gemeldete Wiedergaben. ${state.from === null ? 'Historischer Abruf aller verfügbaren Seiten.' : 'Inkrementeller Abruf mit 24 Stunden Überlappung; ältere Nachmeldungen benötigen erneuten historischen Abruf.'}${invalid ? ` ${invalid} ungültige Einträge während dieser Synchronisation ausgelassen: mögliche Datenlücke.` : ''}`,
    };
  },
};
