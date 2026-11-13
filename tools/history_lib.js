/**
 * history_lib.js — логика загрузки истории назад во времени (без сети, тестируется отдельно).
 *
 * Клиент (client) должен реализовать:
 *   requestBefore(asset, period, before, request, timeoutMs) -> Promise<bar[] | null>
 *     вернуть свечи старше `before` (секунды) или null по таймауту.
 */

/** Подстановка переменных в шаблон запроса. Числовые значения сохраняют тип. */
export function buildPayload(fields, vars) {
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string' && /^\{\w+\}$/.test(v)) {
            const name = v.slice(1, -1);
            if (!(name in vars)) throw new Error(`в шаблоне запроса нет значения для {${name}}`);
            out[k] = vars[name];
        } else {
            out[k] = v;
        }
    }
    return out;
}

/** Нормализованная свеча: {time (сек), open, high, low, close}. Отбрасываем незакрытую и битые. */
export function cleanBars(batch, period, nowSec) {
    const out = [];
    for (const b of batch || []) {
        const time = Number(b.time);
        const close = Number(b.close);
        if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
        if (time + period > nowSec) continue;          // формирующаяся свеча
        out.push({ time, open: Number(b.open), high: Number(b.high), low: Number(b.low), close });
    }
    return out;
}

/**
 * Загрузка назад от startBefore до target.
 * existing — уже сохранённые свечи (для докачки). Возвращает итоговый набор и статус.
 */
export async function downloadBackwards({
    client, asset, period, startBefore, target, existing = [], request,
    nowSec, batchTimeoutMs = 15000, minIntervalMs = 500, maxStalls = 3,
    checkpointEvery = 100, onCheckpoint = () => {}, shouldStop = () => false,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)), log = () => {},
}) {
    const bars = new Map(existing.map(b => [b.time, b]));
    const now = () => (typeof nowSec === 'function' ? nowSec() : nowSec);
    let before = startBefore;
    let requests = 0;
    let stalls = 0;
    let status = 'done';

    while (before > target) {
        if (shouldStop()) { status = 'stopped'; break; }

        const batch = await client.requestBefore(asset, period, before, request, batchTimeoutMs);
        requests++;

        const cleaned = cleanBars(batch, period, now());
        const older = cleaned.filter(b => b.time < before && b.time >= target);
        const oldest = cleaned.length ? Math.min(...cleaned.map(b => b.time)) : Infinity;

        if (older.length === 0 || oldest >= before) {
            stalls++;
            log(`пустой или старый ответ (${stalls}/${maxStalls}) на before=${before}`);
            if (stalls >= maxStalls) {
                status = 'history_start_reached';
                break;
            }
            await sleep(minIntervalMs * 4);
            continue;
        }
        stalls = 0;
        for (const b of older) bars.set(b.time, b);
        before = oldest;

        if (requests % 50 === 0) {
            log(`запросов ${requests}, самая старая свеча: ${new Date(before * 1000).toISOString()}, всего ${bars.size}`);
        }
        if (requests % checkpointEvery === 0) {
            onCheckpoint([...bars.values()], { requests, before, status: 'in_progress' });
        }
        await sleep(minIntervalMs);
    }

    if (status === 'done' && before <= target) status = 'target_reached';
    const result = { bars: [...bars.values()].sort((a, b) => a.time - b.time), requests, oldest: before, status };
    onCheckpoint(result.bars, { requests, before, status });
    return result;
}

/** CSV: time,open,high,low,close — по возрастанию времени. */
export function toCsv(bars) {
    const lines = ['time,open,high,low,close'];
    for (const b of bars) lines.push(`${b.time},${b.open},${b.high},${b.low},${b.close}`);
    return lines.join('\n') + '\n';
}

export function parseCsv(text) {
    const out = [];
    const rows = text.split('\n').slice(1);
    for (const line of rows) {
        if (!line.trim()) continue;
        const [t, o, h, l, c] = line.split(',');
        out.push({ time: Number(t), open: Number(o), high: Number(h), low: Number(l), close: Number(c) });
    }
    return out;
}

