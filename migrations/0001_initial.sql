CREATE TABLE IF NOT EXISTS users (id integer PRIMARY KEY CHECK (id = 1), password_hash text NOT NULL, settings jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS auth_attempts (key text PRIMARY KEY, count integer NOT NULL, resets_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
 id text PRIMARY KEY, kind text NOT NULL, label text NOT NULL, username text, secret text,
 enabled boolean NOT NULL DEFAULT true, interval_minutes integer NOT NULL DEFAULT 30 CHECK(interval_minutes >= 5),
 last_success_at timestamptz, next_sync_at timestamptz, coverage_note text NOT NULL DEFAULT 'Die Vollständigkeit des Verlaufs ist nicht bestätigt.',
 error text, now_playing jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS events (
 id text PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 source_kind text NOT NULL, external_id text NOT NULL, played_at timestamptz NOT NULL,
 artist text NOT NULL, track text NOT NULL, album text, duration_ms bigint CHECK(duration_ms >= 0),
 duration_kind text CHECK(duration_kind IN ('measured','estimated')), tags jsonb NOT NULL DEFAULT '[]',
 CONSTRAINT duration_pair CHECK ((duration_ms IS NULL) = (duration_kind IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS events_source_external_idx ON events(source_id, external_id);
CREATE INDEX IF NOT EXISTS events_played_at_idx ON events(played_at);
CREATE INDEX IF NOT EXISTS events_artist_track_idx ON events(artist, track);
CREATE TABLE IF NOT EXISTS jobs (
 id text PRIMARY KEY, type text NOT NULL CHECK(type IN ('sync','import')), source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('preview','queued','running','complete','failed')), payload jsonb NOT NULL DEFAULT '{}',
 progress integer NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_sync_idx ON jobs(source_id) WHERE type = 'sync' AND status IN ('queued','running');
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status,created_at);
CREATE TABLE IF NOT EXISTS system (key text PRIMARY KEY, value text NOT NULL);
