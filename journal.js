import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'data', 'llm_outcomes.jsonl');
const pending = new Map();   // key -> { candleTime, price, action, t, model }

function append(obj) {
    if (process.env.LLM_JOURNAL === '0') return;
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.appendFileSync(FILE, JSON.stringify(obj) + '\n');
    } catch (e) { console.warn('⚠️ журнал исходов не записан:', e.message); }
}

export function recordDecision({ pair, tf, closedBars, action, model, segment }) {
    const key = `${pair}|${tf}`;
    const last = closedBars[closedBars.length - 1];
    settle(key, closedBars);
    if (action === 'CALL' || action === 'PUT') {
        pending.set(key, { candleTime: last.time, price: last.close, action, t: new Date().toISOString(), model, segment, pair, tf });
        append({ type: 'decision', pair, tf, segment, candleTime: last.time, price: last.close, action, model, t: new Date().toISOString() });
    }
}

function settle(key, closedBars) {
    const p = pending.get(key);
    if (!p) return;
    const newer = closedBars.find(b => b.time > p.candleTime);
    if (!newer) return;
    const up = newer.close > p.price, down = newer.close < p.price;
    const correct = p.action === 'CALL' ? up : p.action === 'PUT' ? down : null;
    if (correct === null) { pending.delete(key); return; }
    append({ type: 'outcome', pair: p.pair, tf: p.tf, candleTime: p.candleTime, action: p.action,
             nextTime: newer.time, price: p.price, nextPrice: newer.close, correct, model: p.model, segment: p.segment });
    pending.delete(key);
}
