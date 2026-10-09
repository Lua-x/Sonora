import {setTimeout} from 'node:timers/promises';
import {closeDb} from './lib/db';
import {scheduleSyncs,runOneJob} from './lib/jobs';
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
console.log('Sonora-Hintergrundprozess gestartet.');
try {
  while(!stopping) {
    try {await scheduleSyncs();await runOneJob();}
    catch {console.error('Worker: Verarbeitung vorübergehend nicht möglich. Automatischer erneuter Versuch.');}
    // All providers receive at most one request per second across this worker.
    if(!stopping) await setTimeout(1500);
  }
} finally {await closeDb();console.log('Sonora-Hintergrundprozess geordnet beendet.');}
