import { DateTime, IANAZone } from 'luxon';
import type { Analytics, ListeningEvent, PeriodKind, PeriodRange, RankedItem, SourceStatus } from './types';

const LOCALE = 'de-DE';
const DAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const identity = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase(LOCALE);
const trackKey = (event: ListeningEvent) => JSON.stringify([identity(event.artist), identity(event.track)]);
const albumKey = (event: ListeningEvent) => JSON.stringify([identity(event.artist), identity(event.album ?? '')]);
const iso = (date: DateTime) => date.toUTC().toISO()!;
const millis = (date: string) => Date.parse(date);
const displayDate = (date: DateTime) => date.setLocale(LOCALE).toFormat('dd. LLL yyyy');

function localDate(value: string, timezone: string): DateTime {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Bitte ein Datum im Format JJJJ-MM-TT angeben.');
  const parsed = DateTime.fromISO(value, { zone: timezone }).startOf('day');
  if (!parsed.isValid) throw new RangeError('Das gewählte Datum ist ungültig.');
  return parsed;
}

/** All ranges are half-open [start, end); the custom end date in the UI is inclusive. */
export function buildPeriod(
  kind: PeriodKind,
  date: string,
  timezone: string,
  start?: string,
  end?: string,
  now: Date = new Date(),
): PeriodRange {
  if (!(IANAZone.isValidZone(timezone) || timezone === 'UTC')) throw new RangeError('Bitte eine gültige IANA-Zeitzone auswählen.');
  const anchor = localDate(date, timezone);
  const localNow = DateTime.fromJSDate(now, { zone: timezone });
  if (!localNow.isValid) throw new RangeError('Der aktuelle Zeitpunkt ist ungültig.');
  let first: DateTime;
  let fullEnd: DateTime;
  let previousStart: DateTime;
  let label: string;
  let customDays = 0;

  switch (kind) {
    case 'day':
      first = anchor;
      fullEnd = first.plus({ days: 1 });
      previousStart = first.minus({ days: 1 });
      label = displayDate(first);
      break;
    case 'week':
      first = anchor.startOf('week'); // ISO weeks always begin on Monday.
      fullEnd = first.plus({ weeks: 1 });
      previousStart = first.minus({ weeks: 1 });
      label = `KW ${first.weekNumber} · ${displayDate(first)} – ${displayDate(fullEnd.minus({ days: 1 }))}`;
      break;
    case 'month':
      first = anchor.startOf('month');
      fullEnd = first.plus({ months: 1 });
      previousStart = first.minus({ months: 1 });
      label = first.setLocale(LOCALE).toFormat('LLLL yyyy');
      break;
    case 'year':
      first = anchor.startOf('year');
      fullEnd = first.plus({ years: 1 });
      previousStart = first.minus({ years: 1 });
      label = first.toFormat('yyyy');
      break;
    case 'custom':
      first = localDate(start ?? date, timezone);
      fullEnd = localDate(end ?? start ?? date, timezone).plus({ days: 1 });
      if (fullEnd <= first) throw new RangeError('Das Enddatum muss am oder nach dem Startdatum liegen.');
      customDays = Math.round(fullEnd.diff(first, 'days').days);
      if (customDays > 366 * 20) throw new RangeError('Ein freier Zeitraum darf höchstens 20 Jahre umfassen.');
      previousStart = first.minus({ days: customDays });
      label = `${displayDate(first)} – ${displayDate(fullEnd.minus({ days: 1 }))}`;
      break;
    default:
      throw new RangeError('Unbekannter Zeitraum.');
  }

  const incomplete = localNow < fullEnd;
  const actualEnd = incomplete ? DateTime.max(first, localNow) : fullEnd;
  let previousEnd = first;
  if (incomplete) {
    if (localNow <= first) previousEnd = previousStart;
    else {
      // Calendar arithmetic preserves local wall-clock time through DST and clamps
      // dates that do not exist in a shorter comparison month or leap year.
      const shifted = kind === 'month' ? localNow.minus({ months: 1 })
        : kind === 'year' ? localNow.minus({ years: 1 })
          : localNow.minus({ days: kind === 'week' ? 7 : kind === 'custom' ? customDays : 1 });
      previousEnd = DateTime.min(first, DateTime.max(previousStart, shifted));
    }
  }
  return {
    kind, start: iso(first), end: iso(actualEnd), previousStart: iso(previousStart),
    previousEnd: iso(previousEnd), label, timezone, incomplete,
  };
}

interface RankedWithKey extends RankedItem { key: string }
function ranked(events: ListeningEvent[], keyOf: (event: ListeningEvent) => string, labelOf: (event: ListeningEvent) => Omit<RankedItem, 'count'>): RankedItem[] {
  const groups = new Map<string, RankedWithKey>();
  for (const event of events) {
    const key = keyOf(event);
    const label = labelOf(event);
    const group = groups.get(key);
    if (group) {
      group.count++;
      // Canonical spelling and ordering remain stable if callers reorder input.
      if (`${label.name}\0${label.artist ?? ''}`.localeCompare(`${group.name}\0${group.artist ?? ''}`, LOCALE) < 0) Object.assign(group, label);
    } else groups.set(key, { ...label, count: 1, key });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count
    || a.name.localeCompare(b.name, LOCALE)
    || (a.artist ?? '').localeCompare(b.artist ?? '', LOCALE)
    || a.key.localeCompare(b.key)).map(item => ({ name: item.name, count: item.count, ...(item.artist === undefined ? {} : { artist: item.artist }) }));
}

