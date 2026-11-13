/**
 * config/index.js — единый источник настроек сегментов (читается из config/segments.json).
 * Python читает тот же файл в train/common.py, так что правила сегментов совпадают.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG = JSON.parse(fs.readFileSync(path.join(here, 'segments.json'), 'utf-8'));

/** Сегмент по имени пары: OTC в имени -> otc, иначе currency. Выходные на сегмент не влияют. */
export function segmentOf(pair = '') {
    return /otc/i.test(pair) ? 'otc' : 'currency';
}

export function segmentConfig(segment) {
    const cfg = CONFIG.segments[segment];
    if (!cfg) throw new Error(`неизвестный сегмент: ${segment}`);
    for (const f of cfg.features) {
        if (!CONFIG.implemented_features.includes(f)) {
            throw new Error(`сегмент ${segment}: признак "${f}" не реализован`);
        }
    }
    return cfg;
}

export const PAYOUT = Number(process.env.PAYOUT) || CONFIG.payout;
