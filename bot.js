import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error('[Bot Error] TELEGRAM_BOT_TOKEN не вказано в .env файлі!');
    process.exit(1);
}

const API_URL = `http://localhost:${process.env.PORT || 3000}`;
const SIGNAL_BUTTON = '📊 Отримати сигнал';
const PAIR = 'EUR/USD OTC';
const TIMEFRAME = 60; // секунды: 5, 15, 30, 60, 180, 300

const bot = new TelegramBot(token, { polling: true });

console.log('[Bot] Telegram бот успішно запущений...');

const escapeMd = (text) => String(text).replace(/([_*`\[])/g, '\\$1');

const DIRECTION_LABEL = {
    CALL: '🟢 КУПУВАТИ (CALL)',
    PUT: '🔴 ПРОДАВАТИ (PUT)'
};

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Ласкаво просимо! Натисніть кнопку нижче, щоб отримати торговий сигнал:', {
        reply_markup: {
            keyboard: [[{ text: SIGNAL_BUTTON }]],
            resize_keyboard: true
        }
    });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (msg.text !== SIGNAL_BUTTON) return;

    try {
        bot.sendMessage(chatId, '⏳ Запитую аналіз ринку...');

        const response = await fetch(`${API_URL}/api/signal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pair: PAIR, timeframe: TIMEFRAME })
        });
        const signal = await response.json();

        if (!response.ok) {
            return bot.sendMessage(chatId, `❌ Помилка: ${signal.error || 'Не вдалося отримати сигнал'}`);
        }

        const stats = await (await fetch(`${API_URL}/api/stats`)).json();
        const reason = signal.factors && signal.factors[0] ? escapeMd(signal.factors[0]) : 'За сукупністю індикаторів';

        const message = `
🎯 *ТОРГОВИЙ СИГНАЛ*

📌 *Пара:* ${escapeMd(PAIR)}
⏳ *Таймфрейм:* ${TIMEFRAME % 60 === 0 ? TIMEFRAME / 60 + ' хв' : TIMEFRAME + ' с'} (експірація: ${escapeMd(signal.expiry)})
📈 *Напрямок:* ${DIRECTION_LABEL[signal.direction] || '⚪ НЕЙТРАЛЬНО'}
💪 *Сила сигналу:* ${signal.accuracy}% (${escapeMd(signal.strength)})
📝 *Причина:* ${reason}
${signal.warning ? `\n${escapeMd(signal.warning)}\n` : ''}
📊 *Статистика робота:*
• Винрейт: ${stats.winRate}%
• Успішних: ${stats.wins}/${stats.total}
`;

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('[Bot Error]:', error.message);
        bot.sendMessage(chatId, '❌ Помилка підключення до сервера аналітики.');
    }
});