function countOverlaps(events: ListeningEvent[]): number {
  const groups = new Map<string, ListeningEvent[]>();
  for (const event of events) {
    const key = trackKey(event);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  let pairs = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => millis(a.playedAt) - millis(b.playedAt));
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length && millis(group[j].playedAt) - millis(group[i].playedAt) <= 2000; j++) {
        if (group[i].sourceId !== group[j].sourceId) pairs++;
      }
    }
  }
  return pairs;
}

/** Counts only stored historical plays; uncertainty never becomes invented listening time. */
export function computeAnalytics(events: ListeningEvent[], sources: SourceStatus[], period: PeriodRange, now: Date = new Date(), discoveryHistory: ListeningEvent[] = events): Analytics {
  const start = millis(period.start);
  const end = Math.min(millis(period.end), now.getTime());
  const previousStart = millis(period.previousStart);
  const previousEnd = millis(period.previousEnd);
  if (![start, end, previousStart, previousEnd].every(Number.isFinite)) throw new Error('Der Zeitraum enthält ungültige Zeitpunkte.');
  const valid = events.filter(event => Number.isFinite(millis(event.playedAt)));
  const historical = valid.filter(event => !event.nowPlaying && millis(event.playedAt) <= now.getTime());
  const current = historical.filter(event => millis(event.playedAt) >= start && millis(event.playedAt) < end);
  const previous = historical.filter(event => millis(event.playedAt) >= previousStart && millis(event.playedAt) < previousEnd);
  // Source filters narrow the displayed metrics, but first discoveries still
  // refer to the complete stored history across all sources.
  const before = discoveryHistory.filter(event => !event.nowPlaying && millis(event.playedAt) <= now.getTime() && millis(event.playedAt) < start);
  const beforeArtists = new Set(before.map(event => identity(event.artist)));
  const beforeTracks = new Set(before.map(trackKey));
  const topArtists = ranked(current, event => identity(event.artist), event => ({ name: event.artist.trim() }));
  const topTracks = ranked(current, trackKey, event => ({ name: event.track.trim(), artist: event.artist.trim() }));
  const knownAlbums = current.filter(event => !!event.album?.trim());
  const topAlbums = ranked(knownAlbums, albumKey, event => ({ name: event.album!.trim(), artist: event.artist.trim() }));
  const measured = current.filter(event => event.durationKind === 'measured' && event.durationMs !== null && Number.isFinite(event.durationMs) && event.durationMs >= 0);
  const estimated = current.filter(event => event.durationKind === 'estimated' && event.durationMs !== null && Number.isFinite(event.durationMs) && event.durationMs >= 0);
  const missingEvents = current.length - measured.length - estimated.length;
  const topTags = ranked(current.flatMap(event => {
    const seen = new Set<string>();
    return event.tags.filter(tag => {
      const key = identity(tag);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(tag => ({ ...event, track: tag.trim() }));
  }), event => identity(event.track), event => ({ name: event.track }));
  const dateCounts = new Map<string, number>();
  const weekdays = DAY_LABELS.map(label => ({ label, count: 0 }));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const event of current) {
    const local = DateTime.fromISO(event.playedAt, { zone: period.timezone });
    const date = local.toISODate()!;
    dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
    weekdays[local.weekday - 1].count++;
    hours[local.hour].count++;
  }
  const activity: Analytics['activity'] = [];
  let day = DateTime.fromMillis(start, { zone: period.timezone }).startOf('day');
  while (day.toMillis() < end) {
    const date = day.toISODate()!;
    activity.push({ date, count: dateCounts.get(date) ?? 0 });
    day = day.plus({ days: 1 });
  }
  const newArtists = topArtists.filter(item => !beforeArtists.has(identity(item.name))).map(item => item.name);
  const newTracks = topTracks.filter(item => !beforeTracks.has(JSON.stringify([identity(item.artist!), identity(item.name)])))
    .map(item => ({ name: item.name, artist: item.artist! }));
  const possibleOverlaps = countOverlaps(current);
  const changePercent = previous.length > 0 ? (current.length - previous.length) / previous.length * 100 : null;
  const warnings = ['Die Auswertung basiert auf gespeicherten Hörereignissen. Erste und letzte Einträge belegen keine lückenlose Abdeckung; Tage ohne Einträge bedeuten nicht sicher, dass keine Musik gehört wurde.'];
  if (period.incomplete) warnings.push('Dieser Zeitraum ist noch nicht abgeschlossen. Verglichen wird derselbe lokale Kalenderfortschritt im Vorzeitraum; fehlende Kalendertage werden auf das Monats- bzw. Jahresende begrenzt. Sommerzeit und Monatslänge können die tatsächliche Stundenzahl verändern.');
  if (start >= now.getTime()) warnings.push('Der ausgewählte Zeitraum liegt in der Zukunft; es stehen noch keine historischen Daten dafür zur Verfügung.');
  if (!current.length) warnings.push('Keine gespeicherten Hörereignisse in diesem Zeitraum. Daraus lässt sich keine tatsächliche Hörzeit von null ableiten.');
  if (!previous.length) warnings.push('Im Vergleichszeitraum sind keine Hörereignisse gespeichert. Eine prozentuale Veränderung ist deshalb nicht berechenbar.');
  if (sources.length > 1 || new Set(current.map(event => event.sourceId)).size > 1) warnings.push('Mehrere Quellen werden gemeinsam gezählt. Dasselbe Hörereignis kann in mehreren Quellen vorkommen; Überschneidungen werden nicht automatisch zusammengeführt.');
  if (possibleOverlaps) warnings.push(`${possibleOverlaps} mögliche Überschneidung${possibleOverlaps === 1 ? '' : 'en'}: gleicher Künstler und Titel in verschiedenen Quellen innerhalb von zwei Sekunden. Gezählt werden Ereignispaare; alle Einträge bleiben erhalten.`);
  if (missingEvents) warnings.push(`Bei ${missingEvents} von ${current.length} Hörereignissen fehlt eine nutzbare Dauer. Die Hörzeit bleibt entsprechend unvollständig.`);
  if (estimated.length) warnings.push('Geschätzte Trackdauern werden getrennt ausgewiesen und sind keine gemessene Wiedergabezeit.');
  if (valid.length < events.length) warnings.push(`${events.length - valid.length} Einträge mit ungültigem Zeitpunkt wurden ausgelassen.`);
  if (!sources.length) warnings.push('Es ist noch keine Datenquelle hinterlegt.');
  for (const source of sources) {
    if (source.kind === 'demo') warnings.push('Demo: Alle dargestellten Hörereignisse sind fiktive Beispieldaten.');
    if (source.status === 'error') warnings.push(`${source.label}: Die letzte Synchronisation ist fehlgeschlagen. Gespeicherte Daten können veraltet sein.`);
    if (!source.earliestEventAt || millis(source.earliestEventAt) > previousStart) warnings.push(`${source.label}: Für den Anfang des Vergleichszeitraums ist keine vollständige Historie belegt; der Vergleich kann verzerrt sein.`);
    if (source.coverageNote.trim()) warnings.push(`${source.label}: ${source.coverageNote.trim()}`);
  }
  const summary: string[] = [];
  if (current.length) {
    summary.push(`${current.length.toLocaleString(LOCALE)} gespeicherte Plays von ${topArtists.length.toLocaleString(LOCALE)} Künstlern im gewählten Zeitraum.`);
    if (topArtists[0]) summary.push(`${topArtists[0].name} führt mit ${topArtists[0].count} Plays deine Künstlerliste an.`);
    if (changePercent !== null) summary.push(`${Math.abs(changePercent).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} % ${changePercent >= 0 ? 'mehr' : 'weniger'} gespeicherte Plays als im ${period.incomplete ? 'zeitlich angeglichenen ' : ''}Vorzeitraum. Die Datenabdeckung kann den Vergleich beeinflussen.`);
    summary.push(`${newArtists.length} Künstler und ${newTracks.length} Titel tauchen erstmals in deiner gesamten verfügbaren Historie auf. Das ist keine Aussage über dein erstes Hören außerhalb dieser Historie.`);
    const peak = [...hours].sort((a, b) => b.count - a.count || a.hour - b.hour)[0];
    if (peak.count) summary.push(`Deine aktivste Stunde beginnt um ${String(peak.hour).padStart(2, '0')}:00 Uhr (${period.timezone}) mit ${peak.count} gespeicherten Plays.`);
  } else summary.push('Für diesen Zeitraum gibt es noch keine gespeicherten Plays. Verbinde eine Quelle oder importiere deine Hörhistorie.');

  return {
    period,
    counts: { plays: current.length, tracks: topTracks.length, artists: topArtists.length, albums: topAlbums.length, albumsUnknown: current.length - knownAlbums.length, previousPlays: previous.length, changePercent },
    listeningTime: {
      measuredMs: measured.length ? measured.reduce((sum, event) => sum + event.durationMs!, 0) : null,
      estimatedMs: estimated.length ? estimated.reduce((sum, event) => sum + event.durationMs!, 0) : null,
      measuredEvents: measured.length, estimatedEvents: estimated.length, missingEvents,
    },
    topTracks, topArtists, topAlbums, tags: topTags, activity, weekdays, hours, newArtists, newTracks,
    nowPlaying: valid.filter(event => event.nowPlaying).sort((a, b) => millis(b.playedAt) - millis(a.playedAt) || a.sourceId.localeCompare(b.sourceId)),
    possibleOverlaps, sources, warnings: [...new Set(warnings)], summary,
  };
}
