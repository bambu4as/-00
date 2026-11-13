import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, cleanBars, downloadBackwards, toCsv, parseCsv, resolvePair, periodLabel } from '../tools/history_lib.js';

const PERIOD = 60;
const T_END = 1_700_000_000;               // момент "сейчас"
const N = 3000;                            // сколько свечей есть у "брокера"
const FIRST = T_END - N * PERIOD;          // самая старая доступная свеча

/** Фейковый брокер: отдаёт до `limit` свечей строго старше before, не глубже `depth`. */
function fakeBroker({ limit = 200, depth = FIRST, empty = false } = {}) {
    let calls = 0;
    return {
        calls: () => calls,
        async requestBefore(asset, period, before) {
            calls++;
            if (empty) return [];
            const out = [];
            for (let t = before - period; t >= depth && out.length < limit; t -= period) {
                if (t > T_END - period) continue;
                out.push({ time: t, open: 1, high: 1, low: 1, close: 1 + (t % 7) * 1e-5 });
            }
            return out;
        }
    };
}

const req = { event: 'loadHistoryPeriod', fields: { asset: '{asset}', period: '{period}', time: '{before}' } };
const run = (over = {}) => downloadBackwards({
    client: over.client || fakeBroker(over.broker), asset: 'EURUSD_otc', period: PERIOD,
    startBefore: T_END, target: T_END - 2500 * PERIOD, existing: over.existing || [],
    request: req, nowSec: T_END, batchTimeoutMs: 1, minIntervalMs: 0, maxStalls: 3,
    checkpointEvery: 1000, sleep: async () => {}, shouldStop: over.shouldStop,
    ...over.extra,
});

test('buildPayload: числа сохраняют тип, шаблоны подставляются', () => {
    const p = buildPayload({ asset: '{asset}', period: '{period}', time: '{before}', index: 0 },
        { asset: 'EURUSD_otc', period: 60, before: 123 });
    assert.deepEqual(p, { asset: 'EURUSD_otc', period: 60, time: 123, index: 0 });
    assert.throws(() => buildPayload({ x: '{nope}' }, {}));
});

test('cleanBars: отбрасывает формирующуюся свечу и битые значения', () => {
    const out = cleanBars([
        { time: T_END - 60, close: 1 },            // закрыта
        { time: T_END, close: 1 },                 // формируется
        { time: T_END - 120, close: 'x' },         // битая
    ], PERIOD, T_END);
    assert.deepEqual(out.map(b => b.time), [T_END - 60]);
});

test('полная загрузка до цели: уникальные свечи, по возрастанию, статус target_reached', async () => {
    const res = await run();
    assert.equal(res.status, 'target_reached');
    const times = res.bars.map(b => b.time);
    assert.equal(new Set(times).size, times.length);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.ok(res.bars[0].time >= T_END - 2500 * PERIOD);
    assert.ok(res.bars[0].time < T_END - 2500 * PERIOD + PERIOD * 200);
    assert.equal(res.requests, Math.ceil(2500 / 200));
});

test('глубина брокера меньше цели: статус history_start_reached, без зацикливания', async () => {
    const res = await run({ broker: { depth: T_END - 2000 * PERIOD } });
    assert.equal(res.status, 'history_start_reached');
    assert.ok(res.bars.every(b => b.time >= T_END - 2000 * PERIOD));
});

test('пустые ответы останавливают загрузку после maxStalls', async () => {
    const client = fakeBroker({ empty: true });
    const res = await run({ client });
    assert.equal(res.status, 'history_start_reached');
    assert.equal(client.calls(), 3);
    assert.equal(res.bars.length, 0);
});

test('докачка: существующие свечи не дублируются', async () => {
    const first = await run({ broker: { depth: T_END - 2000 * PERIOD } });
    const again = await downloadBackwards({
        client: fakeBroker(), asset: 'EURUSD_otc', period: PERIOD,
        startBefore: first.bars[0].time, target: T_END - 2500 * PERIOD, existing: first.bars,
        request: req, nowSec: T_END, batchTimeoutMs: 1, minIntervalMs: 0, maxStalls: 3,
        sleep: async () => {},
    });
    const times = again.bars.map(b => b.time);
    assert.equal(new Set(times).size, times.length);
    assert.ok(again.bars.length > first.bars.length);
});

