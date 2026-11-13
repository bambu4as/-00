import { normalizeCandles } from './candles.js';

const RAW_CAP = 500;
const WINDOW_BARS = 300;
const HURST_MIN_BARS = 300;
const HURST_MAX_BARS = 500;
const HURST_SIZES = [16, 32, 64, 128];
const HURST_TREND_THR = 0.60;
const HURST_MEAN_REV_THR = 0.38;
const VWAP_SIGMA_SCALE = 1.2; 

export class Analyzer {

    static FORMING_DROP_FRACTION = 1.0;

    /**
     * Зона систематической ошибки импульса (подтверждено на 1-минутных данных):
     * последняя закрытая свеча — первая в своём направлении (предыдущее движение противоположное),
     * а её движение меньше 0.08 простого ATR(14). Используется флагом SignalGenerator.REVERSE_POCKET.
     */
    static _reversalPocket(closed) {
        const n = closed.length;
        if (n < 16) return false;
        const c = closed.map(x => x.close);
        const mom = Math.sign(c[n - 1] - c[n - 2]);
        if (mom === 0) return false;
        if (Math.sign(c[n - 2] - c[n - 3]) === mom) return false;
        let sum = 0;
        for (let i = n - 14; i < n; i++) {
            const h = closed[i].high, l = closed[i].low, pc = closed[i - 1].close;
            sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        const atr = sum / 14;
        if (!(atr > 0)) return false;
        return Math.abs(c[n - 1] - c[n - 2]) / atr < 0.08;
    }

    analyze(candles, symbol = '', isOTC = false, timeframe = 1, pair = '', currentTime = null, opts = {}) {
        return Analyzer.analyze(candles, symbol, isOTC, timeframe, pair, currentTime, opts);
    }

    static _sanitize(obj) {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj === 'number') {
            return Number.isNaN(obj) || !Number.isFinite(obj) ? 0 : obj;
        }
        if (typeof obj === 'string' || typeof obj === 'boolean') return obj;
        if (Array.isArray(obj)) {
            return obj.map(item => Analyzer._sanitize(item));
        }
        if (typeof obj === 'object') {
            const clean = {};
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    clean[key] = Analyzer._sanitize(obj[key]);
                }
            }
            return clean;
        }
        return obj;
    }

    static analyze(candles, symbol = '', isOTC = false, timeframe = 1, pair = '', currentTime = null, opts = {}) {
        if (!candles || !Array.isArray(candles) || candles.length === 0) {
            throw new Error('Масив свічок порожній або відсутній');
        }

        const rawInput = candles.length > RAW_CAP ? candles.slice(-RAW_CAP) : candles;
        const {candles: validCandles, quality: dataQuality} = normalizeCandles(rawInput);
        if (validCandles.length < 40) {
            throw new Error(`Недостатньо свічок після фільтрації: ${validCandles.length} (потрібно мінімум 40 для повного аналізу)`);
        }

        const resolvedTfSec = (Number(timeframe) || 1) * 60;
        let normalizedCurrent = null;
        if (currentTime !== null && currentTime !== undefined) {
            const raw = Number(currentTime);
            if (Number.isFinite(raw) && raw > 0) {
                normalizedCurrent = raw > 1e11 ? raw : raw * 1000;
            }
        }
        const _toMs = (c) => (c.time > 1e11 ? c.time : c.time * 1000);

        const _lastRawMs = _toMs(validCandles[validCandles.length - 1]);
        const isFormingNow = normalizedCurrent !== null &&
            (normalizedCurrent - _lastRawMs) / 1000 < resolvedTfSec * Analyzer.FORMING_DROP_FRACTION;

        let formingCandle = null;
        if (isFormingNow) {
            formingCandle = validCandles.pop();
            if (validCandles.length < 40) {
                throw new Error(`Недостатньо закритих свічок: ${validCandles.length} після відокремлення формуючої (потрібно 40)`);
            }
        }
        const lastCandle = validCandles[validCandles.length - 1];
        const entryPriceRaw = Number(opts && opts.currentPrice);
        const entryPrice = Number.isFinite(entryPriceRaw) && entryPriceRaw > 0
            ? entryPriceRaw
            : (formingCandle ? formingCandle.close : lastCandle.close);
        const lastPrice = entryPrice;
        const lastTimeMs = _toMs(lastCandle);
        const curCandleStartMs = formingCandle ? _toMs(formingCandle) : lastTimeMs;
        const effectiveTimeMs = normalizedCurrent !== null
            ? normalizedCurrent
            : (curCandleStartMs + resolvedTfSec * 1000);
        const elapsedSec = (effectiveTimeMs - curCandleStartMs) / 1000;
        const isForming = formingCandle !== null;

        const analysisCandles = formingCandle ? [...validCandles, formingCandle] : validCandles;
        const work = analysisCandles.length > WINDOW_BARS ? analysisCandles.slice(-WINDOW_BARS) : analysisCandles;
        const indicators = this.calculateIndicators(work);
        let hurstSource = (opts && Array.isArray(opts.hurstHistory) && opts.hurstHistory.length > validCandles.length)
            ? opts.hurstHistory : analysisCandles;
        if (formingCandle && hurstSource[hurstSource.length - 1]?.time !== formingCandle.time) {
            hurstSource = [...hurstSource, formingCandle];
        }
        indicators.hurst = this._calcHurstExponent(hurstSource.map(c => Number(c.close)).filter(Number.isFinite));
        indicators.isForming = isForming;
        indicators.lastPrice = lastPrice;
        indicators.lastCandle = lastCandle;
        indicators.liveCandle = formingCandle || lastCandle;

        const levels = this.findLevels(work, indicators);
        const patterns = this.detectPatterns(work, levels);
        const context = this.analyzeContext(levels, indicators);
        const structure = this.analyzeStructure(work, indicators);
        const fakeouts = this.checkFakeouts(work, levels);
        const candleAnatomy = this.analyzeCandleAnatomy(work, indicators);

        const volumeReliable = indicators.volumeReliable !== false;
        const volumeSignal = this.analyzeVolume(work, effectiveTimeMs, volumeReliable, indicators.atr);
        const shadowContext = this.analyzeShadowCandles(work);
        const divergences = this.detectDivergences(work, indicators, Number(timeframe) || 1);
        const smc = this.analyzeSMC(work, levels);
        const otc = this.analyzeOTC(work, symbol, indicators, isOTC);

        const marketBehavior = this.analyzeMarketBehavior(work, indicators, structure, volumeSignal, candleAnatomy.impulse);
        const events = this.buildMarketEvents(marketBehavior, structure, fakeouts, candleAnatomy.impulse);
        const consolidation = this._detectConsolidation(work, indicators.atr);
        const choppyMarket = this._detectChoppyMarket(work);

        const resolvedPair = pair || symbol || 'UNKNOWN';
        const resolvedTf = Number(timeframe) || 1;
        const expirySeconds = (Number(opts && opts.expirySec) > 0) ? Number(opts.expirySec) : resolvedTfSec;
        const horizon = Analyzer._calcHorizon(work, resolvedTfSec, expirySeconds, entryPrice, elapsedSec, isForming, indicators);

        const outIndicators = { ...indicators };
        delete outIndicators.rsi14Arr;
        delete outIndicators.macdArr;
        delete outIndicators.histArr;
        const result = {
            lastPrice, lastCandle, formingCandle, indicators: outIndicators, patterns, levels, context, structure,
            fakeouts, hugeCandle: candleAnatomy.hugeCandle, volumeSignal, shadowContext, divergences, smc, otc,
            impulse: candleAnatomy.impulse, marketBehavior, events,
            alternatingBalance: marketBehavior.alternatingBalance,
            pair: resolvedPair, symbol: symbol || resolvedPair,
            timeframe: resolvedTf, isForming, currentTime: effectiveTimeMs, elapsedSec,
            consolidation, choppyMarket, dataQuality,
            reversalPocket: Analyzer._reversalPocket(analysisCandles),
            expirySeconds, expiryMinutes: expirySeconds / 60, entryPrice, horizon
        };
        return Analyzer._sanitize(result);
    }

    static _calcHorizon(candles, tfSec, expirySec, entryPrice, elapsedSec, isForming, indicators = {}) {
        const len = candles.length;
        const closes = candles.map(c => c.close);
        const r3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0);
        const n = Math.min(30, len - 1);
        let sq = 0;
        for (let i = len - n; i < len; i++) { const d = closes[i] - closes[i - 1]; sq += d * d; }
        let sigmaCandle = n >= 5 ? Math.sqrt(sq / n) : 0;
        if (!(sigmaCandle > 0)) sigmaCandle = (Number(indicators.atr) || 0) * 0.8;
        const horizonCandles = expirySec / tfSec;
        const sigmaH = sigmaCandle * Math.sqrt(horizonCandles);
        const z = (x) => (sigmaH > 0 ? x / sigmaH : 0);
        const lb = Math.max(1, Math.round(horizonCandles));
        const refClose = closes[Math.max(0, len - 1 - lb)];
        const lastClose = closes[len - 1];
        const ema8 = Number(indicators.ema8);
        const ema13 = Number(indicators.ema13);
        const lastMove = isForming ? (entryPrice - lastClose) : (lastClose - closes[len - 2]);
        const lastMoveZ = sigmaCandle > 0 ? lastMove / sigmaCandle : 0;
        const M = Math.min(150, len - 1);
        const inc = [];
        for (let i = len - M; i < len; i++) inc.push(closes[i] - closes[i - 1]);
        const mean = inc.reduce((s, v) => s + v, 0) / (inc.length || 1);
        const dev = inc.map(v => v - mean);
        const var1 = dev.reduce((s, v) => s + v * v, 0) / (dev.length || 1);
        const k = Math.max(2, lb);
        const blocks = [];
        for (let i = inc.length - k; i >= 0; i -= k) {
            let s = 0; for (let j = 0; j < k; j++) s += inc[i + j];
            blocks.push(s);
        }
        let varianceRatio = 1;
        if (blocks.length >= 8 && var1 > 0) {
            const bm = blocks.reduce((s, v) => s + v, 0) / blocks.length;
            const bv = blocks.reduce((s, v) => s + (v - bm) * (v - bm), 0) / blocks.length;
            varianceRatio = bv / (k * var1);
        }
        const acf = (lag) => {
            if (!(var1 > 0) || dev.length <= lag + 5) return 0;
            let s = 0; for (let i = lag; i < dev.length; i++) s += dev[i] * dev[i - lag];
            return s / (dev.length * var1);
        };
        const autocorr1 = acf(1);
        const autocorrK = acf(lb);
        const autocorrZ = autocorr1 * Math.sqrt(dev.length);
        const nVR = Math.max(10, inc.length);
        const varianceRatioSE = Math.sqrt(2 * (2 * k - 1) * (k - 1) / (3 * k * nVR));
        const autocorrSE = dev.length > 0 ? 1 / Math.sqrt(dev.length) : 0;
        const W = Math.min(20, len);
        let hiIdx = len - W, loIdx = len - W, hi = -Infinity, lo = Infinity;
        for (let i = len - W; i < len; i++) {
            if (candles[i].high > hi) { hi = candles[i].high; hiIdx = i; }
            if (candles[i].low < lo) { lo = candles[i].low; loIdx = i; }
        }
        if (entryPrice > hi) { hi = entryPrice; hiIdx = len; }
        if (entryPrice < lo) { lo = entryPrice; loIdx = len; }
        const leg = hi - lo;
        const legUp = hiIdx > loIdx;
        const retrace = legUp ? (hi - entryPrice) : (entryPrice - lo);
        const extremeIdx = legUp ? hiIdx : loIdx;
        const pullback = {
            legDir: legUp ? 'UP' : 'DOWN',
            legSizeZ: r3(z(leg)),
            retraceZ: r3(z(retrace)),
            depth: leg > 0 ? r3(Math.min(1.5, retrace / leg)) : 0,
            legAgeSec: r3(Math.max(0, (len - 1 - extremeIdx)) * tfSec + (isForming ? elapsedSec : 0))
        };

        return {
            expirySec, tfSec, horizonCandles: r3(horizonCandles),
            liveEntry: Boolean(isForming),
            elapsedInCandleSec: r3(elapsedSec),
            remainingInCandleSec: isForming ? r3(Math.max(0, tfSec - elapsedSec)) : 0,
            spansCandleClose: Boolean(isForming) && (elapsedSec + expirySec > tfSec),
            sigmaCandle, sigmaH, entryPrice,
            liveDriftZ: r3(z(entryPrice - lastClose)),
            lastMoveZ: r3(lastMoveZ),
            momentumZ: r3(z(entryPrice - refClose)),
            meanRevZ8: Number.isFinite(ema8) ? r3(z(entryPrice - ema8)) : 0,
            meanRevZ13: Number.isFinite(ema13) ? r3(z(entryPrice - ema13)) : 0,
            varianceRatio: r3(varianceRatio), varianceRatioSE: r3(varianceRatioSE), autocorrSE: r3(autocorrSE), vrBlock: k, vrBlocks: blocks.length,
            autocorr1: r3(autocorr1), autocorrK: r3(autocorrK), autocorrZ: r3(autocorrZ),
            pullback
        };
    }

    static _trueRanges(highs, lows, closes) {
        const len = closes.length;
        const tr = new Array(len).fill(0);
        for (let i = 1; i < len; i++) {
            tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
        }
        return tr;
    }

    static _emaSeries(closes, period) {
        const len = closes.length;
        const out = new Array(len).fill(null);
        const p = Math.min(period, len);
        if (p <= 0) return out;
        const k = 2 / (period + 1);
        let e = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
        out[p - 1] = e;
        for (let i = p; i < len; i++) { e = closes[i] * k + e * (1 - k); out[i] = e; }
        return out;
    }

    static _wilderStep(avgGain, avgLoss, diff, period) {
        const gain = diff >= 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        return [
            (avgGain * (period - 1) + gain) / period,
            (avgLoss * (period - 1) + loss) / period
        ];
    }

    static _calcRSISeries(closes, period) {
        const len = closes.length;
        const arr = new Array(len).fill(50);
        if (len < period + 1) return arr;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff >= 0) gains += diff; else losses -= diff;
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        if (avgGain === 0 && avgLoss === 0) arr[period] = 50;
        else if (avgLoss === 0) arr[period] = 100;
        else if (avgGain === 0) arr[period] = 0;
        else arr[period] = 100 - (100 / (1 + avgGain / avgLoss));
        for (let i = period + 1; i < len; i++) {
            [avgGain, avgLoss] = Analyzer._wilderStep(avgGain, avgLoss, closes[i] - closes[i - 1], period);
            if (avgGain === 0 && avgLoss === 0) arr[i] = 50;
            else if (avgLoss === 0) arr[i] = 100;
            else if (avgGain === 0) arr[i] = 0;
            else arr[i] = 100 - (100 / (1 + avgGain / avgLoss));
        }
        return arr;
    }

    static _emaAlignment(indicators) {
        const e3 = Number(indicators.ema3);
        const e8 = Number(indicators.ema8);
        const e13 = Number(indicators.ema13);
        const valid = Number.isFinite(e3) && Number.isFinite(e8) && Number.isFinite(e13) && e3 > 0 && e8 > 0 && e13 > 0;
        return {
            up: valid ? (e3 > e8 && e8 > e13) : false,
            down: valid ? (e3 < e8 && e8 < e13) : false
        };
    }

    static calculateIndicators(candles) {
        const lastCandle = candles[candles.length - 1];
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);
        const len = closes.length;
        const lastClose = closes[len - 1];
        const lastHigh = highs[len - 1];
        const lastLow = lows[len - 1];
        const lastRange = lastHigh - lastLow;

        const calcSMA = (period) => {
            const p = Math.min(period, len);
            const slice = closes.slice(-p);
            return slice.reduce((a, b) => a + b, 0) / slice.length;
        };

        const rsi7 = Number(Analyzer._calcRSISeries(closes, 7)[len - 1].toFixed(2));
        const rsi14Arr = Analyzer._calcRSISeries(closes, 14);
        const rsi14 = rsi14Arr[len - 1];
        const emaS = (p) => Analyzer._emaSeries(closes, p);
        const e3S = emaS(3), e8S = emaS(8), e13S = emaS(13);
        const ema3 = e3S[len - 1];
        const ema5 = emaS(5)[len - 1];
        const ema8 = e8S[len - 1];
        const ema13 = e13S[len - 1];
        const ema21 = emaS(21)[len - 1];
        const sma20 = calcSMA(20);

        const emaRun = (dir, n = 3) => {
            if (len < n) return false;
            for (let i = len - n; i < len; i++) {
                const a = e3S[i], b = e8S[i], c = e13S[i];
                if (a === null || b === null || c === null) return false;
                const ok = dir > 0 ? (a > b && b > c) : (a < b && b < c);
                if (!ok) return false;
            }
            return true;
        };

        const stochPeriod = Math.min(14, len);
        const stochHighs = highs.slice(-stochPeriod);
        const stochLows = lows.slice(-stochPeriod);
        const maxH = Math.max(...stochHighs);
        const minL = Math.min(...stochLows);
        const stoch = maxH === minL ? 50 : Number((((lastClose - minL) / (maxH - minL)) * 100).toFixed(1));

        let macd = null, macdSignal = null, prevMacd = null, prevMacdSignal = null;
        let macdHistogramSlope = null;
        const histArr = new Array(len).fill(null);
        const macdArr = new Array(len).fill(null);
        if (len >= 35) {
            const k12 = 2 / 13, k26 = 2 / 27;
            let emaF = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
            let emaS = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
            for (let i = 0; i < len; i++) {
                if (i >= 12) emaF = (closes[i] * k12) + (emaF * (1 - k12));
                if (i >= 26) {
                    emaS = (closes[i] * k26) + (emaS * (1 - k26));
                    macdArr[i] = emaF - emaS;
                }
            }
            const kSig = 2 / 10;
            let sig = 0;
            for (let i = 26; i < 35; i++) sig += macdArr[i];
            sig /= 9;
            for (let i = 35; i < len; i++) {
                sig = (macdArr[i] * kSig) + (sig * (1 - kSig));
                histArr[i] = macdArr[i] - sig;
                if (i === len - 2) {
                    prevMacd = macdArr[i];
                    prevMacdSignal = sig;
                }
                if (i === len - 1) {
                    macd = macdArr[i];
                    macdSignal = sig;
                }
            }
            if (histArr[len - 1] !== null && histArr[len - 4] !== null) {
                macdHistogramSlope = (histArr[len - 1] - histArr[len - 4]) / 3;
            } else if (histArr[len - 1] !== null && histArr[len - 2] !== null) {
                macdHistogramSlope = histArr[len - 1] - histArr[len - 2];
            } else {
                macdHistogramSlope = 0;
            }
        }
        const macdHistogram = (macd !== null && macdSignal !== null) ? macd - macdSignal : null;

        let atr = 0;
        const atrPeriod = Math.min(14, len - 1);
        const trArr = Analyzer._trueRanges(highs, lows, closes);
        const atrSeries = new Array(len).fill(null);
        if (atrPeriod > 0) {
            let trSumInit = 0;
            for (let i = 1; i <= atrPeriod; i++) trSumInit += trArr[i];
            atr = trSumInit / atrPeriod;
            atrSeries[atrPeriod] = atr;
            for (let i = atrPeriod + 1; i < len; i++) {
                atr = (atr * (atrPeriod - 1) + trArr[i]) / atrPeriod;
                atrSeries[i] = atr;
            }
        }
        const atrPercent = Number(((atr / lastClose) * 100).toFixed(3));
        const lastMoveAtr = atr > 0 ? Math.abs(closes[len - 1] - closes[len - 2]) / atr : 0;
        const lastRangeAtr = atr > 0 ? (highs[len - 1] - lows[len - 1]) / atr : 0;
        const lastMoveAtrSigned = atr > 0 ? (closes[len - 1] - closes[len - 2]) / atr : 0;
        const macdThreshold = atr > 0 ? atr * 0.05 : 0.00001;
        const macdZeroLinePosition = macd === null ? 'AT_ZERO' :
            (macd > macdThreshold ? 'ABOVE_ZERO' : macd < -macdThreshold ? 'BELOW_ZERO' : 'AT_ZERO');
        const macdCrossover = (macd !== null && macdSignal !== null && prevMacd !== null && prevMacdSignal !== null)
            ? ((macd > macdSignal && prevMacd <= prevMacdSignal) ? 'bullish' :
                (macd < macdSignal && prevMacd >= prevMacdSignal) ? 'bearish' : 'none')
            : 'none';

        const bbSlice = closes.slice(-Math.min(20, len));
        const bbMean = bbSlice.reduce((a, b) => a + b, 0) / bbSlice.length;
        const stdDev = bbSlice.length > 1
            ? Math.sqrt(bbSlice.reduce((sq, n) => sq + Math.pow(n - bbMean, 2), 0) / bbSlice.length)
            : 0;
        const upperBB = bbMean + (stdDev * 2);
        const lowerBB = bbMean - (stdDev * 2);
        const bbPosition = upperBB === lowerBB ? 0.5 : (lastClose - lowerBB) / (upperBB - lowerBB);
        const bbWidth = bbMean > 0 ? ((upperBB - lowerBB) / bbMean) * 100 : 0;
        const bbZScore = stdDev > 0 ? Number(((lastClose - bbMean) / stdDev).toFixed(3)) : 0;
        const prevBbSlice = closes.slice(-Math.min(21, len), -1);
        let prevBbWidth = 0;
        if (prevBbSlice.length > 1) {
            const prevBbMean = prevBbSlice.reduce((a, b) => a + b, 0) / prevBbSlice.length;
            const prevStdDev = Math.sqrt(prevBbSlice.reduce((sq, n) => sq + Math.pow(n - prevBbMean, 2), 0) / prevBbSlice.length);
            const prevUpperBB = prevBbMean + (prevStdDev * 2);
            const prevLowerBB = prevBbMean - (prevStdDev * 2);
            prevBbWidth = prevBbMean > 0 ? ((prevUpperBB - prevLowerBB) / prevBbMean) * 100 : 0;
        }
        const bbwExpanding = prevBbWidth > 0 && bbWidth > prevBbWidth * 1.05;

        const momPeriod = Math.min(10, len - 1);
        const momentum = lastClose - closes[len - 1 - momPeriod];

        const adxPeriod = Math.min(14, len - 1);
        let plusDM = new Array(len).fill(0);
        let minusDM = new Array(len).fill(0);
        for (let i = 1; i < len; i++) {
            const upMove = highs[i] - highs[i - 1];
            const downMove = lows[i - 1] - lows[i];
            plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
            minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
        }
        let smoothPlusDM = 0, smoothMinusDM = 0, smoothTR = 0;
        for (let i = 1; i <= adxPeriod; i++) {
            smoothPlusDM += plusDM[i];
            smoothMinusDM += minusDM[i];
            smoothTR += trArr[i];
        }
        let dxValues = [];
        for (let i = adxPeriod + 1; i < len; i++) {
            smoothPlusDM = smoothPlusDM - (smoothPlusDM / adxPeriod) + plusDM[i];
            smoothMinusDM = smoothMinusDM - (smoothMinusDM / adxPeriod) + minusDM[i];
            smoothTR = smoothTR - (smoothTR / adxPeriod) + trArr[i];
            const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
            const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
            const diSum = plusDI + minusDI;
            const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
            dxValues.push(dx);
        }
        let adx = 0;
        if (dxValues.length >= adxPeriod) {
            let smoothDX = 0;
            for (let i = 0; i < adxPeriod; i++) smoothDX += dxValues[i];
            smoothDX /= adxPeriod;
            for (let i = adxPeriod; i < dxValues.length; i++) smoothDX = (smoothDX * (adxPeriod - 1) + dxValues[i]) / adxPeriod;
            adx = smoothDX;
        } else if (dxValues.length > 0) adx = dxValues[dxValues.length - 1];

        const cciPeriod = Math.min(20, len);
        const tpArray = [];
        for (let i = len - cciPeriod; i < len; i++) tpArray.push((highs[i] + lows[i] + closes[i]) / 3);
        const tpMean = tpArray.reduce((a, b) => a + b, 0) / cciPeriod;
        const meanDev = tpArray.reduce((acc, tp) => acc + Math.abs(tp - tpMean), 0) / cciPeriod;
        const cci = meanDev === 0 ? 0 : Number(((tpArray[tpArray.length - 1] - tpMean) / (0.015 * meanDev)).toFixed(1));

        const VWAP_WINDOW = 34;
        const MIN_POINTS = 12;
        let vwap = null, vwapStdev = null, vwapSigmaRatio = null;
        let vwapZone = 'MIDDLE';
        let vwapSlope = null;
        let vwapBullishSlope = false, vwapBearishSlope = false;
        let vwapReclaim = 'none';
        let vwapUpper1 = null, vwapLower1 = null, vwapUpper2 = null, vwapLower2 = null;
        let vwapDistance = 0, vwapPosition = 'at', vwapAtrRatio = 0;
        if (len >= MIN_POINTS) {
            const n = Math.min(VWAP_WINDOW, len);
            const start = len - n;
            const useVolume = volumes.every(v => Number.isFinite(v) && v >= 0) &&
                volumes.slice(start).some(v => v > 0);
            const weights = new Array(n);
            let totalWeight = 0;
            for (let i = 0; i < n; i++) {
                const idx = start + i;
                const v = volumes[idx];
                const w = useVolume && Number.isFinite(v) && v > 0 ? v : 1;
                weights[i] = w;
                totalWeight += w;
            }
            const vwapPx = (idx) => (highs[idx] + lows[idx] + closes[idx]) / 3;
            let tpv = 0;
            for (let i = 0; i < n; i++) {
                tpv += vwapPx(start + i) * weights[i];
            }
            vwap = totalWeight > 0 ? tpv / totalWeight : vwapPx(start);
            let variance = 0;
            for (let i = 0; i < n; i++) {
                const d = vwapPx(start + i) - vwap;
                variance += d * d * weights[i];
            }
            vwapStdev = totalWeight > 0 ? Math.sqrt(variance / totalWeight) * VWAP_SIGMA_SCALE : 0;
            let prevVwap = null;
            if (start >= 1) {
                let prevTpv = 0, prevWeight = 0;
                for (let i = 0; i < n; i++) {
                    const idx = start - 1 + i;
                    const v = volumes[idx];
                    const w = useVolume && Number.isFinite(v) && v > 0 ? v : 1;
                    prevTpv += vwapPx(idx) * w;
                    prevWeight += w;
                }
                if (prevWeight > 0) prevVwap = prevTpv / prevWeight;
            }
            vwapSlope = (prevVwap !== null && prevVwap > 0)
                ? ((vwap - prevVwap) / prevVwap) * 100
                : 0;
            vwapSigmaRatio = vwapStdev > 1e-9 ? Number(((lastClose - vwap) / vwapStdev).toFixed(3)) : 0;
            vwapUpper1 = vwap + vwapStdev;
            vwapLower1 = vwap - vwapStdev;
            vwapUpper2 = vwap + (vwapStdev * 2.0);
            vwapLower2 = vwap - (vwapStdev * 2.0);
            vwapDistance = lastClose > 0 ? (lastClose - vwap) / lastClose : 0;
            vwapPosition = lastClose > vwap ? 'above' : lastClose < vwap ? 'below' : 'at';
            vwapAtrRatio = atr > 0 ? Number(((lastClose - vwap) / atr).toFixed(3)) : 0;
            if (lastClose >= vwapUpper2) vwapZone = 'UPPER_EXTREME';
            else if (lastClose >= vwapUpper1) vwapZone = 'UPPER';
            else if (lastClose <= vwapLower2) vwapZone = 'LOWER_EXTREME';
            else if (lastClose <= vwapLower1) vwapZone = 'LOWER';
            const SLOPE_THRESHOLD = 0.02;
            vwapBullishSlope = vwapSlope !== null && vwapSlope > SLOPE_THRESHOLD;
            vwapBearishSlope = vwapSlope !== null && vwapSlope < -SLOPE_THRESHOLD;
            const prevClose = len >= 2 ? closes[len - 2] : lastClose;
            if (prevVwap !== null) {
                if (prevClose <= prevVwap && lastClose > vwap + 0.1 * (atr || 0)) vwapReclaim = 'bullish';
                else if (prevClose >= prevVwap && lastClose < vwap - 0.1 * (atr || 0)) vwapReclaim = 'bearish';
            }
        }

        const medianPrices = candles.map(c => (c.high + c.low) / 2);
        const calcSMA_MP = (period) => {
            const p = Math.min(period, len);
            const slice = medianPrices.slice(-p);
            return slice.reduce((a, b) => a + b, 0) / slice.length;
        };
        const sma5_MP = calcSMA_MP(5);
        const sma34_MP = calcSMA_MP(34);
        const ao = Number((sma5_MP - sma34_MP).toFixed(5));

        let positiveMF = 0, negativeMF = 0;
        const mfiPeriod = Math.min(14, len);
        const mfiStart = Math.max(1, len - mfiPeriod);
        for (let i = mfiStart; i < len; i++) {
            const tp = (highs[i] + lows[i] + closes[i]) / 3;
            const rawMF = tp * (Number.isFinite(volumes[i]) && volumes[i] > 0 ? volumes[i] : 0);
            const prevTp = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3;
            if (tp > prevTp) positiveMF += rawMF;
            else if (tp < prevTp) negativeMF += rawMF;
        }
        const mfi = (positiveMF === 0 && negativeMF === 0) ? 50 : negativeMF === 0 ? 100 : Number((100 - (100 / (1 + positiveMF / negativeMF))).toFixed(2));

        const recentVolumes = volumes.slice(-21, -1);
        const uniqueVolumes = new Set(recentVolumes.map(v => Number(v.toFixed(2))));
        const meanVol = recentVolumes.length > 0 ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length : 0;
        const variance = recentVolumes.length > 0 ? recentVolumes.reduce((a, b) => a + Math.pow(b - meanVol, 2), 0) / recentVolumes.length : 0;
        const isVolumeFake = uniqueVolumes.size <= 2 && meanVol < 100 && variance < 1;
        const avgVolume = recentVolumes.length > 0 ? meanVol : 0;
        const volumeRatio = (isVolumeFake || avgVolume <= 0) ? 0 : Number((volumes[len - 1] / avgVolume).toFixed(2));
        const volumeSpike = !isVolumeFake && avgVolume > 0 && volumeRatio >= 1.5;
        const volumeReliable = !isVolumeFake && avgVolume > 0;

        const hurst = this._calcHurstExponent(closes);
        const cvdData = this._calcCVD(candles, volumeReliable);
        const volumeProfile = this._calcVolumeProfile(candles, volumeReliable);
        const killzone = this._calcKillzone(lastCandle.time);

        const atrValues = [];
        for (let i = Math.max(14, len - 200); i < len; i++) {
            if (atrSeries[i] !== null && closes[i] > 0) atrValues.push((atrSeries[i] / closes[i]) * 100);
        }
        const sortedAtr = atrValues.slice().sort((a, b) => a - b);
        const medianAtrPercent = sortedAtr.length > 0 ? sortedAtr[Math.floor(sortedAtr.length / 2)] : 0.05;

        let rsiSlope = 0;
        if (len > 4) {
            const currentRSI = rsi14Arr[len - 1];
            const rsi4BarsAgo = rsi14Arr[len - 5];
            rsiSlope = currentRSI - rsi4BarsAgo;
        }

        const isStrongCloseHigh = lastRange > 0 && lastClose >= lastHigh - lastRange * 0.2;
        const isStrongCloseLow = lastRange > 0 && lastClose <= lastLow + lastRange * 0.2;

        return {
            rsi7, rsi14, ema3, ema5, ema8, ema13, ema21, sma20,
            stoch, macd, macdSignal, macdHistogram, macdHistogramSlope, macdCrossover,
            macdZeroLinePosition,
            atr, atrPercent, lastMoveAtr, lastRangeAtr, lastMoveAtrSigned, bbPosition, bbWidth, bbwExpanding, upperBB, lowerBB, bbMean, bbZScore,
            momentum, adx, cci,
            vwap, vwapDistance, vwapPosition, vwapAtrRatio, vwapSigmaRatio, vwapZone, vwapSlope, vwapReclaim,
            vwapStdev, vwapUpper1, vwapLower1, vwapUpper2, vwapLower2, vwapBasis: 'typical',
            vwapBullishSlope, vwapBearishSlope,
            vwapReliable: volumeReliable && vwap !== null && vwapStdev > 1e-9,
            ao, mfi, volumeRatio, volumeSpike, isVolumeFake, volumeReliable,
            hurst, cvd: cvdData.cvd, cvdDelta: cvdData.delta, cvdDivergence: cvdData.divergence,
            volumeProfile, killzone, medianAtrPercent,
            rsiSlope: Number(rsiSlope.toFixed(2)),
            isStrongCloseHigh, isStrongCloseLow,
            rsi14Arr, macdArr, histArr,
            emaUpStable: emaRun(1), emaDownStable: emaRun(-1)
        };
    }

    static analyzeCandleAnatomy(candles, indicators) {
        const len = candles.length;
        if (len < 1) return { impulse: { isImpulse: false }, hugeCandle: { isHuge: false } };
        const lastC = candles[len - 1];
        const prior20 = candles.slice(-Math.min(21, len), -1);
        const avgBodySize = prior20.length > 0
            ? prior20.reduce((acc, c) => acc + Math.abs(c.close - c.open), 0) / prior20.length
            : 0;
        const lastBody = Math.abs(lastC.close - lastC.open);
        const bodyRatio = avgBodySize > 0 ? lastBody / avgBodySize : 1;
        const range = lastC.high - lastC.low;
        const bodyToRangeRatio = range > 0 ? lastBody / range : 0;
        const isBullish = lastC.close > lastC.open;
        const isBearish = lastC.close < lastC.open;
        const momentum3 = lastC.close - candles[Math.max(0, candles.length - 4)].close;
        const atr = indicators.atr || 0;
        const momentumStrength = atr > 0 ? Math.abs(momentum3) / atr : 0;
        const volumeRatio = indicators.volumeRatio || 0;
        const isVolumeFake = indicators.isVolumeFake || false;
        let impulseScore = 0;
        if (bodyRatio > 2.0) impulseScore += 2;
        if (momentumStrength > 1.5) impulseScore += 2;
        if (bodyToRangeRatio > 0.7) impulseScore += 1;
        if (bodyRatio > 3.0) impulseScore += 1;
        if (!isVolumeFake && volumeRatio >= 2.0) impulseScore += 3;
        else if (!isVolumeFake && volumeRatio >= 1.5) impulseScore += 1;
        const isImpulse = impulseScore >= 4;
        const impulseDirection = isBullish ? 'UP' : isBearish ? 'DOWN' : 'NEUTRAL';
        const impulseStrength = impulseScore >= 7 ? 'STRONG' : impulseScore >= 5 ? 'MODERATE' : 'WEAK';
        const upperShadow = lastC.high - Math.max(lastC.open, lastC.close);
        const lowerShadow = Math.min(lastC.open, lastC.close) - lastC.low;
        const isHuge = avgBodySize > 0 && lastBody > avgBodySize * 2.5;
        const hasLongUpper = upperShadow > lastBody * 1.5 && upperShadow > range * 0.3;
        const hasLongLower = lowerShadow > lastBody * 1.5 && lowerShadow > range * 0.3;
        return {
            impulse: {
                isImpulse, direction: impulseDirection, strength: impulseStrength,
                score: impulseScore, bodyRatio, momentumStrength, bodyToRangeRatio, volumeRatio
            },
            hugeCandle: {
                isHuge, isBullish, isBearish: lastC.close < lastC.open, hasLongUpper, hasLongLower, bodyToRangeRatio,
                range, upperShadow, lowerShadow
            }
        };
    }

    static _lgamma(x) {
        const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
            -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
        if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - this._lgamma(1 - x);
        x -= 1;
        let a = c[0];
        const t = x + 7.5;
        for (let i = 1; i < 9; i++) a += c[i] / (x + i);
        return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
    }

    static _expectedRS(n) {
        if (!this._hurstCriticalCache) this._hurstCriticalCache = new Map();
        if (this._hurstCriticalCache.has(n)) return this._hurstCriticalCache.get(n);
        let sum = 0;
        for (let i = 1; i < n; i++) sum += Math.sqrt((n - i) / i);
        const pre = (n - 0.5) / n;
        const val = n <= 340
            ? pre * Math.exp(this._lgamma((n - 1) / 2) - 0.5 * Math.log(Math.PI) - this._lgamma(n / 2)) * sum
            : pre * Math.pow(n * Math.PI / 2, -0.5) * sum;
        this._hurstCriticalCache.set(n, val);
        return val;
    }

    /**
     * Hurst по R/S с поправкой Anis–Lloyd–Peters. Требует длинного окна (HURST_MIN_BARS..HURST_MAX_BARS):
     * на коротком окне регрессия шумит, поэтому режим принудительно RANDOM_WALK и reliable=false.
     */
    static _calcHurstExponent(closes) {
        const none = (bars) => ({ H: 0.5, regime: 'RANDOM_WALK', confidence: 0, reliable: false, bars });
        const src = closes.length > HURST_MAX_BARS ? closes.slice(-HURST_MAX_BARS) : closes;
        const n = src.length;
        if (n < HURST_MIN_BARS) return none(n);
        const returns = [];
        for (let i = 1; i < n; i++) {
            if (src[i - 1] > 0 && src[i] > 0) returns.push(Math.log(src[i] / src[i - 1]));
        }
        if (returns.length < HURST_MIN_BARS - 5) return none(n);
        const logN = [], logRS = [];
        for (const size of HURST_SIZES) {
            const chunks = Math.floor(returns.length / size);
            if (chunks < 2) continue;
            let sumRS = 0, used = 0;
            for (let k = 0; k < chunks; k++) {
                let mean = 0;
                for (let j = k * size; j < (k + 1) * size; j++) mean += returns[j];
                mean /= size;
                let acc = 0, mx = 0, mn = 0, ss = 0;
                for (let j = k * size; j < (k + 1) * size; j++) {
                    const d = returns[j] - mean;
                    acc += d; ss += d * d;
                    if (acc > mx) mx = acc;
                    if (acc < mn) mn = acc;
                }
                const S = Math.sqrt(ss / size);
                if (S > 0) { sumRS += (mx - mn) / S; used++; }
            }
            if (!used) continue;
            const avgRS = sumRS / used;
            if (avgRS <= 1e-12) continue;
            logN.push(Math.log(size));
            logRS.push(Math.log(avgRS) - Math.log(this._expectedRS(size)));
        }
        if (logN.length < 3) return none(n);
        const m = logN.length;
        const sumX = logN.reduce((a, b) => a + b, 0);
        const sumY = logRS.reduce((a, b) => a + b, 0);
        const sumXY = logN.reduce((a, x, i) => a + x * logRS[i], 0);
        const sumXX = logN.reduce((a, x) => a + x * x, 0);
        const slope = (m * sumXY - sumX * sumY) / (m * sumXX - sumX * sumX);
        if (!Number.isFinite(slope)) return none(n);
        const H = Math.max(0, Math.min(1, 0.5 + slope));
        let regime = 'RANDOM_WALK';
        if (H < HURST_MEAN_REV_THR) regime = 'MEAN_REVERTING';
        else if (H > HURST_TREND_THR) regime = 'TRENDING';
        return {
            H: Number(H.toFixed(3)),
            regime,
            confidence: Number((Math.abs(H - 0.5) * 2).toFixed(2)),
            reliable: true,
            bars: n
        };
    }

    static _calcCVD(candles, volumeReliable = true) {
        const len = candles.length;
        if (len < 5 || !volumeReliable) return { cvd: 0, delta: 0, divergence: 'none' };
        let cvd = 0;
        const cvdArr = [];
        for (let i = 0; i < len; i++) {
            const c = candles[i];
            const range = c.high - c.low;
            if (range <= 0) {
                cvdArr.push(cvd);
                continue;
            }
            const vol = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
            const buyVol = vol * ((c.close - c.low) / range);
            const sellVol = vol - buyVol;
            cvd += (buyVol - sellVol);
            cvdArr.push(cvd);
        }
        const lastCVD = cvd;
        const lookback = Math.min(10, len - 1);
        if (lookback < 1) return { cvd: Number(lastCVD.toFixed(2)), delta: 0, divergence: 'none' };
        const prevCVD = Number.isFinite(cvdArr[len - 1 - lookback]) ? cvdArr[len - 1 - lookback] : 0;
        const delta = lastCVD - prevCVD;
        const priceChange = candles[len - 1].close - candles[len - 1 - lookback].close;
        const totalVolume = candles.slice(-lookback).reduce((sum, c) => sum + (Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0), 0);
        const atr = this._calcATR(candles);
        const deltaRatio = totalVolume > 0 ? Math.abs(delta) / totalVolume : 0;
        const priceChangeRatio = atr > 1e-9 ? Math.abs(priceChange) / atr : 0;
        let divergence = 'none';
        if (deltaRatio > 0.12 && priceChangeRatio > 0.25) {
            if (priceChange > 0 && delta < 0) divergence = 'bearish';
            else if (priceChange < 0 && delta > 0) divergence = 'bullish';
        }
        return {
            cvd: Number(lastCVD.toFixed(2)),
            delta: Number(delta.toFixed(2)),
            divergence
        };
    }

    static _calcVolumeProfile(candles, volumeReliable = true) {
        const len = candles.length;
        if (len < 10 || !volumeReliable) return { poc: 0, vah: 0, val: 0, priceVsPoc: 'at' };
        const lookback = Math.min(100, len);
        const slice = candles.slice(-lookback);
        const allHighs = slice.map(c => c.high);
        const allLows = slice.map(c => c.low);
        const maxP = Math.max(...allHighs);
        const minP = Math.min(...allLows);
        if (maxP === minP) return { poc: maxP, vah: maxP, val: minP, priceVsPoc: 'at' };
        const bins = 50;
        const step = (maxP - minP) / bins;
        const volumeAtPrice = new Array(bins).fill(0);
        for (const c of slice) {
            const vol = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
            if (vol <= 0) continue;
            const lo = Math.min(bins - 1, Math.max(0, Math.floor((c.low - minP) / step)));
            const hi = Math.min(bins - 1, Math.max(lo, Math.floor((c.high - minP) / step)));
            const share = vol / (hi - lo + 1);
            for (let b = lo; b <= hi; b++) volumeAtPrice[b] += share;
        }
        let pocIdx = 0, maxVol = 0;
        for (let i = 0; i < bins; i++) {
            if (volumeAtPrice[i] > maxVol) {
                maxVol = volumeAtPrice[i];
                pocIdx = i;
            }
        }
        const poc = minP + (pocIdx + 0.5) * step;
        const totalVol = volumeAtPrice.reduce((a, b) => a + b, 0);
        if (totalVol <= 0) return { poc, vah: maxP, val: minP, priceVsPoc: 'at' };
        const targetVol = totalVol * 0.7;
        let accVol = volumeAtPrice[pocIdx];
        let lowIdx = pocIdx, highIdx = pocIdx;
        while (accVol < targetVol && (lowIdx > 0 || highIdx < bins - 1)) {
            const downVol = lowIdx > 0 ? volumeAtPrice[lowIdx - 1] : 0;
            const upVol = highIdx < bins - 1 ? volumeAtPrice[highIdx + 1] : 0;
            if (downVol >= upVol && lowIdx > 0) {
                lowIdx--;
                accVol += downVol;
            } else if (highIdx < bins - 1) {
                highIdx++;
                accVol += upVol;
            } else break;
        }
        const val = minP + lowIdx * step;
        const vah = minP + (highIdx + 1) * step;
        const lastPrice = slice[slice.length - 1].close;
        let priceVsPoc = 'at';
        if (lastPrice > vah) priceVsPoc = 'above_va';
        else if (lastPrice < val) priceVsPoc = 'below_va';
        else if (lastPrice > poc) priceVsPoc = 'above_poc';
        else if (lastPrice < poc) priceVsPoc = 'below_poc';
        return { poc, vah, val, priceVsPoc };
    }

    static _calcKillzone(timestamp) {
        if (!timestamp) return { session: 'UNKNOWN', active: false, label: 'unknown' };
        const normalizedTime = timestamp > 1e11 ? timestamp / 1000 : timestamp;
        const date = new Date(normalizedTime * 1000);
        const hour = date.getUTCHours();
        let session, label, active;
        if (hour >= 0 && hour < 7) {
            session = 'ASIA'; label = 'Азійська сесія'; active = false;
        } else if (hour >= 7 && hour < 10) {
            session = 'LONDON_PRE'; label = 'Пре-Лондон'; active = true;
        } else if (hour >= 10 && hour < 13) {
            session = 'LONDON'; label = 'Лондон (Killzone)'; active = true;
        } else if (hour >= 13 && hour < 15) {
            session = 'NY_PRE'; label = 'Пре-Нью-Йорк'; active = true;
        } else if (hour >= 15 && hour < 18) {
            session = 'NY'; label = 'Нью-Йорк (Killzone)'; active = true;
        } else if (hour >= 18 && hour < 21) {
            session = 'NY_CLOSE'; label = 'Закриття Нью-Йорка'; active = false;
        } else {
            session = 'DEAD'; label = 'Мертва зона'; active = false;
        }
        return { session, label, active, hour };
    }

    static _calcATR(candles) {
        if (!candles || candles.length < 2) return 0;
        const len = candles.length;
        const atrPeriod = Math.min(14, len - 1);
        if (atrPeriod <= 0) return 0;
        const tr = Analyzer._trueRanges(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close));
        let trSumInit = 0;
        for (let i = 1; i <= atrPeriod; i++) trSumInit += tr[i];
        let atrVal = trSumInit / atrPeriod;
        for (let i = atrPeriod + 1; i < len; i++) {
            atrVal = (atrVal * (atrPeriod - 1) + tr[i]) / atrPeriod;
        }
        return atrVal;
    }

    static detectDivergences(candles, indicators, timeframe = 1) {
        const len = candles.length;
        if (len < 40) return {
            rsi: 'none', macd: 'none', hidden: 'none',
            strength: 0, strengthBull: 0, strengthBear: 0,
            summary: 'Недостатньо даних'
        };
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const tfMultiplier = timeframe <= 1 ? 1 : timeframe <= 5 ? 1.2 : 1.5;
        const lookback = Math.min(Math.round(60 * tfMultiplier), len - 1);
        const startIdx = len - lookback;
        const rsiArr = indicators.rsi14Arr;
        const histArr = indicators.histArr;
        const swingWindow = timeframe <= 1 ? 5 : timeframe <= 5 ? 4 : 3;
        const minDistance = Math.max(8, Math.round(15 / Math.max(1, timeframe)));
        const maxDistance = Math.min(lookback - 1, Math.round(50 * tfMultiplier));
        const recencyThreshold = timeframe <= 1 ? 20 : timeframe <= 5 ? 30 : 40;

        const getValidRSI = (idx) => (idx >= 14 ? rsiArr[idx] : null);
        const getValidHist = (idx) => {
            const v = histArr[idx];
            return (v === null || v === undefined || !Number.isFinite(v)) ? null : v;
        };

        const findSwingLows = () => {
            const swings = [];
            for (let i = startIdx + swingWindow; i < len - swingWindow; i++) {
                let isMin = true;
                for (let j = i - swingWindow; j <= i + swingWindow; j++) {
                    if (j !== i && lows[j] < lows[i]) { isMin = false; break; }
                }
                if (isMin) swings.push(i);
            }
            return swings;
        };

        const findSwingHighs = () => {
            const swings = [];
            for (let i = startIdx + swingWindow; i < len - swingWindow; i++) {
                let isMax = true;
                for (let j = i - swingWindow; j <= i + swingWindow; j++) {
                    if (j !== i && highs[j] > highs[i]) { isMax = false; break; }
                }
                if (isMax) swings.push(i);
            }
            return swings;
        };

        const swingLows = findSwingLows();
        const swingHighs = findSwingHighs();
        let rsiBull = false, rsiBear = false;
        let macdBull = false, macdBear = false;
        let hiddenBull = false, hiddenBear = false;
        let hiddenMacdBull = false, hiddenMacdBear = false;
        let strengthBull = 0, strengthBear = 0;

        if (swingLows.length >= 2) {
            const firstIdx = swingLows[swingLows.length - 2];
            const secondIdx = swingLows[swingLows.length - 1];
            const distance = secondIdx - firstIdx;
            const isRecent = (len - 1 - secondIdx) <= recencyThreshold;
            if (distance >= minDistance && distance <= maxDistance && isRecent) {
                const rsiFirst = getValidRSI(firstIdx);
                const rsiSecond = getValidRSI(secondIdx);
                const histFirst = getValidHist(firstIdx);
                const histSecond = getValidHist(secondIdx);
                if (rsiFirst !== null && rsiSecond !== null) {
                    const optimalDistance = distance >= 15 && distance <= 30;
                    const distanceBonus = optimalDistance ? 1 : 0;
                    if (lows[secondIdx] < lows[firstIdx]) {
                        if (rsiSecond < 50 && rsiSecond > rsiFirst + 3) {
                            rsiBull = true;
                            strengthBull += (rsiSecond > rsiFirst + 5) ? 2 : 1;
                            strengthBull += distanceBonus;
                        }
                        if (histFirst !== null && histSecond !== null &&
                            histSecond > histFirst && histSecond < 0) {
                            macdBull = true;
                            strengthBull += 2;
                            strengthBull += distanceBonus;
                        }
                    } else if (lows[secondIdx] > lows[firstIdx]) {
                        if (rsiSecond < rsiFirst - 3 && rsiSecond < 50) {
                            hiddenBull = true;
                            strengthBull += (rsiSecond < rsiFirst - 5) ? 3 : 1.5;
                            strengthBull += distanceBonus;
                        }
                        if (histFirst !== null && histSecond !== null &&
                            histSecond < histFirst && histSecond < 0) {
                            hiddenMacdBull = true;
                            strengthBull += 2;
                            strengthBull += distanceBonus;
                        }
                    }
                }
            }
        }

        if (swingHighs.length >= 2) {
            const firstIdx = swingHighs[swingHighs.length - 2];
            const secondIdx = swingHighs[swingHighs.length - 1];
            const distance = secondIdx - firstIdx;
            const isRecent = (len - 1 - secondIdx) <= recencyThreshold;
            if (distance >= minDistance && distance <= maxDistance && isRecent) {
                const rsiFirst = getValidRSI(firstIdx);
                const rsiSecond = getValidRSI(secondIdx);
                const histFirst = getValidHist(firstIdx);
                const histSecond = getValidHist(secondIdx);
                if (rsiFirst !== null && rsiSecond !== null) {
                    const optimalDistance = distance >= 15 && distance <= 30;
                    const distanceBonus = optimalDistance ? 1 : 0;
                    if (highs[secondIdx] > highs[firstIdx]) {
                        if (rsiSecond > 50 && rsiSecond < rsiFirst - 3) {
                            rsiBear = true;
                            strengthBear += (rsiSecond < rsiFirst - 5) ? 2 : 1;
                            strengthBear += distanceBonus;
                        }
                        if (histFirst !== null && histSecond !== null &&
                            histSecond < histFirst && histSecond > 0) {
                            macdBear = true;
                            strengthBear += 2;
                            strengthBear += distanceBonus;
                        }
                    } else if (highs[secondIdx] < highs[firstIdx]) {
                        if (rsiSecond > rsiFirst + 3 && rsiSecond > 50) {
                            hiddenBear = true;
                            strengthBear += (rsiSecond > rsiFirst + 5) ? 3 : 1.5;
                            strengthBear += distanceBonus;
                        }
                        if (histFirst !== null && histSecond !== null &&
                            histSecond > histFirst && histSecond > 0) {
                            hiddenMacdBear = true;
                            strengthBear += 2;
                            strengthBear += distanceBonus;
                        }
                    }
                }
            }
        }

        if (rsiBull || macdBull) { hiddenBull = false; hiddenMacdBull = false; }
        if (rsiBear || macdBear) { hiddenBear = false; hiddenMacdBear = false; }

        const rsi = (rsiBull && rsiBear) ? 'conflict' : (rsiBull ? 'bullish' : (rsiBear ? 'bearish' : 'none'));
        const macd = (macdBull && macdBear) ? 'conflict' : (macdBull ? 'bullish' : (macdBear ? 'bearish' : 'none'));
        const hiddenBullCombined = hiddenBull || hiddenMacdBull;
        const hiddenBearCombined = hiddenBear || hiddenMacdBear;
        const hidden = (hiddenBullCombined && hiddenBearCombined) ? 'conflict'
            : (hiddenBullCombined ? 'bullish' : (hiddenBearCombined ? 'bearish' : 'none'));
        const strength = strengthBull + strengthBear;
        const summary = (rsi !== 'none' || macd !== 'none' || hidden !== 'none') ?
            `Дивергенція: RSI=${rsi}, MACD=${macd}, Hidden=${hidden}, Bull=${strengthBull.toFixed(1)}, Bear=${strengthBear.toFixed(1)}` :
            'Дивергенцій немає';
        return { rsi, macd, hidden, strength, strengthBull, strengthBear, summary };
    }

    static analyzeSMC(candles, levels) {
        const len = candles.length;
        if (len < 5) return { liquiditySweep: 'none', confirmed: false, orderBlock: null, fvg: null, eqh: [], eql: [] };
        const last = candles[len - 1];
        const support = levels.support;
        const resistance = levels.resistance;
        let liquiditySweep = 'none';
        let confirmed = false;
        const isValidLevel = (val) => Number.isFinite(val) && val > 1e-9;
        if (isValidLevel(support) && last.low < support && last.close > support) {
            liquiditySweep = 'bullish';
            confirmed = last.close > support + (last.high - last.low) * 0.2;
        } else if (isValidLevel(resistance) && last.high > resistance && last.close < resistance) {
            liquiditySweep = 'bearish';
            confirmed = last.close < resistance - (last.high - last.low) * 0.2;
        }
        const orderBlock = this._findOrderBlockNearPrice(candles, last.close, levels);
        const fvg = this._findFVG(candles);

        const atr = levels.atr || 0;
        const liquidityMap = this._findEqualHighsLows(candles, atr);

        return {
            liquiditySweep, confirmed, orderBlock, fvg,
            eqh: liquidityMap.eqh,
            eql: liquidityMap.eql
        };
    }

    static _findEqualHighsLows(candles, atr) {
        const len = candles.length;
        const eqh = [];
        const eql = [];
        if (len < 10 || atr <= 0) return { eqh, eql };

        const tolerance = atr * 0.2;
        const window = 3;

        for (let i = window; i < len - window; i++) {
            let isHigh = true;
            let isLow = true;
            for (let j = i - window; j <= i + window; j++) {
                if (j === i) continue;
                if (candles[j].high >= candles[i].high) isHigh = false;
                if (candles[j].low <= candles[i].low) isLow = false;
            }
            if (isHigh) eqh.push({ price: candles[i].high, index: i });
            if (isLow) eql.push({ price: candles[i].low, index: i });
        }

        const groupLevels = (levels) => {
            const groups = [];
            for (const level of levels) {
                let foundGroup = false;
                for (const group of groups) {
                    if (Math.abs(group.avgPrice - level.price) <= tolerance) {
                        group.levels.push(level);
                        group.avgPrice = group.levels.reduce((sum, l) => sum + l.price, 0) / group.levels.length;
                        group.touches++;
                        foundGroup = true;
                        break;
                    }
                }
                if (!foundGroup) {
                    groups.push({ avgPrice: level.price, levels: [level], touches: 1 });
                }
            }
            return groups.filter(g => g.touches >= 2);
        };

        return {
            eqh: groupLevels(eqh),
            eql: groupLevels(eql)
        };
    }

    static _findOrderBlockNearPrice(candles, price, levels) {
        const len = candles.length;
        const atr = levels.atr || 0;
        const buffer = atr > 1e-9 ? atr * 0.5 : (price * 0.001);
        for (let i = len - 2; i >= Math.max(0, len - 15); i--) {
            const c = candles[i];
            const isBullishOB = c.close < c.open;
            const isBearishOB = c.close > c.open;
            const nextCandles = candles.slice(i + 1, Math.min(len, i + 4));
            const hasBullishImpulse = nextCandles.some(nc => nc.close > nc.open && Math.abs(nc.close - nc.open) > (levels.atr || 1) * 0.5);
            const hasBearishImpulse = nextCandles.some(nc => nc.close < nc.open && Math.abs(nc.close - nc.open) > (levels.atr || 1) * 0.5);
            if (isBullishOB && hasBullishImpulse) {
                const dist = Math.abs(price - c.low);
                if (dist < buffer * 3) return { type: 'bullish', high: c.high, low: c.low, fresh: i >= len - 5 };
            }
            if (isBearishOB && hasBearishImpulse) {
                const dist = Math.abs(price - c.high);
                if (dist < buffer * 3) return { type: 'bearish', high: c.high, low: c.low, fresh: i >= len - 5 };
            }
        }
        return null;
    }

    static _findFVG(candles) {
        const len = candles.length;
        if (len < 3) return null;
        const c1 = candles[len - 3];
        const c3 = candles[len - 1];
        if (c3.low > c1.high) {
            return { type: 'bullish', top: c3.low, bottom: c1.high };
        }
        if (c3.high < c1.low) {
            return { type: 'bearish', top: c1.low, bottom: c3.high };
        }
        return null;
    }

    static analyzeOTC(candles, symbol, indicators, isOTC) {
        if (!isOTC) return {
            series: { type: 'none', streak: 0 },
            ladder: null, emaRetrace: null,
            rsiDivergence: { type: 'none' },
            active: false, symbol: symbol || ''
        };
        const len = candles.length;
        if (len < 5) return {
            series: { type: 'none', streak: 0 },
            ladder: null, emaRetrace: null,
            rsiDivergence: { type: 'none' },
            active: false, symbol: symbol || ''
        };
        let greenStreak = 0, redStreak = 0;
        for (let i = len - 1; i >= 0; i--) {
            if (candles[i].close > candles[i].open) {
                if (redStreak > 0) break;
                greenStreak++;
            } else if (candles[i].close < candles[i].open) {
                if (greenStreak > 0) break;
                redStreak++;
            } else break;
        }
        let series;
        if (greenStreak === 0 && redStreak === 0) {
            series = { type: 'none', streak: 0 };
        } else {
            series = greenStreak >= redStreak
                ? { type: 'green', streak: greenStreak }
                : { type: 'red', streak: redStreak };
        }
        let ladder = null;
        const last3 = candles.slice(-3);
        if (last3.every(c => c.close > c.open)) {
            ladder = { type: 'up', streak: 3 };
        } else if (last3.every(c => c.close < c.open)) {
            ladder = { type: 'down', streak: 3 };
        }
        if (ladder) {
            let extra = 0;
            for (let i = candles.length - 4; i >= 0; i--) {
                const c = candles[i];
                const up = ladder.type === 'up';
                if ((up && c.close > c.open) || (!up && c.close < c.open)) extra++;
                else break;
            }
            ladder.streak += extra;
        }
        const last = candles[len - 1];
        const ema8 = indicators.ema8;
        let emaRetrace = null;
        if (last.low <= ema8 && last.close > ema8) emaRetrace = { type: 'bounce_up' };
        else if (last.high >= ema8 && last.close < ema8) emaRetrace = { type: 'bounce_down' };
        const rsiDivergence = this.detectOTCRsiDivergence(candles);
        return {
            series, ladder, emaRetrace, rsiDivergence,
            active: true, symbol: symbol || ''
        };
    }

    static detectOTCRsiDivergence(candles) {
        const len = candles.length;
        const lookback = Math.min(30, len - 1);
        if (lookback < 10) return { type: 'none' };
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const startIdx = len - lookback;
        const window = 3;
        const rs7 = Analyzer._calcRSISeries(closes, 7);
        const swingLows = [];
        for (let i = startIdx + window; i < len - window; i++) {
            let isMin = true;
            for (let j = i - window; j <= i + window; j++) {
                if (j !== i && j >= 0 && j < len && lows[j] < lows[i]) { isMin = false; break; }
            }
            if (isMin) swingLows.push(i);
        }
        const swingHighs = [];
        for (let i = startIdx + window; i < len - window; i++) {
            let isMax = true;
            for (let j = i - window; j <= i + window; j++) {
                if (j !== i && j >= 0 && j < len && highs[j] > highs[i]) { isMax = false; break; }
            }
            if (isMax) swingHighs.push(i);
        }
        let bull = false, bear = false;
        if (swingLows.length >= 2) {
            const firstIdx = swingLows[swingLows.length - 2];
            const secondIdx = swingLows[swingLows.length - 1];
            if (secondIdx - firstIdx >= 4 &&
                (len - 1 - secondIdx) <= 10 &&
                lows[secondIdx] < lows[firstIdx]) {
                const rsiFirst = rs7[firstIdx];
                const rsiSecond = rs7[secondIdx];
                if (rsiSecond < 45 && rsiSecond > rsiFirst + 5) bull = true;
            }
        }
        if (swingHighs.length >= 2) {
            const firstIdx = swingHighs[swingHighs.length - 2];
            const secondIdx = swingHighs[swingHighs.length - 1];
            if (secondIdx - firstIdx >= 4 &&
                (len - 1 - secondIdx) <= 10 &&
                highs[secondIdx] > highs[firstIdx]) {
                const rsiFirst = rs7[firstIdx];
                const rsiSecond = rs7[secondIdx];
                if (rsiSecond > 55 && rsiSecond < rsiFirst - 5) bear = true;
            }
        }
        if (bull && bear) return { type: 'none' };
        if (bull) return { type: 'bullish' };
        if (bear) return { type: 'bearish' };
        return { type: 'none' };
    }

    static detectPatterns(candles, levels = {}) {
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const prev2 = candles[candles.length - 3];
        const empty = {
            bullishEngulfing: false, bearishEngulfing: false,
            morningStar: false, eveningStar: false,
            bullishPinBar: false, bearishPinBar: false,
            hammer: false, shootingStar: false,
            threeWhiteSoldiers: false, threeBlackCrows: false,
            pinBarAtSupport: false, pinBarAtResistance: false
        };
        if (!last || !prev || !prev2) return empty;
        const lastBody = Math.abs(last.close - last.open);
        const lastRange = last.high - last.low;
        const prevBody = Math.abs(prev.close - prev.open);
        if (lastRange <= 0) return empty;
        const atr = Number(levels.atr) > 0 ? Number(levels.atr) : lastRange;
        const gapTolerance = atr * 0.1;
        const bullishEngulfing = prev.close < prev.open && last.close > last.open &&
            last.open <= prev.close && last.close >= prev.open;
        const bearishEngulfing = prev.close > prev.open && last.close < last.open &&
            last.open >= prev.close && last.close <= prev.open;
        const morningStar = prev2.close < prev2.open &&
            prev.open <= prev2.close + gapTolerance &&
            prevBody < Math.abs(prev2.close - prev2.open) * 0.4 &&
            last.close > last.open &&
            last.close > (prev2.open + prev2.close) / 2;
        const eveningStar = prev2.close > prev2.open &&
            prev.open >= prev2.close - gapTolerance &&
            prevBody < Math.abs(prev2.close - prev2.open) * 0.4 &&
            last.close < last.open &&
            last.close < (prev2.open + prev2.close) / 2;
        const isSmallBody = lastBody < lastRange * 0.35;
        const bullishPinBar = isSmallBody && lastRange > atr * 0.5 &&
            (Math.min(last.open, last.close) - last.low) > lastRange * 0.60 &&
            (last.high - Math.max(last.open, last.close)) < lastRange * 0.15;
        const bearishPinBar = isSmallBody && lastRange > atr * 0.5 &&
            (last.high - Math.max(last.open, last.close)) > lastRange * 0.60 &&
            (Math.min(last.open, last.close) - last.low) < lastRange * 0.15;
        const buffer = atr > 0 ? atr * 1.5 : lastRange * 3;
        const nearSupport = levels.nearSupport || (levels.support > 0 && last.low <= levels.support + buffer);
        const nearResistance = levels.nearResistance || (levels.resistance > 0 && last.high >= levels.resistance - buffer);
        const hammer = bullishPinBar && nearSupport;
        const shootingStar = bearishPinBar && nearResistance;
        const pinBarAtSupport = hammer;
        const pinBarAtResistance = shootingStar;
        const xa = (c) => Math.abs(c.close - c.open);
        const xr = (c) => (c.high - c.low) || 1e-9;
        const xu = (c) => c.high - Math.max(c.open, c.close);
        const xl = (c) => Math.min(c.open, c.close) - c.low;
        const xd = (c) => (c.close > c.open ? 1 : (c.close < c.open ? -1 : 0));
        const xMid = (c) => (c.open + c.close) / 2;
        const x2 = candles[candles.length - 4];
        const xTrendDown = x2 && candles[candles.length - 4].close > candles[candles.length - 2].close;
        const xTrendUp = x2 && candles[candles.length - 4].close < candles[candles.length - 2].close;
        const xPiercingBull = xd(prev) === -1 && xd(last) === 1 && last.open < prev.low && last.close > xMid(prev) && last.close < prev.open;
        const xDarkCloud = xd(prev) === 1 && xd(last) === -1 && last.open > prev.high && last.close < xMid(prev) && last.close > prev.open;
        const xTweezerBull = xd(prev) === -1 && xd(last) === 1 && Math.abs(prev.low - last.low) <= 0.05 * xr(prev);
        const xTweezerBear = xd(prev) === 1 && xd(last) === -1 && Math.abs(prev.high - last.high) <= 0.05 * xr(prev);
        const xCounterBull = xd(prev) === -1 && xd(last) === 1 && Math.abs(last.close - prev.close) <= 0.05 * xr(prev);
        const xCounterBear = xd(prev) === 1 && xd(last) === -1 && Math.abs(last.close - prev.close) <= 0.05 * xr(prev);
        const xBeltBull = xd(last) === 1 && xl(last) <= 0.05 * xr(last) && last.open < prev.low && xa(last) >= 0.6 * xr(last);
        const xBeltBear = xd(last) === -1 && xu(last) <= 0.05 * xr(last) && last.open > prev.high && xa(last) >= 0.6 * xr(last);
        const xAbandonedBull = !!prev2 && xd(prev2) === -1 && xa(prev) <= 0.1 * xr(prev) && prev.high < prev2.low && last.low > prev.high && xd(last) === 1;
        const xAbandonedBear = !!prev2 && xd(prev2) === 1 && xa(prev) <= 0.1 * xr(prev) && prev.low > prev2.high && last.high < prev.low && xd(last) === -1;
        const xTwoCrows = !!prev2 && xd(prev2) === 1 && xd(prev) === -1 && xd(last) === -1 && prev.open > prev2.close && last.open < prev.open && last.open > prev.close && last.close < prev.close;
        const xRiseMethods = !!prev2 && xd(prev2) === 1 && xa(prev2) >= 0.6 * xr(prev2) && xd(prev) === -1 && prev.high <= prev2.high && prev.low >= prev2.low && xd(last) === 1 && last.close > prev2.close;
        const xFallMethods = !!prev2 && xd(prev2) === -1 && xa(prev2) >= 0.6 * xr(prev2) && xd(prev) === 1 && prev.high <= prev2.high && prev.low >= prev2.low && xd(last) === -1 && last.close < prev2.close;
        const xInvHammer = xTrendDown && xu(last) >= 2 * xa(last) && xl(last) <= 0.1 * xr(last) && xa(last) <= 0.3 * xr(last);
        const xHangingMan = xTrendUp && xl(last) >= 2 * xa(last) && xu(last) <= 0.1 * xr(last) && xa(last) <= 0.3 * xr(last);
        const xDragonfly = xa(last) <= 0.1 * xr(last) && xl(last) >= 0.6 * xr(last) && xu(last) <= 0.1 * xr(last);
        const xGravestone = xa(last) <= 0.1 * xr(last) && xu(last) >= 0.6 * xr(last) && xl(last) <= 0.1 * xr(last);
        const xMaruBull = xd(last) === 1 && xa(last) >= 0.9 * xr(last);
        const xMaruBear = xd(last) === -1 && xa(last) >= 0.9 * xr(last);
        const threeWhiteSoldiers = last.close > last.open && prev.close > prev.open && prev2.close > prev2.open &&
            last.close > prev.close && prev.close > prev2.close &&
            last.open >= prev.open - gapTolerance && last.open <= prev.close + gapTolerance &&
            prev.open >= prev2.open - gapTolerance && prev.open <= prev2.close + gapTolerance;
        const threeBlackCrows = last.close < last.open && prev.close < prev.open && prev2.close < prev2.open &&
            last.close < prev.close && prev.close < prev2.close &&
            last.open <= prev.open + gapTolerance && last.open >= prev.close - gapTolerance &&
            prev.open <= prev2.open + gapTolerance && prev.open >= prev2.close - gapTolerance;
        return {
            bullishEngulfing, bearishEngulfing, morningStar, eveningStar,
            bullishPinBar, bearishPinBar, hammer, shootingStar,
            threeWhiteSoldiers, threeBlackCrows, pinBarAtSupport, pinBarAtResistance,
            insideBar: last.high < prev.high && last.low > prev.low,
            harami: ((last.close < last.open && prev.close > prev.open) || (last.close > last.open && prev.close < prev.open)) &&
                Math.max(last.open, last.close) <= Math.max(prev.open, prev.close) && Math.min(last.open, last.close) >= Math.min(prev.open, prev.close),
            motherDir: prev.close > prev.open ? 1 : (prev.close < prev.open ? -1 : 0),
            lastDir: last.close > last.open ? 1 : (last.close < last.open ? -1 : 0),
            tweezerBottom: last.close > last.open && prev.close < prev.open && Math.abs(prev.low - last.low) <= 0.05 * (prev.high - prev.low || 1e-9),
            tweezerTop: last.close < last.open && prev.close > prev.open && Math.abs(prev.high - last.high) <= 0.05 * (prev.high - prev.low || 1e-9),
            marubozuDir: ((last.high - last.low) > 0 && Math.abs(last.close - last.open) >= 0.9 * (last.high - last.low)) ? (last.close > last.open ? 1 : -1) : 0,
            xPiercingBull, xDarkCloud, xTweezerBull, xTweezerBear, xCounterBull, xCounterBear, xBeltBull, xBeltBear,
            xAbandonedBull, xAbandonedBear, xTwoCrows, xRiseMethods, xFallMethods, xInvHammer, xHangingMan, xDragonfly, xGravestone, xMaruBull, xMaruBear
        };
    }

    static findLevels(candles, indicators) {
        const len = candles.length;
        if (len < 10) return {
            support: 0, resistance: 0,
            nearSupport: false, nearResistance: false,
            nearRoundNumber: false, zoneBuffer: 0,
            brokeSupport: false, brokeResistance: false
        };
        const last = candles[len - 1];
        const prev = candles[len - 2];
        const atr = indicators.atr;
        const zoneBuffer = atr * 1.2;
        const window = Math.min(5, Math.max(2, Math.floor(len / 4)));
        const swingLows = [];
        const swingHighs = [];
        for (let i = window; i < len - 1 - window; i++) {
            let isSwingLow = true, isSwingHigh = true;
            for (let j = Math.max(0, i - window); j <= Math.min(len - 2, i + window); j++) {
                if (j === i) continue;
                if (candles[j].low <= candles[i].low) isSwingLow = false;
                if (candles[j].high >= candles[i].high) isSwingHigh = false;
            }
            if (isSwingLow) swingLows.push(candles[i].low);
            if (isSwingHigh) swingHighs.push(candles[i].high);
        }

        let support = 0;
        for (let i = swingLows.length - 1; i >= 0; i--) {
            if (swingLows[i] < last.close) {
                if (last.close - swingLows[i] > atr * 0.2) {
                    support = swingLows[i];
                    break;
                }
            }
        }

        let resistance = 0;
        for (let i = swingHighs.length - 1; i >= 0; i--) {
            if (swingHighs[i] > last.close) {
                if (swingHighs[i] - last.close > atr * 0.2) {
                    resistance = swingHighs[i];
                    break;
                }
            }
        }

        const isValidLevel = (val) => Number.isFinite(val) && val > 1e-9;
        const nearSupport = isValidLevel(support) && last.low <= (support + zoneBuffer) && last.close > support;
        const nearResistance = isValidLevel(resistance) && last.high >= (resistance - zoneBuffer) && last.close < resistance;
        const magnitude = Math.pow(10, Math.floor(Math.log10(last.close)));
        const roundStep = magnitude / 10;
        const roundNumber = Math.round(last.close / roundStep) * roundStep;
        const nearRoundNumber = Math.abs(last.close - roundNumber) / last.close < 0.002;
        const atrBuffer = atr * 0.15;
        let supportPrev = 0;
        for (let i = swingLows.length - 1; i >= 0; i--) {
            if (swingLows[i] < prev.close && prev.close - swingLows[i] > atr * 0.2) { supportPrev = swingLows[i]; break; }
        }
        let resistancePrev = 0;
        for (let i = swingHighs.length - 1; i >= 0; i--) {
            if (swingHighs[i] > prev.close && swingHighs[i] - prev.close > atr * 0.2) { resistancePrev = swingHighs[i]; break; }
        }
        const brokeSupport = isValidLevel(supportPrev) && prev.close >= supportPrev && last.close < (supportPrev - atrBuffer);
        const brokeResistance = isValidLevel(resistancePrev) && prev.close <= resistancePrev && last.close > (resistancePrev + atrBuffer);
        return {
            support, resistance,
            nearSupport, nearResistance,
            nearRoundNumber, zoneBuffer, atr,
            brokeSupport, brokeResistance
        };
    }

    static analyzeContext(levels, indicators) {
        const adx = Number(indicators.adx) || 0;
        const e3 = Number(indicators.ema3);
        const e8 = Number(indicators.ema8);
        const e13 = Number(indicators.ema13);
        const e21 = Number(indicators.ema21);
        const validEMA = Number.isFinite(e3) && Number.isFinite(e8) &&
            Number.isFinite(e13) && Number.isFinite(e21) &&
            e3 > 0 && e8 > 0 && e13 > 0 && e21 > 0;
        const trend = validEMA
            ? (e3 > e8 && e8 > e13 ? 'UP' : e3 < e8 && e8 < e13 ? 'DOWN' : 'SIDEWAYS')
            : 'SIDEWAYS';
        const trendStrength = adx > 30 ? 'strong' : adx > 20 ? 'moderate' : 'weak';
        const volatility = indicators.atrPercent > 0.1 ? 'high' : indicators.atrPercent > 0.05 ? 'moderate' : 'low';
        const isFlat = adx < 20;
        const emaAlignment = validEMA
            ? (e3 > e8 && e8 > e13 && e13 > e21 ? 'strong_bullish' :
                e3 < e8 && e8 < e13 && e13 < e21 ? 'strong_bearish' : 'mixed')
            : 'mixed';
        return {
            nearSupport: levels.nearSupport, nearResistance: levels.nearResistance,
            trend, trendStrength, volatility, isFlat, emaAlignment
        };
    }

    static analyzeStructure(candles, indicators = {}) {
        const len = candles.length;
        if (len < 15) return {
            direction: 'neutral', slope: 'FLAT', strength: 'weak',
            bos: 'none', choch: 'none', chochDirection: null, hasConflict: false,
            lastSwingHigh: 0, lastSwingLow: 0,
            prevSwingHigh: 0, prevSwingLow: 0,
            displacement: false, displacementDir: null, orderBlock: null, freshBos: false,
            atr: indicators.atr || 0, adx: indicators.adx || 0
        };
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const closes = candles.map(c => c.close);
        const last = candles[len - 1];
        const atr = Number(indicators.atr) || 0;
        const adx = Number(indicators.adx) || 0;

        const window = Math.min(5, Math.max(2, Math.floor(len / 8)));

        let lastSwingHigh = 0, lastSwingHighIdx = -1;
        let prevSwingHigh = 0, prevSwingHighIdx = -1;
        for (let i = len - 2 - window; i >= Math.max(window, len - 40); i--) {
            let isMax = true;
            for (let j = i - window; j <= i + window; j++) {
                if (j !== i && j >= 0 && j < len && highs[j] > highs[i]) { isMax = false; break; }
            }
            if (isMax) {
                if (lastSwingHighIdx === -1) {
                    lastSwingHigh = highs[i];
                    lastSwingHighIdx = i;
                } else if (prevSwingHighIdx === -1) {
                    prevSwingHigh = highs[i];
                    prevSwingHighIdx = i;
                    break;
                }
            }
        }
        let lastSwingLow = Infinity, lastSwingLowIdx = -1;
        let prevSwingLow = Infinity, prevSwingLowIdx = -1;
        for (let i = len - 2 - window; i >= Math.max(window, len - 40); i--) {
            let isMin = true;
            for (let j = i - window; j <= i + window; j++) {
                if (j !== i && j >= 0 && j < len && lows[j] < lows[i]) { isMin = false; break; }
            }
            if (isMin) {
                if (lastSwingLowIdx === -1) {
                    lastSwingLow = lows[i];
                    lastSwingLowIdx = i;
                } else if (prevSwingLowIdx === -1) {
                    prevSwingLow = lows[i];
                    prevSwingLowIdx = i;
                    break;
                }
            }
        }
        let bos = 'none';
        let freshBos = false;
        const atrBuffer = atr > 0 ? atr * 0.15 : 0;
        const brokeUp = lastSwingHighIdx >= 0 && last.close > (lastSwingHigh + atrBuffer);
        const brokeDown = lastSwingLowIdx > 0 && last.close < (lastSwingLow - atrBuffer);
        if (brokeUp && brokeDown) {
            const prevClose = closes[len - 2];
            const bodyUp = last.close > last.open;
            const bodyDown = last.close < last.open;
            if (bodyUp && !bodyDown) {
                bos = 'bullish';
                freshBos = !(prevClose > (lastSwingHigh + atrBuffer));
            } else if (bodyDown && !bodyUp) {
                bos = 'bearish';
                freshBos = !(prevClose < (lastSwingLow - atrBuffer));
            }
        } else if (brokeUp && !brokeDown) {
            const prevClose = closes[len - 2];
            const wasAlreadyBroken = prevClose > (lastSwingHigh + atrBuffer);
            bos = 'bullish';
            freshBos = !wasAlreadyBroken;
        } else if (brokeDown && !brokeUp) {
            const prevClose = closes[len - 2];
            const wasAlreadyBroken = prevClose < (lastSwingLow - atrBuffer);
            bos = 'bearish';
            freshBos = !wasAlreadyBroken;
        }
        let choch = 'none';
        let chochDirection = null;
        const chochBuffer = atr > 0 ? atr * 0.15 : 0;
        const wasUptrend = prevSwingHighIdx > 0 && prevSwingLowIdx > 0 &&
            lastSwingHighIdx > 0 && lastSwingLowIdx > 0 &&
            lastSwingHigh > prevSwingHigh && lastSwingLow > prevSwingLow;
        const wasDowntrend = prevSwingHighIdx > 0 && prevSwingLowIdx > 0 &&
            lastSwingHighIdx > 0 && lastSwingLowIdx > 0 &&
            lastSwingHigh < prevSwingHigh && lastSwingLow < prevSwingLow;
        const chochBullish = wasDowntrend && brokeUp && !brokeDown && last.close > lastSwingHigh + chochBuffer;
        const chochBearish = wasUptrend && brokeDown && !brokeUp && last.close < lastSwingLow - chochBuffer;
        let freshChoch = false;
        if (chochBullish) {
            choch = 'bullish'; chochDirection = 'UP';
            freshChoch = !(closes[len - 2] > lastSwingHigh + chochBuffer);
            bos = 'none'; freshBos = false;
        } else if (chochBearish) {
            choch = 'bearish'; chochDirection = 'DOWN';
            freshChoch = !(closes[len - 2] < lastSwingLow - chochBuffer);
            bos = 'none'; freshBos = false;
        }
        let direction = 'neutral';
        if (bos === 'bullish') direction = 'bullish';
        else if (bos === 'bearish') direction = 'bearish';
        else if (choch === 'bullish') direction = 'bullish';
        else if (choch === 'bearish') direction = 'bearish';
        let slope = 'FLAT';
        const last10 = candles.slice(-Math.min(10, len));
        const priceDiff = last10[last10.length - 1].close - last10[0].close;
        if (atr > 0 && Math.abs(priceDiff) > atr * 0.5) {
            slope = priceDiff > 0 ? 'UP' : 'DOWN';
        }
        let strength = 'weak';
        if (adx > 30) strength = 'strong';
        else if (adx > 20) strength = 'moderate';
        const { up: emaBullish, down: emaBearish } = Analyzer._emaAlignment(indicators);
        const hasConflict =
            (choch === 'bullish' && (slope === 'DOWN' || emaBearish)) ||
            (choch === 'bearish' && (slope === 'UP' || emaBullish)) ||
            (bos === 'bullish' && (slope === 'DOWN' || emaBearish)) ||
            (bos === 'bearish' && (slope === 'UP' || emaBullish));
        const dispResult = this._checkDisplacement(candles, atr);
        const displacement = dispResult.isDisplacement;
        const displacementDir = dispResult.direction;
        const orderBlock = this._findOrderBlock(candles, bos !== 'none' ? bos : choch);
        return {
            direction, slope, strength, bos, choch, chochDirection, hasConflict,
            lastSwingHigh: lastSwingHigh === Infinity ? 0 : lastSwingHigh,
            lastSwingLow: lastSwingLow === Infinity ? 0 : lastSwingLow,
            prevSwingHigh: prevSwingHigh === Infinity ? 0 : prevSwingHigh,
            prevSwingLow: prevSwingLow === Infinity ? 0 : prevSwingLow,
            displacement, displacementDir, orderBlock, freshBos, freshChoch,
            atr, adx
        };
    }

    static _checkDisplacement(candles, atr = 0) {
        const len = candles.length;
        if (len < 1) return { isDisplacement: false, direction: null };
        for (let i = len - 1; i >= Math.max(0, len - 5); i--) {
            const c = candles[i];
            const body = Math.abs(c.close - c.open);
            const range = c.high - c.low;
            if (range === 0) continue;
            const bodyRatio = body / range;
            if (bodyRatio > 0.70 && (atr === 0 || body > atr * 0.4)) {
                const dir = c.close > c.open ? 'bullish' : (c.close < c.open ? 'bearish' : null);
                if (!dir) continue;
                let faded = false;
                for (let k = i + 1; k < len; k++) {
                    const ck = candles[k];
                    const oppBody = Math.abs(ck.close - ck.open);
                    const oppDir = ck.close > ck.open ? 'bullish' : (ck.close < ck.open ? 'bearish' : null);
                    if (oppDir && oppDir !== dir && oppBody > body * 0.6) {
                        faded = true;
                        break;
                    }
                }
                if (!faded) return { isDisplacement: true, direction: dir };
            }
        }
        return { isDisplacement: false, direction: null };
    }

    static _findOrderBlock(candles, bos) {
        const len = candles.length;
        if (len < 3 || bos === 'none') return null;
        if (bos === 'bullish') {
            for (let i = len - 2; i >= Math.max(0, len - 10); i--) {
                if (candles[i].close < candles[i].open) return {
                    type: 'bullish',
                    high: candles[i].high,
                    low: candles[i].low
                };
            }
        }
        if (bos === 'bearish') {
            for (let i = len - 2; i >= Math.max(0, len - 10); i--) {
                if (candles[i].close > candles[i].open) return {
                    type: 'bearish',
                    high: candles[i].high,
                    low: candles[i].low
                };
            }
        }
        return null;
    }

    static checkFakeouts(candles, levels) {
        const last = candles[candles.length - 1];
        return {
            fakeBreakoutSupport: last.low < levels.support && last.close > levels.support,
            fakeBreakoutResistance: last.high > levels.resistance && last.close < levels.resistance
        };
    }

    static analyzeVolume(candles, currentTime = null, volumeReliable = true, atrRef = 0) {
        const len = candles.length;
        if (len < 5 || !volumeReliable) {
            return {
                signal: 'NEUTRAL', ratio: 1, maturity: 1,
                isBullish: false, isBearish: false,
                hasLongUpper: false, hasLongLower: false,
                atResistance: false, atSupport: false
            };
        }
        const last = candles[len - 1];
        const prevSlice = candles.slice(-Math.min(21, len), -1);
        const avgVolume = prevSlice.length > 0
            ? prevSlice.reduce((a, c) => a + (Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0), 0) / prevSlice.length
            : 0;
        const ratio = avgVolume > 0 ? last.volume / avgVolume : 0;
        const range = last.high - last.low;
        const isBullish = last.close > last.open;
        const isBearish = last.close < last.open;
        const upperShadow = last.high - Math.max(last.open, last.close);
        const lowerShadow = Math.min(last.open, last.close) - last.low;
        const SHADOW_REL = 0.35;
        const hasLongUpper = range > 0 && upperShadow >= range * SHADOW_REL && upperShadow > lowerShadow;
        const hasLongLower = range > 0 && lowerShadow >= range * SHADOW_REL && lowerShadow > upperShadow;
        const recentHighs = candles.slice(-20, -1).map(c => c.high);
        const recentLows = candles.slice(-20, -1).map(c => c.low);
        const localResistance = Math.max(...recentHighs);
        const localSupport = Math.min(...recentLows);
        const atrBuffer = atrRef > 0 ? atrRef : (last.high - last.low);
        const resistanceBuffer = atrBuffer * 0.3;
        const supportBuffer = atrBuffer * 0.3;
        const atResistance = last.high >= localResistance - resistanceBuffer;
        const atSupport = last.low <= localSupport + supportBuffer;
        let signal = 'NEUTRAL';
        if (ratio > 2.0) {
            if (isBullish && !hasLongUpper) signal = 'STRONG_BULL';
            else if (isBearish && !hasLongLower) signal = 'STRONG_BEAR';
            else if (isBullish && hasLongUpper && atResistance) signal = 'BULL_TRAP';
            else if (isBearish && hasLongLower && atSupport) signal = 'BEAR_TRAP';
            else if (isBullish && hasLongUpper && !atResistance) signal = 'WEAK_BULL_REJECTION';
            else if (isBearish && hasLongLower && !atSupport) signal = 'WEAK_BEAR_REJECTION';
            else if (!isBullish && !isBearish && hasLongUpper && atResistance) signal = 'BULL_TRAP';
            else if (!isBullish && !isBearish && hasLongLower && atSupport) signal = 'BEAR_TRAP';
        } else if (ratio >= 1.5) {
            if (isBullish && !hasLongUpper) signal = 'MODERATE_BULL';
            else if (isBearish && !hasLongLower) signal = 'MODERATE_BEAR';
            else if (isBullish && hasLongUpper && atResistance) signal = 'WEAK_BULL_TRAP';
            else if (isBearish && hasLongLower && atSupport) signal = 'WEAK_BEAR_TRAP';
        }
        const t1 = last.time > 1e11 ? last.time : last.time * 1000;
        const t0 = candles[len - 2].time > 1e11 ? candles[len - 2].time : candles[len - 2].time * 1000;
        const timeframeMs = (t1 > t0 && (t1 - t0) < 86400000) ? (t1 - t0) : 60000;
        const lastTimeMs = t1;
        const effectiveTimeMs = currentTime !== null ? currentTime : (lastTimeMs + timeframeMs);
        const elapsedSec = (effectiveTimeMs - lastTimeMs) / 1000;
        const maturity = timeframeMs > 0 ? Math.min(1, Math.max(0, elapsedSec / ((timeframeMs / 1000) * 0.7))) : 1;
        return {
            signal, ratio: Number(ratio.toFixed(2)), maturity: Number(maturity.toFixed(2)),
            isBullish, isBearish, hasLongUpper, hasLongLower, atResistance, atSupport
        };
    }

    static analyzeShadowCandles(candles) {
        const len = candles.length;
        if (len < 3) return { shadowCount: 0, pattern: 'NONE' };
        const prev1 = candles[len - 2];
        const prev2 = candles[len - 3];
        const last = candles[len - 1];
        const analyzeShadow = (c) => {
            const body = Math.abs(c.close - c.open);
            const range = c.high - c.low;
            if (range <= 0) return { isShadow: false, upperShadow: 0, lowerShadow: 0 };
            const upperShadow = c.high - Math.max(c.open, c.close);
            const lowerShadow = Math.min(c.open, c.close) - c.low;
            const isShadow = (range - body) / range > 0.72;
            return {
                isShadow, upperShadow, lowerShadow,
                upperShadowRatio: upperShadow / range,
                lowerShadowRatio: lowerShadow / range
            };
        };
        const prev1Info = analyzeShadow(prev1);
        const prev2Info = analyzeShadow(prev2);
        const prev1Shadow = prev1Info.isShadow;
        const prev2Shadow = prev2Info.isShadow;
        const shadowCount = (prev1Shadow ? 1 : 0) + (prev2Shadow ? 1 : 0);
        let pattern = 'NONE';
        let breakoutDirection = null;
        let shadowBias = null;
        if (shadowCount === 2) {
            const totalUpper = prev1Info.upperShadow + prev2Info.upperShadow;
            const totalLower = prev1Info.lowerShadow + prev2Info.lowerShadow;
            if (totalUpper > totalLower * 1.5) shadowBias = 'BEARISH';
            else if (totalLower > totalUpper * 1.5) shadowBias = 'BULLISH';
            const lastBody = Math.abs(last.close - last.open);
            const lastRange = last.high - last.low || 0.00001;
            const lastIsStrong = lastBody / lastRange > 0.7;
            if (lastIsStrong) {
                pattern = 'BREAKOUT_AFTER_CONSOLIDATION';
                breakoutDirection = last.close > last.open ? 'UP' : (last.close < last.open ? 'DOWN' : null);
            } else {
                pattern = 'CONTINUED_INDECISION';
            }
        } else if (shadowCount === 1) pattern = 'SINGLE_SHADOW';
        return {
            shadowCount, pattern, prev1Shadow, prev2Shadow,
            breakoutDirection, shadowBias
        };
    }

    static _detectConsolidation(candles, atr) {
        const len = candles.length;
        if (len < 12 || atr <= 0) return { isSqueeze: false, range: 0, high: 0, low: 0 };
        const recent = candles.slice(-12, -1);
        const highs = recent.map(c => c.high);
        const lows = recent.map(c => c.low);
        const high = Math.max(...highs);
        const low = Math.min(...lows);
        const range = high - low;
        const isSqueeze = range < atr * 2.5;
        return { isSqueeze, range, high, low };
    }

    static _detectChoppyMarket(candles) {
        const len = candles.length;
        if (len < 10) return { isChoppy: false, dojiCount: 0 };
        const recent = candles.slice(-10);
        let dojiCount = 0;
        for (const c of recent) {
            const range = c.high - c.low;
            const body = Math.abs(c.close - c.open);
            if (range > 0 && (body / range) < 0.15) {
                dojiCount++;
            }
        }
        return { isChoppy: dojiCount >= 4, dojiCount };
    }

    static analyzeMarketBehavior(candles, indicators = {}, structure = {}, volumeSignal = {}, impulseData = {}) {
        const len = candles.length;
        if (len < 12) {
            return {
                behavior: 'NEUTRAL', direction: null, trendDirection: 'FLAT',
                pullbackDepth: 0, anomalyType: null, evidence: [],
                volumeEvent: 'NONE', volumeDirection: null, volumeRatio: 1,
                atr: 0, range: 0, body: 0, bodyRatio: 0, impulseSize: 0,
                structure: {}, isImpulse: false, isLongTail: false, isStagnation: false,
                alternationRatio: 0,
                alternatingBalance: { active: false, score: 0, evidence: [] },
                evidenceAll: []
            };
        }
        const last = candles[len - 1];
        const prev = candles[len - 2];
        const atr = Math.max(Number(indicators.atr) || (last.high - last.low), 1e-9);
        const adx = Number(indicators.adx) || 0;
        const range = Math.max(last.high - last.low, 1e-12);
        const body = Math.abs(last.close - last.open);
        const bodyRatio = body / range;
        const prior = candles.slice(Math.max(0, len - 12), len - 1);
        const avgRange = prior.length ? prior.reduce((s, c) => s + Math.max(c.high - c.low, 0), 0) / prior.length : atr;
        const avgBody = prior.length ? prior.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / prior.length : body;
        const _finite = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
        const volRatio = _finite(volumeSignal?.ratio) ?? _finite(indicators.volumeRatio) ?? 1;
        const volumeReliable = indicators.volumeReliable !== false;
        const _emaAl = Analyzer._emaAlignment(indicators);
        const emaUp = indicators.emaUpStable ?? _emaAl.up;
        const emaDown = indicators.emaDownStable ?? _emaAl.down;
        const recentCloses = candles.slice(-5).map(c => c.close);
        const priceMomentum = recentCloses[recentCloses.length - 1] - recentCloses[0];
        const priceUp = atr > 0 ? priceMomentum > (atr * 0.5) : priceMomentum > 0;
        const priceDown = atr > 0 ? priceMomentum < -(atr * 0.5) : priceMomentum < 0;
        let trend = 'FLAT';
        if (emaUp) trend = 'UP';
        else if (emaDown) trend = 'DOWN';
        else if (priceUp && adx >= 20) trend = 'UP';
        else if (priceDown && adx >= 20) trend = 'DOWN';
        const structureHigh = Number(structure.lastSwingHigh);
        const structureLow = Number(structure.lastSwingLow);
        const chochHigh = (structureHigh > 0 && Number.isFinite(structureHigh)) ? structureHigh : 0;
        const chochLow = (structureLow > 0 && Number.isFinite(structureLow) && structureLow < Infinity) ? structureLow : 0;
        const recentHigh = Math.max(...candles.slice(-9, -1).map(c => c.high));
        const recentLow = Math.min(...candles.slice(-9, -1).map(c => c.low));
        const impulseLookback = candles.slice(Math.max(0, len - 10), len - 1);
        let impulseSize = 0;
        for (let i = impulseLookback.length - 1; i >= 0; i--) {
            const c = impulseLookback[i];
            const cBody = Math.abs(c.close - c.open);
            if (cBody > avgBody * 1.5) {
                impulseSize = Math.max(impulseSize, cBody);
            }
        }
        if (impulseSize === 0) impulseSize = Math.max(recentHigh - recentLow, atr * 1.5);
        const prior5 = candles.slice(Math.max(0, len - 6), len - 1);
        const range5 = prior5.length ? Math.max(...prior5.map(c => c.high)) - Math.min(...prior5.map(c => c.low)) : range;
        const avgRange5 = prior5.length ? prior5.reduce((a, c) => a + (c.high - c.low), 0) / prior5.length : avgRange;
        const older5 = candles.slice(Math.max(0, len - 11), Math.max(0, len - 6));
        const olderAvgRange = older5.length ? older5.reduce((a, c) => a + Math.max(c.high - c.low, 0), 0) / older5.length : avgRange;
        const compression = prior5.length >= 5 && older5.length >= 4 &&
            range5 <= Math.max(atr * 2.0, olderAvgRange * 3.0) &&
            avgRange5 <= olderAvgRange * 0.75;
        const seq = candles.slice(-8).map(c => c.close > c.open ? 1 : c.close < c.open ? -1 : 0);
        const directional = seq.filter(Boolean).length;
        const alternating = seq.slice(1).reduce((n, v, i) => n + (v && seq[i] && v !== seq[i] ? 1 : 0), 0);
        const alternationRatio = directional >= 3 ? alternating / directional : 0;
        const upper = Math.max(0, last.high - Math.max(last.open, last.close));
        const lower = Math.max(0, Math.min(last.open, last.close) - last.low);
        const upperRatio = upper / range;
        const lowerRatio = lower / range;
        const isLongTail = Math.max(upperRatio, lowerRatio) >= 0.45;
        const strongCloseHigh = last.close >= last.high - range * 0.2;
        const strongCloseLow = last.close <= last.low + range * 0.2;
        const volSignal = String(volumeSignal?.signal || 'NEUTRAL');
        const volAgainstUpTrend = ['STRONG_BEAR', 'MODERATE_BEAR', 'WEAK_BEAR_REJECTION'].includes(volSignal);
        const volAgainstDownTrend = ['STRONG_BULL', 'MODERATE_BULL', 'WEAK_BULL_REJECTION'].includes(volSignal);
        let behavior = 'NEUTRAL', direction = null, pullbackDepth = 0, anomalyType = null;
        let evidence = [];
        const breakoutUp = (compression || volRatio >= 2.0) &&
            prior5.length >= 5 &&
            last.close > Math.max(...prior5.map(c => c.high)) &&
            body >= avgBody * 1.5 &&
            (volumeReliable ? volRatio >= 1.3 : body >= avgBody * 2.0) &&
            strongCloseHigh;
        const breakoutDown = (compression || volRatio >= 2.0) &&
            prior5.length >= 5 &&
            last.close < Math.min(...prior5.map(c => c.low)) &&
            body >= avgBody * 1.5 &&
            (volumeReliable ? volRatio >= 1.3 : body >= avgBody * 2.0) &&
            strongCloseLow;
        const downContext = trend === 'DOWN';
        const upContext = trend === 'UP';
        const chochUp = downContext && chochHigh > 0 &&
            last.close > chochHigh + atr * 0.1 && prev.close <= chochHigh;
        const chochDown = upContext && chochLow > 0 && chochLow < Infinity &&
            last.close < chochLow - atr * 0.1 && prev.close >= chochLow;
        const falseReversalUp = trend === 'DOWN' &&
            last.low < prev.low && last.close > prev.low &&
            last.close < last.open &&
            (volRatio >= 1.1 || isLongTail);
        const falseReversalDown = trend === 'UP' &&
            last.high > prev.high && last.close < prev.high &&
            last.close > last.open &&
            (volRatio >= 1.1 || isLongTail);
        const isTrendUpConfirmed = emaUp;
        const isTrendDownConfirmed = emaDown;
        if (breakoutUp) {
            behavior = 'BREAKOUT_UP'; direction = 'CALL'; anomalyType = 'BREAKOUT';
            evidence = ['стиснення/діапазон або екстремальний обсяг', 'пробій вгору', 'сильне закриття'];
        } else if (breakoutDown) {
            behavior = 'BREAKOUT_DOWN'; direction = 'PUT'; anomalyType = 'BREAKOUT';
            evidence = ['стиснення/діапазон або екстремальний обсяг', 'пробій вниз', 'сильне закриття'];
        } else if (chochUp) {
            behavior = 'REAL_REVERSAL_UP'; direction = 'CALL'; anomalyType = 'REAL_REVERSAL';
            evidence = ['CHoCH вверх', 'слом попереднього swing high'];
        } else if (chochDown) {
            behavior = 'REAL_REVERSAL_DOWN'; direction = 'PUT'; anomalyType = 'REAL_REVERSAL';
            evidence = ['CHoCH вниз', 'слом попереднього swing low'];
        } else if (falseReversalUp) {
            behavior = 'FALSE_REVERSAL_UP'; direction = 'PUT'; anomalyType = 'FALSE_REVERSAL';
            evidence = ['ложный разворот вверх отменён (sweep)'];
        } else if (falseReversalDown) {
            behavior = 'FALSE_REVERSAL_DOWN'; direction = 'CALL'; anomalyType = 'FALSE_REVERSAL';
            evidence = ['ложный разворот вниз отменён (sweep)'];
        } else if (trend === 'UP' && last.close < last.open) {
            pullbackDepth = (recentHigh != null && atr > 0) ? Math.max(0, recentHigh - last.close) / atr : 0;
            const barsAgainst = candles.slice(-Math.min(4, len)).filter(c => c.close < c.open).length;
            const ratioToImpulse = impulseSize > 0 ? Math.max(0, recentHigh - last.close) / impulseSize : 1;
            if (ratioToImpulse < 0.30 && barsAgainst <= 2 && adx >= 30 && emaUp && !isLongTail) {
                if (volAgainstUpTrend) {
                    behavior = 'POTENTIAL_REVERSAL'; direction = null; anomalyType = 'VOLUME_WARNING';
                    evidence = ['мікро-відкат на ведмежому обсязі — можливий розворот', `обсяг ×${volRatio.toFixed(2)}`];
                } else {
                    behavior = 'MICRO_PULLBACK_DOWN'; direction = null; anomalyType = 'MICRO_PULLBACK';
                    evidence = ['1-2 свічки коррекції', `глибина ${(ratioToImpulse * 100).toFixed(0)}% імпульсу`, 'напрямок не визначено — тільки попередження'];
                }
            } else if (ratioToImpulse < 0.65 && pullbackDepth < 1.5 && isTrendUpConfirmed) {
                behavior = 'PULLBACK_DOWN'; direction = 'CALL'; anomalyType = 'NORMAL_PULLBACK';
                evidence = ['корекція всередині висхідної структури'];
            } else {
                behavior = 'DEEP_PULLBACK_DOWN'; direction = null; anomalyType = 'DEEP_PULLBACK';
                evidence = ['глибокий відкат', 'структура під загрозою'];
            }
        } else if (trend === 'DOWN' && last.close > last.open) {
            pullbackDepth = (recentLow != null && atr > 0) ? Math.max(0, last.close - recentLow) / atr : 0;
            const barsAgainst = candles.slice(-Math.min(4, len)).filter(c => c.close > c.open).length;
            const ratioToImpulse = impulseSize > 0 ? Math.max(0, last.close - recentLow) / impulseSize : 1;
            if (ratioToImpulse < 0.30 && barsAgainst <= 2 && adx >= 30 && emaDown && !isLongTail) {
                if (volAgainstDownTrend) {
                    behavior = 'POTENTIAL_REVERSAL'; direction = null; anomalyType = 'VOLUME_WARNING';
                    evidence = ['мікро-відкат на бичачому обсязі — можливий розворот', `обсяг ×${volRatio.toFixed(2)}`];
                } else {
                    behavior = 'MICRO_PULLBACK_UP'; direction = null; anomalyType = 'MICRO_PULLBACK';
                    evidence = ['1-2 свічки коррекції', `глибина ${(ratioToImpulse * 100).toFixed(0)}% імпульсу`, 'напрямок не визначено — тільки попередження'];
                }
            } else if (ratioToImpulse < 0.65 && pullbackDepth < 1.5 && isTrendDownConfirmed) {
                behavior = 'PULLBACK_UP'; direction = 'PUT'; anomalyType = 'NORMAL_PULLBACK';
                evidence = ['корекція всередині низхідної структури'];
            } else {
                behavior = 'DEEP_PULLBACK_UP'; direction = null; anomalyType = 'DEEP_PULLBACK';
                evidence = ['глибокий відкат', 'структура під загрозою'];
            }
        } else if (trend === 'UP' && bodyRatio > 0.65 && range > avgRange * 1.4) {
            behavior = 'EXPANSION_UP'; direction = 'CALL';
            evidence = ['розширення діапазону вверх у тренді'];
        } else if (trend === 'DOWN' && bodyRatio > 0.65 && range > avgRange * 1.4) {
            behavior = 'EXPANSION_DOWN'; direction = 'PUT';
            evidence = ['розширення діапазону вниз у тренді'];
        } else if (alternationRatio >= 0.55 && range < avgRange * 0.9) {
            behavior = 'ALTERNATING_NOISE'; direction = null;
            evidence = ['часте чергування свічок'];
        } else if (range < atr * 0.6) {
            behavior = 'STAGNATION'; direction = null;
            evidence = ['стиснення діапазону'];
        }
        let volumeEvent = 'NONE', volumeDirection = null;
        if (volRatio >= 1.6) {
            if (upperRatio >= 0.30 && !strongCloseHigh) {
                volumeEvent = 'BULL_TRAP'; volumeDirection = 'PUT';
            } else if (lowerRatio >= 0.30 && !strongCloseLow) {
                volumeEvent = 'BEAR_TRAP'; volumeDirection = 'CALL';
            } else if (last.close > last.open && strongCloseHigh) {
                volumeEvent = 'BULL_EXPANSION'; volumeDirection = 'CALL';
            } else if (last.close < last.open && strongCloseLow) {
                volumeEvent = 'BEAR_EXPANSION'; volumeDirection = 'PUT';
            }
        }
        if ((behavior === 'PULLBACK_DOWN' || behavior === 'MICRO_PULLBACK_DOWN' ||
            behavior === 'PULLBACK_UP' || behavior === 'MICRO_PULLBACK_UP') && volRatio < 1.2) {
            evidence.push('обсяг коррекції нижче середнього');
        }
        if (volumeEvent !== 'NONE') evidence.push(volumeEvent);
        const altScore = Math.min(1, alternationRatio);
        const STAGNATION_THRESHOLD = 0.6;
        return {
            behavior, direction, trendDirection: trend,
            pullbackDepth: Number(pullbackDepth.toFixed(2)),
            anomalyType, evidence,
            volumeEvent, volumeDirection, volumeRatio: Number(volRatio.toFixed(2)),
            atr, range, body, bodyRatio: Number(bodyRatio.toFixed(3)),
            impulseSize: Number(impulseSize.toFixed(5)),
            structure: { swingHigh: chochHigh, swingLow: chochLow },
            isImpulse: Boolean(impulseData?.isImpulse),
            isLongTail,
            isStagnation: range < atr * STAGNATION_THRESHOLD,
            alternationRatio: Number(alternationRatio.toFixed(2)),
            alternatingBalance: {
                active: altScore >= 0.45,
                score: Number(altScore.toFixed(2)),
                evidence: altScore >= 0.45 ? ['часте чергування свічок', `ratio=${alternationRatio.toFixed(2)}`] : []
            },
            evidenceAll: evidence
        };
    }

    static buildMarketEvents(behavior = {}, structure = {}, fakeouts = {}, impulseData = {}) {
        const events = [];
        const add = (type, side, strength, reason) => events.push({
            type, side: side || null, strength, reason
        });
        const b = String(behavior.behavior || '');
        if (b === 'MICRO_PULLBACK_DOWN') add('MICRO_PULLBACK_CONTINUATION', null, 2.6, 'Мікро-відкат у висхідному русі — напрямок не визначено');
        if (b === 'MICRO_PULLBACK_UP') add('MICRO_PULLBACK_CONTINUATION', null, 2.6, 'Мікро-відкат у низхідному русі — напрямок не визначено');
        if (b === 'PULLBACK_DOWN') add('NORMAL_PULLBACK', 'CALL', 1.8, 'Нормальний відкат без зламу структури');
        if (b === 'PULLBACK_UP') add('NORMAL_PULLBACK', 'PUT', 1.8, 'Нормальний відкат без зламу структури');
        if (b === 'DEEP_PULLBACK_DOWN') add('DEEP_PULLBACK', null, 2.2, 'Глибокий відкат: напрямок не підтверджений');
        if (b === 'DEEP_PULLBACK_UP') add('DEEP_PULLBACK', null, 2.2, 'Глибокий відкат: напрямок не підтверджений');
        if (b === 'BREAKOUT_UP') add('BREAKOUT', 'CALL', 3.4, 'Підтверджений пробій вгору');
        if (b === 'BREAKOUT_DOWN') add('BREAKOUT', 'PUT', 3.4, 'Підтверджений пробій вниз');
        if (b === 'FALSE_REVERSAL_UP') add('FALSE_REVERSAL', 'PUT', 3.0, 'Ложный разворот вверх отменён');
        if (b === 'FALSE_REVERSAL_DOWN') add('FALSE_REVERSAL', 'CALL', 3.0, 'Ложный разворот вниз отменён');
        if (b === 'REAL_REVERSAL_UP') add('REAL_REVERSAL', 'CALL', 3.8, 'Підтверджений структурний разворот вверх');
        if (b === 'REAL_REVERSAL_DOWN') add('REAL_REVERSAL', 'PUT', 3.8, 'Підтверджений структурний разворот вниз');
        if (behavior.volumeEvent === 'BULL_TRAP') add('FAKEOUT_SWEEP', 'PUT', 2.8, 'Обсяг + відмова від пробою вверх: BULL TRAP (sweep)');
        if (behavior.volumeEvent === 'BEAR_TRAP') add('FAKEOUT_SWEEP', 'CALL', 2.8, 'Обсяг + відмова від пробою вниз: BEAR TRAP (sweep)');
        if (behavior.volumeEvent === 'BULL_EXPANSION') add('VOLUME_EXPANSION', 'CALL', 2.2, 'Розширення вверх підтверджено обсягом');
        if (behavior.volumeEvent === 'BEAR_EXPANSION') add('VOLUME_EXPANSION', 'PUT', 2.2, 'Розширення вниз підтверджено обсягом');
        if (b === 'ALTERNATING_NOISE') add('ALTERNATION', null, 1.5, 'Чергування без стійкого руху');
        if (b === 'STAGNATION') add('STAGNATION', null, 1.5, 'Стиснення / стагнація');
        if (impulseData && impulseData.isImpulse) {
            const impulseDirRaw = impulseData.direction;
            const impulseSide = impulseDirRaw === 'UP' ? 'CALL' : impulseDirRaw === 'DOWN' ? 'PUT' : null;
            if (impulseSide) {
                add('IMPULSE', impulseSide, 2.0, `Імпульс ${impulseDirRaw} (candleAnatomy)`);
            }
        }
        if (structure && structure.bos === 'bullish') add('BOS', 'CALL', 2.5, 'Break of Structure вверх');
        if (structure && structure.bos === 'bearish') add('BOS', 'PUT', 2.5, 'Break of Structure вниз');
        if (structure && structure.choch === 'bullish') add('CHoCH', 'CALL', 3.0, 'Change of Character вверх');
        if (structure && structure.choch === 'bearish') add('CHoCH', 'PUT', 3.0, 'Change of Character вниз');
        if (fakeouts.fakeBreakoutSupport) add('FAKEOUT_SUPPORT', 'CALL', 3, 'Хибний пробій підтримки');
        if (fakeouts.fakeBreakoutResistance) add('FAKEOUT_RESISTANCE', 'PUT', 3, 'Хибний пробій опору');
        const FAMILY = {
            REAL_REVERSAL: 'REVERSAL', CHoCH: 'REVERSAL',
            FAKEOUT_SWEEP: 'SWEEP', FAKEOUT_SUPPORT: 'SWEEP', FAKEOUT_RESISTANCE: 'SWEEP',
            BREAKOUT: 'BREAK', BOS: 'BREAK'
        };
        const bestByFamily = new Map();
        const deduped = [];
        for (const e of events) {
            const fam = FAMILY[e.type];
            if (!fam || !e.side) { deduped.push(e); continue; }
            const key = fam + ':' + e.side;
            const prev = bestByFamily.get(key);
            if (!prev || e.strength > prev.strength) bestByFamily.set(key, e);
        }
        events.length = 0;
        events.push(...deduped, ...bestByFamily.values());
        const call = events.filter(e => e.side === 'CALL').reduce((s, e) => s + Number(e.strength || 0), 0);
        const put = events.filter(e => e.side === 'PUT').reduce((s, e) => s + Number(e.strength || 0), 0);
        return {
            events,
            direction: call > put + 0.75 ? 'CALL' : put > call + 0.75 ? 'PUT' : null,
            score: Number(Math.max(call, put).toFixed(2)),
            call: Number(call.toFixed(2)),
            put: Number(put.toFixed(2))
        };
    }
}
