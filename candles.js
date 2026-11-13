/**
 * candles.js — единый разбор и строгая проверка OHLCV-свечей.
 *
 * Используется и po-socket.js (входящие данные брокера), и analyzer.js (вход анализа).
 * Свеча либо принимается целиком, либо отклоняется с указанием причины.
 * Восстановление недостающих цен не выполняется: искусственная свеча хуже пропуска.
 */

const FIELD_ALIASES = {
    time: ['time', 't', 'timestamp', 'ts'],
    open: ['open', 'o', 'openPrice'],
    close: ['close', 'c', 'closePrice', 'price'],
    high: ['high', 'h', 'highPrice'],
    low: ['low', 'l', 'lowPrice'],
    volume: ['volume', 'v', 'vol'],
};

function pick(obj, names) {
    for (const n of names) {
        if (obj[n] !== undefined && obj[n] !== null) return obj[n];
    }
    return undefined;
}

function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
}

/**
 * Разбор сырой свечи.
 * Формат массива: [time, open, close, high, low, volume] (порядок Pocket Option).
 * Формат объекта: поля из FIELD_ALIASES.
 * @returns {{ok: true, candle: object} | {ok: false, reason: string}}
 */
export function parseCandle(raw) {
    if (raw === null || raw === undefined) return {ok: false, reason: 'empty'};

    let time, open, close, high, low, volume;
    if (Array.isArray(raw)) {
        if (raw.length < 5) return {ok: false, reason: 'short_array'};
        time = toNumber(raw[0]);
        open = toNumber(raw[1]);
        close = toNumber(raw[2]);
        high = toNumber(raw[3]);
        low = toNumber(raw[4]);
        volume = toNumber(raw[5]);
    } else if (typeof raw === 'object') {
        time = toNumber(pick(raw, FIELD_ALIASES.time));
        open = toNumber(pick(raw, FIELD_ALIASES.open));
        close = toNumber(pick(raw, FIELD_ALIASES.close));
        high = toNumber(pick(raw, FIELD_ALIASES.high));
        low = toNumber(pick(raw, FIELD_ALIASES.low));
        volume = toNumber(pick(raw, FIELD_ALIASES.volume));
    } else {
        return {ok: false, reason: 'not_object'};
    }

    if (!Number.isFinite(time) || time <= 0) return {ok: false, reason: 'bad_time'};
    const timeSec = Math.floor(time > 1e11 ? time / 1000 : time);

    for (const [name, v] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
        if (!Number.isFinite(v)) return {ok: false, reason: `bad_${name}`};
        if (v <= 0) return {ok: false, reason: `nonpositive_${name}`};
    }
    if (high < low) return {ok: false, reason: 'high_below_low'};
    if (high < Math.max(open, close)) return {ok: false, reason: 'high_inconsistent'};
    if (low > Math.min(open, close)) return {ok: false, reason: 'low_inconsistent'};

    const explicitUnknown = !Array.isArray(raw) && raw.volumeKnown === false;
    const volumeKnown = !explicitUnknown && Number.isFinite(volume) && volume >= 0;

    return {
        ok: true,
        candle: {time: timeSec, open, high, low, close, volume: volumeKnown ? volume : 0, volumeKnown},
    };
}

/**
 * Разбор и проверка пачки свечей.
 * Сортирует по времени, удаляет дубликаты (побеждает последнее вхождение),
 * считает статистику качества. Пропуски во времени не заполняются.
 * @returns {{candles: object[], quality: {received, accepted, rejected, duplicates, unsorted, rejectReasons}}}
 */
export function normalizeCandles(rawList) {
    const quality = {received: 0, accepted: 0, rejected: 0, duplicates: 0, unsorted: false, rejectReasons: {}};
    const list = Array.isArray(rawList) ? rawList : [];
    quality.received = list.length;

    const parsed = [];
    for (const raw of list) {
        const r = parseCandle(raw);
        if (r.ok) parsed.push(r.candle);
        else {
            quality.rejected++;
            quality.rejectReasons[r.reason] = (quality.rejectReasons[r.reason] || 0) + 1;
        }
    }

    for (let i = 1; i < parsed.length; i++) {
        if (parsed[i].time < parsed[i - 1].time) {
            quality.unsorted = true;
            break;
        }
    }
    if (quality.unsorted) parsed.sort((a, b) => a.time - b.time);

    const out = [];
    for (const c of parsed) {
        if (out.length && out[out.length - 1].time === c.time) {
            out[out.length - 1] = c;
            quality.duplicates++;
        } else {
            out.push(c);
        }
    }
    quality.accepted = out.length;
    return {candles: out, quality};
}
