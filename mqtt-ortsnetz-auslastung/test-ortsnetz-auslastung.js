// Tests ohne Broker und ohne Netzwerk. Aufruf: npm test
'use strict';

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const bridge = require('./ortsnetz-auslastung.js');

const NOW = Date.parse('2026-10-21T12:00:00Z');

function config(overrides = {}) {
    return {
        ...bridge.CONFIG,
        latitude: 48.2,
        longitude: 11.6,
        l1Topic: 'v/l1',
        l2Topic: 'v/l2',
        l3Topic: 'v/l3',
        frequencyTopic: 'f',
        ...overrides,
    };
}

function stateWith(values, at = NOW) {
    const state = bridge.createState();
    for (const [topic, list] of Object.entries(values)) {
        for (const value of [].concat(list)) {
            bridge.recordValue(state, topic, value, at);
        }
    }
    return state;
}

const VOLTAGES = { 'v/l1': 230.1, 'v/l2': 229.9, 'v/l3': 231.0 };

test('envName trennt auch nach Ziffern', () => {
    assert.equal(bridge.envName('l1Topic'), 'ORTSNETZ_L1_TOPIC');
    assert.equal(bridge.envName('l2CurrentTopic'), 'ORTSNETZ_L2_CURRENT_TOPIC');
    assert.equal(bridge.envName('plant_capacity_kwp'), 'ORTSNETZ_PLANT_CAPACITY_KWP');
    assert.equal(bridge.envName('gridPowerInvert'), 'ORTSNETZ_GRID_POWER_INVERT');
});

test('loadConfig liest Umgebungsvariablen mit passendem Typ', () => {
    const loaded = bridge.loadConfig({
        ORTSNETZ_LATITUDE: '48.2',
        ORTSNETZ_L1_TOPIC: 'sdm630/l1',
        ORTSNETZ_GRID_POWER_INVERT: 'true',
        ORTSNETZ_PLANT_CAPACITY_KWP: '29.6',
        ORTSNETZ_LONGITUDE: '',
    });
    assert.equal(loaded.latitude, 48.2);
    assert.equal(loaded.l1Topic, 'sdm630/l1');
    assert.equal(loaded.gridPowerInvert, true);
    assert.equal(loaded.plant_capacity_kwp, 29.6);
    assert.equal(loaded.longitude, null, 'leere Variable lässt den Standardwert');
});

test('loadConfig lehnt ungültige Zahlen und Wahrheitswerte ab', () => {
    assert.throws(() => bridge.loadConfig({ ORTSNETZ_LATITUDE: 'abc' }), /ORTSNETZ_LATITUDE/);
    assert.throws(() => bridge.loadConfig({ ORTSNETZ_DRY_RUN: 'ja' }), /ORTSNETZ_DRY_RUN/);
});

test('validateConfig verlangt Koordinaten; Standardwerte senden keine erfundenen Daten', () => {
    const errors = bridge.validateConfig(bridge.CONFIG);
    assert.ok(errors.some((error) => error.includes('latitude')));
    assert.ok(errors.some((error) => error.includes('longitude')));
    assert.equal(bridge.CONFIG.plant_capacity_kwp, null);
    assert.equal(bridge.CONFIG.smartmeterModel, '');
    assert.deepEqual(bridge.validateConfig(config()), []);
});

test('validateConfig prüft statische Angaben und Topics', () => {
    assert.ok(bridge.validateConfig(config({ plant_capacity_kwp: 0 })).length > 0);
    assert.ok(bridge.validateConfig(config({ plant_capacity_kwp: 1001 })).length > 0);
    assert.ok(bridge.validateConfig(config({ battery_capacity_kwh: -1 })).length > 0);
    assert.ok(bridge.validateConfig(config({ l1Topic: '', l2Topic: '', l3Topic: '' })).length > 0);
});

test('parsePayload liest Zahlen und JSON-Schlüssel', () => {
    assert.equal(bridge.parsePayload(Buffer.from(' 230.5 '), ''), 230.5);
    assert.equal(bridge.parsePayload(Buffer.from('{"data":{"v":231}}'), 'data.v'), 231);
    assert.ok(Number.isNaN(bridge.parsePayload(Buffer.from(''), '')));
    assert.ok(Number.isNaN(bridge.parsePayload(Buffer.from('{"v":null}'), 'v')));
    assert.ok(Number.isNaN(bridge.parsePayload(Buffer.from('kaputt'), '')));
});

