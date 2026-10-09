# Datenquellen und Nutzungsgrenzen

**Prüfdatum: 8. Oktober 2026.** Geprüft wurden die unten verlinkten offiziellen Dokumentationen und Bedingungen vor Implementierung der Connectoren. Diese Fassung ist für einen privaten, nicht kommerziellen Einzelbenutzerbetrieb gedacht. Änderungen der Anbieterbedingungen erfordern eine neue Prüfung. Live-Abrufe mit einem persönlichen Konto sind erst nach dessen Einrichtung prüfbar; die automatisierten Tests verwenden realitätsnahe Antworten ohne Kontodaten.

| Quelle | Aktivierter Weg | Historie | Hörzeit |
| --- | --- | --- | --- |
| Last.fm | Lesender API-Connector | Alle verfügbaren Scrobbles über dokumentierte Seiten | Unbekannt; Scrobbles enthalten keine gemessene Wiedergabedauer |
| ListenBrainz | Lesender API-Connector und offizieller Datei-Export | Automatisch zunächst 7 Tage; vollständige Historie als Export | Vorhandene Tracklänge nur als Schätzung |
| Eigene CSV/JSON | Lokaler Datei-Import mit Vorschau | Zeitraum der Datei | Gemessen nur bei expliziter Kennzeichnung |
| Spotify | Eigener offizieller Datenschutzexport, lokal importiert | Einfacher oder erweiterter Export | Gemessene Millisekunden aus dem Export |
| Spotify Web API / SDK | Nicht implementiert oder aktiviert | — | — |
| Apple Music / YouTube Music / weitere Direktdienste | Nicht implementiert oder aktiviert | — | — |

## Last.fm

