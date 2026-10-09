# Sonora – Umsetzung

Prüfdatum: 09.10.2026. Ziel: persönliche, selbst gehostete Musikauswertung auf Deutsch.

## Meilensteine

1. Quellenprüfung, TypeScript-Domänenvertrag und Docker-Grundlage – in Arbeit.
2. Geschützter Einzelzugang, PostgreSQL, Dateiimport und Last.fm – in Arbeit.
3. Zeitzonenfeste Auswertung, Dashboard, Hörverlauf – in Arbeit.
4. ListenBrainz, Rückblickkarten, lokaler Export – in Arbeit.
5. CI/GHCR, Betrieb, Abnahme – offen.

## Entscheidungen

- Next.js/React und Node.js 24 LTS, PostgreSQL; ein separater Worker nutzt eine persistente PostgreSQL-Auftragswarteschlange. Kein Redis notwendig.
- Ein persönlicher Zugang. Setup benötigt einen konfigurierten Zufallstoken und ein eigenes Passwort. Keine Standardzugangsdaten.
- Ereignisse werden pro Quelle dedupliziert. Quellenübergreifende Ähnlichkeit wird als mögliche Überschneidung angezeigt, nicht automatisch zusammengeführt.
- Reale Daten und ausdrücklich markierter Demo-Modus sind getrennt.
- Normale Docker-Produktion nutzt PostgreSQL. PGlite wird nur für lokale automatisierte Datenbanktests und Browserprüfung ohne installierten PostgreSQL-Server genutzt.
- Lokales GitHub-Ziel laut Nutzer: https://github.com/Lua-x/Sonora (anfangs leer).
- Keine Docker-Engine, kein WSL und keine GitHub-CLI in der geprüften Umgebung gefunden. Container-Abnahme bleibt bis zur Verfügbarkeit einer Engine ausdrücklich offen; Git-Zugang funktioniert.

## Prüfung von Betrieb und CI am 09.10.2026

- Dockerfile und Compose-Konfiguration auf Startreihenfolge, produktive Worker-Abhängigkeiten, nichtprivilegierte Prozesse, Healthchecks und persistentes PostgreSQL-Volume geprüft. Die tatsächlich installierte Next.js-Dokumentation zu Deployment und Standalone-Ausgabe wurde berücksichtigt.
- Der CI-Test prüft reale API-Abläufe statt eines isolierten Datenbank-Prüfeintrags: Erstsetup, Zugriffsschutz, Origin-Prüfung, Worker-Import, Wiederholungsimport, vier Kalenderzeiträume, Export, Ab-/Anmeldung und nach Container-Neuerstellung denselben Zugang, die Sitzung, Einstellungen, Daten und einen erneuten Worker-Auftrag. Der Demo-Modus wird auf Daten und Schreibschutz geprüft.
- `node --check scripts/smoke.mjs` und ESLint für das neue Prüfsystem erfolgreich. Praktische Container-Ausführung bleibt bis zum erfolgreichen Actions-Lauf offen.
- Aktuelle lokale Abhängigkeitsprüfung: `npm audit --json` meldet **0 Schwachstellen** (einschließlich Entwicklungsabhängigkeiten); `npm audit --omit=dev --audit-level=moderate` ebenfalls **0**. `braces@3.0.3` ist nur als Entwicklungsabhängigkeit über die Next.js-ESLint-Konfiguration vorhanden. Es ist derzeit keine Audit-Ausnahme konfiguriert; Produktionsfunde ab Schweregrad „moderate“ lassen CI fehlschlagen.
