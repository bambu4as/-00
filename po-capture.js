/** po-capture.js — маскирование сырых сообщений брокера перед записью в файл. */
export function maskRaw(raw) {
    return String(raw)
        .replace(/("session"\s*:\s*")[^"]*"/g, '$1***"')
        .replace(/("ssid"\s*:\s*")[^"]*"/gi, '$1***"')
        .slice(0, 4000);
}
