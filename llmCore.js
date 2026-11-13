/**
 * llmCore.js — единственное ядро решения направления: локальная LLM.
 *
 * Сегменты (config/segments.json): currency и otc. У каждого сегмента свой сервис
 * LLM (свой порт, своя обученная модель). Адрес берётся из LLM_URL_<СЕГМЕНТ>
 * (поле llm_url_env в конфиге), при отсутствии — из LLM_URL.
 *
 * Переменные окружения:
 *   LLM_URL_CURRENCY, LLM_URL_OTC   адреса сервисов по сегментам
 *   LLM_URL                         адрес по умолчанию (если сегментного нет)
 *   LLM_TIMEOUT_MS                  по умолчанию 30000 (CPU-инференс 3B может занимать секунды)
 *   LLM_USE_INDICATORS              0 (по умолчанию) или 1; см. config/segments.json
 *
 * Сбой LLM (таймаут, HTTP, мусор в ответе, несовпадение сегмента) -> NONE, сделки нет.
 */
import { segmentOf, segmentConfig } from './config/index.js';

const VALID = new Set(['CALL', 'PUT', 'NONE']);
const INDICATOR_KEYS = [
    'rsi14', 'rsi7', 'stoch', 'macd', 'bbPosition', 'adx', 'cci', 'williamsR',
    'momentum', 'ema5', 'ema13', 'ema21', 'atr', 'vwap'
];
const RETURNS_COUNT = 20;

/** Режим ядра. Единственный поддерживаемый — 'llm'. */
export function coreMode() {
    return 'llm';
}

export { segmentOf };

/**
 * Адрес сервиса для сегмента и периода (сек).
 * Порядок: LLM_URL_<СЕГМЕНТ>_<СЕК> (например LLM_URL_OTC_5), затем LLM_URL_<СЕГМЕНТ>, затем LLM_URL.
 * Модель обучена на своём периоде: сервис другого периода ответит 409 и сделка будет пропущена.
 */
export function llmUrlFor(segment, periodSec = 60) {
    const base = segmentConfig(segment).llm_url_env;
    return process.env[`${base}_${periodSec}`] || process.env[base] || process.env.LLM_URL || 'http://127.0.0.1:8787/decide';
}

/** Тело запроса к LLM-сервису: доходности в б.п. и (опционально) индикаторы. */
export function buildRequest(closedBars, ctx = {}) {
    const closes = closedBars.map(b => Number(b.close));
    const tail = closes.slice(-(RETURNS_COUNT + 1));
    const returns_bp = [];
    for (let i = 1; i < tail.length; i++) {
        returns_bp.push(Math.round((tail[i] / tail[i - 1] - 1) * 1e4));
    }
    const indicators = {};
    const useInd = process.env.LLM_USE_INDICATORS === '1';
    for (const k of useInd ? INDICATOR_KEYS : []) {
        const v = ctx.indicators?.[k];
        if (typeof v === 'number' && Number.isFinite(v)) indicators[k] = Math.round(v * 100) / 100;
    }
    const pair = ctx.pair ?? '';
    return { pair, tf: ctx.tf ?? 60, segment: segmentOf(pair), returns_bp, indicators };
}

/** Проверка ответа сервиса. Всё неожиданное становится ok: false. */
export function validateDecision(data, latencyMs = 0) {
    if (!data || typeof data !== 'object') return { ok: false, error: 'bad_response', latencyMs };
    if (data.ok === false) return { ok: false, error: String(data.error || 'service_error'), latencyMs };
    const action = String(data.action ?? '').toUpperCase();
    if (!VALID.has(action)) return { ok: false, error: 'bad_action', latencyMs };
    let confidence = Number(data.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));
    return {
        ok: true,
        action,
        confidence,
        reason: String(data.reason ?? '').slice(0, 200),
        latencyMs
    };
}

export async function askLlm(closedBars, ctx = {}) {
    const body = buildRequest(closedBars, ctx);
    const url = llmUrlFor(body.segment, body.tf);
    const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 30000;
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
        const latencyMs = Date.now() - t0;
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, latencyMs, segment: body.segment };
        return { ...validateDecision(await res.json(), latencyMs), segment: body.segment };
    } catch (e) {
        const error = e.name === 'AbortError' ? 'timeout' : `unreachable: ${e.message}`;
        return { ok: false, error, latencyMs: Date.now() - t0, segment: body.segment };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Единая точка решения направления для server.js.
 * Возвращает { action, confidence, reason, source, segment, latencyMs, llmError? }.
 */
export async function decideCore(closedBars, ctx = {}) {
    const llm = await askLlm(closedBars, ctx);
    const segment = llm.segment;

    if (llm.ok) {
        return {
            action: llm.action,
            confidence: llm.confidence,
            reason: llm.reason,
            source: 'llm',
            segment,
            latencyMs: llm.latencyMs
        };
    }

    return {
        action: 'NONE',
        confidence: 0,
        reason: `LLM недоступна (${llm.error}), сделка пропущена`,
        source: 'fallback-none',
        segment,
        llmError: llm.error,
        latencyMs: llm.latencyMs
    };
}
