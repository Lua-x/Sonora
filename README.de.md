# Sonora

[English overview](README.md) · [Releases](https://github.com/Lua-x/Sonora/releases) · [Docker-Betrieb](docs/operations.md)

Deine Musik, im Rückblick. Sonora ist eine selbst gehostete Web-App für einen persönlichen Hörverlauf, zeitzonengenaue Statistiken und Musikrückblicke auf Deutsch. Sie benötigt keine kostenpflichtige Cloud und keine externe KI.

## Start mit Docker

Voraussetzungen: Docker Engine bzw. Docker Desktop im Linux-Container-Modus, Docker Compose v2 und zum einmaligen Erzeugen der Konfiguration Node.js 24. Ein Git-Checkout dieses Repositorys ist erforderlich. Die App verwendet Port 3000 ausschließlich auf dem eigenen Rechner; für entfernten Zugriff siehe [HTTPS-Betrieb](docs/operations.md#https-reverse-proxy).

```sh
node scripts/setup-env.mjs
docker compose up -d --build
docker compose ps
```

Alternativ kann die Konfiguration ohne lokal installiertes Node erzeugt werden:

```sh
docker run --rm -v "${PWD}:/app" -w /app public.ecr.aws/docker/library/node:24.21.0-bookworm-slim node scripts/setup-env.mjs
docker compose up -d --build
```

Das Skript erstellt eine private `.env` mit zufälligem Datenbankpasswort, Verschlüsselungsschlüssel und Einrichtungstoken. Eine vorhandene `.env` bleibt erhalten. Öffne danach [localhost:3000](http://localhost:3000). Trage den `SETUP_TOKEN` aus deiner lokalen `.env` ein, wähle deinen Namen und ein eigenes Passwort mit mindestens 12 Zeichen. Der Token ermöglicht nur das erste Setup; es gibt kein Standardpasswort. Teile weder Token noch `.env`.

Compose startet PostgreSQL, führt die versionierte Migration aus und startet anschließend Web-App und Hintergrundprozess. Hörverlauf, Quellen, Einstellungen, Sitzungen und Aufträge liegen im persistenten Volume `sonora_database`. `docker compose down` behält dieses Volume. `docker compose down --volumes` löscht es.

Alle Variablen sind in [.env.example](.env.example) erklärt. Bei einem anderen Port sowohl `PORT` als auch `APP_URL` anpassen. Der persönliche Betrieb ist immer vom Demo-Modus getrennt.

## Demo ohne Zugangsdaten

```sh
docker compose -f compose.demo.yaml up -d --build
```

Öffne [localhost:3001](http://localhost:3001). Dieser getrennte, schreibgeschützte Modus erzeugt rund 1.200 ausdrücklich fiktive Hörereignisse aus 90 Tagen. Künstler, Titel und Alben sind erfunden. Es laufen keine Datenbank und keine Synchronisation; es werden keine persönlichen Daten geladen.

```sh
docker compose -f compose.demo.yaml down
```

## Eigene Musikdaten

- **Last.fm:** Im Bereich Datenquellen den Last.fm-Benutzernamen und einen eigenen API-Schlüssel verbinden. Neue Scrobbles werden regelmäßig synchronisiert. Der Umfang des initialen Imports und die Bedingungen sind in [Integrationen](docs/integrations.md) beschrieben. Ein Last.fm-Konto muss zuvor durch einen passenden Scrobbler mit Musik versorgt werden.
- **ListenBrainz:** Benutzernamen verbinden; die öffentliche Lese-Schnittstelle benötigt keinen persönlichen Schreibtoken. Für ältere Historie den offiziellen Datenexport nutzen und als JSON importieren. Verbinde vor dem Import das zugehörige ListenBrainz-Konto und wähle es ausdrücklich als Importziel aus, damit Ereignisse mit dessen Synchronisation abgeglichen werden. Ohne Auswahl bleibt der Export eine separate Quelle.
- **CSV und JSON:** Datei auswählen, Vorschau und Fehler prüfen, Import bestätigen. Größere Importe verarbeitet der Worker in Portionen. Maximal 20 MiB und 100.000 Zeilen pro Datei; eine Vorschau verfällt nach 24 Stunden. Fehlerhafte Dateien müssen vor dem Import korrigiert werden.
- **Persönlicher Spotify-Export:** Den getrennten Importtyp „Spotify“ verwenden. Unterstützt werden regulärer und erweiterter Hörverlauf als JSON. Es gibt keine direkte Spotify-API-Verbindung. Podcasts und Hörbücher werden ausgelassen. Grenzen und rechtliche Grundlage sind separat in [Integrationen](docs/integrations.md) dokumentiert.

Eine Verbindung zu Last.fm oder ListenBrainz erfasst nicht automatisch alle Streamingdienste. Jeder Dienst benötigt einen passenden, bereits eingerichteten Übertragungsweg. Datenlücken beim Anbieter kann Sonora nicht nachträglich rekonstruieren.

CSV-Beispiel mit gemessener Wiedergabedauer:

```csv
externalId,playedAt,artist,track,album,durationMs,durationKind,tags
mein-ereignis-001,2026-10-08T18:30:00Z,Beispielkünstler,Beispieltitel,Beispielalbum,183000,measured,Indie|Electronic
```

JSON kann eine Liste oder `{ "events": [...] }` enthalten. Pflichtfelder sind `playedAt` mit UTC/Offset, `artist` und `track`. Optional: `externalId`, `album`, `durationMs`, `durationKind` (`measured` oder `estimated`) und `tags`. Tags sind im JSON eine Textliste und in CSV mit `|` getrennt. Dauern ohne Kennzeichnung werden als Schätzung behandelt. Stabile `externalId`-Werte erleichtern eindeutige Wiederholungsimporte.

Wiederholte Importe und Synchronisationen werden je Quelle anhand stabiler Kennungen abgeglichen. Eine bereits vergebene `externalId` mit abweichendem Zeitpunkt, Künstler oder Titel wird als Konflikt gemeldet; korrigiere solche IDs vor dem Import. Mehrfach abgespielte Songs bleiben erhalten. Identische Ereignisse ohne Quellkennung sind über unterschiedlich aufgeteilte Dateien nicht immer eindeutig unterscheidbar. Vollständige Originaldateien zusammenhängend importieren; Sonora erklärt solche Grenzen in der Vorschau. Quellenübergreifende Ähnlichkeit führt zu einem Hinweis, nicht zu einer stillen Zusammenführung.

## Kennzahlen und Rückblicke

Dashboard und Rückblicke verwenden dieselbe Berechnung. Zeitstempel liegen in UTC; Kalendergrenzen richten sich nach deiner eingestellten Zeitzone (anfangs `Europe/Berlin`). Wochen beginnen montags. Sommerzeit, unterschiedlich lange Monate und Schaltjahre sind berücksichtigt. Eigene Zeiträume schließen das gewählte Enddatum ein und sind auf 7.320 Kalendertage begrenzt.

Laufende Zeiträume vergleichen denselben lokalen Kalenderfortschritt im vorherigen Tag, in der Vorwoche, im Vormonat oder Vorjahr. Nicht existierende Vergleichstage werden geklemmt. Deshalb können die tatsächlichen Stundenlängen verschieden sein. Bei null gespeicherten Plays im Vergleichszeitraum ist keine Prozentänderung verfügbar.

- „Plays“ sind gespeicherte Wiedergaben bzw. Scrobbles, keine Behauptung einer vollständigen Nutzungserfassung.
- Tatsächliche Hörzeit summiert ausschließlich als gemessen gekennzeichnete Wiedergabedauern. Schätzungen werden separat angezeigt. Fehlende Dauer bleibt unbekannt; eine ausdrücklich gemessene Dauer von 0 ms bleibt ein bekannter Wert.
- Titel werden durch Künstler und Titelname unterschieden; Alben durch Künstler und Albumname. Fehlende Alben zählen nicht als ein eigenes Album.
- „Neu“ bedeutet erstmals in der gesamten verfügbaren Historie, auch bei ausgewähltem Quellenfilter, nicht erstmals im Leben gehört.
- „Läuft gerade“ zählt nicht als abgeschlossenes Hörereignis.
- Tags erscheinen nur, wenn sie in den Daten vorliegen. Sonora errät keine Genres.
- Erste und letzte Einträge einer Quelle belegen keine durchgehende Abdeckung. Tage ohne gespeicherte Einträge sind kein sicherer Nachweis von Inaktivität.

Rückblicke für Tag, Woche, Monat und Jahr werden bei jeder Abfrage neu aus den gespeicherten Daten berechnet. Spätere Importe sind dadurch automatisch enthalten. Ausgewählte Rückblickkarten lassen sich lokal als Bild exportieren. Die Karten verwenden eigene Gestaltung und Textdaten ohne fremde Coverbilder.

Unter Einstellungen lassen sich eigene Daten als JSON exportieren und löschen. Das Trennen einer Quelle beendet neue Synchronisationen und entfernt ihre gespeicherten Zugangsdaten; bestehende Historie bleibt bis zur ausdrücklichen Datenlöschung erhalten. Datenlöschung setzt auch persönliche Anzeigeeinstellungen zurück, behält aber den geschützten Zugang.

## Architektur und Entwicklung

TypeScript, Next.js 16 / React 19, PostgreSQL 17 mit Drizzle, Luxon und Recharts. Ein separater Node-Prozess verarbeitet persistente PostgreSQL-Aufträge für Synchronisation und Importe; Redis wird nicht benötigt. Die Oberfläche verwendet eigenes CSS und semantische React-Komponenten statt Tailwind/shadcn, um die kleine persönliche Anwendung ohne zusätzliche Komponenten-Abhängigkeiten zu halten. PGlite ist ausschließlich eine lokale Entwicklungs- und Testhilfe; der Docker-Betrieb verwendet PostgreSQL.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Lokale Entwicklung mit PostgreSQL: `DATABASE_URL`, `APP_URL`, `SETUP_TOKEN` und `ENCRYPTION_KEY` im Prozess setzen; dann `npm run db:migrate`, `npm run dev` und in einem zweiten Terminal `npm run worker`. Next.js lädt `.env` für die Web-App; separat gestartete TypeScript-Skripte benötigen ihre Variablen in der Prozessumgebung, z. B. `node --env-file=.env --import tsx scripts/migrate.ts`. Die `.env` aus Docker enthält absichtlich keine Verbindung auf eine extern freigegebene Datenbank.

Für eine isolierte lokale Browserprüfung ohne PostgreSQL kann `PGLITE_PATH=./data/development` und `LOCAL_WORKER=true` gesetzt werden; dann arbeitet der lokale Worker im Webprozess. Dies ist kein Produktionsbetrieb und darf nicht gleichzeitig von mehreren Prozessen auf demselben PGlite-Verzeichnis geöffnet werden.

## GitHub und Container-Images

[GitHub Actions](.github/workflows/ci.yml) prüft Typen, Lint, Tests, Produktionsbuild, bekannte Sicherheitslücken in Produktionsabhängigkeiten und Docker-Build. Ein API-Test im vollständigen Container-Stack richtet einen Testzugang ein, importiert fiktive Hörereignisse über den Worker, wiederholt den Import und kontrolliert die Statistiken für Tag, Woche, Monat und Jahr. Nach Neuerstellung der Container prüft er Zugang, Sitzung, Einstellungen, Hörverlauf und Worker erneut. Auch Zugriffsschutz, Abmeldung, Origin-Prüfung, JSON-Export und der unabhängige schreibgeschützte Demo-Modus werden geprüft. Erst nach erfolgreichen Prüfungen veröffentlicht ein Push nach `main` ein Image unter `ghcr.io/lua-x/sonora` mit `main` und unveränderlichem `sha-<vollständiger-commit>`-Tag. Git-Tags wie `v0.1.0` erzeugen zusätzlich den Image-Tag `0.1.0`. Veröffentlicht wird zunächst für Linux/amd64.

`GITHUB_TOKEN` reicht bei erlaubter Actions-/Packages-Nutzung aus; ein zusätzlicher GitHub-Token gehört nicht in dieses Repository. Schreibzugriff auf Packages erhält ausschließlich der Publish-Job. Details zu Aktualisierung, privater GHCR-Anmeldung, Backups, Wiederherstellung und HTTPS stehen im [Betriebshandbuch](docs/operations.md).

## Stand der Abnahme

Der [vollständige Actions-Lauf für 2f03edd](https://github.com/Lua-x/Sonora/actions/runs/38062449662) hat Typprüfung, Lint, Tests, Produktionsbuild, Docker-Build, Compose-Start, Container-Neustart-Persistenz und GHCR-Veröffentlichung erfolgreich abgeschlossen. Einrichtung, Dateiimport, Dashboard, Hörverlauf und Rückblicke wurden zusätzlich im lokalen Browser geprüft. Details und spätere Korrekturen stehen in [docs/progress.md](docs/progress.md); den Status des aktuellen Commits zeigt [GitHub Actions](https://github.com/Lua-x/Sonora/actions).

Die lokale Entwicklungsumgebung hat keine Docker-Engine; die praktische Container-Abnahme erfolgte deshalb auf dem GitHub-Runner. Für den eigenen Betrieb Docker bereitstellen. Reale Anbieterzugriffe benötigen eigene gültige Zugangsdaten bzw. einen existierenden öffentlichen Benutzernamen. Die Konten werden wie vereinbart später in Sonora eingerichtet; Tests mit kontrollierten API-Antworten ersetzen keine bestätigte Synchronisation deines Kontos.