`user.getRecentTracks` liefert Song, Künstler, optional Album und UTC-Sekunden. Laufende Wiedergaben tragen ein eigenes Attribut. Erforderlich sind Benutzername und API-Schlüssel; für diesen Lese-Endpunkt ist keine Benutzersitzung nötig. Maximal 200 Ergebnisse pro Seite, `page`, `from` und `to` sind dokumentiert. [Offizielle API-Dokumentation](https://www.last.fm/api/show/user.getRecentTracks).

Die API-Bedingungen erlauben nicht kommerzielle Nutzung unter Bedingungen. Last.fm verlangt Quellenkennzeichnung und passende Profil-/Kataloglinks; die Kennzeichnung „powered by AudioScrobbler“ gehört zur Einbindung. Öffentliche API-basierte Seiten bedürfen schriftlicher Freigabe. Sonora bleibt zugangsgeschützt; private Karten verwenden keine Anbieterbilder. Die Lizenz beinhaltet weitere Datenschutz- und Verwendungsauflagen. Nach Lizenzbeendigung müssen bezogene Daten gelöscht werden. Kommerzielle oder Forschungsnutzung muss gesondert geklärt werden. [API-Bedingungen, insbesondere 2.7, 3, 4 und 9.3](https://www.last.fm/api/tos), [allgemeine Bedingungen](https://www.last.fm/legal/terms).

### Einrichtung und Abdeckung

1. Im eigenen [Last.fm-Konto](https://www.last.fm/) kontrollieren, dass Scrobbles ankommen, und einen [API-Schlüssel beantragen](https://www.last.fm/api/account/create).
2. In Sonora unter **Datenquellen** Last.fm, den Benutzernamen und den Schlüssel hinterlegen. Der Schlüssel verbleibt serverseitig.
3. Synchronisieren. Die Quelle zeigt den ersten und letzten lokal vorhandenen Zeitstempel, Ereignisanzahl, letzte erfolgreiche Synchronisation und Hinweise.

Die Musik muss bereits durch eine geeignete Scrobbling-Verbindung oder einen Client an Last.fm gemeldet werden. Sonora liest diese Meldungen; das Verbinden von Last.fm stellt keine Verbindung zu sämtlichen Streamingdiensten her. Historie vor Einrichtung des Scrobblings, nicht gemeldete Offline-Wiedergaben oder deaktivierte Clients sind möglicherweise nicht vorhanden.

Implementierung: Ein historischer Durchlauf friert `to` ein und speichert Seitenfortschritt. Folgedurchläufe lesen 24 Stunden überlappend. Identische Song-Zeit-Kombinationen erhalten einen Vorkommensindex, auch über Seitengrenzen. Historische Nachmeldungen außerhalb der Überlappung und nachträgliche Änderungen/Löschungen beim Anbieter werden nicht automatisch vollständig abgeglichen; hierfür Quelle neu historisch synchronisieren beziehungsweise lokale Quelldaten vor Neuimport löschen. Die obere Zeitgrenze verhindert Verschiebungen durch neue aktuelle Scrobbles, aber kein Anbieter-Snapshot gegenüber historischen Korrekturen. Ungültige Einträge erzeugen einen sichtbaren Lückenhinweis.

## ListenBrainz

Öffentliche Listen sind lesbar über `GET /1/user/{user}/listens`. `max_ts` und `min_ts` sind **exklusiv**, nicht gemeinsam nutzbar; maximal 1.000 Listen pro Abruf. Vollständige Historie darf nicht über diesen Endpunkt abgeblättert werden. Die Dokumentation verlangt dafür den Exportweg. [Core API](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html).

Die API verlangt höchstens eine Anfrage pro Sekunde, Beachtung der Rate-Limit-Header und einen identifizierenden User-Agent mit Kontakt. Sonora sendet `Sonora/1.0 (+https://github.com/Lua-x/Sonora)`. Leseabrufe benötigen keinen Schreibtoken. [API-Nutzung und Limits](https://listenbrainz.readthedocs.io/en/latest/users/api/index.html). Listen und Texte veröffentlicht ListenBrainz unter CC0; die verlinkten MetaBrainz-Richtlinien gelten zusätzlich. [ListenBrainz-Nutzungsbedingungen](https://listenbrainz.org/terms-of-service/).

### Einrichtung

In Sonora den ListenBrainz-Benutzernamen verbinden. Musik muss bereits bei ListenBrainz erfasst werden, beispielsweise durch einen vom Anbieter unterstützten Client/Importer. Im eigenen Profil prüfen, ob neue Wiedergaben ankommen. Sonora aktiviert selbst weder Spotify- noch andere Streamingdienst-Importer.

Der erste automatische Abruf umfasst nur sieben Tage. Folgeläufe überlappen 24 Stunden. Abfragen sind auf 14 Tage und zehn Seiten begrenzt; größere Lücken werden angezeigt und benötigen einen Export. Eine volle Seite hält die letzte Zeitsekunde zurück und fordert diese mit `max_ts=Sekunde+1` erneut an. So gehen Einträge gleicher Sekunde an Seitengrenzen nicht verloren. Bei mindestens 1.000 Ereignissen in derselben Sekunde stoppt der Abruf mit Exporthinweis, da eindeutiges Weiterblättern unmöglich ist. Laufende Wiedergaben werden separat abgefragt und niemals als abgeschlossene Listen gespeichert.

### Vollständige Historie importieren

1. Bei [ListenBrainz-Einstellungen](https://listenbrainz.org/settings/) den eigenen Token beziehen. Er ist nur für den Export nötig; nicht in Chat, Git oder Screenshots teilen.
2. Mit `Authorization: Token …` und identifizierendem User-Agent zuerst `GET https://api.listenbrainz.org/1/export/list` abrufen. Geeigneten fertigen Export wiederverwenden oder bestehenden Auftrag fortsetzen.
3. Andernfalls einmal `POST https://api.listenbrainz.org/1/export/` ohne Body senden und `export_id` aufbewahren.
4. `GET /1/export/{export_id}` zunächst nach mindestens 30 Sekunden, dann mit größeren Abständen abrufen. Bei `failed` stoppen. Bei `completed` über `GET /1/export/{export_id}/download` die ZIP-Datei herunterladen.
5. Lokal entpacken. Ausschließlich Dateien `listens/<Jahr>/<Monat>.jsonl` in Sonora als **JSON** importieren und die bestehende ListenBrainz-Quelle als Ziel wählen. Vorschau prüfen und bestätigen. Der Parser akzeptiert auch Listen-Arrays.

Vollständige Endpoint-, Authentifizierungs- und Archivbeschreibung: [offizieller Exportweg](https://listenbrainz.readthedocs.io/en/latest/users/api/export.html). Sonora fordert diesen Export nicht automatisch an. Der Token muss Sonora dafür nicht übergeben werden. Die Monatsdateien enthalten genügend Angaben zum Abgleich mit neuen API-Listen. Wiederholt denselben Monats-Export in dieselbe Quelle zu importieren erzeugt keine weiteren Ereignisse. Nachträgliche Anbieteränderungen und sehr alte Nachmeldungen verlangen einen neuen Export; API-Inkremente sind kein vollständiges Änderungsprotokoll.

## Persönlicher Spotify-Datenexport: gesonderte Entscheidung

**Kein Spotify-API-Connector, OAuth, SDK, Player oder Katalogabruf.** Die Developer Policy untersagt unter III.13 Analysen einschließlich abgeleiteter Hör-/Nutzerkennzahlen. Technisch verfügbare API-Endpunkte wären deshalb keine Grundlage für Sonoras Statistikprodukt. [Developer Policy](https://developer.spotify.com/policy). Die Developer Terms regeln den Zugriff auf die Entwicklerplattform und definieren Spotify-Inhalte weit. [Developer Terms](https://developer.spotify.com/terms).

Spotify bietet unabhängig davon eine Kopie eigener Daten über **Kontodatenschutz → Daten herunterladen** an. Spotify beschreibt auch das Recht, persönliche Daten zur Verwendung bei anderen Diensten zu übertragen. [Datenrechte und Download](https://support.spotify.com/us/article/data-rights-and-privacy-settings/), [Datenschutzerklärung, Abschnitt 2](https://www.spotify.com/de/legal/privacy-policy/).

**Umsetzungsentscheidung / Einordnung:** Sonora verarbeitet ausschließlich die vom Kontoinhaber selbst heruntergeladenen Dateien privat auf seinem Server. Diese lokale Nutzung der eigenen Datenkopie wird vom Zugriff auf die Entwicklerplattform getrennt. Die Exportdokumentation ist keine ausdrückliche Spotify-Freigabe für jedes Analyseprodukt. Keine Behauptung einer Partnerschaft oder allgemeinen kommerziellen Lizenz; öffentliche/kommerzielle Nutzung und die Einbeziehung von Plattformdaten wären erneut gesondert zu prüfen. Eine Zustimmung zu API-Zugriff würde das Statistikverbot nicht aufheben.

### Import und Bedeutung

1. Im eigenen Spotify-Konto den **erweiterten Streamingverlauf** anfordern, sofern gewünscht; ZIP herunterladen und lokal entpacken.
2. In Sonora das eigene Importformat **Spotify** wählen und ausschließlich Hörverlaufs-JSON hochladen; jede Exportdatei nacheinander in dieselbe Quelle importieren.
3. Vorschau mit Zeitraum, Wiedergaben und Hinweisen prüfen, danach bestätigen.

Der erweiterte Export beschreibt den Kontoverlauf; der einfache Kontodatenexport den jüngeren Verlauf. Beide enthalten das Ende des Streams in UTC und gespielte Millisekunden. [Offizielle Feldbeschreibung](https://support.spotify.com/us/article/understanding-your-data/).

Parser: erweitert `ts`, `ms_played`, `master_metadata_track_name`, `master_metadata_album_artist_name`, optional `master_metadata_album_album_name`; einfach `endTime`, `msPlayed`, `trackName`, `artistName`. `endTime` wird gemäß Exportdefinition als UTC interpretiert, trotz fehlendem Offset. Seine Minutenauflösung bleibt als Warnung sichtbar. Die Statistik ordnet das Ereignis dem **Stream-Ende** zu; gemessene Dauer wird nicht künstlich über Kalendergrenzen aufgeteilt. Auch kurze und abgebrochene Musikstreams zählen als erfasste Ereignisse; das entspricht nicht zwingend Spotifys oder Last.fms Zählregeln. Podcasts/Hörbücher werden mit Hinweis ausgelassen. IP-Adresse, Plattform, Land, Benutzername und sonstige Begleitdaten werden nicht übernommen. Es werden keine Titelbilder oder Audiodaten importiert.

## Eigene CSV- und JSON-Dateien

UTF-8, optional BOM; CSV mit Komma oder Semikolon, korrekt gesetzten Anführungszeichen. Ein eigener JSON-Export aus Sonora (`{"events": [...]}`) lässt sich wieder importieren. JSON-Arrays und ListenBrainz-JSONL werden ebenfalls akzeptiert. Maximum pro Datei: **25 MiB und 100.000 Datensätze**. Größere Dateien entlang vollständiger Zeitgruppen aufteilen, damit identische Ereignisse derselben Sekunde zusammenbleiben. Die Vorschau speichert noch keine Ereignisse; Validierungsfehler enthalten Zeilennummern.

```csv
playedAt,artist,track,album,durationMs,durationKind,tags,externalId
2026-03-29T03:15:00+02:00,Beispielkünstler,Beispielsong,,180000,measured,ambient|electronic,mein-event-001
```

```json
[
  {
    "playedAt": "2026-03-29T01:15:00Z",
    "artist": "Beispielkünstler",
    "track": "Beispielsong",
    "album": null,
    "durationMs": null,
    "durationKind": null,
    "tags": [],
    "externalId": "mein-event-001"
  }
]
```

`playedAt`, `artist`, `track` sind erforderlich. ISO-8601-Zeitstempel brauchen einen UTC-Offset oder `Z`; ungültige Daten und mehrdeutige lokale Uhrzeiten werden abgelehnt. Die Spotify-Ausnahme gilt ausschließlich für das beschriebene, offizielle `endTime`-Format. Unbekannte Dauer und Album bleiben `null`. Millisekunden mit `durationKind=measured` zählen als gemessen; `estimated` als geschätzt. Fehlt die Kennzeichnung bei vorhandener Dauer, wird vorsichtig geschätzt. Tags sind optional; Sonora behauptet keine automatisch vollständige Genreabdeckung.

### Identität, Überschneidungen und Grenzen

- Datenbankidentität: **Quelle + externalId**. Stabile Quell-IDs bleiben bei Folgeimporten erhalten; Dateinamen sind keine Quellenidentität.
- Ohne eigene externe ID: normalisierter Zeitstempel, Künstler und Song plus Vorkommensindex. Derselbe Song zu unterschiedlichen Zeiten bleibt mehrfach erhalten; mehrere identische Ereignisse derselben Sekunde innerhalb einer Datei ebenfalls.
- **Unauflösbare Grenze:** Zwei vollständig identische Ereignisse in verschiedenen Teil-Dateien sind ohne stabile Anbieter-ID nicht von überlappenden Kopien zu unterscheiden. Vollständige Originaldateien zusammen importieren beziehungsweise eigene stabile `externalId` liefern. Ein Index ist kein Beweis einer global eindeutigen Wiedergabe.
- Ereignisse verschiedener Quellen werden nicht automatisch zusammengeführt. Kanonische Sammel-Exporte übernehmen die Herkunft und kapseln IDs unterschiedlicher Originalquellen, damit sie nicht kollidieren. Mögliche Überschneidungen bleiben sichtbar.
- Laufende Wiedergaben sind transient; Dateiimporte überspringen sie mit Warnung.
- Anbieter können keine Ereignisse liefern, die nie erfasst wurden. „Erstmals gehört“ bedeutet ausschließlich erstmals im **vorhandenen Sonora-Verlauf**.

## Betrieb der Connectoren

`connectors[kind].fetchPage({sourceId, username, apiKey?, cursor?, since?})` führt eine Seite aus und liefert `events`, `cursor`, `done`, `coverageNote`. Der Worker speichert Ereignisse idempotent und Cursor atomar. Nur nach vollständigem Durchlauf wird die erfolgreiche Synchronisation aktualisiert. `since` ist beim nächsten Durchlauf die letzte verlässlich abgearbeitete obere Grenze; die Connectoren berechnen selbst die Überlappung. Last.fm-Cursor enthält feste Zeitgrenzen, Seite und Vorkommenszähler am Rand. ListenBrainz-Cursor enthält feste untere Grenze, nächste exklusive Obergrenze und Seitenzahl.

HTTP-Abrufe sind pro Anbieter serialisiert und mindestens 1,1 Sekunden auseinander. `Retry-After` und ListenBrainz-Reset-Header werden beachtet. Bis zu drei Versuche bei vorübergehenden Server-/Limitfehlern; längere Wartezeiten gehen an die Job-Wiederholung. Einzelanfragen haben 20 Sekunden Timeout, maximal 8 MB Antwort und feste HTTPS-Zieladressen; Weiterleitungen sind gesperrt. Fehlermeldungen geben weder Schlüssel noch rohe Anbieterantworten aus. Schlüssel stehen ausschließlich in serverseitigen Anfragen und gehören nicht in Zugriffslogs des ausgehenden Proxys.

Geprüft mit automatisierten Tests: BOM/CSV-Escaping, UTC/Datumsvalidierung, fehlende und gemessene/geschätzte Dauer, Spotify-Formate, JSON-Rundlauf, identische Wiederholungen, Export/API-Abgleich, Seitenübergänge, laufende Wiedergaben, Rate-Limits und sichere Fehlermeldungen. Live-Ende-zu-Ende mit den eigenen Konten muss nach Einrichten der Zugangsdaten kontrolliert werden.
