/**
 * po-socket.js — WebSocket-клієнт Pocket Option (Socket.IO поверх Engine.IO v4).
 */
import WebSocket from 'ws';
import { normalizeCandles, parseCandle } from './candles.js';

const KNOWN_ASSETS = new Set([
    'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD',
    'AUDCAD', 'AUDCHF', 'AUDJPY', 'AUDNZD',
    'CADCHF', 'CADJPY', 'CHFJPY',
    'EURAUD', 'EURCAD', 'EURCHF', 'EURGBP', 'EURJPY', 'EURNZD',
    'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPJPY', 'GBPNZD',
    'NZDCAD', 'NZDCHF', 'NZDJPY',
    'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'USDCHF_otc', 'USDCAD_otc',
    'AUDUSD_otc', 'AUDNZD_otc', 'AUDCAD_otc', 'AUDCHF_otc', 'AUDJPY_otc',
    'CADCHF_otc', 'CADJPY_otc', 'CHFJPY_otc', 'EURCHF_otc', 'EURGBP_otc',
    'EURJPY_otc', 'EURNZD_otc', 'GBPAUD_otc', 'GBPJPY_otc', 'NZDJPY_otc',
    'NZDUSD_otc', 'EURAUD_otc', 'EURCAD_otc', 'GBPCAD_otc', 'GBPCHF_otc',
    'GBPNZD_otc', 'NZDCAD_otc', 'NZDCHF_otc',
    'XAUUSD', 'XAUUSD_otc', 'XAGUSD', 'XAGUSD_otc',
    'BTCUSD', 'ETHUSD',
    'SP500', 'SP500_otc', 'NASUSD', 'NASUSD_otc', 'DJI30', 'DJI30_otc',
    '#AAPL', '#AAPL_otc', '#MSFT', '#MSFT_otc', '#TSLA', '#TSLA_otc',
]);

export class POSocketClient {
    constructor(url, authString, cookies = '') {
        this.regions = [
            'wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket',
            'wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket',
            'wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket',
            'wss://api-sc.po.market/socket.io/?EIO=4&transport=websocket',
            'wss://api-fr.po.market/socket.io/?EIO=4&transport=websocket',
            'wss://api-fin.po.market/socket.io/?EIO=4&transport=websocket',
        ];
        this.url = url || this.regions[0];
        this.rawAuth = authString;
        this.cookies = cookies;
        this.ws = null;
        this.connected = false;
        this.authorized = false;
        this.connectingPromise = null;
        this.currentRegionIndex = 0;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.handshakeComplete = false;
        this.candlesMap = new Map();
        this.quality = {received: 0, accepted: 0, rejected: 0, rejectReasons: {}};
        this._clockSamples = [];   // разница «время тика брокера − локальное время», мс
        this.latestTick = null;    // последний реальный тик выбранного актива
        this.candlesList = [];
        this.maxCandles = 500;
        this.currentAsset = null;
        this.currentPeriod = null;
        this.subscribedAssets = new Set();
        this._bufferLockUntil = 0;  // захист від старих даних у польоті
        this._pendingBinaryEvent = null; // буфер для очікування сирих бінарних даних
        this.onConnectCallback = null;
        this.onAuthCallback = null;
        this.onCandlesCallback = null;
        this.onDisconnectCallback = null;
        this.onErrorCallback = null;
        this.onRawMessageCallback = null;
        this.pingInterval = null;
        this._authTimeout = null;
        this._resolveConnect = null;
        this._handshakeStep = 0;
    }

    /**
     ПРАВИЛЬНЕ форматування назви активу для PO
     OTC суфікс має бути в нижньому регістрі: EURUSD_otc (не EURUSD_OTC)
     */
    _formatAsset(pair) {
        if (!pair) return '';
        let clean = pair.replace('/', '').replace(' ', '').replace('-', '').trim();
        const otcMatch = clean.match(/^(.+?)(_?OTC|_?otc)$/i);
        if (otcMatch) {
            const base = otcMatch[1].toUpperCase();
            return base + '_otc'; // суфікс _otc в нижньому регістрі
        }
        return clean.toUpperCase();
    }

