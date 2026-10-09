export type SourceKind = 'lastfm' | 'listenbrainz' | 'csv' | 'json' | 'spotify' | 'demo';
export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'custom';
export interface ListeningEvent {
  id?: string;
  sourceId: string;
  sourceKind: SourceKind;
  externalId: string;
  playedAt: string;
  artist: string;
  track: string;
  album: string | null;
  durationMs: number | null;
  durationKind: 'measured' | 'estimated' | null;
  tags: string[];
  nowPlaying: boolean;
}
export interface SourceStatus {
  id: string;
  kind: SourceKind;
  label: string;
  username: string | null;
  enabled: boolean;
  intervalMinutes: number;
  lastSuccessAt: string | null;
  earliestEventAt: string | null;
  latestEventAt: string | null;
  eventCount: number;
  status: 'ready' | 'syncing' | 'error' | 'disconnected';
  error: string | null;
  coverageNote: string;
}
export interface PeriodRange {
  kind: PeriodKind;
  start: string;
  end: string;
  previousStart: string;
  previousEnd: string;
  label: string;
  timezone: string;
  incomplete: boolean;
}
export interface RankedItem { name: string; artist?: string; count: number; }
export interface Analytics {
  period: PeriodRange;
  counts: { plays: number; tracks: number; artists: number; albums: number; albumsUnknown: number; previousPlays: number; changePercent: number | null };
  listeningTime: { measuredMs: number | null; estimatedMs: number | null; measuredEvents: number; estimatedEvents: number; missingEvents: number };
  topTracks: RankedItem[];
  topArtists: RankedItem[];
  topAlbums: RankedItem[];
  tags: RankedItem[];
  activity: { date: string; count: number }[];
  weekdays: { label: string; count: number }[];
  hours: { hour: number; count: number }[];
  newArtists: string[];
  newTracks: { name: string; artist: string }[];
  nowPlaying: ListeningEvent[];
  possibleOverlaps: number;
  sources: SourceStatus[];
  warnings: string[];
  summary: string[];
}
export interface ImportPreview {
  format: 'csv' | 'json' | 'spotify';
  events: ListeningEvent[];
  errors: { row: number; message: string }[];
  warnings: string[];
  totalRows: number;
  listenBrainzExport?: boolean;
  restoredSources?: {id:string;kind:SourceKind;label:string}[];
}
export interface SyncPage {
  events: ListeningEvent[];
  cursor: string | null;
  done: boolean;
  coverageNote: string;
}
export interface ConnectorConfig { sourceId: string; username: string; apiKey?: string; cursor?: string | null; since?: string | null; }
export interface Connector { kind: 'lastfm' | 'listenbrainz'; fetchPage(config: ConnectorConfig, fetcher?: typeof fetch): Promise<SyncPage>; }
export interface UserSettings { displayName: string; timezone: string; theme: 'dark' | 'light' | 'system'; }
