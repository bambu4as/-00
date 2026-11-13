/**
 * timeframes.js — таймфреймы бота. Внутри всё считается в СЕКУНДАХ.
 * Список берётся из config/segments.json (timeframes_sec).
 */
import { CONFIG } from './config/index.js';

export const TIMEFRAMES_SEC = CONFIG.timeframes_sec;

export function isSupportedTf(sec) {
    return TIMEFRAMES_SEC.includes(Number(sec));
}

/** Короткая метка для хранения и статистики: 60 -> "1m", 5 -> "5s". */
export function tfLabel(sec) {
    const s = Number(sec);
    return s % 60 === 0 ? `${s / 60}m` : `${s}s`;
}

/** Текст для человека: 60 -> "1 хв", 5 -> "5 с". */
export function tfText(sec) {
    const s = Number(sec);
    return s % 60 === 0 ? `${s / 60} хв` : `${s} с`;
}
