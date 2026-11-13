// Конфигурация калибруемых параметров
export const CALIBRATION_CONFIG = {
    // === L1: Веса конфликтов (критичные) ===
    conflictWeights: {
        STRUCTURE_EVENT: { min: 1.5, max: 3.5, step: 0.2, default: 2.2 },
        ANOMALY:         { min: 1.0, max: 3.0, step: 0.2, default: 1.8 },
        PRICE_EVENT:     { min: 1.0, max: 3.0, step: 0.2, default: 1.7 },
        DIVERGENCE:      { min: 0.8, max: 2.5, step: 0.15, default: 1.45 },
        TREND:           { min: 0.6, max: 2.0, step: 0.15, default: 1.2 },
        VWAP:            { min: 0.5, max: 2.0, step: 0.15, default: 1.1 },
        MOMENTUM:        { min: 0.3, max: 1.5, step: 0.1, default: 0.65 },
        MACD:            { min: 0.2, max: 1.2, step: 0.1, default: 0.55 }
    },

    // Целевая функция
    objective: {
        winrateWeight: 0.60,
        profitFactorWeight: 0.25,
        tradeCountWeight: 0.15,
        minTrades: 50,
        lowTradePenalty: 0.5
    }
};