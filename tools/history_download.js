/**
 * history_download.js — загрузка истории 1-минутных свечей OTC-пар за N дней.
 *
 * Примеры:
 *   node tools/history_download.js --discover               # перебор вариантов формата истории
 *   node tools/history_download.js --discover --save        # и записать найденный в config/history.json
 *   node tools/history_download.js                          # все пары из config/history.json, 365 дней
 *   node tools/history_download.js --list                   # список пар с номерами и прогрессом
 *   node tools/history_download.js --pair 1                 # одна пара по номеру (1 минута)
 *   node tools/history_download.js --period 5 --days 30 --pair 1   # 5-секундные свечи, месяц
 *   node tools/history_download.js --period 5 --discover    # проверить, принимает ли брокер период 5 с
 *   node tools/history_download.js --pair "EURUSD_otc"       # или по имени
 *   node tools/history_download.js --pairs "EUR/USD OTC" --days 30
 *
 * Результат: data/otc/hist_<ASSET>_1m.csv (по возрастанию времени).
 * Прерывание (Ctrl+C) сохраняет прогресс; повторный запуск докачивает дальше назад.
 *
 * ВНИМАНИЕ: формат запроса loadHistoryPeriod в config/history.json не подтверждён
 * захватом реального трафика. Сначала запустите --probe и сверьте ответ.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { POSocketClient } from '../po-socket.js';
import { segmentOf } from '../config/index.js';
import { maskRaw } from '../po-capture.js';
import { buildPayload, discoverFormat, downloadBackwards, parseCsv, periodLabel, resolvePair, toCsv } from './history_lib.js';

dotenv.config();

const HIST = JSON.parse(fs.readFileSync(new URL('../config/history.json', import.meta.url), 'utf-8'));

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : def;
}
const DISCOVER = process.argv.includes('--discover') || process.argv.includes('--probe');
const SAVE = process.argv.includes('--save');
const DAYS = Number(arg('--days', HIST.days));
// Период в секундах: --period 5 для 5-секундных, по умолчанию из конфига (60 = 1 минута).
const PERIOD = Number(arg('--period', HIST.period_sec || 60));
const WINDOW = Number(arg('--window', HIST.window_sec || 9000));
const LIST = process.argv.includes('--list');
const PAIR_ARG = arg('--pair', null);
let PAIRS = arg('--pairs', null)?.split(',').map(x => x.trim()).filter(Boolean) || HIST.pairs;
if (PAIR_ARG !== null) {
    try {
        PAIRS = [resolvePair(PAIR_ARG, HIST.pairs)];
    } catch (e) {
        console.error(e.message);
        console.error('доступные пары: node tools/history_download.js --list');
        process.exit(1);
    }
}
const period = PERIOD;

let stopRequested = false;
process.on('SIGINT', () => {
    stopRequested = true;
    console.log('\nСохраняю прогресс и останавливаюсь...');
});

/** Живой клиент: пакеты истории приходят через хук onHistoryBatch сокета. */
class LiveClient {
    constructor(sock) {
        this.sock = sock;
        this.pending = null;   // ожидание одного пакета для requestBefore
        this.sink = null;      // сбор всего для requestRaw (проба)
        sock.onHistoryBatch = (candles) => {
            if (this.sink) this.sink.candles.push(...candles);
            if (this.pending) {
                const p = this.pending;
                this.pending = null;
                p(candles);
            }
        };
        sock.onAnyEvent = (name) => {
            if (this.sink) this.sink.events.add(name);
        };
        // Сырые кадры в файл (с маскировкой session/ssid), чтобы видеть ответы брокера целиком.
        this.frameLog = null;
        if (DISCOVER) {
            fs.mkdirSync('data', { recursive: true });
            this.frameLog = fs.createWriteStream(path.join('data', 'history_probe_frames.log'), { flags: 'w' });
        }
        sock.onRawFrame = (raw) => {
            if (this.frameLog) this.frameLog.write(`${new Date().toISOString()} ${maskRaw(raw)}\n`);
        };
    }

    /** Один запрос в произвольном формате: вернуть свечи и имена всех событий, что пришли. */
    async requestRaw(event, payload, timeoutMs) {
        this.sink = { candles: [], events: new Set() };
        const t0 = Date.now();
        this.sock.sendEvent(event, payload);
        while (Date.now() - t0 < timeoutMs) {
            await new Promise(r => setTimeout(r, 200));
            if (this.sink.candles.length && Date.now() - t0 > 1500) break;
        }
        const res = this.sink;
        this.sink = null;
        return res;
    }

    async ready(timeoutMs = 30000) {
        await this.sock.connect();
        const t0 = Date.now();
        while (!this.sock.authorized) {
            if (Date.now() - t0 > timeoutMs) throw new Error('авторизация не завершилась за 30 с (обновите PO_AUTH_STRING)');
            await new Promise(r => setTimeout(r, 200));
        }
    }

    /** Установить актив в сессии брокера (через штатный changeSymbol). */
    async prepare(pair) {
        const sink = this.sink || (this.sink = { candles: [], events: new Set() });
        this.sock.requestCandles(pair, period, 200);   // период в секундах
        await new Promise(r => setTimeout(r, 2500));
        this.prepareLog = { candles: sink.candles.length, events: [...sink.events] };
    }

    requestBefore(asset, per, before, request, timeoutMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending = null;
                resolve(null);
            }, timeoutMs);
            this.pending = (candles) => {
                clearTimeout(timer);
                resolve(candles);
            };
            const payload = buildPayload(request.fields, { asset, period: per, before, index: before * 100, offset: WINDOW });
            const ok = this.sock.sendEvent(request.event, payload);
            if (!ok) {
                clearTimeout(timer);
                this.pending = null;
                resolve(null);
            }
        });
    }
}