    _parseSubKey(key) {
        const idx = key.lastIndexOf('_');
        return {
            asset: key.slice(0, idx),
            period: parseInt(key.slice(idx + 1), 10)
        };
    }

    _parseAuthString() {
        if (!this.rawAuth) {
            throw new Error('❌ Рядок автентифікації PO не вказано');
        }
        return this.rawAuth.trim();
    }

    _getHeaders() {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': 'https://pocketoption.com',
        };
        if (this.cookies && this.cookies.trim().length > 0) {
            headers['Cookie'] = this.cookies;
        }
        return headers;
    }

    connect() {
        if (this.connectingPromise) {
            return this.connectingPromise;
        }
        if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }
        this.connectingPromise = new Promise((resolve, reject) => {
            this._tryConnect(resolve, reject);
        });
        return this.connectingPromise;
    }

    _tryConnect(resolve, reject) {
        try {
            const wsUrl = this.regions[this.currentRegionIndex] || this.url;
            console.log(`🌐 Спроба підключення до: ${wsUrl}`);
            this.ws = new WebSocket(wsUrl, {
                origin: 'https://pocketoption.com',
                headers: this._getHeaders(),
                handshakeTimeout: 15000,
                rejectUnauthorized: process.env.PO_TLS_REJECT_UNAUTHORIZED !== 'false',
            });
            this.ws.on('open', () => {
                this.connected = true;
                this.reconnectAttempts = 0;
                this._handshakeStep = 1;
                console.log('✅ WebSocket відкрито, очікуємо handshake...');
            });
            this.ws.on('message', (data) => {
                const raw = data.toString();
                if (this.onRawFrame) {
                    try { this.onRawFrame(raw); } catch (_) { /* диагностика не должна ломать сокет */ }
                }
                this._handleMessage(raw);
            });
            this.ws.on('close', (code, reason) => {
                const wasConnected = this.connected;
                this.connected = false;
                this.authorized = false;
                this.handshakeComplete = false;
                this._handshakeStep = 0;
                this.connectingPromise = null;
                this._stopPing();
                console.log(`🔌 З'єднання закрито: ${code} ${reason}`);
                if (wasConnected && this.reconnectAttempts < this.maxReconnectAttempts && code !== 1000) {
                    this.reconnectAttempts++;
                    console.log(`🔄 Перепідключення (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                    setTimeout(() => {
                        this.connect().catch(() => {
                        });
                    }, 5000);
                }
                if (this.onDisconnectCallback) this.onDisconnectCallback(code, reason);
            });
            this.ws.on('error', (err) => {
                console.error('❌ Помилка WebSocket:', err.message);
                if (err.message && err.message.includes('403')) {
                    console.warn('⚠️ Отримано 403, пробуємо інший регіон...');
                    this.currentRegionIndex++;
                    if (this.currentRegionIndex < this.regions.length) {
                        this.ws = null;
                        this.connectingPromise = null;
                        setTimeout(() => this._tryConnect(resolve, reject), 1000);
                        return;
                    }
                }
                this.connectingPromise = null;
                if (this.onErrorCallback) this.onErrorCallback(err);
                reject(err);
            });
            this._authTimeout = setTimeout(() => {
                if (!this.authorized) {
                    this.connectingPromise = null;
                    const timeoutErr = new Error('⏱️ Таймаут автентифікації PO (15 сек)');
                    if (this.onErrorCallback) this.onErrorCallback(timeoutErr);
                    reject(timeoutErr);
                }
            }, 15000);
            this._resolveConnect = resolve;
        } catch (err) {
            this.connectingPromise = null;
            reject(err);
        }
    }

    _send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
            return true;
        }
        return false;
    }

    _handleMessage(raw) {
        if (!raw || raw.length === 0) return;
        if (this.onRawMessageCallback) {
            this.onRawMessageCallback(raw);
        }
        const type = raw[0];
        const payload = raw.substring(1);
        if (type === '0') {
            try {
                const handshake = JSON.parse(payload);
                console.log('📡 Engine.IO handshake:', handshake.sid ? `sid=${handshake.sid}` : 'ok');
                if (this._handshakeStep === 1) {
                    this._handshakeStep = 2;
                    this._send('40');
                    console.log('📡 Надіслано Socket.IO connect (40)');
                }
            } catch (e) {
                console.log('📡 Engine.IO connect');
            }
            return;
        }
        if (type === '2') {
            this._send('3');
            return;
        }
        if (type === '3') return;
        if (type === '4' && payload.startsWith('0')) {
            if (this._handshakeStep === 2) {
                this._handshakeStep = 3;
                this._authenticate();
            }
            if (this.onConnectCallback) this.onConnectCallback();
            return;
        }
        if (type === '4' && payload.startsWith('1')) {
            console.log('🔌 Socket.IO disconnect');
            return;
        }
        if (type === '4' && payload.startsWith('2')) {
            const eventPayload = payload.substring(1);
            this._handleSocketEvent(eventPayload);
            return;
        }

        if (raw.startsWith('451-')) {
            const jsonStart = raw.indexOf('[');
            if (jsonStart !== -1) {
                const jsonPart = raw.substring(jsonStart);
                try {
                    const parsed = JSON.parse(jsonPart);
                    const eventName = parsed[0];
                    const eventData = parsed[1];

                    if (eventData && typeof eventData === 'object' && eventData._placeholder) {
                        this._pendingBinaryEvent = eventName;
                        return;
                    }

                    this._handleSocketEvent(jsonPart);
                } catch (e) {
                    this._handleSocketEvent(jsonPart);
                }
            }
            return;
        }

        if (this._pendingBinaryEvent) {
            const eventName = this._pendingBinaryEvent;
            this._pendingBinaryEvent = null;
            try {
                const parsedData = JSON.parse(raw);
                this._handleSocketEvent(JSON.stringify([eventName, parsedData]));
            } catch (e) {
            }
            return;
        }

        if (raw.startsWith('[')) {
            this._handleSocketEvent(raw);
            return;
        }
        if (raw.startsWith('{')) {
            try {
                const jsonData = JSON.parse(raw);
                if (jsonData.candles && Array.isArray(jsonData.candles)) {
                    console.log('📊 JSON candles отримано:', jsonData.candles.length);
                    this._processCandlesArray(jsonData.candles);
                }
                if (jsonData.history && Array.isArray(jsonData.history)) {
                    console.log('📊 JSON history отримано:', jsonData.history.length);
                    this._processCandlesArray(jsonData.history);
                }
            } catch (e) {
            }
            return;
        }
    }

    _authenticate() {
        try {
            const authMsg = this._parseAuthString();
            this._send(authMsg);
            console.log('🔑 Надіслано запит автентифікації');
        } catch (e) {
            console.error('❌ Помилка автентифікації:', e.message);
        }
    }

    _handleSocketEvent(payload) {
        try {
            const event = JSON.parse(payload);
            if (!Array.isArray(event) || event.length < 1) return;
            const eventName = event[0];
            const data = event[1] !== undefined ? event[1] : {};
            // Диагностика: видеть все входящие события (нужна для пробы формата истории).
            if (this.onAnyEvent) {
                try { this.onAnyEvent(eventName, data); } catch (_) { /* не мешаем диспетчеру */ }
            }
            switch (eventName) {
                case 'auth':
                    console.log('📥 Отримано auth');
                    break;
                case 'successauth':
                case 'authorized':
                    this.authorized = true;
                    this.handshakeComplete = true;
                    console.log('✅ Авторизація PO успішна');
                    this._startPing(); // keepalive після auth
                    if (this._authTimeout) {
                        clearTimeout(this._authTimeout);
                        this._authTimeout = null;
                    }
                    if (this._resolveConnect) {
                        this._resolveConnect();
                        this._resolveConnect = null;
                    }
                    if (this.onAuthCallback) this.onAuthCallback(data);
                    break;
                case 'NotAuthorized':
                    console.error('❌ Авторизація відхилена: NotAuthorized');
                    break;
                case 'user':
                    console.log('👤 Дані користувача отримано');
                    break;
                case 'stream_update': {
                    if (data && (data.candles || data.data)) {
                        const candlesData = data.candles || data.data;
                        if (Array.isArray(candlesData)) {
                            console.log(`📊 stream_update: ${candlesData.length} свічок`);
                            this._processCandlesArray(candlesData);
                        }
                    }
                    break;
                }
                case 'loadHistoryPeriod':
                case 'candles_received': {
                    let candles = data;
                    if (data && data.candles && Array.isArray(data.candles)) {
                        candles = data.candles;
                    }
                    if (Array.isArray(candles)) {
                        console.log(`📊 loadHistoryPeriod: ${candles.length} свічок`);
                        // Пакет истории отдаём загрузчику отдельно (до слияния с текущим буфером).
                        if (this.onHistoryBatch) {
                            this.onHistoryBatch(normalizeCandles(candles).candles);
                        }
                        this._processCandlesArray(candles);
                    }
                    break;
                }
                case 'loadHistoryPeriodFast': {
                    // Ответ на loadHistoryPeriod: свечи в поле data. Отдаём загрузчику истории.
                    this._emitHistory(data);
                    break;
                }
                case 'updateHistoryNew':
                case 'updateHistoryNewFast': {
                    this._handleHistoryPayload(data);
                    break;
                }
                case 'candles':
                case 'candle': {
                    if (Array.isArray(data)) {
                        this._emitHistory(data);
                        this._processCandlesArray(data);
                    } else {
                        this._updateCandle(data);
                    }
                    break;
                }
                case 'candles_update': {
                    this._updateCandle(data);
                    break;
                }
                case 'successupdateBalance':
                    console.log('💰 Баланс оновлено:', data);
                    break;
                case 'successopenOrder':
                    console.log('📈 Ордер відкрито:', data);
                    break;
                case 'successcloseOrder':
                    console.log('📉 Ордер закрито:', data);
                    break;
                case 'updateStream':
                    this._handleStream(data);
                    break;
                case 'disconnect':
                    console.log('🔌 Отримано disconnect');
                    break;
                case 'error':
                    console.error('❌ Помилка від сервера:', data);
                    break;
                default:
                    if (typeof eventName === 'string' && !eventName.startsWith('update')) {
                        console.log('📨 Подія:', eventName, JSON.stringify(data).slice(0, 200));
                    }
                    break;
            }
        } catch (e) {
        }
    }

    _startPing(intervalMs = 20000) {
        this._stopPing();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this._send('42["ps"]');
            }
        }, intervalMs);
    }

    _stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    _asTick(e) {
        if (!Array.isArray(e)) return null;
        let asset = null, ts, price;
        if (e.length === 2) { ts = e[0]; price = e[1]; }
        else if (e.length === 3 && typeof e[0] === 'string') { asset = e[0]; ts = e[1]; price = e[2]; }
        else return null;
        ts = typeof ts === 'string' ? Number(ts) : ts;
        price = typeof price === 'string' ? Number(price) : price;
        if (!Number.isFinite(ts) || !Number.isFinite(price) || ts <= 0 || price <= 0) return null;
        return {asset, ts: ts > 1e11 ? ts / 1000 : ts, price};
    }

    _compileTicks(ticks, period) {
        const by = new Map();
        for (const t of [...ticks].sort((x, y) => x.ts - y.ts)) {
            const k = Math.floor(t.ts / period) * period;
            const c = by.get(k);
            if (!c) by.set(k, {time: k, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0, volumeKnown: false});
            else { c.high = Math.max(c.high, t.price); c.low = Math.min(c.low, t.price); c.close = t.price; }
        }
        return [...by.values()];
    }

    /** Отдать пакет истории загрузчику через onHistoryBatch (до слияния с буфером). */
    _emitHistory(data) {
        if (!this.onHistoryBatch) return;
        let list = Array.isArray(data) ? data : null;
        if (!list && data && typeof data === 'object') {
            list = ['candles', 'history', 'data'].map(k => data[k]).find(Array.isArray) || null;
        }
        if (!list || !list.length) return;
        const cs = normalizeCandles(list).candles;
        if (cs.length) this.onHistoryBatch(cs);
    }

    _handleHistoryPayload(data) {
        this._emitHistory(data);
        if (Array.isArray(data)) { this._processCandlesArray(data); return; }
        if (!data || typeof data !== 'object') { this._updateCandle(data); return; }
        const period = Number(data.period) || this.currentPeriod || 60;
        const candleItems = [], ticks = [];
        let sawList = false;
        for (const key of ['candles', 'history', 'data']) {
            if (!Array.isArray(data[key])) continue;
            sawList = true;
            for (const e of data[key]) {
                if (Array.isArray(e) ? e.length >= 5 : (e && typeof e === 'object')) candleItems.push(e);
                else { const t = this._asTick(e); if (t) ticks.push(t); }
            }
        }
        if (!sawList) {
            const values = Object.values(data);
            if (values.length > 0) this._processCandlesArray(values); else this._updateCandle(data);
            return;
        }
        if (candleItems.length) this._processCandlesArray(candleItems);
        else if (ticks.length) {
            const orderedTicks = ticks.sort((x, y) => x.ts - y.ts);
            const latest = orderedTicks[orderedTicks.length - 1];
            if (latest) {
                this._noteClock(latest.ts);
                this.latestTick = {asset: this.currentAsset, ts: latest.ts, price: latest.price};
            }
            this._processCandlesArray(this._compileTicks(orderedTicks, period));
        }
        if (candleItems.length && ticks.length) {
            const asset = this.currentAsset;
            const lastT = this.candlesList.length ? this.candlesList[this.candlesList.length - 1].time : 0;
            let changed = false;
            for (const t of ticks.sort((x, y) => x.ts - y.ts)) {
                if (t.ts >= lastT) changed = this._applyTick(asset, t.ts, t.price) || changed;
            }
            if (changed && this.onCandlesCallback) this.onCandlesCallback(this.getCandles());
        }
    }

    _noteClock(tsSec) {
        const d = tsSec * 1000 - Date.now();
        if (!Number.isFinite(d) || Math.abs(d) > 600000) return;
        this._clockSamples.push(d);
        if (this._clockSamples.length > 25) this._clockSamples.shift();
    }

    getClockOffsetMs() {
        if (this._clockSamples.length < 3) return 0;
        const a = [...this._clockSamples].sort((x, y) => x - y);
        return Math.round(a[Math.floor((a.length - 1) * 0.75)]);
    }

    brokerNowMs() { return Date.now() + this.getClockOffsetMs(); }

    _handleStream(data) {
        if (!Array.isArray(data) || data.length === 0) return;
        const list = Array.isArray(data[0]) ? data : [data];
        let changed = false;
        let noted = false;
        for (const e of list) {
            const t = this._asTick(e);
            if (!t) continue;
            if (!noted) { this._noteClock(t.ts); noted = true; }
            if (!t.asset || this._formatAsset(t.asset) === this.currentAsset) {
                changed = this._applyTick(t.asset || this.currentAsset, t.ts, t.price) || changed;
            }
        }
        if (changed && this.onCandlesCallback) this.onCandlesCallback(this.getCandles());
    }

    _applyTick(asset, ts, price) {
        if (!this.currentAsset || !this.currentPeriod) return false;
        if (asset && this._formatAsset(asset) !== this.currentAsset) return false;
        if (Date.now() < this._bufferLockUntil) return false;
        if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) return false;
        const period = this.currentPeriod;
        const bucket = Math.floor(ts / period) * period;
        const last = this.candlesList.length ? this.candlesList[this.candlesList.length - 1] : null;
        if (last && bucket < last.time) return false;           // опоздавший тик
        this.latestTick = {asset: this.currentAsset, ts, price};
        const existing = this.candlesMap.get(String(bucket));
        if (existing) {
            this._addOrUpdateCandle({
                time: bucket, open: existing.open, volume: existing.volume, volumeKnown: existing.volumeKnown,
                high: Math.max(existing.high, price), low: Math.min(existing.low, price), close: price,
            });
        } else {
            const open = last ? last.close : price;
            this._addOrUpdateCandle({
                time: bucket, open, high: Math.max(open, price), low: Math.min(open, price), close: price,
                volume: 0, volumeKnown: false,
            });
        }
        return true;
    }

    _recordQuality(q) {
        this.quality.received += q.received;
        this.quality.accepted += q.accepted;
        this.quality.rejected += q.rejected;
        for (const [reason, n] of Object.entries(q.rejectReasons)) {
            this.quality.rejectReasons[reason] = (this.quality.rejectReasons[reason] || 0) + n;
        }
    }

    _processCandlesArray(data) {
        if (!data || !Array.isArray(data)) {
            console.warn('⚠️ _processCandlesArray: дані не є масивом', typeof data);
            return;
        }
        const {candles, quality} = normalizeCandles(data);
        this._recordQuality(quality);
        for (const c of candles) this._addOrUpdateCandle(c);

        if (quality.rejected) {
            console.warn(`⚠️ Відхилено свічок: ${quality.rejected}/${quality.received}`, quality.rejectReasons);
        }
        console.log(`📊 Оброблено ${candles.length}/${data.length} свічок. Всього: ${this.candlesList.length}`);
        if (this.onCandlesCallback) {
            this.onCandlesCallback(this.getCandles());
        }
    }

    _updateCandle(data) {
        if (!data || typeof data !== 'object') {
            console.warn('⚠️ _updateCandle: некоректні дані', data);
            return;
        }
        const r = parseCandle(data);
        this._recordQuality({
            received: 1, accepted: r.ok ? 1 : 0, rejected: r.ok ? 0 : 1,
            rejectReasons: r.ok ? {} : {[r.reason]: 1},
        });
        if (!r.ok) {
            console.warn(`⚠️ _updateCandle: свічку відхилено (${r.reason})`);
            return;
        }
        this._addOrUpdateCandle(r.candle);
        if (this.onCandlesCallback) {
            this.onCandlesCallback(this.getCandles());
        }
    }

    _addOrUpdateCandle(candle) {
        if (Date.now() < this._bufferLockUntil) return;

        const key = String(candle.time);
        const normalized = {
            time: candle.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            volumeKnown: candle.volumeKnown !== false,
        };
        normalized.color = normalized.close >= normalized.open ? 'green' : 'red';
        const existed = this.candlesMap.has(key);
        this.candlesMap.set(key, normalized);
        if (existed) {
            const idx = this.candlesList.findIndex(c => c.time === normalized.time);
            if (idx >= 0) this.candlesList[idx] = normalized;
            else this.candlesList.push(normalized);
        } else {
            this.candlesList.push(normalized);
        }
        if (this.candlesList.length > this.maxCandles) {
            const oldest = this.candlesList.shift();
            if (oldest) this.candlesMap.delete(String(oldest.time));
        }
        this.candlesList.sort((a, b) => a.time - b.time);
    }

    unsubscribeCandles(pair, timeframeSec) {
        if (!this.connected || !this.authorized) return false;
        const asset = this._formatAsset(pair);
        const period = timeframeSec ? Number(timeframeSec) : this.currentPeriod;
        if (!asset || !period) return false;
        const payload = ['unsubscribeCandles', {asset, period}];
        this._send('42' + JSON.stringify(payload));
        this.subscribedAssets.delete(`${asset}_${period}`);
        console.log(`🔕 Відписка від ${asset} (${period}с)`);
        return true;
    }

    requestCandles(pair, timeframeSec, count = 200) {
        if (!this.connected || !this.authorized) {
            console.warn("⚠️ Неможливо запросити свічки: немає з'єднання або авторизації");
            return false;
        }
        const asset = this._formatAsset(pair);
        const period = Number(timeframeSec);
        if (!KNOWN_ASSETS.has(asset)) {
            console.log(`ℹ️ Актив "${asset}" — нестандартна назва, але буде використано`);
        }
        for (const key of [...this.subscribedAssets]) {
            const {asset: oldAsset, period: oldPeriod} = this._parseSubKey(key);
            const p = ['unsubscribeCandles', {asset: oldAsset, period: oldPeriod}];
            this._send('42' + JSON.stringify(p));
            this.subscribedAssets.delete(key);
        }
        if (this.currentAsset) {
            this.unsubscribeCandles(this.currentAsset, this.currentPeriod);
        }
        this.currentAsset = asset;
        this.currentPeriod = period;
        console.log(`📊 changeSymbol: ${asset}, ТФ=${period}с`);
        const payload = ['changeSymbol', {asset, period}];
        this._send('42' + JSON.stringify(payload));
        const historyPayload = ['loadHistory', {asset, period, count}];
        this._send('42' + JSON.stringify(historyPayload));
        console.log(`📊 loadHistory: ${asset}, count=${count}`);
        this.subscribeCandles(pair, period);
        return true;
    }

    subscribeCandles(pair, timeframeSec) {
        if (!this.connected || !this.authorized) {
            console.warn("⚠️ Неможливо підписатися: немає з'єднання");
            return false;
        }
        const asset = this._formatAsset(pair);
        const period = Number(timeframeSec);
        for (const key of [...this.subscribedAssets]) {
            const {asset: oldAsset, period: oldPeriod} = this._parseSubKey(key);
            if (oldAsset !== asset || oldPeriod !== period) {
                const p = ['unsubscribeCandles', {asset: oldAsset, period: oldPeriod}];
                this._send('42' + JSON.stringify(p));
                this.subscribedAssets.delete(key);
            }
        }
        this.subscribedAssets.add(`${asset}_${period}`);
        const payload = ['subscribeCandles', {asset, period}];
        this._send('42' + JSON.stringify(payload));
        console.log(`🔔 Підписка на ${asset} (${period}с)`);
        return true;
    }

    getCandles() {
        return [...this.candlesList];
    }

    /** Публичное имя актива для пары (как его понимает брокер). */
    assetOf(pair) {
        return this._formatAsset(pair);
    }

    /** Отправить произвольное событие брокеру (нужно загрузчику истории). */
    sendEvent(event, payload) {
        if (!this.connected || !this.authorized) return false;
        return this._send('42' + JSON.stringify([event, payload]));
    }

    getCurrentPrice(maxAgeMs = 15000) {
        const tick = this.latestTick;
        const now = this.brokerNowMs();
        if (tick && tick.asset === this.currentAsset &&
            now - tick.ts * 1000 >= -2000 && now - tick.ts * 1000 <= maxAgeMs) {
            return tick.price;
        }
        const last = this.candlesList[this.candlesList.length - 1];
        return last ? last.close : null;
    }

    getCurrentTick() {
        const tick = this.latestTick;
        if (!tick || tick.asset !== this.currentAsset) return null;
        return {...tick};
    }

    clearCandles() {
        this.latestTick = null;
        this.candlesMap.clear();
        this.candlesList = [];
        this._bufferLockUntil = Date.now() + 300; // ігноруємо дані в польоті 300мс
        console.log('🧹 Свічки очищено, буфер заблоковано на 300мс');
    }

    disconnect() {
        this._stopPing();
        if (this._authTimeout) {
            clearTimeout(this._authTimeout);
            this._authTimeout = null;
        }
        if (this.ws) {
            try {
                this.ws.close(1000, 'Client disconnect');
            } catch (e) {
            }
            this.ws = null;
        }
        this.connected = false;
        this.authorized = false;
        this.handshakeComplete = false;
        this._handshakeStep = 0;
        this.connectingPromise = null;
        this.currentRegionIndex = 0;
        this.currentAsset = null;
        this.currentPeriod = null;
        this.subscribedAssets.clear();
        this.clearCandles();
        console.log("🔌 З'єднання PO розірвано");
    }

    getStatus() {
        return {
            connected: this.connected,
            authorized: this.authorized,
            handshakeComplete: this.handshakeComplete,
            candlesCount: this.candlesList.length,
            url: this.url,
            region: this.regions[this.currentRegionIndex],
            currentAsset: this.currentAsset,
            clockOffsetMs: this.getClockOffsetMs()
        };
    }
}