/**
 * Гипотезы формата запроса истории. Известно из кода: loadHistory {asset, period, count} работает
 * (его шлёт requestCandles). Остальные — варианты с добавленным полем времени.
 */
export const DISCOVERY_VARIANTS = [
    // Точный формат из браузера: loadHistoryPeriod {asset, index, time, offset, period}.
    // Неизвестно, какой index принимает брокер — перебираем два кандидата.
    { name: 'exact index=time*100', event: 'loadHistoryPeriod',
      fields: { asset: '{asset}', index: '{index}', time: '{before}', offset: '{offset}', period: '{period}' },
      indexOf: (before) => before * 100 },
    { name: 'exact index=0', event: 'loadHistoryPeriod',
      fields: { asset: '{asset}', index: 0, time: '{before}', offset: '{offset}', period: '{period}' } },
    { name: 'loadHistory count=1000', event: 'loadHistory',
      fields: { asset: '{asset}', period: '{period}', count: 1000 } },
    { name: 'loadHistory count=500', event: 'loadHistory',
      fields: { asset: '{asset}', period: '{period}', count: 500 } },
    { name: 'loadHistory + time', event: 'loadHistory',
      fields: { asset: '{asset}', period: '{period}', count: 200, time: '{before}' } },
    { name: 'loadHistoryPeriod time', event: 'loadHistoryPeriod',
      fields: { asset: '{asset}', period: '{period}', time: '{before}' } },
    { name: 'loadHistoryPeriod index', event: 'loadHistoryPeriod',
      fields: { asset: '{asset}', period: '{period}', index: '{before}', offset: 0 } },
    { name: 'loadHistoryPeriod time+count', event: 'loadHistoryPeriod',
      fields: { asset: '{asset}', period: '{period}', time: '{before}', count: 200 } },
];

/**
 * Перебор вариантов. client.requestRaw(event, payload, timeoutMs) -> { candles, events }.
 * Вариант подходит, если пришли свечи строго старше before.
 */
export async function discoverFormat({ client, asset, period, before, windowSec = 9000, variants = DISCOVERY_VARIANTS, timeoutMs = 10000, log = () => {} }) {
    const report = [];
    for (const v of variants) {
        const index = v.indexOf ? v.indexOf(before) : before * 100;
        const payload = buildPayload(v.fields, { asset, period, before, index, offset: windowSec });
        const res = await client.requestRaw(v.event, payload, timeoutMs);
        const candles = res?.candles || [];
        const older = candles.filter(c => c.time < before);
        const row = {
            name: v.name, event: v.event, payload,
            received: candles.length, older: older.length,
            events: [...(res?.events || [])],
            ok: older.length > 0,
        };
        report.push(row);
        log(row);
        if (row.ok) return { found: v, report };
    }
    return { found: null, report };
}

/** Нормализация имени для сравнения: только буквы и цифры, без регистра. EUR/USD OTC == EURUSD_otc. */
export function normalizePair(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Выбор одной пары: номер из списка (1-based) или имя в любом написании. */
export function resolvePair(input, pairs) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('не указана пара');
    if (/^\d+$/.test(raw)) {
        const i = Number(raw) - 1;
        if (i < 0 || i >= pairs.length) throw new Error(`номер ${raw} вне списка 1..${pairs.length}`);
        return pairs[i];
    }
    const hit = pairs.find(p => normalizePair(p) === normalizePair(raw));
    if (!hit) throw new Error(`пары "${raw}" нет в config/history.json`);
    return hit;
}

/** Подпись периода для имён файлов: 60 -> "1m", 5 -> "5s", 300 -> "5m". */
export function periodLabel(periodSec) {
    return periodSec % 60 === 0 ? `${periodSec / 60}m` : `${periodSec}s`;
}
