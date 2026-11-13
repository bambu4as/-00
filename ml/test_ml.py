import hashlib
import json
import os
import random
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "train"))

import joblib  # noqa: E402
import numpy as np  # noqa: E402

from features import FEATURE_LEN, decide, features, returns_from_prompt  # noqa: E402
from common import make_prompt, returns_bp  # noqa: E402
from train_trees import pick_threshold  # noqa: E402
from tree_server import Service, make_server  # noqa: E402


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def tiny_bundle(path, segment="otc", seed=0):
    from sklearn.ensemble import RandomForestClassifier
    rnd = np.random.RandomState(seed)
    X = rnd.normal(0, 10, size=(400, FEATURE_LEN))
    y = (X[:, -1] > 0).astype(int)
    m = RandomForestClassifier(n_estimators=20, min_samples_leaf=20, random_state=seed).fit(X, y)
    joblib.dump({"segment": segment, "models": {"rf": m}, "threshold": 0.02,
                 "feature_version": "returns20-v1", "model_names": ["rf"]}, path)


def approve(dir_, segment, bundle):
    with open(os.path.join(dir_, "APPROVED.json"), "w") as f:
        json.dump({"segment": segment, "bundle_sha256": sha(bundle)}, f)


class Features(unittest.TestCase):
    def test_prompt_parity_with_bp_returns(self):
        closes = [1.0 + 0.0003 * i * (-1) ** i for i in range(21)]
        p = make_prompt("EUR/USD OTC", 60, closes)
        self.assertEqual(returns_from_prompt(p), [float(x) for x in returns_bp(closes)])

    def test_incomplete_window_is_none(self):
        self.assertIsNone(returns_from_prompt("Recent 1-minute returns (bp), oldest to newest: none"))

    def test_features_validation(self):
        with self.assertRaises(ValueError):
            features([1, 2, 3])
        with self.assertRaises(ValueError):
            features(["a"] * FEATURE_LEN)
        self.assertEqual(len(features(list(range(FEATURE_LEN)))), FEATURE_LEN)


class Decision(unittest.TestCase):
    def test_mapping_and_abstain(self):
        self.assertEqual(decide(0.60, 0.05)[0], "CALL")
        self.assertEqual(decide(0.40, 0.05)[0], "PUT")
        self.assertEqual(decide(0.52, 0.05)[0], "NONE")     # в зоне воздержания
        self.assertEqual(decide(0.50, 0.0)[0], "NONE")      # ровно 0.5 не торгуем
        self.assertLessEqual(decide(0.99, 0.0)[1], 1.0)


class Threshold(unittest.TestCase):
    def test_picks_threshold_on_planted_signal(self):
        rnd = random.Random(1)
        p, y = [], []
        for _ in range(2000):
            edge = rnd.uniform(-0.3, 0.3)
            p.append(0.5 + edge)
            y.append(1 if (edge > 0) == (rnd.random() < 0.8) else 0)   # правда в 80% случаев
        best = pick_threshold(np.array(p), np.array(y), min_trades=100, min_cov=0.1)
        self.assertIsNotNone(best)
        self.assertGreater(best["val_acc"], 0.7)

    def test_none_when_too_few_trades(self):
        p = np.array([0.5] * 50)
        y = np.array([1] * 50)
        self.assertIsNone(pick_threshold(p, y, min_trades=300, min_cov=0.2))


class ServiceApproval(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.bundle = os.path.join(self.dir, "bundle.joblib")
        tiny_bundle(self.bundle)

    def test_not_approved_refuses_to_trade(self):
        svc = Service("otc", bundle_path=self.bundle, approval_dir=self.dir)
        self.assertFalse(svc.approved)
        code, body = svc.decide({"segment": "otc", "returns_bp": [1] * FEATURE_LEN})
        self.assertEqual(code, 503)
        self.assertEqual(body["action"], "NONE")

    def test_approved_serves(self):
        approve(self.dir, "otc", self.bundle)
        svc = Service("otc", bundle_path=self.bundle, approval_dir=self.dir)
        self.assertTrue(svc.approved)
        code, body = svc.decide({"segment": "otc", "returns_bp": list(range(FEATURE_LEN))})
        self.assertEqual(code, 200)
        self.assertIn(body["action"], ("CALL", "PUT", "NONE"))

    def test_bundle_swap_invalidates_approval(self):
        approve(self.dir, "otc", self.bundle)
        tiny_bundle(self.bundle, seed=7)                 # подмена модели после одобрения
        svc = Service("otc", bundle_path=self.bundle, approval_dir=self.dir)
        self.assertFalse(svc.approved)
        self.assertEqual(svc.reason, "approval_mismatch")

    def test_wrong_segment_refused(self):
        approve(self.dir, "otc", self.bundle)
        svc = Service("otc", bundle_path=self.bundle, approval_dir=self.dir)
        code, body = svc.decide({"segment": "currency", "returns_bp": [1] * FEATURE_LEN})
        self.assertEqual((code, body["error"]), (409, "segment_mismatch"))

    def test_bad_input(self):
        approve(self.dir, "otc", self.bundle)
        svc = Service("otc", bundle_path=self.bundle, approval_dir=self.dir)
        code, _ = svc.decide({"segment": "otc", "returns_bp": [1, 2]})
        self.assertEqual(code, 400)


class HttpRoundTrip(unittest.TestCase):
    def test_decide_over_http(self):
        d = tempfile.mkdtemp()
        b = os.path.join(d, "bundle.joblib")
        tiny_bundle(b)
        approve(d, "otc", b)
        svc = Service("otc", bundle_path=b, approval_dir=d)
        srv = make_server(svc, port=0)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            port = srv.server_address[1]
            req = urllib.request.Request(f"http://127.0.0.1:{port}/decide",
                                         data=json.dumps({"segment": "otc", "returns_bp": [3] * FEATURE_LEN}).encode(),
                                         method="POST")
            with urllib.request.urlopen(req) as r:
                body = json.loads(r.read())
            self.assertTrue(body["ok"])
            self.assertIn(body["action"], ("CALL", "PUT", "NONE"))
            req2 = urllib.request.Request(f"http://127.0.0.1:{port}/decide",
                                          data=json.dumps({"segment": "currency", "returns_bp": [3] * FEATURE_LEN}).encode(),
                                          method="POST")
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req2)
            self.assertEqual(cm.exception.code, 409)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
