/**
 * collect_candles.js — накопление закрытых свечей одной пары в CSV для обучения.
 *
 * Запуск (на машине с доступом к брокеру):
 *   node tools/collect_candles.js "EUR/USD OTC" 1
 *   node tools/collect_candles.js "EUR/USD OTC" 1 data/otc/candles_EUR_USD_OTC_1m.csv
 *
 * Пишется только закрытая свеча: бар попадает в файл, когда появился следующий.
 * Дубликаты по времени пропускаются, поэтому файл можно дописывать между запусками.
 * Брокер отдаёт не больше ~200 свечей за запрос, поэтому датасет копится непрерывной работой.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { POSocketClient } from '../po-socket.js';
import { segmentOf } from '../config/index.js';

dotenv.config();

const [pair, tfArg = '1', outArg] = process.argv.slice(2);
if (!pair) {
    console.error('Использование: node tools/collect_candles.js "PAIR" [tf_min] [out.csv]');
    process.exit(1);
}
const tf = Number(tfArg);
const out = outArg || path.join('data', segmentOf(pair), `candles_${pair.replace(/[\/\s]/g, '_')}_${tf}m.csv`);
fs.mkdirSync(path.dirname(out), { recursive: true });

const seen = new Set();
if (fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, 'utf-8').split('\n').slice(1)) {
        const t = Number(line.split(',')[0]);
        if (Number.isFinite(t)) seen.add(t);
    }
} else {
    fs.writeFileSync(out, 'time,open,high,low,close\n');
}

let written = 0;
const sock = new POSocketClient(process.env.PO_WS_URL, process.env.PO_AUTH_STRING);

sock.onCandlesCallback = (candles) => {
    // Последняя свеча в списке может быть формирующейся: берём все кроме неё.
    const closed = candles.slice(0, -1);
    const rows = [];
    for (const c of closed) {
        if (seen.has(c.time)) continue;
        seen.add(c.time);
        rows.push(`${c.time},${c.open},${c.high},${c.low},${c.close}`);
    }
    if (rows.length) {
        fs.appendFileSync(out, rows.join('\n') + '\n');
        written += rows.length;
        console.log(`[collect] +${rows.length} закрытых свечей, всего записано за сессию: ${written}`);
    }
};

const refresh = () => sock.requestCandles(pair, tf * 60, 200);   // аргумент в минутах

sock.connect().then(() => {
    refresh();
    // Периодически перезапрашиваем историю: это подтягивает пропущенные закрытые бары.
    setInterval(refresh, 60_000);
}).catch(err => {
    console.error('Не удалось подключиться:', err.message);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log(`\nОстановка. Всего в файле: ${out}`);
    sock.disconnect();
    process.exit(0);
});