function csvPath(pair) {
    const asset = pair.replace(/[\/\s]/g, '_');
    return path.join('data', segmentOf(pair), `hist_${asset}_${periodLabel(period)}.csv`);
}

function loadExisting(file) {
    if (!fs.existsSync(file)) return [];
    return parseCsv(fs.readFileSync(file, 'utf-8'));
}

function save(file, bars) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, toCsv(bars));
}

async function discover(client, pair) {
    const asset = client.sock.assetOf(pair);
    console.log(`\nпоиск формата истории: ${pair} (актив ${asset})`);
    await client.prepare(pair);
    console.log(`при подготовке (changeSymbol + loadHistory count=200): свечей=${client.prepareLog?.candles ?? '?'}, события: ${(client.prepareLog?.events || []).join(', ') || '-'}`);
    const before = Math.floor(client.sock.brokerNowMs() / 1000);
    const { found, report } = await discoverFormat({
        client, asset, period, before, windowSec: WINDOW, timeoutMs: 10000,
        log: (r) => console.log(`  ${r.ok ? 'OK ' : '-- '} ${r.name.padEnd(28)} событие=${r.event.padEnd(18)} свечей=${r.received} старше=${r.older} события: ${r.events.join(', ') || '-'}`),
    });
    if (client.frameLog) client.frameLog.end();
    console.log(`сырые кадры пробы: data/history_probe_frames.log`);
    const seen = new Set(report.flatMap(r => r.events));
    console.log(`\nвсе события во время пробы: ${[...seen].join(', ') || 'нет'}`);
    if (!found) {
        console.log('\nни один вариант не вернул свечи старше точки запроса.');
        console.log('Пришлите этот вывод: нужен захват реального кадра истории из браузера (DevTools -> WS).');
        return;
    }
    console.log(`\nнайден формат: ${found.name} -> ${found.event}`);
    const row = report.find(r => r.name === found.name);
    console.log('payload:', JSON.stringify(row?.payload));
    if (SAVE) {
        const cfgPath = new URL('../config/history.json', import.meta.url);
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        cfg.request = { event: found.event, fields: found.fields };
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        console.log('config/history.json обновлён (--save)');
    } else {
        console.log('чтобы записать формат в config/history.json: добавьте --save');
    }
}

function printList() {
    console.log('пары из config/history.json (номер или имя для --pair):\n');
    HIST.pairs.forEach((p, i) => {
        const file = csvPath(p);
        let status = 'нет файла';
        if (fs.existsSync(file)) {
            const rows = fs.readFileSync(file, 'utf-8').split('\n').length - 2;
            status = `${Math.max(0, rows)} свечей, ${file}`;
        }
        console.log(`  ${String(i + 1).padStart(2)}. ${p.padEnd(14)} ${status}`);
    });
    console.log('\nпример: node tools/history_download.js --pair 1');
}

async function main() {
    if (LIST) { printList(); return; }
    if (!process.env.PO_WS_URL || !process.env.PO_AUTH_STRING) {
        console.error('Задайте PO_WS_URL и PO_AUTH_STRING в .env');
        process.exit(1);
    }
    const sock = new POSocketClient(process.env.PO_WS_URL, process.env.PO_AUTH_STRING);
    const client = new LiveClient(sock);
    await client.ready();

    if (DISCOVER) {
        await discover(client, PAIRS[0]);
        sock.disconnect();
        return;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const pair of PAIRS) {
        if (stopRequested) break;
        if (segmentOf(pair) !== 'otc') {
            console.warn(`пропуск ${pair}: имя без OTC попадёт в сегмент currency, а этот загрузчик только для OTC`);
            continue;
        }
        const file = csvPath(pair);
        const existing = loadExisting(file);
        const nowSec = Math.floor(client.sock.brokerNowMs() / 1000);
        const target = nowSec - DAYS * 86400;
        const startBefore = existing.length ? Math.min(...existing.map(b => b.time)) : nowSec;
        const asset = sock.assetOf(pair);

        if (existing.length && startBefore <= target) {
            console.log(`${pair}: уже есть история за ${DAYS} дней, пропуск`);
            continue;
        }
        console.log(`\n${pair}: ${existing.length ? 'докачка с ' + new Date(startBefore * 1000).toISOString() : 'с нуля'}, цель ${new Date(target * 1000).toISOString()}`);
        await client.prepare(pair);

        const res = await downloadBackwards({
            client, asset, period, startBefore, target, existing,
            request: HIST.request, nowSec: () => Math.floor(client.sock.brokerNowMs() / 1000),
            batchTimeoutMs: HIST.batch_timeout_ms, minIntervalMs: HIST.min_interval_ms,
            maxStalls: HIST.max_stalls, checkpointEvery: HIST.checkpoint_every,
            onCheckpoint: (bars, st) => save(file, bars),
            shouldStop: () => stopRequested,
            sleep, log: (m) => console.log(`  ${m}`),
        });
        save(file, res.bars);
        const first = res.bars[0] ? new Date(res.bars[0].time * 1000).toISOString() : '-';
        const last = res.bars.at(-1) ? new Date(res.bars.at(-1).time * 1000).toISOString() : '-';
        console.log(`${pair}: статус ${res.status}, запросов ${res.requests}, свечей ${res.bars.length}, ${first} .. ${last}`);
        console.log(`  файл: ${file}`);
        if (res.status === 'history_start_reached') {
            console.log(`  брокер отдаёт историю только до ${new Date(res.oldest * 1000).toISOString()} (глубина меньше ${DAYS} дн.)`);
        }
    }
    sock.disconnect();
}

main().catch(err => {
    console.error('ошибка:', err.message);
    process.exit(1);
});
