/*
 * Ortsnetz-Auslastung für MQTT
 * Version: 0.4.0
 *
 * Abonniert Messwerte auf einem MQTT-Broker und sendet sie alle fünf Minuten
 * an die API von ortsnetz-auslastung.de.
 * Benötigt Node.js ab Version 24 und das npm-Paket "mqtt".
 *
 * Aufruf:
 *   node ortsnetz-auslastung.js            Dauerbetrieb
 *   node ortsnetz-auslastung.js --dry-run  Payload nur ausgeben, nicht senden
 */

'use strict';

// ---------------- Konfiguration ----------------
// Jeder Wert lässt sich auch per Umgebungsvariable setzen. Der Name ist der
// Schlüssel in Großbuchstaben mit Präfix ORTSNETZ_, z. B. l1Topic ->
// ORTSNETZ_L1_TOPIC. Eine nichtleere Umgebungsvariable hat Vorrang.
// Ein leeres Topic ('') bedeutet: Wert nicht vorhanden.
const CONFIG = {
    latitude: null, // Pflicht, z. B. 52.520008
    longitude: null, // Pflicht, z. B. 13.404954
    brokerUrl: 'mqtt://broker.local:1883',
    username: '',
    password: '',

    // Spannung je Phase in Volt. Bei einphasiger Messung die fehlenden Phasen
    // auf '' setzen; sie werden als -1 übertragen.
    l1Topic: 'mbmd/sdm1-1/Voltage/L1',
    l2Topic: 'mbmd/sdm1-1/Voltage/L2',
    l3Topic: 'mbmd/sdm1-1/Voltage/L3',
    frequencyTopic: 'mbmd/sdm1-1/Frequency', // Netzfrequenz in Hz
    jsonKey: '', // Schlüssel in einem JSON-Payload, z. B. 'value' oder 'data.voltage'

    // Optionale Messwerte am Hausanschluss. Nur Werte des Hausanschlusses
    // eintragen, keine Werte eines Wechselrichters oder einer Unterverteilung.
    gridPowerTopic: '', // Wirkleistung gesamt in W, Bezug positiv
    gridPowerInvert: false, // true, wenn das Gerät Einspeisung positiv meldet
    apparentPowerTopic: '', // Scheinleistung gesamt in VA
    powerFactorTopic: '', // Leistungsfaktor; das Vorzeichen wird ignoriert
    l1CurrentTopic: '', // Strom je Phase in A
    l2CurrentTopic: '',
    l3CurrentTopic: '',
    batterySocTopic: '', // Ladezustand des Speichers in %

    // PV-Tagesprognose in Wh, z. B. von evcc.
    solarForecastTopic: '',
    solarForecastJsonKey: 'today.energy',

    // Statische Angaben. Das Script sendet sie nach jedem Start einmal.
    // null oder '' = nicht senden.
    smartmeterModel: '', // Hersteller und Modell des Messgeräts, z. B. 'Eastron SDM630'
    plant_capacity_kwp: null, // installierte PV-Leistung in kWp
    battery_capacity_kwh: null, // nutzbare Speicherkapazität in kWh

    maxValueAgeMs: 6 * 60 * 1000, // ältere Werte gelten als fehlend
    uploadIntervalMs: 5 * 60 * 1000,
    firstUploadDelayMs: 15 * 1000, // Wartezeit auf die ersten Werte nach dem Verbinden
    dryRun: false,
};
// -----------------------------------------------

const API_URL = 'https://www.ortsnetz-auslastung.de/v1/measurements';
const VERSION = 'mqtt-0.4.0';

const VOLTAGE_MIN = 150;
const VOLTAGE_MAX = 300;
const FREQUENCY_MIN = 45;
const FREQUENCY_MAX = 55;
const PHASES = ['l1', 'l2', 'l3'];

// Wahr nur für endliche Zahlen. Vergleiche wie null >= 0 sind in JavaScript wahr.
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const between = (value, min, max) => isNumber(value) && value >= min && value <= max;

