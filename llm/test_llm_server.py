import json
import os
import threading
import unittest
import urllib.request

from llm_server import build_user_prompt, make_server, parse_decision


class FakeBackend:
    name = "fake.gguf"
    loaded = True

    def __init__(self, reply="", raise_exc=None):
        self.reply = reply
        self.raise_exc = raise_exc
        self.last_user = None

    def generate(self, system_prompt, user_prompt):
        self.last_user = user_prompt
        if self.raise_exc:
            raise self.raise_exc
        return self.reply


class ParseDecisionTests(unittest.TestCase):
    def test_clean_json(self):
        r = parse_decision('{"action":"CALL","confidence":0.7,"reason":"rsi low"}')
        self.assertTrue(r["ok"])
        self.assertEqual(r["action"], "CALL")
        self.assertAlmostEqual(r["confidence"], 0.7)

    def test_json_with_chatter_around(self):
        r = parse_decision('Sure! Here it is: {"action":"put","confidence":"0.4","reason":"x"} done.')
        self.assertTrue(r["ok"])
        self.assertEqual(r["action"], "PUT")
        self.assertAlmostEqual(r["confidence"], 0.4)

    def test_unknown_action_becomes_not_ok(self):
        r = parse_decision('{"action":"BUY","confidence":1}')
        self.assertFalse(r["ok"])
        self.assertEqual(r["action"], "NONE")

    def test_no_json(self):
        r = parse_decision("I think it will go up")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "no_json")

    def test_broken_json(self):
        r = parse_decision('{"action": CALL}')
        self.assertFalse(r["ok"])
        self.assertEqual(r["action"], "NONE")

    def test_confidence_clamped(self):
        self.assertEqual(parse_decision('{"action":"CALL","confidence":7}')["confidence"], 1.0)
        self.assertEqual(parse_decision('{"action":"CALL","confidence":-3}')["confidence"], 0.0)

    def test_bad_confidence_defaults_to_zero(self):
        self.assertEqual(parse_decision('{"action":"CALL","confidence":"high"}')["confidence"], 0.0)


class PromptTests(unittest.TestCase):
    def test_prompt_contains_pair_returns_and_indicators(self):
        p = build_user_prompt({
            "pair": "EUR/USD OTC", "tf": 60,
            "returns_bp": [3, -5, 12],
            "indicators": {"rsi14": 28.456, "macd": -0.00012, "bad": None, "nan": float("nan")},
        })
        self.assertIn("EUR/USD OTC", p)
        self.assertIn("3, -5, 12", p)
        self.assertIn("rsi14=28.46", p)
        self.assertNotIn("bad=", p)
        self.assertNotIn("nan=", p)

    def test_prompt_limits_length(self):
        p = build_user_prompt({"returns_bp": list(range(500)), "indicators": {f"i{k}": k for k in range(100)}})
        self.assertLess(len(p), 1500)

    def test_empty_input_does_not_crash(self):
        p = build_user_prompt({})
        self.assertIn("none", p)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = FakeBackend(reply='{"action":"PUT","confidence":0.55,"reason":"overbought"}')
        cls.server = make_server(cls.backend, "127.0.0.1", 0)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _post(self, path, payload):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())

    def test_health(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=5) as r:
            data = json.loads(r.read())
        self.assertTrue(data["ok"])
        self.assertEqual(data["model"], "fake.gguf")

    def test_decide_ok(self):
        self.backend.reply = '{"action":"PUT","confidence":0.55,"reason":"overbought"}'
        data = self._post("/decide", {"pair": "X", "tf": 60, "returns_bp": [1], "indicators": {"rsi14": 80}})
        self.assertTrue(data["ok"])
        self.assertEqual(data["action"], "PUT")
        self.assertIn("latency_ms", data)

    def test_backend_exception_returns_none_not_500(self):
        self.backend.raise_exc = RuntimeError("out of memory")
        try:
            data = self._post("/decide", {"pair": "X"})
        finally:
            self.backend.raise_exc = None
        self.assertFalse(data["ok"])
        self.assertEqual(data["action"], "NONE")
        self.assertIn("out of memory", data["error"])

    def test_garbage_reply_is_none(self):
        self.backend.reply = "no idea"
        data = self._post("/decide", {"pair": "X"})
        self.assertFalse(data["ok"])
        self.assertEqual(data["action"], "NONE")



class PeriodLabels(unittest.TestCase):
    def test_labels(self):
        from llm_server import period_label
        self.assertEqual(period_label(60), "1 min")
        self.assertEqual(period_label(300), "5 min")
        self.assertEqual(period_label(5), "5 s")
        self.assertEqual(period_label(30), "30 s")

    def test_prompt_uses_seconds_label(self):
        from llm_server import build_user_prompt
        self.assertIn("Timeframe: 5 s. Expiry: 5 s.", build_user_prompt({"pair": "X", "tf": 5, "returns_bp": []}))
        self.assertIn("Timeframe: 1 min. Expiry: 1 min.", build_user_prompt({"pair": "X", "tf": 60, "returns_bp": []}))


class SegmentGuardTests(unittest.TestCase):
    def setUp(self):
        self.old = os.environ.get("LLM_SEGMENT")
        self.backend = FakeBackend(reply='{"action":"CALL","confidence":0.5,"reason":"r"}')
        self.server = make_server(self.backend, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        if self.old is None:
            os.environ.pop("LLM_SEGMENT", None)
        else:
            os.environ["LLM_SEGMENT"] = self.old

    def post(self, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/decide",
                                     data=json.dumps(body).encode(), method="POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_matching_segment_is_served(self):
        os.environ["LLM_SEGMENT"] = "otc"
        status, data = self.post({"pair": "X OTC", "segment": "otc", "returns_bp": [1, 2]})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_foreign_segment_is_refused(self):
        os.environ["LLM_SEGMENT"] = "otc"
        status, data = self.post({"pair": "X", "segment": "currency", "returns_bp": [1, 2]})
        self.assertEqual(status, 409)
        self.assertEqual(data["error"], "segment_mismatch")
        self.assertIsNone(self.backend.last_user)   # модель не вызывалась

    def test_no_guard_without_env(self):
        os.environ.pop("LLM_SEGMENT", None)
        status, _ = self.post({"pair": "X", "segment": "currency", "returns_bp": [1]})
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()