test('buildPayload sendet Spannungen, Frequenz und Statistik des Intervalls', () => {
    const state = stateWith({ 'v/l1': [229.0, 232.0, 230.1], 'v/l2': 229.9, 'v/l3': 231.0, f: [49.98, 50.02] });
    const payload = bridge.buildPayload(state, config(), NOW);
    assert.equal(payload.observed_at, '2026-10-21T12:00:00.000Z');
    assert.equal(payload.l1_v, 230.1);
    assert.equal(payload.l1_v_min, 229.0);
    assert.equal(payload.l1_v_max, 232.0);
    assert.equal(payload.l1_v_avg, 230.367);
    assert.ok(payload.l1_v_min <= payload.l1_v_avg && payload.l1_v_avg <= payload.l1_v_max);
    assert.equal(payload.grid_frequency_hz, 50.02);
    assert.equal(payload.grid_frequency_hz_avg, 50);
    assert.equal(payload.integration_version, 'mqtt-0.4.0');
});

test('buildPayload lässt unplausible Werte aus der Statistik weg', () => {
    const state = stateWith({ 'v/l1': [0, 229.0, 231.0], 'v/l2': 229.9, 'v/l3': 231.0 });
    const payload = bridge.buildPayload(state, config(), NOW);
    assert.equal(payload.l1_v_min, 229.0);
});

test('buildPayload überspringt den Upload bei fehlender oder veralteter Spannung', () => {
    assert.equal(bridge.buildPayload(stateWith({ 'v/l1': 230, 'v/l2': 230 }), config(), NOW), null);
    assert.equal(bridge.buildPayload(stateWith({ ...VOLTAGES, 'v/l3': 120 }), config(), NOW), null);
    const old = stateWith(VOLTAGES, NOW - 7 * 60 * 1000);
    assert.equal(bridge.buildPayload(old, config(), NOW), null);
});

test('buildPayload sendet -1 für Phasen ohne Topic (einphasig)', () => {
    const payload = bridge.buildPayload(stateWith({ 'v/l1': 230 }), config({ l2Topic: '', l3Topic: '' }), NOW);
    assert.equal(payload.l1_v, 230);
    assert.equal(payload.l2_v, -1);
    assert.equal(payload.l3_v, -1);
    assert.equal(payload.l2_v_min, undefined);
});

test('buildPayload sendet Leistung, Strom und Ladezustand des Hausanschlusses', () => {
    const topics = {
        gridPowerTopic: 'p', apparentPowerTopic: 's', powerFactorTopic: 'pf',
        l1CurrentTopic: 'i1', l2CurrentTopic: 'i2', batterySocTopic: 'soc',
    };
    const state = stateWith({ ...VOLTAGES, p: -3515, s: 3600, pf: -0.97, i1: 5.2, i2: 4.8, soc: 62.5 });
    const payload = bridge.buildPayload(state, config(topics), NOW);
    assert.equal(payload.grid_power_w, -3515);
    assert.equal(payload.apparent_power_va, 3600);
    assert.equal(payload.power_factor, 0.97, 'Betrag des Leistungsfaktors');
    assert.equal(payload.l1_a, 5.2);
    assert.equal(payload.l2_a, 4.8);
    assert.equal(payload.l3_a, -1, 'Phase ohne Topic');
    assert.equal(payload.battery_soc_percent, 62.5);
});

test('buildPayload dreht das Vorzeichen der Leistung nur auf Anforderung', () => {
    const state = stateWith({ ...VOLTAGES, p: 2597 });
    assert.equal(bridge.buildPayload(state, config({ gridPowerTopic: 'p' }), NOW).grid_power_w, 2597);
    assert.equal(bridge.buildPayload(state, config({ gridPowerTopic: 'p', gridPowerInvert: true }), NOW).grid_power_w, -2597);
});

