import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { maskRaw } from './po-capture.js';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {POSocketClient} from './po-socket.js';
import {Analyzer} from './analyzer.js';
import {WinRateTracker} from './tracker.js';
import {decideCore} from './llmCore.js';
import {segmentOf} from './config/index.js';
import {isSupportedTf, tfLabel, tfText, TIMEFRAMES_SEC} from './timeframes.js';
import {recordDecision} from './journal.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PAYOUT = parseFloat(process.env.PAYOUT) || 0.80;
const BREAKEVEN = (1 / (1 + PAYOUT)) * 100;

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({origin: CORS_ORIGINS.length ? CORS_ORIGINS : false}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const poSocket = new POSocketClient(process.env.PO_WS_URL, process.env.PO_AUTH_STRING);

if (process.env.PO_CAPTURE_FILE) {
    const captureFile = process.env.PO_CAPTURE_FILE;
    const captureMax = Number(process.env.PO_CAPTURE_MAX) || 300;
    let captured = 0;
    fs.mkdirSync(path.dirname(captureFile), {recursive: true});
    poSocket.onRawMessageCallback = (raw) => {
        if (captured >= captureMax) return;
        captured++;
        const masked = maskRaw(raw);
        fs.appendFile(captureFile, JSON.stringify({t: Date.now(), raw: masked}) + '\n', () => {});
    };
    console.log(`📝 Запис сирих повідомлень PO: ${captureFile} (до ${captureMax})`);
}
const analyzer = new Analyzer();

function journalDecision(entry) {
    if (process.env.LLM_JOURNAL === '0') return;
    try {
        const dir = path.join(__dirname, 'data');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
        fs.appendFileSync(path.join(dir, 'llm_decisions.jsonl'), JSON.stringify(entry) + '\n');
    } catch (e) {
        console.warn('⚠️ журнал решений не записан:', e.message);
    }
}
const tracker = new WinRateTracker(50);

poSocket.onCandlesCallback = (candles) => {
    const last = candles[candles.length - 1];
    if (last && poSocket.currentAsset) tracker.onPrice(poSocket.currentAsset, last.close);
};
setInterval(() => tracker.sweep(), 1000);

const FLAGS = {
    AED: '🇦🇪', ARS: '🇦🇷', AUD: '🇦🇺', BDT: '🇧🇩', BHD: '🇧🇭', BRL: '🇧🇷', CAD: '🇨🇦', CHF: '🇨🇭',
    CLP: '🇨🇱', CNY: '🇨🇳', CNH: '🇨🇳', COP: '🇨🇴', DZD: '🇩🇿', EGP: '🇪🇬', EUR: '🇪🇺', GBP: '🇬🇧',
    HUF: '🇭🇺', IDR: '🇮🇩', INR: '🇮🇳', JOD: '🇯🇴', JPY: '🇯🇵', KES: '🇰🇪', LBP: '🇱🇧', MAD: '🇲🇦',
    MXN: '🇲🇽', MYR: '🇲🇾', NGN: '🇳🇬', NOK: '🇳🇴', NZD: '🇳🇿', OMR: '🇴🇲', PHP: '🇵🇭', PKR: '🇵🇰',
    QAR: '🇶🇦', SAR: '🇸🇦', SGD: '🇸🇬', THB: '🇹🇭', TND: '🇹🇳', TRY: '🇹🇷', UAH: '🇺🇦', USD: '🇺🇸',
    VND: '🇻🇳', YER: '🇾🇪', ZAR: '🇿🇦'
};

const CURRENCY_PAIRS = ['AUD/CAD', 'AUD/CHF', 'AUD/JPY', 'AUD/NZD', 'AUD/USD', 'CAD/CHF', 'CAD/JPY', 'CHF/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF', 'EUR/GBP', 'EUR/JPY', 'EUR/NZD', 'EUR/USD', 'GBP/AUD', 'GBP/CAD', 'GBP/CHF', 'GBP/JPY', 'GBP/NZD', 'GBP/USD', 'NZD/CAD', 'NZD/CHF', 'NZD/JPY', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY'];
const OTC_PAIRS = ['AED/CNY', 'AUD/CAD', 'AUD/CHF', 'AUD/JPY', 'AUD/NZD', 'AUD/USD', 'BHD/CNY', 'CAD/CHF', 'CAD/JPY', 'CHF/JPY', 'CHF/NOK', 'EUR/CHF', 'EUR/GBP', 'EUR/HUF', 'EUR/JPY', 'EUR/NZD', 'EUR/TRY', 'EUR/USD', 'GBP/AUD', 'GBP/JPY', 'GBP/USD', 'JOD/CNY', 'KES/USD', 'LBP/USD', 'MAD/USD', 'NGN/USD', 'NZD/JPY', 'NZD/USD', 'OMR/CNY', 'QAR/CNY', 'SAR/CNY', 'TND/USD', 'UAH/USD', 'USD/ARS', 'USD/BDT', 'USD/BRL', 'USD/CAD', 'USD/CHF', 'USD/CLP', 'USD/CNH', 'USD/COP', 'USD/DZD', 'USD/EGP', 'USD/IDR', 'USD/INR', 'USD/JPY', 'USD/MXN', 'USD/MYR', 'USD/PHP', 'USD/PKR', 'USD/SGD', 'USD/THB', 'USD/VND', 'YER/USD', 'ZAR/USD'];

const mk = (n, type) => ({
    name: type === 'otc' ? n + ' OTC' : n,
    type,
    flag1: FLAGS[n.slice(0, 3)] || '🏳️',
    flag2: FLAGS[n.slice(4)] || '🏳️'
});

const PAIRS = [...CURRENCY_PAIRS.map(n => mk(n, 'currency')), ...OTC_PAIRS.map(n => mk(n, 'otc'))];


function checkIsOTC(pairName = '') {
    return segmentOf(pairName) === 'otc';
}

app.get('/api/status', (_req, res) => {
    res.json({
        server: 'online',
        po: poSocket.getStatus(),
        payout: PAYOUT,
        breakeven: BREAKEVEN,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/pairs', (req, res) => {
    const filter = req.query.filter || 'all';
    let pairs = [...PAIRS];
    if (filter === 'currency') pairs = pairs.filter(p => p.type === 'currency');
    if (filter === 'otc') pairs = pairs.filter(p => p.type === 'otc');
    res.json({pairs, total: pairs.length});
});

app.get('/api/stats', (_req, res) => res.json(tracker.getStats(BREAKEVEN)));

let isProcessingSignal = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForCandles(minCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && poSocket.getCandles().length < minCount) await sleep(200);
    return poSocket.getCandles();
}

app.post('/api/signal', async (req, res) => {
    const {pair, timeframe} = req.body;
    const tf = parseInt(timeframe, 10);

    if (!pair || !timeframe) return res.status(400).json({error: 'Вкажіть pair та timeframe'});
    if (!isSupportedTf(tf)) return res.status(400).json({error: `Невірний таймфрейм. Доступно (сек): ${TIMEFRAMES_SEC.join(', ')}`});
    if (isProcessingSignal) return res.status(429).json({error: 'Аналіз вже виконується'});

    isProcessingSignal = true;
    try {
        await poSocket.connect();
        poSocket.clearCandles();
        await sleep(300);
        poSocket.requestCandles(pair, tf, 200);

        const candles = await waitForCandles(50, 12000);
        if (candles.length < 40) {
            return res.status(400).json({error: `Недостатньо свічок для ${tfText(tf)}: отримано ${candles.length}, потрібно 40. Брокер може не віддавати історію цього періоду.`, received: candles.length});
        }

        const tfSeconds = tf;
        const nowMs = poSocket.brokerNowMs();
        const clockOffsetMs = poSocket.getClockOffsetMs();
        if (Math.abs(clockOffsetMs) > 2000) console.warn(`⚠️ Годинник ПК відрізняється від брокера на ${(clockOffsetMs / 1000).toFixed(1)} с (враховано)`);
        const nowSec = Math.floor(nowMs / 1000);
        const lastCandle = candles[candles.length - 1];
        // Допуск не меньше 30 с: для 5-секундных свечей задержка данных брокера легко больше 15 с.
        const staleLimitSec = Math.max(tfSeconds * 3, 30);
        if (nowSec - lastCandle.time > staleLimitSec) {
            return res.status(400).json({error: `Дані застаріли (затримка ${nowSec - lastCandle.time} с, допуск ${staleLimitSec} с)`, delaySec: nowSec - lastCandle.time});
        }

        const isOTC = checkIsOTC(pair);
        const currentPrice = poSocket.getCurrentPrice() ?? lastCandle.close;
        const currentTick = poSocket.getCurrentTick();
        const analysis = analyzer.analyze(candles, pair, isOTC, tf / 60, pair, nowMs, {
            currentPrice,
            expirySec: tfSeconds
        });
        const closedBars = analysis.isForming ? candles.slice(0, -1) : candles;
        const decision = await decideCore(closedBars, {
            pair,
            tf,
            indicators: analysis.indicators || {}
        });
        const dirAction = decision.action;
        const signal = {
            direction: dirAction === 'NONE' ? 'NO TRADE' : dirAction,
            tradeAllowed: dirAction !== 'NONE',
            regime: null,
            accuracy: null,
            decisionSource: decision.source,
            decisionReason: decision.reason,
        };
        journalDecision({
            t: new Date().toISOString(), pair, tf: tfLabel(tf), price: currentPrice,
            direction: signal.direction, segment: decision.segment, decision
        });
        recordDecision({pair, tf: tfLabel(tf), closedBars, action: dirAction, model: 'llm', segment: decision.segment});

        const isTrade = signal.direction === 'CALL' || signal.direction === 'PUT';

        if (isTrade) {
            tracker.addSignal({
                asset: poSocket.currentAsset,
                pair,
                tf: tfLabel(tf),
                direction: signal.direction,
                entryPrice: analysis.entryPrice,
                expirySec: analysis.expirySeconds,
                confidence: null,
                isOTC,
                recommended: isTrade,
                regime: signal.regime
            });
        }

        const ind = analysis.indicators || {};

        res.json({
            pair, timeframe: tf, timeframeLabel: tfLabel(tf), isOTC,
            ...signal,
            decision: {
                action: decision.action,
                confidence: decision.confidence ?? null,
                reason: decision.reason ?? null,
                source: decision.source,
                latencyMs: decision.latencyMs ?? null,
                llmError: decision.llmError ?? null,
                segment: decision.segment,
            },
            indicators: {
                rsi7: ind.rsi7, rsi14: ind.rsi14,
                ema3: ind.ema3, ema5: ind.ema5, ema8: ind.ema8, ema13: ind.ema13, ema21: ind.ema21,
                stoch: ind.stoch, macd: ind.macd, atr: ind.atr, bbPosition: ind.bbPosition,
                momentum: ind.momentum, adx: ind.adx, cci: ind.cci, williamsR: ind.williamsR, vwap: ind.vwap
            },
            otc: analysis.otc || null,
            candlesCount: candles.length,
            dataQuality: analysis.dataQuality || null,
            candleClosed: !analysis.isForming,
            formingCandle: analysis.formingCandle || null,
            currentPrice,
            tickTime: currentTick?.ts ?? null,
            tickAgeMs: currentTick ? Math.max(0, nowMs - currentTick.ts * 1000) : null,
            clockOffsetMs,
            payout: PAYOUT,
            breakeven: BREAKEVEN,
            warning: isTrade ? '⚠️ Рішення LLM: ефективність не підтверджена. Не для реальної торгівлі без перевірки журналу.' : null,
            decisionSource: decision.source,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Помилка:', err.message);
        res.status(500).json({error: err.message});
    } finally {
        isProcessingSignal = false;
    }
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
    console.log(`🚀 Сервер на порту ${PORT}`);
    console.log(`💰 Payout: ${PAYOUT * 100}% | Безубыток: ${BREAKEVEN.toFixed(1)}%`);
    poSocket.connect().catch(err => console.error('❌ PO connect:', err.message));
});

process.on('SIGINT', () => {
    console.log('\n👋 Зупинка...');
    poSocket.disconnect();
    process.exit(0);
});
