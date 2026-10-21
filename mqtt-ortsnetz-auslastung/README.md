# Ortsnetz-Auslastung für MQTT

Das Script abonniert Messwerte auf einem MQTT-Broker. Es prüft die Werte und sendet sie alle fünf Minuten an die Ortsnetz-Auslastung-API.

Pflicht sind die Spannungen. Optional sendet das Script Netzfrequenz, Leistung, Strom und Leistungsfaktor am Hausanschluss, den Ladezustand des Speichers und eine PV-Prognose. Für Spannung und Frequenz bildet es Minimum, Mittelwert und Maximum über das Sendeintervall.

Geeignet für alle Quellen, die Messwerte per MQTT veröffentlichen, z. B. [mbmd](https://github.com/volkszaehler/mbmd), Node-RED, Tasmota, evcc oder Shelly.

## Voraussetzungen

- Node.js ab Version 24 oder Docker
- MQTT-Broker mit der Spannung je Phase in Volt
- Internetzugang
- Koordinaten des Messorts, siehe [OpenStreetMap](https://www.openstreetmap.org/): Ort suchen, Rechtsklick, **„Abfrage starten“**

## Installation

1. Dieses Verzeichnis auf den Zielrechner kopieren.
2. `npm ci` ausführen.
3. Konfiguration eintragen: im `CONFIG`-Block von [ortsnetz-auslastung.js](ortsnetz-auslastung.js) oder per Umgebungsvariable.
4. Probelauf ohne Übertragung: `npm run dry-run`. Nach `firstUploadDelayMs` (15 s) erscheint der Payload. Werte mit einer vorhandenen Anzeige vergleichen.
5. Dauerbetrieb: `npm start`. Der erste Upload folgt 15 s nach dem Verbinden, danach alle fünf Minuten.

Bei ungültiger Konfiguration beendet sich das Script mit Exitcode 2.

## Konfiguration

Jeder Schlüssel aus `CONFIG` lässt sich als Umgebungsvariable setzen: Großbuchstaben, Präfix `ORTSNETZ_`. Beispiel: `l1Topic` wird `ORTSNETZ_L1_TOPIC`. Eine nichtleere Umgebungsvariable hat Vorrang. Ein leeres Topic bedeutet: Wert nicht vorhanden.

| Schlüssel | Pflicht | Beschreibung |
| --- | --- | --- |
| `latitude`, `longitude` | ja | Messort |
| `brokerUrl`, `username`, `password` | ja | Broker, z. B. `mqtt://broker:1883`; Zugangsdaten leer bei anonymem Zugang |
| `l1Topic`, `l2Topic`, `l3Topic` | ja | Spannung je Phase in V; bei einphasiger Messung fehlende Phasen leer lassen (Übertragung als `-1`) |
| `frequencyTopic` | nein | Netzfrequenz in Hz |
| `jsonKey` | nein | Schlüssel in einem JSON-Payload, z. B. `value` oder `data.voltage`; leer bei reinen Zahlen |
| `gridPowerTopic` | nein | Wirkleistung gesamt in W, Bezug positiv, Einspeisung negativ |
| `gridPowerInvert` | nein | `true`, wenn die Quelle Einspeisung positiv meldet |
| `apparentPowerTopic` | nein | Scheinleistung gesamt in VA |
| `powerFactorTopic` | nein | Leistungsfaktor; das Script überträgt den Betrag |
| `l1CurrentTopic`, `l2CurrentTopic`, `l3CurrentTopic` | nein | Strom je Phase in A |
| `batterySocTopic` | nein | Ladezustand des Speichers in % |
| `solarForecastTopic`, `solarForecastJsonKey` | nein | PV-Tagesprognose in Wh, z. B. `evcc/site/forecast/solar` mit `today.energy` |
| `smartmeterModel` | nein | Hersteller und Modell des Messgeräts, z. B. `Eastron SDM630` |
| `plant_capacity_kwp` | nein | Installierte PV-Leistung in kWp; nötig für die PV-Prognose |
| `battery_capacity_kwh` | nein | Nutzbare Speicherkapazität in kWh |
| `maxValueAgeMs` | nein | Ältere Werte gelten als fehlend; Standard 6 min |
| `uploadIntervalMs`, `firstUploadDelayMs` | nein | Sendeintervall (5 min) und Wartezeit vor dem ersten Upload (15 s) |

Leistung, Strom und Leistungsfaktor nur vom Hausanschluss eintragen. Werte eines Wechselrichters oder einer einzelnen Phase sind nicht zulässig, siehe [API.md](../API.md).

Die statischen Angaben `smartmeterModel`, `plant_capacity_kwp` und `battery_capacity_kwh` sendet das Script nach jedem Start, bis die API eine Messung annimmt.

## Docker

```sh
cp .env.example .env     # Koordinaten, Broker und Topics eintragen
docker compose build
docker compose run --rm ortsnetz-mqtt node ortsnetz-auslastung.js --dry-run
docker compose up -d
docker logs -f ortsnetz-mqtt
```

Ohne Koordinaten in `.env` startet Compose den Container nicht.

## Verhalten

- Spannungen außerhalb von 150–300 V und Frequenzen außerhalb von 45–55 Hz gelten als unplausibel.
- Fehlt eine konfigurierte Spannung oder ist sie unplausibel, überspringt das Script den Upload.
- Unplausible Einzelwerte gehen nicht in Minimum, Mittelwert und Maximum ein.
- Optionale Werte außerhalb des API-Wertebereichs lässt das Script weg. Es überträgt kein `0` und keine Schätzung als Ersatz.
- Bei Scheinleistung 0 lässt das Script den Leistungsfaktor weg. Die API würde die Messung sonst ablehnen.
- Ein Upload gilt nur bei HTTP `202` mit `accepted: true` als erfolgreich.
- Bei Ampelstatus `yellow` oder `red` schreibt das Script eine Warnung ins Log.

## Fehleranalyse

- `Spannung fehlt oder ist unplausibel`: Topics mit `mosquitto_sub -h broker.local -v -t '#'` prüfen. Sendet die Quelle seltener als alle sechs Minuten, `maxValueAgeMs` erhöhen.
- `Wert aus … nicht lesbar`: Payload prüfen und ggf. `jsonKey` setzen.
- `API hat die Messung nicht angenommen: HTTP 422`: Ein Wert verletzt den API-Wertebereich. Die Antwort im Log nennt das Feld.

## Tests

Ohne Broker und ohne Netzwerk:

```sh
npm test
```

## Änderungen in Version 0.4.0

- Neue optionale Felder: Leistung, Scheinleistung, Leistungsfaktor, Strom, Ladezustand, Speicherkapazität sowie Minimum, Mittelwert und Maximum für Spannung und Frequenz.
- Konfiguration auch per Umgebungsvariable, Probelauf mit `--dry-run`, Tests.
- Keine Standardwerte mehr für Koordinaten, `plant_capacity_kwp` und `smartmeterModel`. Bisher sendete eine nicht angepasste Installation Berlin, 5 kWp und `SDM630`. Bestehende Installationen müssen diese Werte selbst setzen.
- Statische Angaben gehen nicht mehr mit jedem Upload mit, sondern nach dem Start bis zur ersten angenommenen Messung.
- Einphasige Messungen sind möglich.
- Der erste Upload wartet 15 s auf Werte. Bisher folgte er sofort und scheiterte bei Quellen ohne Retain-Flag.
- Das Log meldet nicht mehr jeden empfangenen Wert.
