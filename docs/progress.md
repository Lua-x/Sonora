# Sonora – Umsetzung und Abnahme

Stand: **11.10.2026**. Ziel: persönliche, selbst gehostete Musikauswertung auf Deutsch.

## Meilensteine

1. **Umgesetzt:** offizielle Datenquellen und Nutzungsgrenzen geprüft, dokumentierter Domänenvertrag, Projektstruktur und Docker-Grundlage.
2. **Umgesetzt:** geschützter Einzelzugang, PostgreSQL, Dateiimport mit Vorschau und Hintergrundaufträgen, Last.fm-Connector.
3. **Umgesetzt:** zeitzonengenaue Auswertungen, Dashboard, filterbarer und paginierter Hörverlauf.
4. **Umgesetzt:** ListenBrainz-Connector, offizieller Historienexport als Importweg, vier Rückblickzeiträume, lokaler PNG-Export und persönlicher JSON-Export.
5. **Geprüft:** GitHub-Pushes, CI, Docker-Build, Compose-Start, Persistenz bei Container-Neuerstellung und GHCR-Veröffentlichung. README, Konfigurationsbeispiel und Betriebshandbuch vorhanden.

## Nachweise

- [Vollständiger erfolgreicher Workflow für Commit 2f03edd](https://github.com/Lua-x/Sonora/actions/runs/38062449662): Typprüfung, Lint, Tests, Produktionsbuild, Sicherheitsprüfung, Docker-Build und Image-Veröffentlichung.
- Derselbe Lauf startet PostgreSQL, Migration, Web und separaten Worker. Die API-Prüfung umfasst Erstsetup, geschützten Zugriff, Origin-Schutz, Worker-Import, wiederholten Import ohne Duplikate, vier Kalenderzeiträume, JSON-Export und Ab-/Anmeldung.
- Nach Container-Neuerstellung ohne Volume-Löschung bestätigt die Prüfung denselben Zugang, Sitzung, Einstellungen, Hörverlauf und einen weiteren Worker-Import. Der separate Demo-Container besteht Daten- und Schreibschutzprüfung.
- Lokale Browserabnahme mit isolierter PGlite-Testdatenbank und fiktiven Importdaten: Erstsetup, Leerzustand, Importvorschau und Hintergrundverarbeitung, Dashboard, Tagesfilter, Hörverlaufsuche, Sortierung, Pagination, Rückblicke und tatsächlich heruntergeladener PNG-Export. Desktop und mobile Darstellung sowie heller Modus wurden geprüft.
- Letzte lokale Prüfung am 11.10.2026: **80 Tests in 7 Dateien erfolgreich**, TypeScript, ESLint und Produktionsbuild erfolgreich. Enthalten sind Sommerzeit, Kalendergrenzen, unvollständige Vergleichszeiträume, gemessene/geschätzte/fehlende Dauern, Deduplizierung, Quellenzuordnung, Sicherheit und kontrollierte Connector-Antworten.

## Korrekturen der Abschlussprüfung

- Bekannte Datenlücken bleiben nach späteren erfolgreichen inkrementellen Synchronisationen sichtbar; ein neuer Erfolg belegt keine Reparatur alter Lücken.
- Widersprüchliche `externalId`-Werte werden bei der Importvorschau mit ursprünglicher Zeilennummer gemeldet. Auch nach einer veralteten Vorschau verhindert eine Transaktionsprüfung stillen Datenverlust; identische Wiederholungen bleiben ohne Duplikate.
- Neue Künstler und Titel werden bei einem Quellenfilter weiterhin gegen die gesamte gespeicherte Historie geprüft. Die übrigen Kennzahlen bleiben auf die ausgewählte Quelle begrenzt.
- Mobile Navigation ist im geschlossenen Zustand nicht fokussierbar; geöffnete Navigation unterstützt Tastaturfokus und Escape. Laufende Zeiträume bleiben auch auf kleinen Displays gekennzeichnet. PNG-Karten enthalten Quellen- und Abdeckungshinweise.
- Der Workflow verwendet den vorhandenen BuildKit-Treiber des Runners und die offiziellen, per Digest festgelegten Images über ECR. Damit sind die zuvor beobachteten Docker-Hub-Timeouts umgangen.

## Entscheidungen

- Next.js/React, TypeScript, Node.js 24, PostgreSQL 17/Drizzle; persistente PostgreSQL-Aufträge statt zusätzlicher Redis-Infrastruktur.
- Eigenes CSS und semantische React-Komponenten statt Tailwind/shadcn, um zusätzliche Komponenten-Abhängigkeiten für die persönliche Anwendung klein zu halten.
- Ein persönlicher Zugang mit zufälligem Einrichtungstoken und selbst gewähltem Passwort. Keine Standardzugangsdaten, keine Geheimnisse im Repository.
- Ereignisse werden je Quelle dedupliziert. Quellenübergreifende Ähnlichkeit wird gekennzeichnet und nicht automatisch zusammengeführt. ListenBrainz-Exporte benötigen eine ausdrückliche Zielkontozuordnung.
- Reale Daten und ausdrücklich gekennzeichneter Demo-Modus bleiben getrennt. PGlite dient ausschließlich Entwicklung und Tests; Docker verwendet PostgreSQL.
- Autorisiertes GitHub-Ziel: [Lua-x/Sonora](https://github.com/Lua-x/Sonora). Sinnvolle geprüfte Meilensteine werden ohne Force-Push gesichert.

## Externe Voraussetzungen und verbleibende Prüfgrenzen

- Der Nutzer richtet seine Quellenkonten ausdrücklich später selbst in Sonora ein. Eine reale Last.fm- oder ListenBrainz-Synchronisation wurde deshalb **nicht** bestätigt. Kontrollierte API-Tests prüfen die Implementierung, nicht die Erreichbarkeit und Datenabdeckung eines konkreten Kontos.
- Auf dem Entwicklungsrechner ist keine Docker-Engine vorhanden. Die praktische Container-Abnahme erfolgte erfolgreich auf GitHub Actions. Für den eigenen Betrieb Docker Desktop/Engine mit Linux-Containern und Compose v2 bereitstellen.
- Fernzugriff benötigt einen konfigurierten HTTPS-Reverse-Proxy und passende `APP_URL`. Backups einschließlich Verschlüsselungsschlüssel gemäß Betriebshandbuch selbst aufbewahren.
- Den Status jedes späteren Commits und sein veröffentlichtes Image zeigt [GitHub Actions](https://github.com/Lua-x/Sonora/actions). Nur erfolgreiche Prüfungen erlauben die Veröffentlichung.
