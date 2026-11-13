#!/usr/bin/env python3
"""
Сервис торгового решения на локальной LLM.

Модель: Qwen2.5-3B-Instruct, GGUF Q4_K_M, загружается через GPT4All (CPU).
Протокол:
  GET  /health   -> {"ok": true, "model": "...", "loaded": bool}
  POST /decide   <- {"pair", "tf", "returns_bp": [int], "indicators": {name: number}}
                 -> {"ok": true, "action": "CALL|PUT|NONE", "confidence": 0..1, "reason": "...", "latency_ms": int}
                    или {"ok": false, "error": "...", "action": "NONE", "latency_ms": int}

Сервис не принимает решений о риске и не отправляет ордера.
Он возвращает только рекомендацию, а решение о сделке принимает Node-часть.

Запуск:
  LLM_SEGMENT=currency LLM_PORT=8787 LLM_MODEL_DIR=/path/to/models \
    LLM_MODEL_FILE=currency-qwen2.5-3b-q4_k_m.gguf python3 llm_server.py

LLM_SEGMENT задаёт сегмент, на который обучена модель (currency или otc).
Запрос другого сегмента отклоняется (409 segment_mismatch), чтобы модель не работала не на своих данных.
"""
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALLOWED_ACTIONS = ("CALL", "PUT", "NONE")

SYSTEM_PROMPT = (
    "You are a strict short-term price-direction analyst for binary options. "
    "CALL means the price of the next candle close will be HIGHER than the current price. "
    "PUT means LOWER. Choose NONE whenever evidence is weak, mixed or missing. "
    "Never invent data. Answer with a single JSON object and nothing else: "
    '{"action":"CALL" or "PUT" or "NONE","confidence":number between 0 and 1,"reason":"at most 15 words"}'
)

# Лимиты, чтобы промпт оставался коротким: на CPU время обработки промпта растёт почти линейно.
MAX_RETURNS = 20
MAX_INDICATORS = 15


def _num(x, nd=2):
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    if x != x or x in (float("inf"), float("-inf")):
        return None
    return round(float(x), nd)


def period_label(period_sec):
    """Подпись периода для промпта: 60 -> '1 min', 5 -> '5 s', 300 -> '5 min'."""
    s = int(period_sec)
    return f"{s // 60} min" if s % 60 == 0 else f"{s} s"


def build_user_prompt(req):
    """Собирает компактное описание рынка для модели."""
    pair = str(req.get("pair", "unknown"))[:40]
    label = period_label(req.get("tf", 60))

    returns = [int(r) for r in (req.get("returns_bp") or []) if isinstance(r, (int, float))]
    returns = returns[-MAX_RETURNS:]

    ind = req.get("indicators") or {}
    parts = []
    for name, value in list(ind.items())[:MAX_INDICATORS]:
        v = _num(value)
        if v is not None:
            parts.append(f"{name}={v}")

    lines = [
        f"Pair: {pair}. Timeframe: {label}. Expiry: {label}.",
        "Last closed candle returns in basis points, oldest to newest: "
        + (", ".join(str(r) for r in returns) if returns else "none"),
        "Indicators (last closed candle): " + (", ".join(parts) if parts else "none"),
        "Predict the direction of the next candle close relative to the current price.",
        'Reply with JSON only: {"action":"CALL|PUT|NONE","confidence":0-1,"reason":"..."}',
    ]
    return "\n".join(lines)


_JSON_RE = re.compile(r"\{[^{}]*\}", re.S)


