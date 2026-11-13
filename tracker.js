import {tfLabel} from './timeframes.js';

/** Ключ статистики. Старые записи хранили число в минутах (1, 3, 5); новые — строку "5s" / "1m". */
function tfKey(tf) {
    return typeof tf === 'string' ? tf : `${tf}m`;
}
import fs from 'fs';
import path from 'path';

/**
 * WinRateTracker
 *  - сигнал привязан к активу (asset) и закривається ТІЛЬКИ ціною цього активу;
 *  - експірація = expirySec сигналу (а не фіксовані 60 с);
 *  - вихід = перша жива ціна активу після моменту експірації (не раніше);
 *  - рівна ціна = TIE (повернення ставки, не рахується в WR);
 *  - якщо ціни по активу не було (перемкнули пару) — VOID, не рахується;
 *  - статистика: Wilson 95% CI, ковзне вікно, розбивка по TF / OTC / confidence / парі.
 */
export class WinRateTracker {
    constructor(windowSize = 50, opts = {}) {
        this.windowSize = Number(windowSize) > 0 ? Number(windowSize) : 50;
        this.graceMs = opts.graceMs ?? 15000;       // максимальна затримка першої ціни після експірації
        this.maxHistory = opts.maxHistory ?? 5000;
        this.file = opts.file || null;
        this.pending = [];
        this.history = [];
        this._seq = 0;
        this._load();
    }


    addSignal({asset, pair, tf, direction, entryPrice, expirySec, confidence = null, edge = null,
               isOTC = false, recommended = false, regime = null, ts = Date.now()}) {
        const entry = Number(entryPrice);
        const exp = Number(expirySec);
        if (!asset || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exp) || exp <= 0) return null;
        if (direction !== 'CALL' && direction !== 'PUT') return null;
        const sig = {
            id: `${ts}-${++this._seq}`,
            asset, pair: pair || asset, tf: typeof tf === 'string' ? tf : tfLabel(tf),
            direction, entryPrice: entry,
            createdAt: ts, expiryAt: ts + exp * 1000, expirySec: exp,
            confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
            edge: Number.isFinite(Number(edge)) ? Number(edge) : null,
            isOTC: Boolean(isOTC), recommended: Boolean(recommended), regime
        };
        this.pending.push(sig);
        return sig.id;
    }

    /** Викликати на кожне ЖИВЕ оновлення ціни активу. */
    onPrice(asset, price, ts = Date.now()) {
        if (!this.pending.length || !asset || !(price > 0)) return;
        const rest = [];
        for (const s of this.pending) {
            if (s.asset !== asset || ts < s.expiryAt) { rest.push(s); continue; }
            if (ts - s.expiryAt > this.graceMs) { this._close(s, 'VOID', price, ts, 'stale'); continue; }
            let res;
            if (price === s.entryPrice) res = 'TIE';
            else if (s.direction === 'CALL') res = price > s.entryPrice ? 'WIN' : 'LOSS';
            else res = price < s.entryPrice ? 'WIN' : 'LOSS';
            this._close(s, res, price, ts);
        }
        this.pending = rest;
        this._save();
    }

    /** Викликати раз на секунду: сигнали без ціни після експірації -> VOID. */
    sweep(now = Date.now()) {
        if (!this.pending.length) return;
        const rest = [];
        let changed = false;
        for (const s of this.pending) {
            if (now - s.expiryAt > this.graceMs) { this._close(s, 'VOID', null, now, 'no_price'); changed = true; }
            else rest.push(s);
        }
        this.pending = rest;
        if (changed) this._save();
    }


    static wilson(w, n, z = 1.96) {
        if (!n) return {low: 0, high: 0};
        const p = w / n, z2 = z * z;
        const d = 1 + z2 / n;
        const c = p + z2 / (2 * n);
        const m = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
        return {low: Math.max(0, (c - m) / d) * 100, high: Math.min(1, (c + m) / d) * 100};
    }

    static _agg(list) {
        let w = 0, l = 0, t = 0, v = 0;
        for (const h of list) {
            if (h.result === 'WIN') w++;
            else if (h.result === 'LOSS') l++;
            else if (h.result === 'TIE') t++;
            else v++;
        }
        const n = w + l;
        const ci = WinRateTracker.wilson(w, n);
        return {
            wins: w, losses: l, ties: t, voids: v, total: n,
            winRate: n ? Number(((w / n) * 100).toFixed(1)) : 0,
            ci95: {low: Number(ci.low.toFixed(1)), high: Number(ci.high.toFixed(1))}
        };
    }

    static _group(list, keyFn) {
        const m = new Map();
        for (const h of list) {
            if (h.result === 'VOID' || h.result === 'TIE') continue;
            const k = keyFn(h);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(h);
        }
        const out = {};
        for (const [k, arr] of m) out[k] = WinRateTracker._agg(arr);
        return out;
    }

    getStats(breakeven = null) {
        const all = WinRateTracker._agg(this.history);
        const settled = this.history.filter(h => h.result === 'WIN' || h.result === 'LOSS');
        const recent = WinRateTracker._agg(settled.slice(-this.windowSize));
        const confBucket = h => h.confidence == null ? 'n/a'
            : h.confidence >= 80 ? '80+' : h.confidence >= 70 ? '70-79' : h.confidence >= 60 ? '60-69' : '<60';
        const out = {
            ...all,
            window: {size: this.windowSize, ...recent},
            pending: this.pending.length,
            byTf: WinRateTracker._group(this.history, h => tfKey(h.tf)),
            byMarket: WinRateTracker._group(this.history, h => h.isOTC ? 'OTC' : 'REAL'),
            byConfidence: WinRateTracker._group(this.history, confBucket),
            byRecommended: WinRateTracker._group(this.history, h => h.recommended ? 'recommended' : 'filtered'),
            byDirection: WinRateTracker._group(this.history, h => h.direction),
            byPair: WinRateTracker._group(this.history, h => h.pair)
        };
        if (breakeven != null) {
            out.breakeven = Number(breakeven.toFixed(1));
            out.significant = all.total >= 100 && all.ci95.low > breakeven;
        }
        return out;
    }


    _close(s, result, exitPrice, ts, reason = null) {
        this.history.push({...s, result, exitPrice, closedAt: ts, reason});
        if (this.history.length > this.maxHistory) this.history.shift();
    }

    _load() {
        if (!this.file) return;
        try {
            if (fs.existsSync(this.file)) {
                const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (Array.isArray(data.history)) this.history = data.history;
            }
        } catch (e) {
            console.warn('⚠️ Tracker: не вдалося прочитати історію:', e.message);
        }
    }

    _save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), {recursive: true});
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({history: this.history}));
            fs.renameSync(tmp, this.file);
        } catch (e) {
            console.warn('⚠️ Tracker: не вдалося зберегти історію:', e.message);
        }
    }
}