function envName(key) {
    return 'ORTSNETZ_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

// Liest die Umgebungsvariablen. Der Typ folgt dem Standardwert; Schlüssel mit
// Standardwert null sind Zahlen.
function loadConfig(env = process.env, defaults = CONFIG) {
    const config = { ...defaults };
    for (const [key, standard] of Object.entries(defaults)) {
        const raw = env[envName(key)];
        if (raw === undefined || raw === '') {
            continue;
        }
        if (typeof standard === 'boolean') {
            if (!['true', 'false', '1', '0'].includes(raw.toLowerCase())) {
                throw new Error(`${envName(key)} muss true oder false sein.`);
            }
            config[key] = ['true', '1'].includes(raw.toLowerCase());
        } else if (typeof standard === 'number' || standard === null) {
            const value = Number(raw);
            if (!Number.isFinite(value)) {
                throw new Error(`${envName(key)} ist keine Zahl.`);
            }
            config[key] = value;
        } else {
            config[key] = raw;
        }
    }
    return config;
}

// Gibt eine Liste mit Fehlermeldungen zurück. Eine leere Liste bedeutet gültig.
function validateConfig(config) {
    const errors = [];
    const inRange = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

    if (!inRange(config.latitude, -90, 90)) {
        errors.push('latitude muss zwischen -90 und 90 gesetzt sein.');
    }
    if (!inRange(config.longitude, -180, 180)) {
        errors.push('longitude muss zwischen -180 und 180 gesetzt sein.');
    }
    if (!PHASES.some((phase) => config[`${phase}Topic`])) {
        errors.push('Mindestens ein Spannungs-Topic (l1Topic, l2Topic, l3Topic) ist nötig.');
    }
    if (config.plant_capacity_kwp !== null && !(config.plant_capacity_kwp > 0 && config.plant_capacity_kwp <= 1000)) {
        errors.push('plant_capacity_kwp muss größer als 0 und höchstens 1000 sein.');
    }
    if (config.battery_capacity_kwh !== null && !(config.battery_capacity_kwh > 0)) {
        errors.push('battery_capacity_kwh muss größer als 0 sein.');
    }
    if (config.smartmeterModel.length > 120) {
        errors.push('smartmeterModel darf höchstens 120 Zeichen lang sein.');
    }
    for (const key of ['maxValueAgeMs', 'uploadIntervalMs']) {
        if (!(config[key] > 0)) {
            errors.push(`${key} muss größer als 0 sein.`);
        }
    }
    if (!(config.firstUploadDelayMs >= 0)) {
        errors.push('firstUploadDelayMs darf nicht negativ sein.');
    }
    return errors;
}

function parsePayload(payload, jsonKey) {
    const text = payload.toString().trim();
    const direct = Number(text);

    if (text !== '' && Number.isFinite(direct)) {
        return direct;
    }

    try {
        const parsed = JSON.parse(text);
        const picked = jsonKey
            ? jsonKey.split('.').reduce((node, key) => (node == null ? undefined : node[key]), parsed)
            : parsed;

        return picked === null || picked === '' ? NaN : Number(picked);
    } catch {
        return NaN;
    }
}

// Zustand: letzter Wert je Topic und alle Werte seit dem letzten Upload.
function createState() {
    return { latest: new Map(), samples: new Map(), staticSent: false };
}

function recordValue(state, topic, value, now) {
    state.latest.set(topic, { value, receivedAt: now });
    if (!state.samples.has(topic)) {
        state.samples.set(topic, []);
    }
    state.samples.get(topic).push(value);
}

function currentValue(state, topic, config, now) {
    const entry = topic ? state.latest.get(topic) : undefined;
    if (!entry || now - entry.receivedAt > config.maxValueAgeMs) {
        return null;
    }
    return entry.value;
}

// Minimum, Maximum und Mittelwert der plausiblen Werte seit dem letzten Upload.
function statistics(state, topic, min, max) {
    const values = (state.samples.get(topic) || []).filter((value) => between(value, min, max));
    if (values.length === 0) {
        return null;
    }
    const round = (value) => Math.round(value * 1000) / 1000;
    return {
        min: round(Math.min(...values)),
        max: round(Math.max(...values)),
        avg: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    };
}

// Erstellt den Request für die API. Gibt null zurück, wenn eine konfigurierte
// Spannung fehlt oder unplausibel ist.
function buildPayload(state, config, now) {
    const value = (topic) => currentValue(state, topic, config, now);
    const payload = {
        observed_at: new Date(now).toISOString(),
        latitude: config.latitude,
        longitude: config.longitude,
    };

    for (const phase of PHASES) {
        const topic = config[`${phase}Topic`];
        if (!topic) {
            payload[`${phase}_v`] = -1;
            continue;
        }
        const voltage = value(topic);
        if (!between(voltage, VOLTAGE_MIN, VOLTAGE_MAX)) {
            return null;
        }
        payload[`${phase}_v`] = voltage;
        const stats = statistics(state, topic, VOLTAGE_MIN, VOLTAGE_MAX);
        if (stats) {
            payload[`${phase}_v_min`] = stats.min;
            payload[`${phase}_v_max`] = stats.max;
            payload[`${phase}_v_avg`] = stats.avg;
        }
    }

    const frequency = value(config.frequencyTopic);
    if (between(frequency, FREQUENCY_MIN, FREQUENCY_MAX)) {
        payload.grid_frequency_hz = frequency;
        const stats = statistics(state, config.frequencyTopic, FREQUENCY_MIN, FREQUENCY_MAX);
        if (stats) {
            payload.grid_frequency_hz_min = stats.min;
            payload.grid_frequency_hz_max = stats.max;
            payload.grid_frequency_hz_avg = stats.avg;
        }
    }

    const gridPower = value(config.gridPowerTopic);
    if (isNumber(gridPower)) {
        payload.grid_power_w = config.gridPowerInvert ? -gridPower : gridPower;
    }

    const apparentPower = value(config.apparentPowerTopic);
    if (isNumber(apparentPower) && apparentPower >= 0) {
        payload.apparent_power_va = apparentPower;
    }

    // Die API lehnt einen Leistungsfaktor bei Scheinleistung 0 ab (HTTP 422).
    const powerFactor = value(config.powerFactorTopic);
    if (between(Math.abs(powerFactor ?? NaN), 0, 1) && payload.apparent_power_va !== 0) {
        payload.power_factor = Math.abs(powerFactor);
    }

    // Strom: -1 nur für Phasen ohne Topic, wenn mindestens ein Strom-Topic
    // gesetzt ist. Ein fehlender oder veralteter Wert wird weggelassen.
    if (PHASES.some((phase) => config[`${phase}CurrentTopic`])) {
        for (const phase of PHASES) {
            const topic = config[`${phase}CurrentTopic`];
            if (!topic) {
                payload[`${phase}_a`] = -1;
                continue;
            }
            const current = value(topic);
            if (isNumber(current) && current >= 0) {
                payload[`${phase}_a`] = current;
            }
        }
    }

    const soc = value(config.batterySocTopic);
    if (between(soc, 0, 100)) {
        payload.battery_soc_percent = soc;
    }

    const pvForecast = value(config.solarForecastTopic);
    if (isNumber(pvForecast) && pvForecast >= 0) {
        payload.pv_forecast_kwh = pvForecast / 1000; // MQTT liefert Wh, die API erwartet kWh.
    }

    if (!state.staticSent) {
        if (config.smartmeterModel) {
            payload.smartmeter_model = config.smartmeterModel;
        }
        if (config.plant_capacity_kwp !== null) {
            payload.plant_capacity_kwp = config.plant_capacity_kwp;
        }
        if (config.battery_capacity_kwh !== null) {
            payload.battery_capacity = config.battery_capacity_kwh;
        }
    }

    payload.integration_version = VERSION;
    return payload;
}

// Prüft die API-Antwort. Gibt die Antwortdaten zurück oder wirft einen Fehler.
function checkResponse(status, body) {
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        data = undefined;
    }
    if (status !== 202 || data?.accepted !== true) {
        throw new Error(`API hat die Messung nicht angenommen: HTTP ${status}: ${body}`);
    }
    return data;
}

