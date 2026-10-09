import type { Connector } from '../types';
import { lastfm } from './lastfm';
import { listenbrainz } from './listenbrainz';

export const connectors: Record<'lastfm' | 'listenbrainz', Connector> = { lastfm, listenbrainz };
export { fetchListenBrainzNowPlaying } from './listenbrainz';
export { ConnectorError } from './http';
