const USER_AGENT = 'Sonora/1.0 (+https://github.com/Lua-x/Sonora)';
const slots = new Map<string, { nextAt: number; queue: Promise<unknown> }>();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ConnectorError extends Error {
  constructor(message: string, public retryAfterSeconds = 0) { super(message); this.name = 'ConnectorError'; }
}

function retryDelay(response: Response): number {
  const header = response.headers.get('retry-after');
  const seconds = header ? (/^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000) : 0;
  const reset = Number(response.headers.get('x-ratelimit-reset-in') ?? 0);
  return Math.max(1, Number.isFinite(seconds) ? seconds : 0, Number.isFinite(reset) ? reset : 0);
}

/** Rate limits apply to all connectors for an origin, including concurrent live requests. */
export async function requestJson(url: URL, fetcher: typeof fetch = fetch): Promise<unknown> {
  let slot = slots.get(url.origin);
  if (!slot) { slot = { nextAt: 0, queue: Promise.resolve() }; slots.set(url.origin, slot); }
  const current = slot;
  const request = current.queue.catch(() => undefined).then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const delay = current.nextAt - Date.now();
      if (delay > 60_000) throw new ConnectorError('Anbieterlimit erreicht. Die Synchronisation wird später erneut versucht.', Math.ceil(delay / 1000));
      if (delay > 0) await wait(delay);
      let response: Response;
      try {
        response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store' });
      } catch {
        // Network exception text can contain a URL and Last.fm's API key.
        throw new ConnectorError('Die Musikquelle ist gerade nicht erreichbar. Verbindung später erneut versuchen.');
      } finally {
        current.nextAt = Date.now() + 1100;
      }
      if (response.headers.get('x-ratelimit-remaining') === '0') current.nextAt = Date.now() + retryDelay(response) * 1000;
      if (response.status === 429 || response.status >= 500) {
        const seconds = Math.max(retryDelay(response), 2 ** attempt);
        current.nextAt = Date.now() + seconds * 1000;
        if (attempt === 2 || seconds > 60) throw new ConnectorError('Die Musikquelle ist ausgelastet oder begrenzt Anfragen. Später erneut versuchen.', seconds);
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        const message = response.status === 404 ? 'Benutzer oder Ressource wurde bei der Musikquelle nicht gefunden.' : response.status === 401 || response.status === 403 ? 'Die Musikquelle verweigert den Zugriff. Zugangsdaten und Freigabe prüfen.' : 'Die Musikquelle hat die Anfrage abgelehnt.';
        throw new ConnectorError(message);
      }
      // Bound upstream responses as well as uploads. Never persist raw API data.
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectorError('Die Musikquelle lieferte eine leere Antwort.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8_000_000) { await reader.cancel(); throw new ConnectorError('Die Antwort der Musikquelle ist unerwartet groß.'); }
        chunks.push(value);
      }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ConnectorError('Die Musikquelle lieferte ungültiges JSON.'); }
      const lastFmError = data && typeof data === 'object' && 'error' in data ? Number(data.error) : 0;
      if (lastFmError) {
        if ([11, 16, 29].includes(lastFmError)) {
          current.nextAt = Date.now() + 2000 * 2 ** attempt;
          if (attempt < 2) continue;
          throw new ConnectorError('Last.fm ist ausgelastet oder begrenzt Anfragen. Später erneut versuchen.', 60);
        }
        throw new ConnectorError([4, 9, 10, 26].includes(lastFmError) ? 'Last.fm-Zugriff abgelehnt. API-Schlüssel und Freigabe prüfen.' : 'Last.fm hat die Anfrage abgelehnt. Benutzernamen prüfen.');
      }
      return data;
    }
    throw new ConnectorError('Die Musikquelle ist gerade nicht erreichbar.');
  });
  current.queue = request;
  return request;
}
