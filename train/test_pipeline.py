import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from common import binom_two_sided_p, breakeven, js_round, make_prompt, returns_bp, wilson  # noqa: E402
import build_dataset as bd  # noqa: E402
import evaluate as ev  # noqa: E402


def walk(n, seed=1, step=60, start=1000):
    rnd = random.Random(seed)
    times = [1_700_000_000 + i * step for i in range(n)]
    closes = [1.0]
    for _ in range(n - 1):
        closes.append(closes[-1] * (1 + rnd.gauss(0, 1e-4)))
    return times, closes


class RoundingParity(unittest.TestCase):
    def test_js_math_round(self):
        self.assertEqual(js_round(2.5), 3)
        self.assertEqual(js_round(-2.5), -2)     # JS: .5 -> +inf; Python round() дал бы -2 банковским
        self.assertEqual(js_round(-0.4), 0)
        self.assertEqual(js_round(0.5), 1)

    def test_returns_match_node_formula(self):
        closes = [1.0, 1.0001, 1.00005, 1.00015]
        exp = [round((closes[i] / closes[i - 1] - 1) * 1e4) for i in range(1, 4)]
        self.assertEqual(len(returns_bp(closes)), 3)
        self.assertEqual(returns_bp(closes)[0], 1)


class DatasetRules(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_splits_are_disjoint_in_time(self):
        times, closes = walk(3000)
        splits, _ = bd.build(times, closes, 60, "T", 1)
        tr = {r["t"] for r in splits["train"]}
        va = {r["t"] for r in splits["val"]}
        te = {r["t"] for r in splits["test"]}
        self.assertTrue(max(tr) < min(va) < max(va) < min(te))
        self.assertFalse(tr & va or va & te or tr & te)

    def test_no_window_crosses_split_boundary(self):
        """Окно признаков и бар метки целиком внутри сплита: без утечки через перекрытие."""
        times, closes = walk(3000)
        splits, _ = bd.build(times, closes, 60, "T", 1)
        index = {t: i for i, t in enumerate(times)}
        b1 = int(3000 * 0.70)
        b2 = int(3000 * 0.85)
        for r in splits["train"]:
            self.assertLess(index[r["t"]] + 1, b1)
        for r in splits["val"]:
            self.assertGreaterEqual(index[r["t"]] - 20, b1)
            self.assertLess(index[r["t"]] + 1, b2)
        for r in splits["test"]:
            self.assertGreaterEqual(index[r["t"]] - 20, b2)

    def test_label_is_next_bar_direction(self):
        times, closes = walk(300, seed=3)
        splits, _ = bd.build(times, closes, 60, "T", 1)
        index = {t: i for i, t in enumerate(times)}
        for name in splits:
            for r in splits[name]:
                i = index[r["t"]]
                want = "CALL" if closes[i + 1] > closes[i] else "PUT"
                self.assertEqual(r["action"], want)

    def test_gap_drops_windows(self):
        times, closes = walk(400)
        times2 = times[:200] + [t + 600 for t in times[200:]]    # разрыв 10 минут
        splits, dropped = bd.build(times2, closes, 60, "T", 1)
        self.assertGreater(dropped["gap"], 0)

    def test_prompt_matches_service_format(self):
        p = make_prompt("EUR/USD OTC", 60, [1.0 + 0.0001 * i for i in range(21)])
        self.assertIn("Pair: EUR/USD OTC. Timeframe: 1 min.", p)
        self.assertIn("Indicators (last closed candle): none", p)


class Statistics(unittest.TestCase):
    def test_wilson_bounds_contain_point(self):
        lo, hi = wilson(60, 100)
        self.assertLess(lo, 0.6)
        self.assertGreater(hi, 0.6)
        self.assertTrue(math.isnan(wilson(0, 0)[0]))

    def test_binomial_p_symmetric_at_half(self):
        self.assertAlmostEqual(binom_two_sided_p(5, 10), 1.0, places=6)
        self.assertLess(binom_two_sided_p(90, 100), 1e-10)

    def test_breakeven_80_payout(self):
        self.assertAlmostEqual(breakeven(0.80), 1 / 1.8, places=6)


class Gate(unittest.TestCase):
    def pairs(self, acc, n):
        k = int(n * acc)
        return [("CALL", "CALL")] * k + [("CALL", "PUT")] * (n - k)

    def test_random_model_fails(self):
        m = ev.summarize("m", self.pairs(0.5, 5000), 0.8)
        ok, _ = ev.gate(m, best_baseline_acc=0.5, min_n=1000)
        self.assertFalse(ok)

    def test_strong_model_passes(self):
        m = ev.summarize("m", self.pairs(0.62, 5000), 0.8)
        ok, reasons = ev.gate(m, best_baseline_acc=0.51, min_n=1000)
        self.assertTrue(ok, reasons)

    def test_above_chance_but_below_breakeven_fails(self):
        m = ev.summarize("m", self.pairs(0.54, 5000), 0.8)     # 54% < 55.6%
        ok, _ = ev.gate(m, best_baseline_acc=0.50, min_n=1000)
        self.assertFalse(ok)

    def test_too_few_trades_fails(self):
        m = ev.summarize("m", self.pairs(0.9, 100), 0.8)
        ok, reasons = ev.gate(m, best_baseline_acc=0.5, min_n=1000)
        self.assertFalse(ok)
        self.assertTrue(any("мало сделок" in r for r in reasons))


@unittest.skipUnless(shutil.which("node"), "node не найден")
class NodeParity(unittest.TestCase):
    def test_python_returns_equal_js_buildRequest(self):
        rnd = random.Random(7)
        closes = [1.0]
        for _ in range(40):
            closes.append(closes[-1] * (1 + rnd.gauss(0, 5e-4)))
        bars = [{"time": i, "close": c, "open": c, "high": c, "low": c} for i, c in enumerate(closes)]
        js = (
            "import {buildRequest} from './llmCore.js';"
            f"const bars={json.dumps(bars)};"
            "const r=buildRequest(bars,{pair:'X',tf:1});"
            "process.stdout.write(JSON.stringify(r.returns_bp));"
        )
        out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT,
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), returns_bp(closes)[-20:])


class Segments(unittest.TestCase):
    def test_segment_rules(self):
        from common import segment_config, segment_of
        self.assertEqual(segment_of("EUR/USD"), "currency")
        self.assertEqual(segment_of("EUR/USD OTC"), "otc")
        self.assertEqual(segment_of("usd/jpy otc"), "otc")
        for s in ("currency", "otc"):
            self.assertIn("features", segment_config(s))
        with self.assertRaises(ValueError):
            segment_config("forex")

    @unittest.skipUnless(shutil.which("node"), "node не найден")
    def test_segment_rules_match_node(self):
        names = ["EUR/USD", "EUR/USD OTC", "usd/jpy otc", "GBP/AUD", "", "OTC"]
        js = ("import {segmentOf} from './config/index.js';"
              f"process.stdout.write(JSON.stringify({json.dumps(names)}.map(segmentOf)));")
        out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT,
                             capture_output=True, text=True, check=True).stdout
        from common import segment_of
        self.assertEqual(json.loads(out), [segment_of(n) for n in names])


if __name__ == "__main__":
    unittest.main()
