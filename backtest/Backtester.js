import { Analyzer } from '../analyzer.js';
import { SignalGenerator } from '../signals.js';
import { CALIBRATION_CONFIG } from './CalibrationConfig.js'; // <--- ДОБАВЛЕНО

export class Backtester {
    constructor(options = {}) {
        this.options = {
            positionSize: options.positionSize ?? 1.0,
            winPayout: options.winPayout ?? 0.85,      // 85% с учётом комиссии брокера
            lossPayout: options.lossPayout ?? 1.0,
            minConfidence: options.minConfidence ?? 65,
            minStrength: options.minStrength ?? 'СЕРЕДНІЙ',
            ...options
        };
    }

    /**
     * Прогон истории с заданными весами
     */
    run(candles, calibratedWeights = {}, meta = {}) {
        if (!candles || candles.length < 60) {
            return { error: 'Недостатньо свічок', trades: [], score: 0 };
        }

        const analyzer = new Analyzer();
        const generator = new SignalGenerator();
        const trades = [];
        const equityCurve = [1000];
        let equity = 1000;
        const tf = meta.timeframe || 1;
        const windowSize = 100;

        // Патчим _resolveConflict с новыми весами
        if (Object.keys(calibratedWeights).length > 0) {
            this._patchWeights(generator, calibratedWeights);
        }

        for (let i = windowSize; i < candles.length - 1; i++) {
            const window = candles.slice(i - windowSize, i + 1);
            const currentCandle = candles[i];
            const nextCandle = candles[i + 1];

            try {
                const analysis = Analyzer.analyze(
                    window,
                    meta.symbol || 'AUDNZD_otc',
                    true, // isOTC
                    tf,
                    meta.pair || 'AUDNZD_otc'
                );

                const signal = generator.generate(
                    analysis,
                    { timeframe: tf, pair: meta.pair },
                    {}, {}, window, true
                );

                if (!this._shouldEnter(signal)) continue;

                const result = this._simulateTrade(signal, currentCandle, nextCandle);
                if (result) {
                    equity *= (1 + result.pnl * this.options.positionSize / 100);
                    equityCurve.push(equity);
                    trades.push({
                        index: i,
                        time: currentCandle.time,
                        direction: signal.direction,
                        confidence: signal.accuracy,
                        strength: signal.strength,
                        entryPrice: currentCandle.close,
                        exitPrice: nextCandle.close,
                        win: result.win,
                        pnl: result.pnl,
                        equity,
                        regime: signal.regime
                    });
                }
            } catch (err) {
                continue;
            }
        }

        return this._computeMetrics(trades, equityCurve);
    }

    _patchWeights(generator, weights) {
        generator._resolveConflict = function(conflict, rawCall, rawPut, anomalyContext, events) {
            const groups = Array.isArray(conflict.groups) ? conflict.groups : [];
            const weight = { ...weights };
            const sideScore = { CALL: 0, PUT: 0 };
            for (const g of groups) {
                if (!g || !Object.prototype.hasOwnProperty.call(sideScore, g.side)) continue;
                sideScore[g.side] += (Number(g.strength) || 0) * (weight[g.name] || 1);
            }
            const total = rawCall + rawPut;
            let direction = total === 0 ? 'NO TRADE' : (rawCall > rawPut ? 'CALL' : 'PUT');
            return {
                call: rawCall || 0, put: rawPut || 0, direction,
                wait: false, waitReason: '', weakConsensus: false,
                method: 'CALIBRATED',
                weightedCall: Number(sideScore.CALL.toFixed(2)),
                weightedPut: Number(sideScore.PUT.toFixed(2)),
                strongEvents: []
            };
        };
    }

    _shouldEnter(signal) {
        if (!signal || signal.direction === 'NO TRADE') return false;
        if (signal.accuracy < this.options.minConfidence) return false;
        if (signal.strength === 'СЛАБКИЙ') return false;
        return true;
    }

    _simulateTrade(signal, entryCandle, exitCandle) {
        const entry = entryCandle.close;
        const exit = exitCandle.close;
        if (entry === 0) return null;

        const direction = signal.direction;
        const priceChange = (exit - entry) / entry;
        // Для форекса: 1 pip = 0.0001 для AUDNZD
        const pips = Math.abs(priceChange) * 10000;
        const isWin = (direction === 'CALL' && priceChange > 0) ||
                      (direction === 'PUT' && priceChange < 0);

        // Фиксированная выплата в пипсах (бинарный вариант)
        const pnl = isWin
            ? this.options.winPayout * pips * 0.1   // ~8.5% от движения
            : -this.options.lossPayout * pips * 0.1;

        return { win: isWin, pnl };
    }

    _computeMetrics(trades, equityCurve) {
        if (trades.length === 0) {
            return {
                totalTrades: 0, winrate: 0, profitFactor: 0,
                totalPnl: 0, maxDrawdown: 0, sharpe: 0, score: 0, trades: []
            };
        }

        const wins = trades.filter(t => t.win);
        const losses = trades.filter(t => !t.win);
        const winrate = wins.length / trades.length;

        const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;

        const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

        // Max drawdown
        let peak = equityCurve[0];
        let maxDrawdown = 0;
        for (const eq of equityCurve) {
            if (eq > peak) peak = eq;
            const dd = (peak - eq) / peak;
            if (dd > maxDrawdown) maxDrawdown = dd;
        }

        // Sharpe
        const returns = trades.map(t => t.pnl);
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
        const std = Math.sqrt(variance);
        const sharpe = std > 0 ? mean / std : 0;

        // Score
        const obj = this.options.objective || CALIBRATION_CONFIG.objective;
        let score =
            winrate * obj.winrateWeight +
            Math.min(profitFactor, 5) / 5 * obj.profitFactorWeight +
            Math.min(trades.length / 300, 1) * obj.tradeCountWeight;

        if (trades.length < obj.minTrades) score *= obj.lowTradePenalty;
        if (maxDrawdown > 0.3) score *= 0.7;

        return {
            totalTrades: trades.length,
            wins: wins.length,
            losses: losses.length,
            winrate: Number(winrate.toFixed(4)),
            profitFactor: Number(profitFactor.toFixed(2)),
            totalPnl: Number(totalPnl.toFixed(2)),
            maxDrawdown: Number(maxDrawdown.toFixed(4)),
            sharpe: Number(sharpe.toFixed(3)),
            grossProfit: Number(grossProfit.toFixed(2)),
            grossLoss: Number(grossLoss.toFixed(2)),
            score: Number(score.toFixed(4)),
            equityCurve,
            trades
        };
    }
}