test('buildPayload lässt unplausible optionale Werte weg', () => {
    const topics = { apparentPowerTopic: 's', powerFactorTopic: 'pf', batterySocTopic: 'soc', l1CurrentTopic: 'i1' };
    const state = stateWith({ ...VOLTAGES, s: 0, pf: 0.9, soc: 101, i1: -2 });
    const payload = bridge.buildPayload(state, config(topics), NOW);
    assert.equal(payload.apparent_power_va, 0);
    assert.equal(payload.power_factor, undefined, 'kein Leistungsfaktor bei Scheinleistung 0');
    assert.equal(payload.battery_soc_percent, undefined);
    assert.equal(payload.l1_a, undefined, 'veralteter oder ungültiger Strom wird weggelassen, nicht -1');
});

test('buildPayload rechnet die PV-Prognose von Wh in kWh um', () => {
    const payload = bridge.buildPayload(stateWith({ ...VOLTAGES, fc: 24500 }), config({ solarForecastTopic: 'fc' }), NOW);
    assert.equal(payload.pv_forecast_kwh, 24.5);
});

test('statische Angaben gehen nur bis zur ersten angenommenen Messung mit', () => {
    const state = stateWith(VOLTAGES);
    const cfg = config({ smartmeterModel: 'Eastron SDM630', plant_capacity_kwp: 29.6, battery_capacity_kwh: 41.2 });
    const first = bridge.buildPayload(state, cfg, NOW);
    assert.equal(first.smartmeter_model, 'Eastron SDM630');
    assert.equal(first.plant_capacity_kwp, 29.6);
    assert.equal(first.battery_capacity, 41.2);
    state.staticSent = true;
    const later = bridge.buildPayload(state, cfg, NOW);
    assert.equal(later.smartmeter_model, undefined);
    assert.equal(later.plant_capacity_kwp, undefined);
    assert.equal(later.battery_capacity, undefined);
});

test('checkResponse verlangt HTTP 202 und accepted=true', () => {
    assert.equal(bridge.checkResponse(202, '{"accepted":true,"status":{"overall":"green"}}').status.overall, 'green');
    assert.throws(() => bridge.checkResponse(202, '{"accepted":false}'));
    assert.throws(() => bridge.checkResponse(422, '{"error":"x"}'), /HTTP 422/);
    assert.throws(() => bridge.checkResponse(202, 'kein json'));
});

test('upload sendet, setzt staticSent und beginnt ein neues Statistik-Intervall', async (t) => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => ({
        status: 202,
        text: async () => '{"accepted":true,"status":{"overall":"green"},"storage_recommendation":"none"}',
    }));
    t.after(() => fetchMock.mock.restore());
    mock.method(console, 'log', () => {});
    const state = stateWith(VOLTAGES);
    assert.equal(await bridge.upload(state, config({ plant_capacity_kwp: 10 }), NOW), true);
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.plant_capacity_kwp, 10);
    assert.equal(state.staticSent, true);
    assert.equal(state.samples.size, 0);
});

test('upload behält statische Angaben nach einer Ablehnung', async (t) => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => ({ status: 422, text: async () => '{}' }));
    t.after(() => fetchMock.mock.restore());
    mock.method(console, 'warn', () => {});
    const state = stateWith(VOLTAGES);
    assert.equal(await bridge.upload(state, config(), NOW), false);
    assert.equal(state.staticSent, false);
});

test('upload sendet im Probelauf nichts', async (t) => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('darf nicht senden'); });
    t.after(() => fetchMock.mock.restore());
    const logMock = mock.method(console, 'log', () => {});
    assert.equal(await bridge.upload(stateWith(VOLTAGES), config({ dryRun: true }), NOW), true);
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.match(logMock.mock.calls.at(-1).arguments[0], /"l1_v": 230.1/);
});

test('topicsOf abonniert jedes konfigurierte Topic genau einmal', () => {
    const topics = bridge.topicsOf(config({ gridPowerTopic: 'p', batterySocTopic: 'p', solarForecastTopic: '' }));
    assert.deepEqual(topics, ['v/l1', 'v/l2', 'v/l3', 'f', 'p']);
});
