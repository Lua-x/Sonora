import { getDb,migrate,closeDb } from '../src/lib/db';
try { await migrate(await getDb()); console.log('Datenbankmigrationen erfolgreich.'); }
catch { console.error('Migration fehlgeschlagen. Datenbankverbindung und Schema prüfen.'); process.exitCode=1; }
finally { await closeDb(); }
