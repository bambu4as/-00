import { Backtester } from './Backtester.js';
import { CALIBRATION_CONFIG } from './CalibrationConfig.js';

export class Optimizer {
    constructor(options = {}) {
        this.options = {
            method: options.method || 'random', // 'random' | 'bayesian' | 'genetic'
            maxIterations: options.maxIterations || 300,
            populationSize: options.populationSize || 30,
            mutationRate: options.mutationRate || 0.2,
            backtesterOptions: options.backtesterOptions || {},
            ...options
        };
        this.history = [];
    }

    optimize(candles, meta = {}) {
        const config = CALIBRATION_CONFIG.conflictWeights;
        const startTime = Date.now();

        console.log(`\n🚀 Запуск оптимизации (${this.options.method})...`);
        console.log(`   Параметров: ${Object.keys(config).length}`);
        console.log(`   Свечей: ${candles.length}`);

        let best = { score: -Infinity };

        switch (this.options.method) {
            case 'random':
                best = this._randomSearch(candles, meta, config);
                break;
            case 'bayesian':
                best = this._bayesianSearch(candles, meta, config);
                break;
            case 'genetic':
                best = this._geneticSearch(candles, meta, config);
                break;
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ Готово за ${elapsed}с`);
        console.log(`   Итераций: ${this.history.length}`);
        console.log(`   Лучший score: ${best.score.toFixed(4)}`);
        console.log(`   Winrate: ${(best.metrics.winrate * 100).toFixed(1)}%`);
        console.log(`   Сделок: ${best.metrics.totalTrades}`);

        return {
            bestParams: best.params,
            bestScore: best.score,
            bestMetrics: best.metrics,
            iterations: this.history.length,
            elapsedSec: Number(elapsed)
        };
    }

    _randomPoint(config) {
        const point = {};
        for (const [key, p] of Object.entries(config)) {
            const steps = Math.round((p.max - p.min) / p.step);
            const step = Math.floor(Math.random() * (steps + 1));
            point[key] = Number((p.min + step * p.step).toFixed(4));
        }
        return point;
    }

    _evaluate(candles, meta, weights) {
        const backtester = new Backtester({
            ...this.options.backtesterOptions,
            objective: CALIBRATION_CONFIG.objective
        });
        const metrics = backtester.run(candles, weights, meta);
        const record = { params: weights, metrics, score: metrics.score };
        this.history.push(record);
        return record;
    }

    _randomSearch(candles, meta, config) {
        let best = { score: -Infinity };
        for (let i = 0; i < this.options.maxIterations; i++) {
            const point = this._randomPoint(config);
            const result = this._evaluate(candles, meta, point);
            if (result.score > best.score) best = result;
            if ((i + 1) % 50 === 0) {
                console.log(`   [${i + 1}/${this.options.maxIterations}] лучший: ${best.score.toFixed(4)}`);
            }
        }
        return best;
    }

    _bayesianSearch(candles, meta, config) {
        const initial = Math.min(50, Math.floor(this.options.maxIterations * 0.25));
        for (let i = 0; i < initial; i++) {
            this._evaluate(candles, meta, this._randomPoint(config));
        }
        let best = this._getBest();
        const topK = Math.max(5, Math.floor(initial * 0.2));

        for (let i = initial; i < this.options.maxIterations; i++) {
            const topPoints = this.history
                .slice().sort((a, b) => b.score - a.score).slice(0, topK);
            const base = topPoints[Math.floor(Math.random() * topPoints.length)].params;
            const mutated = this._mutate(base, config, 0.3);
            const result = this._evaluate(candles, meta, mutated);
            if (result.score > best.score) best = result;
            if ((i + 1) % 50 === 0) {
                console.log(`   [${i + 1}] лучший: ${best.score.toFixed(4)}`);
            }
        }
        return best;
    }

    _geneticSearch(candles, meta, config) {
        const popSize = this.options.populationSize;
        const generations = Math.floor(this.options.maxIterations / popSize);
        let population = [];

        for (let i = 0; i < popSize; i++) {
            const point = this._randomPoint(config);
            population.push(this._evaluate(candles, meta, point));
        }
        let best = this._getBest();

        for (let gen = 0; gen < generations; gen++) {
            population.sort((a, b) => b.score - a.score);
            const eliteSize = Math.max(2, Math.floor(popSize * 0.2));
            const elite = population.slice(0, eliteSize);
            const nextGen = [...elite];

            while (nextGen.length < popSize) {
                const p1 = elite[Math.floor(Math.random() * elite.length)];
                const p2 = elite[Math.floor(Math.random() * elite.length)];
                const child = this._crossover(p1.params, p2.params);
                const mutated = this._mutate(child, config, this.options.mutationRate);
                nextGen.push(this._evaluate(candles, meta, mutated));
            }
            population = nextGen;
            const currentBest = this._getBest();
            if (currentBest.score > best.score) best = currentBest;
            if ((gen + 1) % 5 === 0) {
                console.log(`   Поколение ${gen + 1}/${generations}, лучший: ${best.score.toFixed(4)}`);
            }
        }
        return best;
    }

    _getBest() {
        return this.history.reduce((b, r) => r.score > b.score ? r : b, this.history[0]);
    }

    _crossover(p1, p2) {
        const child = {};
        for (const key of Object.keys(p1)) {
            child[key] = Math.random() < 0.5 ? p1[key] : p2[key];
        }
        return child;
    }

    _mutate(params, config, rate) {
        const mutated = { ...params };
        for (const key of Object.keys(mutated)) {
            if (Math.random() < rate && config[key]) {
                const p = config[key];
                const delta = (Math.random() - 0.5) * 2 * p.step;
                let newVal = mutated[key] + delta;
                newVal = Math.max(p.min, Math.min(p.max, newVal));
                newVal = p.min + Math.round((newVal - p.min) / p.step) * p.step;
                mutated[key] = Number(newVal.toFixed(4));
            }
        }
        return mutated;
    }
}