test('остановка по сигналу сохраняет частичный результат', async () => {
    let n = 0;
    const res = await run({ shouldStop: () => n++ >= 2 });
    assert.equal(res.status, 'stopped');
    assert.ok(res.bars.length > 0);
});

test('checkpoint вызывается и в конце', async () => {
    const saves = [];
    await run({ extra: { onCheckpoint: (bars, st) => saves.push([bars.length, st.status]) } });
    assert.ok(saves.length >= 1);
    assert.equal(saves.at(-1)[1], 'target_reached');
});

test('CSV: круговой проход сохраняет данные', () => {
    const bars = [{ time: 1, open: 1.1, high: 1.2, low: 1.0, close: 1.15 }, { time: 61, open: 1.15, high: 1.2, low: 1.1, close: 1.18 }];
    assert.deepEqual(parseCsv(toCsv(bars)), bars);
});

import { discoverFormat, DISCOVERY_VARIANTS } from '../tools/history_lib.js';

test('discoverFormat: находит вариант, на который отвечает брокер', async () => {
    const target = DISCOVERY_VARIANTS.find(v => v.name === 'exact index=time*100');
    const pos = DISCOVERY_VARIANTS.indexOf(target) + 1;
    const before = 1_700_000_000;
    const client = {
        async requestRaw(event, payload) {
            const matches = event === 'loadHistoryPeriod' && payload.index === before * 100 && payload.offset === 9000;
            if (!matches) return { candles: [], events: new Set(['updateHistoryNew']) };
            const candles = [];
            for (let t = before - 60; t > before - 9000; t -= 60) {
                candles.push({ time: t, open: 1, high: 1, low: 1, close: 1 });
            }
            return { candles, events: new Set(['updateHistoryNew']) };
        }
    };
    const res = await discoverFormat({ client, asset: 'EURUSD_otc', period: 60, before });
    assert.equal(res.found?.name, 'exact index=time*100');
    assert.equal(res.report.length, pos);
    assert.equal(res.report[pos - 1].received, 149);
    assert.equal(res.report[pos - 1].ok, true);
});

test('discoverFormat: ничего не нашли -> found=null, отчёт по всем вариантам', async () => {
    const client = { async requestRaw() { return { candles: [], events: new Set() }; } };
    const res = await discoverFormat({ client, asset: 'X', period: 60, before: 1000 });
    assert.equal(res.found, null);
    assert.equal(res.report.length, DISCOVERY_VARIANTS.length);
});

test('exact frame from browser: payload воспроизводит кадр loadHistoryPeriod', () => {
    const frame = { asset: 'AUDCHF_otc', index: 179434940240, time: 1794289620, offset: 9000, period: 60 };
    const cfg = JSON.parse(readFileSync(new URL('../config/history.json', import.meta.url), 'utf-8'));
    const p = buildPayload(cfg.request.fields, { asset: 'AUDCHF_otc', index: 179434940240, before: 1794289620, offset: 9000, period: 60 });
    assert.deepEqual(p, frame);
    assert.equal(cfg.request.event, 'loadHistoryPeriod');
});

test('resolvePair: номер, имя в любом написании, ошибки', () => {
    const pairs = ['EUR/USD OTC', 'AUD/CAD OTC'];
    assert.equal(resolvePair('1', pairs), 'EUR/USD OTC');
    assert.equal(resolvePair('2', pairs), 'AUD/CAD OTC');
    assert.equal(resolvePair('EURUSD_otc', pairs), 'EUR/USD OTC');
    assert.equal(resolvePair('aud/cad otc', pairs), 'AUD/CAD OTC');
    assert.throws(() => resolvePair('3', pairs));
    assert.throws(() => resolvePair('GBPUSD_otc', pairs));
    assert.throws(() => resolvePair('', pairs));
});

test('periodLabel: 1 минута и секунды', () => {
    assert.equal(periodLabel(60), '1m');
    assert.equal(periodLabel(300), '5m');
    assert.equal(periodLabel(5), '5s');
});
