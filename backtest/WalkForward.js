import { Optimizer } from './Optimizer.js';
import { Backtester } from './Backtester.js';

export class WalkForward {
    constructor(options = {}) {
        this.options = {
            nFolds: options.nFolds || 5,
            minCandlesPerFold: options.minCandlesPerFold || 500,
            ...options
        };
    }

    validate(candles, meta = {}, optimizerOptions = {}) {
        const n = this.options.nFolds;
        const foldSize = Math.floor(candles.length / (n + 1));

        if (foldSize < this.options.minCandlesPerFold) {
            throw new Error(`Нужно минимум ${n * this.options.minCandlesPerFold} свечей`);
        }

        console.log(`\n🔀 Walk-Forward: ${n} фолдов, размер ~${foldSize} свечей\n`);

        const foldResults = [];
        const allParams = [];

        for (let fold = 0; fold < n; fold++) {
            console.log(`\n=== Фолд ${fold + 1}/${n} ===`);
            const trainEnd = foldSize * (fold + 1);
            const testStart = trainEnd;
            const testEnd = Math.min(trainEnd + foldSize, candles.length);

            const trainCandles = candles.slice(0, trainEnd);
            const testCandles = candles.slice(testStart, testEnd);

            // Оптимизация на train
            const optimizer = new Optimizer({
                ...optimizerOptions,
                maxIterations: optimizerOptions.maxIterations || 150
            });
            const optResult = optimizer.optimize(trainCandles, meta);
            allParams.push(optResult.bestParams);

            // Тест на out-of-sample
            const backtester = new Backtester(optimizerOptions.backtesterOptions || {});
            const testMetrics = backtester.run(testCandles, optResult.bestParams, meta);

            console.log(`   Train score: ${optResult.bestScore.toFixed(4)}`);
            console.log(`   Test score:  ${testMetrics.score.toFixed(4)}`);
            console.log(`   Test winrate: ${(testMetrics.winrate * 100).toFixed(1)}%`);

            foldResults.push({
                fold: fold + 1,
                trainScore: optResult.bestScore,
                testScore: testMetrics.score,
                degradation: optResult.bestScore - testMetrics.score,
                testWinrate: testMetrics.winrate,
                params: optResult.bestParams
            });
        }

        return this._analyzeStability(foldResults, allParams);
    }

    _analyzeStability(foldResults, allParams) {
        const testScores = foldResults.map(r => r.testScore);
        const degradations = foldResults.map(r => r.degradation);
        const avgTestScore = testScores.reduce((a, b) => a + b, 0) / testScores.length;
        const avgDegradation = degradations.reduce((a, b) => a + b, 0) / degradations.length;

        let verdict = 'STABLE';
        if (avgDegradation > 0.15) verdict = 'OVERFIT';
        if (testScores.filter(s => s < 0.35).length > foldResults.length * 0.3) verdict = 'WEAK';

        console.log(`\n${'='.repeat(50)}`);
        console.log(`📊 ИТОГ: ${verdict}`);
        console.log(`   Средний test score: ${avgTestScore.toFixed(4)}`);
        console.log(`   Средняя деградация: ${avgDegradation.toFixed(4)}`);
        console.log(`${'='.repeat(50)}\n`);

        return {
            verdict,
            avgTestScore,
            avgDegradation,
            foldResults,
            recommendedParams: verdict === 'STABLE' ? this._medianParams(allParams) : null
        };
    }

    _medianParams(allParams) {
        const keys = Object.keys(allParams[0]);
        const median = {};
        for (const key of keys) {
            const values = allParams.map(p => p[key]).sort((a, b) => a - b);
            median[key] = values[Math.floor(values.length / 2)];
        }
        return median;
    }
}