# Betrieb von Sonora

Stand: **11.10.2026**. Der vollständige Compose-Start, Container-Neustart mit erhaltenen Daten und die GHCR-Veröffentlichung wurden im [Repository-Workflow](https://github.com/Lua-x/Sonora/actions/runs/38062449662) erfolgreich geprüft; siehe [Abnahmestand](progress.md).

## Konfiguration und Start

`node scripts/setup-env.mjs` erzeugt zufällige Geheimnisse in `.env`. Die Datei ist durch Git und Docker-Build-Kontext ausgeschlossen. Auf Linux sollte nur der betreibende Nutzer lesenden Zugriff erhalten (`chmod 600 .env`); unter Windows entsprechende Dateiberechtigungen verwenden. Die Datei niemals in Tickets oder CI-Ausgaben kopieren. Nach der Konfiguration:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 web worker migrate
```

Compose bindet die Anwendung an `127.0.0.1:3000`. PostgreSQL hat keinen veröffentlichten Host-Port. `migrate` endet nach erfolgreicher Ausführung mit Exit-Code 0; das ist erwartetes Verhalten. Web und Worker starten erst danach. Fehlgeschlagene oder nachträglich veränderte Migrationen stoppen den Start. Bereits angewandte Migrationsdateien nicht bearbeiten; Schemaänderungen benötigen eine neue versionierte Migration und einen entsprechend erweiterten Runner.

| Variable | Bedeutung |
| --- | --- |
| `POSTGRES_PASSWORD` | Neues zufälliges Datenbankpasswort in Hex; Compose setzt daraus intern `DATABASE_URL` zusammen. Wirkt bei der Datenbankinitialisierung. |
| `ENCRYPTION_KEY` | Genau 64 Hex-Zeichen; verschlüsselt Quellengeheimnisse mit AES-256-GCM. Bei Verlust müssen die Quellen neu verbunden werden. |
| `SETUP_TOKEN` | Zufälliger Token mit mindestens 32 Zeichen für das einmalige Erstsetup. Ein bestehender Zugang kann damit nicht übernommen werden. |
| `APP_URL` | Exakter Browser-Ursprung, z. B. `https://sonora.example.org`. Bestimmt Same-Origin-Prüfung und sichere Cookies. |
| `PORT` | Host-Port; standardmäßig 3000. Die Bindung bleibt auf Loopback. |
| `SYNC_INTERVAL_MINUTES` | Standardintervall neuer Quellen, normalerweise 30; pro Quelle einstellbar. |
| `SONORA_IMAGE` | Optional ein bestimmtes geprüftes GHCR-Image; nur zusammen mit `--no-build` verwenden. |

`DEMO_MODE` ist in der persönlichen Compose-Datei fest `false` und in der separaten Demo-Datei fest `true`. Die Demo benötigt keine Geheimnisse und keine Datenbank. Variablen für die lokale PGlite-Entwicklung werden in Produktion nicht gesetzt.

## Healthchecks und geordnetes Beenden

- PostgreSQL: `pg_isready` prüft alle fünf Sekunden, ob die Datenbank Verbindungen annimmt.
- Web: `GET /api/health` prüft im persönlichen Modus die Datenbankverbindung. Der Endpunkt gibt keine persönlichen Daten oder Geheimnisse aus.
- Worker: Ein Heartbeat in `system.workerHeartbeat` wird während der Arbeit aktualisiert. Der Healthcheck verlangt einen höchstens 120 Sekunden alten Eintrag. Ein gesunder Web-Endpunkt allein beweist keine funktionierende Synchronisation.
- `docker compose stop` beendet Web und Worker über SIGTERM. Der Worker schließt seine laufende Portion ab und die Datenbankverbindung geordnet. Nicht abgeschlossene Aufträge bleiben gespeichert und werden nach Ablauf ihrer Bearbeitungsfrist wieder aufgenommen.

`restart: unless-stopped` startet abgestürzte Prozesse neu; ein nur als „unhealthy“ markierter laufender Prozess wird von Docker Compose nicht automatisch neu gestartet. Bei längeren Fehlern Logs und Quelleneinstellungen prüfen, Ursache beheben und nötigenfalls `docker compose restart worker` ausführen. Die UI zeigt Quellfehler und ausstehende Aufträge.

## HTTPS-Reverse-Proxy

Für Zugriff außerhalb des eigenen Rechners `APP_URL=https://sonora.example.org` in `.env` setzen und Web/Worker neu erstellen. Ein Reverse-Proxy auf demselben Host verbindet sich mit `127.0.0.1:3000`. Beispiel für Caddy mit automatisch verwaltetem Zertifikat:

```caddyfile
sonora.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

DNS und die erforderlichen HTTPS-/ACME-Ports müssen auf diesen Server zeigen. Der Browser muss die konfigurierte Adresse exakt verwenden; die App lehnt zustandsändernde Anfragen mit abweichendem Origin ab. Mit einer HTTPS-`APP_URL` tragen Sessions das `Secure`-Flag. Sitzungen sind HTTP-only, SameSite=Strict und zeitlich begrenzt. HSTS gegebenenfalls im Reverse-Proxy nach erfolgreicher HTTPS-Einrichtung ergänzen.

Läuft der Proxy selbst in Docker, muss er gezielt an das Compose-Netz angeschlossen werden und `web:3000` erreichen. Keine öffentliche Portfreigabe für PostgreSQL ergänzen. Das Beispiel für einen Host-Proxy ist die einfachere Variante.

## Backup

Ein vollständiges Backup besteht aus einem konsistenten Datenbank-Dump und der zugehörigen `.env` einschließlich `ENCRYPTION_KEY`. Das JSON aus der Oberfläche exportiert den Hörverlauf und Metadaten ohne Zugangsdaten; es ersetzt kein vollständiges Betriebsbackup mit Passwort, Jobs und Quelleneinstellungen.

Den Ordner `backups` zuerst erstellen. Der Dump entsteht innerhalb des Containers und wird binär unverändert kopiert; das vermeidet Probleme mit PowerShell-Umleitung:

```sh
docker compose exec -T db pg_dump -U sonora -d sonora -Fc -f /tmp/sonora-backup.dump
docker compose cp db:/tmp/sonora-backup.dump ./backups/sonora-backup.dump
docker compose exec -T db rm /tmp/sonora-backup.dump
```

Datei mit Datum versehen, `.env` separat sicher kopieren und beide verschlüsselt auf einem anderen Datenträger aufbewahren. Backups enthalten persönlichen Hörverlauf und Kontodaten. `backups/`, `.env` und `*.dump` werden nicht versioniert. Ein laufendes PostgreSQL-Volume niemals einfach dateiweise kopieren. `pg_dump` liefert einen konsistenten Datenbankstand, während laufende Importe nach dem Snapshot weiterarbeiten können.

## Wiederherstellung

Die folgenden Schritte ersetzen die Tabelleninhalte der gewählten Sonora-Datenbank durch den Backupstand. Zuvor auch vom aktuellen Stand ein Backup erstellen. Zur Kontrolle Wiederherstellungen möglichst zuerst in einem getrennten Compose-Projekt durchführen.

1. Den passenden Repository-/Image-Stand und die gesicherte `.env` bereitstellen. `ENCRYPTION_KEY` muss zum Dump passen.
2. Web und Worker stoppen; die Datenbank starten.
3. Dump einspielen und anschließend Migrationen und Anwendung starten.

```sh
docker compose stop web worker
docker compose up -d db
docker compose cp ./backups/sonora-backup.dump db:/tmp/sonora-backup.dump
docker compose exec -T db pg_restore -U sonora -d sonora --clean --if-exists --no-owner --exit-on-error /tmp/sonora-backup.dump
docker compose exec -T db rm /tmp/sonora-backup.dump
docker compose run --rm migrate
docker compose up -d web worker
```

Danach anmelden, Anzahl und Datumsbereich der Ereignisse prüfen und eine Quelle synchronisieren. Die Wiederherstellung regelmäßig mit einem Testbackup üben. Die Anwendung löscht keine externen Backups; nach gewünschter Datenlöschung müssen diese nach der eigenen Aufbewahrungsregel ebenfalls entfernt werden.

## Aktualisierung und Rückkehr zu einem älteren Stand

Vor Updates ein Backup erstellen und Release-/Migrationshinweise prüfen. Für lokale Builds:

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Basisimages sind auf Version **und Manifest-Digest** festgelegt: Node `24.21.0-bookworm-slim` und PostgreSQL `17.11-bookworm`. Sie werden über den öffentlichen ECR-Spiegel unter `public.ecr.aws/docker/library/` bezogen. Die Manifest-Digests wurden am 10.10.2026 mit den offiziellen Docker-Hub-Images abgeglichen und stimmen überein. Das vermeidet die während der ersten CI-Läufe beobachteten Docker-Hub-Authentifizierungs-Timeouts. Ein erneuter Build ändert diese Images nicht stillschweigend. Sicherheitsupdates erfordern einen bewusst geprüften Digest-/Versionswechsel; die npm-Versionen stehen im Lockfile. Quellen: [Docker Official Images auf ECR](https://gallery.ecr.aws/docker/), [Node Official Image](https://hub.docker.com/_/node), [PostgreSQL Official Image](https://hub.docker.com/_/postgres), [PostgreSQL-Versionierung](https://www.postgresql.org/support/versioning/).

Ein PostgreSQL-Major-Upgrade ist kein einfaches Image-Tag-Update. Dafür Dump/Restore oder ein geplantes `pg_upgrade` durchführen. Die Volume-Position dieses Projekts gilt für PostgreSQL 17 (`/var/lib/postgresql/data`); neuere Major-Versionen haben abweichende Vorgaben.

Zur Rückkehr einen vorherigen getesteten Image-Commit verwenden. Falls eine neuere Migration nicht rückwärts kompatibel ist, zusätzlich das zugehörige Backup in eine getrennte Datenbank wiederherstellen. Keine alten Migrationsdateien nachträglich verändern.

## GitHub Actions und GHCR

Ein sinnvoller Commit wird lokal geprüft und normal gepusht. Es gibt keinen Force-Push. Der Workflow startet für Pull Requests und Pushes nach `main`; Release-Tags `v*` werden ebenfalls geprüft. Die Prüfungen sind:

1. `npm ci`, `npm audit --omit=dev --audit-level=moderate`, TypeScript, ESLint, Tests und Next.js-Produktionsbuild.
2. Docker-Build des tatsächlichen Runtime-Images.
3. PostgreSQL + Migration + Web + Worker starten und Healthchecks bestehen lassen.
4. Mit `node scripts/smoke.mjs seed` einen Testzugang einrichten, API-Zugriffsschutz und Origin-Prüfung testen, fiktive Daten zweimal über den Worker importieren, Deduplizierung und vier Kalenderzeiträume prüfen sowie JSON-Export und Ab-/Anmeldung testen.
5. Container ohne Volume-Löschung neu erstellen; mit `node scripts/smoke.mjs verify` gespeicherten Zugang, Sitzung, Einstellungen, Hörverlauf und Statistiken prüfen und einen weiteren deduplizierten Import durch den neu gestarteten Worker verarbeiten lassen. Den unabhängigen Demo-Container starten und mit `node scripts/smoke.mjs demo` fiktive Auswertung und Schreibschutz prüfen.
6. Nur nach Erfolg: das Image für Linux/amd64 in GHCR veröffentlichen.

Der Workflow verwendet standardmäßig `contents: read`; ausschließlich der Publish-Job erhält zusätzlich `packages: write`. Ein für diese Prüfung erzeugtes `.env` bleibt im flüchtigen Runner und wird weder als Artefakt veröffentlicht noch in das Image kopiert. Repository- und Organisationseinstellungen müssen GitHub Actions und Package-Publishing erlauben. Den ersten tatsächlichen Workflow-Lauf und dessen Image-Digest im GitHub-Repository kontrollieren.

Die Smoke-Prüfung ist ausschließlich für eine frische, wegwerfbare Testinstallation vorgesehen: Sie legt einen Zugang und fiktive Hörereignisse an und lehnt eine bereits eingerichtete Installation im Schritt `seed` ab. Temporäre Sitzungsdaten liegen in der ignorierten Datei `work/smoke-state.json`; sie werden nicht protokolliert oder als Artefakt hochgeladen. `SMOKE_URL` kann die Prüfadresse und `SMOKE_STATE_FILE` den privaten Zustandspfad ändern. Der Einrichtungstoken wird aus der Prozessumgebung oder der lokalen `.env` gelesen. Die Prüfung ist ein API-Integrationstest; die visuelle Browserabnahme wird separat dokumentiert.

Image-Tags: `main` für den jeweils geprüften Hauptbranch, `sha-<40 Zeichen>` für einen konkreten Commit, bei Git-Tag `v0.1.0` zusätzlich `0.1.0`. Für einen nachvollziehbaren Betrieb den SHA-Tag oder den veröffentlichten Digest auswählen. Ein neues GHCR-Package kann zunächst privat sein. Zum Abrufen eines privaten Pakets auf dem Zielserver mit einem dafür vorgesehenen GitHub-Zugang und `read:packages` über `docker login ghcr.io` anmelden; Token nur über die interaktive Eingabe bzw. `--password-stdin` übergeben.

Nach Setzen von `SONORA_IMAGE=ghcr.io/lua-x/sonora:sha-<commit>` in `.env`:

```sh
docker compose pull web worker migrate
docker compose up -d --no-build
```

Das identische Image führt abhängig vom Compose-Kommando Web, Migration oder Worker aus. Der Publish-Job wird von bestandenen Prüfungen abhängig gemacht; Repository-Branch-Regeln sollten direkte ungeprüfte Änderungen zusätzlich begrenzen. Verwendete Mechanik: [Compose-Startreihenfolge](https://docs.docker.com/compose/how-tos/startup-order/), [GitHub-Container-Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Persönliche Daten und Zugang

Quellengeheimnisse sind serverseitig verschlüsselt; der Schlüssel liegt ausschließlich in der Serverkonfiguration. Der Browser erhält keine gespeicherten API-Schlüssel. Beim Trennen einer Quelle werden Geheimnisse entfernt und neue Synchronisationen gestoppt. Die zentrale Datenlöschung entfernt Quellen, Hörereignisse und deren Aufträge. Persönlicher Zugang und Passwort bleiben bestehen, damit die Installation geschützt bleibt.

Es gibt absichtlich keinen öffentlichen Passwort-Reset ohne Identitätsnachweis. Zugang und Einrichtungstoken sicher aufbewahren. Bei Verlust auf eine gesicherte Installation mit bekanntem Zugang zurückgreifen; keine Datenbankmanipulation ungeprüft im laufenden Betrieb vornehmen.