def parse_decision(text):
    """Достаёт решение из ответа модели. Любая неоднозначность -> NONE."""
    match = _JSON_RE.search(text or "")
    if not match:
        return {"ok": False, "error": "no_json", "action": "NONE", "confidence": 0.0, "reason": ""}
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"ok": False, "error": "bad_json", "action": "NONE", "confidence": 0.0, "reason": ""}
    if not isinstance(obj, dict):
        return {"ok": False, "error": "bad_json", "action": "NONE", "confidence": 0.0, "reason": ""}

    action = str(obj.get("action", "")).strip().upper()
    if action not in ALLOWED_ACTIONS:
        return {"ok": False, "error": "bad_action", "action": "NONE", "confidence": 0.0, "reason": ""}

    try:
        conf = float(obj.get("confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    conf = min(1.0, max(0.0, conf))

    return {
        "ok": True,
        "action": action,
        "confidence": round(conf, 3),
        "reason": str(obj.get("reason", ""))[:200],
    }


class GPT4AllBackend:
    """Обёртка над GPT4All. Модель грузится лениво, один запрос за раз (llama.cpp не потокобезопасен)."""

    def __init__(self):
        self.model_dir = os.environ.get("LLM_MODEL_DIR", os.path.join(os.path.dirname(__file__), "models"))
        self.model_file = os.environ.get("LLM_MODEL_FILE", "qwen2.5-3b-instruct-q4_k_m.gguf")
        self.device = os.environ.get("LLM_DEVICE", "cpu")
        self.threads = int(os.environ.get("LLM_THREADS", "0")) or None
        self.max_tokens = int(os.environ.get("LLM_MAX_TOKENS", "64"))
        self.temp = float(os.environ.get("LLM_TEMP", "0.1"))
        self._model = None
        self._lock = threading.Lock()

    @property
    def name(self):
        return self.model_file

    def _load(self):
        if self._model is None:
            from gpt4all import GPT4All  # импорт здесь, чтобы тесты работали без gpt4all
            self._model = GPT4All(
                model_name=self.model_file,
                model_path=self.model_dir,
                allow_download=False,
                device=self.device,
                n_threads=self.threads,
            )
        return self._model

    @property
    def loaded(self):
        return self._model is not None

    def generate(self, system_prompt, user_prompt):
        with self._lock:
            model = self._load()
            with model.chat_session(system_prompt=system_prompt):
                return model.generate(user_prompt, max_tokens=self.max_tokens, temp=self.temp)


def make_handler(backend):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True, "model": backend.name, "loaded": backend.loaded,
                                        "segment": os.environ.get("LLM_SEGMENT") or None})
            self._send(404, {"ok": False, "error": "not_found"})

        def do_POST(self):
            if self.path != "/decide":
                return self._send(404, {"ok": False, "error": "not_found"})
            t0 = time.time()
            try:
                length = int(self.headers.get("Content-Length", "0"))
                req = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self._send(400, {"ok": False, "error": "bad_request", "action": "NONE", "latency_ms": 0})

            expected = os.environ.get("LLM_SEGMENT")
            if expected and req.get("segment") != expected:
                return self._send(409, {"ok": False, "error": "segment_mismatch", "action": "NONE", "latency_ms": 0})
            expected_period = os.environ.get("LLM_PERIOD")
            if expected_period and str(req.get("tf")) != expected_period:
                return self._send(409, {"ok": False, "error": "period_mismatch", "action": "NONE", "latency_ms": 0})

            try:
                text = backend.generate(SYSTEM_PROMPT, build_user_prompt(req))
                result = parse_decision(text)
            except Exception as exc:  # модель недоступна или упала: это не должно ронять сервис
                result = {"ok": False, "error": f"backend: {exc}", "action": "NONE", "confidence": 0.0, "reason": ""}

            result["latency_ms"] = int((time.time() - t0) * 1000)
            self._send(200, result)

        def log_message(self, fmt, *args):  # тишина в stdout, при необходимости включить
            if os.environ.get("LLM_HTTP_LOG") == "1":
                super().log_message(fmt, *args)

    return Handler


def make_server(backend, host="127.0.0.1", port=8787):
    return ThreadingHTTPServer((host, port), make_handler(backend))


def main():
    host = os.environ.get("LLM_HOST", "127.0.0.1")
    port = int(os.environ.get("LLM_PORT", "8787"))
    backend = GPT4AllBackend()
    server = make_server(backend, host, port)
    print(f"LLM-сервис: http://{host}:{port}  модель: {backend.name}")
    print("Модель загрузится при первом запросе.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