async function upload(state, config, now = Date.now()) {
    const payload = buildPayload(state, config, now);
    state.samples.clear(); // Neues Intervall für min, avg und max beginnen.

    if (payload === null) {
        console.warn('Ortsnetz-Auslastung: Spannung fehlt oder ist unplausibel; Upload übersprungen');
        return false;
    }
    if (config.dryRun) {
        console.log(JSON.stringify(payload, null, 2));
        return true;
    }

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000),
        });
        const data = checkResponse(response.status, await response.text());
        state.staticSent = true;
        console.log(`Ortsnetz-Auslastung: Upload angenommen, Ampel ${data.status?.overall ?? '-'}, `
            + `Empfehlung ${data.storage_recommendation ?? '-'}`);
        if (data.status?.overall === 'yellow' || data.status?.overall === 'red') {
            console.warn(`Ortsnetz-Auslastung: Ampelstatus ${data.status.overall}`);
        }
        return true;
    } catch (error) {
        console.warn(`Ortsnetz-Auslastung: Upload fehlgeschlagen: ${error.message ?? error}`);
        return false;
    }
}

function topicsOf(config) {
    const keys = ['l1Topic', 'l2Topic', 'l3Topic', 'frequencyTopic', 'gridPowerTopic', 'apparentPowerTopic',
        'powerFactorTopic', 'l1CurrentTopic', 'l2CurrentTopic', 'l3CurrentTopic', 'batterySocTopic',
        'solarForecastTopic'];
    return [...new Set(keys.map((key) => config[key]).filter(Boolean))];
}

