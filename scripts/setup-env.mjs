import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const token = () => randomBytes(32).toString('hex');
const env = `# Lokal erzeugt. Nicht veröffentlichen oder in Git speichern.
POSTGRES_PASSWORD=${token()}
APP_URL=http://localhost:3000
PORT=3000
SETUP_TOKEN=${token()}
ENCRYPTION_KEY=${token()}
SYNC_INTERVAL_MINUTES=30
DEMO_MODE=false
`;
try {
  await writeFile('.env',env,{flag:'wx',mode:0o600});
  console.log('.env mit sicheren Zufallswerten erstellt. Einrichtungstoken lokal aus .env ablesen.');
} catch (error) {
  if(error.code==='EEXIST') { console.error('.env existiert bereits und wurde unverändert belassen.');process.exitCode=1; }
  else throw error;
}
