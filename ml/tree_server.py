"""
tree_server.py — HTTP-сервис решения CALL/PUT на деревьях (XGBoost + Random Forest).
Контракт тот же, что у llm/llm_server.py: POST /decide, ответ {ok, action, confidence, reason}.

Запуск на сегмент (отдельный порт на каждый сегмент):
  ML_SEGMENT=otc      LLM_PORT=8788 python3 ml/tree_server.py
  ML_SEGMENT=currency LLM_PORT=8787 python3 ml/tree_server.py

Сервис работает ТОЛЬКО для одобренного сегмента:
  * нет train/out/<сегмент>/trees/APPROVED.json                -> 503 not_approved
  * sha256 бандла не совпадает с одобрением                    -> 503 approval_mismatch
  * запрос другого сегмента                                    -> 409 segment_mismatch
Так модель не будет торговать сегмент, который не прошёл проверку на тесте.
"""
import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import joblib  # noqa: E402

from features import FEATURE_LEN, FEATURE_VERSION, decide, features  # noqa: E402
from models import predict_p_call  # noqa: E402


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Service:
    def __init__(self, segment, bundle_path=None, approval_dir=None, period=None):
        self.segment = segment
        self.period = int(period) if period else None
        self.bundle_path = bundle_path or os.path.join(ROOT, "train", "out", segment, "trees", "bundle.joblib")
        self.approval_dir = approval_dir or os.path.dirname(self.bundle_path)
        self.lock = threading.Lock()
        self.bundle = None
        self.approved, self.reason = self._check_approval()
        if os.path.exists(self.bundle_path):
            self.bundle = joblib.load(self.bundle_path)
        self.requests = 0

    def _check_approval(self):
        if not os.path.exists(self.bundle_path):
            return False, "no_bundle"
        path = os.path.join(self.approval_dir, "APPROVED.json")
        if not os.path.exists(path):
            return False, "not_approved"
        with open(path, encoding="utf-8") as f:
            ap = json.load(f)
        if ap.get("segment") != self.segment:
            return False, "approval_segment_mismatch"
        if ap.get("bundle_sha256") != sha256(self.bundle_path):
            return False, "approval_mismatch"
        return True, "ok"

    def health(self):
        return {"ok": True, "segment": self.segment, "approved": self.approved,
                "status": self.reason, "feature_version": FEATURE_VERSION,
                "models": (self.bundle or {}).get("model_names"), "threshold": (self.bundle or {}).get("threshold")}

    def decide(self, req):
        """Возвращает (код HTTP, тело ответа)."""
        if req.get("segment") != self.segment:
            return 409, {"ok": False, "error": "segment_mismatch", "action": "NONE"}
        if self.period is not None and str(req.get("tf")) != str(self.period):
            return 409, {"ok": False, "error": "period_mismatch", "action": "NONE"}
        if not self.approved:
            return 503, {"ok": False, "error": self.reason, "action": "NONE"}
        try:
            x = features(req.get("returns_bp"))
        except ValueError as e:
            return 400, {"ok": False, "error": f"bad_input: {e}", "action": "NONE"}
        with self.lock:
            self.requests += 1
            p = float(predict_p_call(self.bundle["models"], [x])[0])
        action, conf = decide(p, self.bundle["threshold"])
        return 200, {"ok": True, "action": action, "confidence": round(conf, 4),
                     "reason": f"p_call={p:.3f} thr={self.bundle['threshold']:.2f}",
                     "segment": self.segment, "feature_version": FEATURE_VERSION}


def make_server(service, host="127.0.0.1", port=8787):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, service.health())
            self._send(404, {"ok": False, "error": "not_found"})

        def do_POST(self):
            if self.path != "/decide":
                return self._send(404, {"ok": False, "error": "not_found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                req = json.loads(self.rfile.read(n) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self._send(400, {"ok": False, "error": "bad_json", "action": "NONE"})
            code, body = service.decide(req)
            self._send(code, body)

        def log_message(self, fmt, *args):
            pass

    return ThreadingHTTPServer((host, port), Handler)


def main():
    segment = os.environ.get("ML_SEGMENT")
    if segment not in ("currency", "otc"):
        raise SystemExit("задайте ML_SEGMENT=currency или ML_SEGMENT=otc")
    port = int(os.environ.get("LLM_PORT") or os.environ.get("ML_PORT") or 8787)
    period = os.environ.get("ML_PERIOD") or os.environ.get("LLM_PERIOD")
    svc = Service(segment, period=period)
    print(f"сегмент {segment}, период {period or 'любой'} с, статус: {svc.reason}, признаки {FEATURE_VERSION} ({FEATURE_LEN} доходностей)")
    if not svc.approved:
        print("сервис запущен, но решений не выдаёт, пока сегмент не одобрен (см. ml/evaluate_trees.py --approve)")
    srv = make_server(svc, port=port)
    print(f"слушаю http://127.0.0.1:{port}/decide")
    srv.serve_forever()


if __name__ == "__main__":
    main()