function main() {
    let config;
    try {
        config = loadConfig();
        if (process.argv.includes('--dry-run')) {
            config.dryRun = true;
        }
    } catch (error) {
        console.error(`FEHLER: ${error.message}`);
        process.exit(2);
    }
    const errors = validateConfig(config);
    if (errors.length > 0) {
        errors.forEach((error) => console.error(`FEHLER: ${error}`));
        process.exit(2);
    }

    const mqtt = require('mqtt');
    const state = createState();
    const topics = topicsOf(config);
    let uploadTimer = null;

    const client = mqtt.connect(config.brokerUrl, {
        username: config.username || undefined,
        password: config.password || undefined,
        reconnectPeriod: 5000,
    });

    client.on('connect', () => {
        client.subscribe(topics, (error) => {
            if (error) {
                console.warn(`Ortsnetz-Auslastung: Abonnement fehlgeschlagen: ${error}`);
            }
        });
        console.log(`Ortsnetz-Auslastung: MQTT verbunden, ${topics.length} Topics abonniert`);
        // Der erste Upload wartet auf die ersten Werte. Danach gilt das feste Intervall.
        if (uploadTimer === null) {
            uploadTimer = setTimeout(() => {
                upload(state, config);
                uploadTimer = setInterval(() => upload(state, config), config.uploadIntervalMs);
            }, config.firstUploadDelayMs);
        }
    });

    client.on('error', (error) => {
        console.warn(`Ortsnetz-Auslastung: MQTT-Fehler: ${error}`);
    });

    client.on('message', (topic, payload) => {
        const jsonKey = topic === config.solarForecastTopic ? config.solarForecastJsonKey : config.jsonKey;
        const value = parsePayload(payload, jsonKey);
        if (Number.isFinite(value)) {
            recordValue(state, topic, value, Date.now());
        } else {
            console.warn(`Ortsnetz-Auslastung: Wert aus ${topic} nicht lesbar`);
        }
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    CONFIG, VERSION, envName, loadConfig, validateConfig, parsePayload, createState, recordValue,
    statistics, buildPayload, checkResponse, upload, topicsOf,
};
