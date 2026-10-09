import { DateTime } from 'luxon';
import type { ListeningEvent, SourceStatus } from './types';

// Deliberately invented artists, albums, and tracks: no provider data or cover art.
const CATALOG = [
  { artist: 'Velvet Atlas', album: 'After the Rain', tags: ['Indie', 'Dream Pop'], tracks: ['Soft Landing', 'The Blue Hour', 'Paper Satellites'] },
  { artist: 'Mira & The Tides', album: 'Coastal Lines', tags: ['Indie', 'Alternative'], tracks: ['Saltwater Windows', 'Almost Home', 'Tidal Memory'] },
  { artist: 'North of June', album: 'Quiet Geometry', tags: ['Ambient', 'Electronic'], tracks: ['Parallel Light', 'A Room in the Clouds', 'Slow Orbit'] },
  { artist: 'Lune Harbor', album: 'Small Hours', tags: ['Jazz', 'Soul'], tracks: ['Window Seat', 'Midnight Espresso', 'All That Remains'] },
  { artist: 'Studio Fern', album: 'Greenhouse', tags: ['Electronic', 'Downtempo'], tracks: ['Open Circuit', 'Glasshouse', 'Still Growing'] },
  { artist: 'Cedar Avenue', album: 'Sunday Maps', tags: ['Folk', 'Indie'], tracks: ['A Different Way', 'Low Sun', 'Postcards to Nobody'] },
  { artist: 'Soft Meridian', album: 'Between Places', tags: ['Dream Pop', 'Electronic'], tracks: ['Halfway to Morning', 'Weightless', 'Violet Lines'] },
  { artist: 'Ember District', album: 'City in Bloom', tags: ['Soul', 'R&B'], tracks: ['Golden Pavements', 'Late Checkout', 'Stay a Little'] },
  { artist: 'Nebelgarten', album: 'Offene Fenster', tags: ['Ambient', 'Instrumental'], tracks: ['Morgentau', 'Leise Kreise', 'Im Vorübergehen'] },
  { artist: 'Low Season', album: 'The Long Way', tags: ['Alternative', 'Indie'], tracks: ['Northern Signs', 'Everything Moves', 'Home Again'] },
  { artist: 'Iris Transit', album: 'Night Service', tags: ['Electronic', 'House'], tracks: ['Platform Nine', 'Neon Reflections', 'Last Connection'] },
  { artist: 'Aster Field', album: 'A Gentle Distance', tags: ['Folk', 'Ambient'], tracks: ['First Light', 'Where We Begin', 'Little Constellations'] },
] as const;

/** Repeatable example history, generated only when the explicit demo mode requests it. */
export function demoData(now: Date = new Date()): { events: ListeningEvent[]; sources: SourceStatus[] } {
  let seed = 17031991;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const current = DateTime.fromJSDate(now, { zone: 'Europe/Berlin' });
  if (!current.isValid) throw new Error('Ungültiger Demo-Zeitpunkt.');
  const today = current.startOf('day');
  const events: ListeningEvent[] = [];
  for (let offset = 89; offset >= 0; offset--) {
    const day = today.minus({ days: offset });
    const plays = 9 + Math.floor(random() * 11);
    for (let index = 0; index < plays; index++) {
      // A morning cluster, then a stronger evening cluster; weekends are later.
      const weekend = day.weekday >= 6;
      const hour = index < 4 ? (weekend ? 10 : 8) : 17 + Math.floor((index - 4) / 3);
      const minute = 3 + Math.floor(random() * 53);
      const scheduled = day.set({ hour: Math.min(hour, 23), minute, second: index * 3 % 60 });
      // Today uses only timestamps before the supplied clock, without future plays.
      if (scheduled >= current) continue;
      const accessibleArtists = offset < 8 ? CATALOG.length : offset < 25 ? CATALOG.length - 1 : CATALOG.length - 2;
      const artistIndex = Math.floor(Math.pow(random(), 1.8) * accessibleArtists);
      const entry = CATALOG[artistIndex];
      const track = entry.tracks[Math.floor(random() * entry.tracks.length)];
      const durationRoll = random();
      const durationKind = durationRoll < 0.27 ? 'measured' : durationRoll < 0.85 ? 'estimated' : null;
      events.push({
        id: `demo-${day.toISODate()}-${index}`,
        externalId: `demo-${day.toISODate()}-${index}`,
        sourceId: 'demo-fictional', sourceKind: 'demo',
        playedAt: scheduled.toUTC().toISO()!, artist: entry.artist, track,
        album: random() < 0.05 ? null : entry.album,
        durationMs: durationKind === null ? null : (150 + Math.floor(random() * 130)) * 1000,
        durationKind, tags: [...entry.tags], nowPlaying: false,
      });
    }
  }
  events.sort((a, b) => a.playedAt.localeCompare(b.playedAt));
  const historyCount = events.length;
  const earliestEventAt = events[0]?.playedAt ?? null;
  const latestEventAt = events.at(-1)?.playedAt ?? null;
  events.push({
    id: 'demo-now-playing', externalId: 'demo-now-playing', sourceId: 'demo-fictional', sourceKind: 'demo',
    playedAt: current.toUTC().toISO()!, artist: CATALOG[0].artist, track: CATALOG[0].tracks[0], album: CATALOG[0].album,
    durationMs: null, durationKind: null, tags: [...CATALOG[0].tags], nowPlaying: true,
  });
  return {
    events,
    sources: [{
      id: 'demo-fictional', kind: 'demo', label: 'Demo · fiktiver Hörverlauf', username: null,
      enabled: false, intervalMinutes: 15, lastSuccessAt: current.toUTC().toISO()!,
      earliestEventAt, latestEventAt, eventCount: historyCount, status: 'ready', error: null,
      coverageNote: 'Fiktive Beispieldaten für die letzten 90 Kalendertage. Keine Verbindung zu einem Musikdienst und keine persönliche Hörhistorie.',
    }],
  };
}
