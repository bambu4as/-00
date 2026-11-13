"""
evaluate.py — оценка модели и базовых линий на тестовом сплите + критерий допуска в ядро.

Режимы:
  --baselines-only                 только базовые линии (ничего не требует, кроме numpy/sklearn)
  --predictions preds.jsonl        предсказания модели: {"t": <time>, "action": "CALL|PUT|NONE"}
  --backend gpt4all --model-dir D --model-file F
                                   прогнать модель через llm_server.GPT4AllBackend по test.jsonl

Метрика — доля верных среди сделок (NONE не считается ни верным, ни неверным, но учитывается в покрытии).
Критерий допуска (все условия обязательны):
  1. сделок на тесте >= --min-n;
  2. нижняя граница 95% Wilson для точности > точки безубыточности 1/(1+payout);
  3. точность на тесте > лучшей базовой линии на тесте;
  4. тест используется ОДИН раз: выбор чекпойнта и параметров делается по val.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CONFIG, binom_two_sided_p, breakeven, segment_config, wilson  # noqa: E402

FEATURE_LEN = 20


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def features_of(row):
    """Признаки для логистической базовой линии: 20 доходностей из промпта (как в сервисе)."""
    import re
    m = re.search(r"oldest to newest: ([^\n]*)", row["prompt"])
    if not m or m.group(1).strip() == "none":
        return None
    vals = [float(x) for x in m.group(1).split(",")]
    return vals[-FEATURE_LEN:] if len(vals) == FEATURE_LEN else None


def summarize(name, pairs, payout):
    """pairs: список (pred, truth). Возвращает словарь метрик."""
    n_all = len(pairs)
    trades = [(p, t) for p, t in pairs if p in ("CALL", "PUT")]
    n = len(trades)
    k = sum(1 for p, t in trades if p == t)
    lo, hi = wilson(k, n)
    return {
        "name": name,
        "n_all": n_all,
        "n_trade": n,
        "coverage": n / n_all if n_all else float("nan"),
        "acc": k / n if n else float("nan"),
        "ci95": (lo, hi),
        "p_vs_50": binom_two_sided_p(k, n),
        "breakeven": breakeven(payout),
    }


def fmt(m):
    lo, hi = m["ci95"]
    acc = "  -  " if m["n_trade"] == 0 else f"{100 * m['acc']:6.2f}%"
    ci = "    -    " if m["n_trade"] == 0 else f"{100 * lo:5.2f}-{100 * hi:5.2f}"
    return (f"{m['name']:28s} сделок {m['n_trade']:6d} из {m['n_all']:6d} "
            f"(покрытие {100 * m['coverage']:5.1f}%)  точность {acc}  95%: {ci}  p={m['p_vs_50']:.3g}")


def baselines(train, test):
    """Простые правила, которые должна обыгрывать модель."""
    out = {}
    out["always CALL"] = [("CALL", r["action"]) for r in test]
    out["always PUT"] = [("PUT", r["action"]) for r in test]

    def last_ret(r):
        f = features_of(r)
        return None if f is None else f[-1]

    mom, rev = [], []
    for r in test:
        x = last_ret(r)
        if x is None or x == 0:
            mom.append(("NONE", r["action"])); rev.append(("NONE", r["action"]))
            continue
        mom.append(("CALL" if x > 0 else "PUT", r["action"]))
        rev.append(("PUT" if x > 0 else "CALL", r["action"]))
    out["momentum (знак последней)"] = mom
    out["reversal (против последней)"] = rev

    try:
        import numpy as np
        from sklearn.linear_model import LogisticRegression
        Xtr, ytr, idx_tr = [], [], []
        for r in train:
            f = features_of(r)
            if f is None:
                continue
            Xtr.append(f); ytr.append(1 if r["action"] == "CALL" else 0)
        clf = LogisticRegression(max_iter=1000).fit(np.array(Xtr) / 100.0, np.array(ytr))
        lr = []
        for r in test:
            f = features_of(r)
            if f is None:
                lr.append(("NONE", r["action"])); continue
            p = clf.predict(np.array([f]) / 100.0)[0]
            lr.append(("CALL" if p == 1 else "PUT", r["action"]))
        out["logistic на 20 доходностях"] = lr
    except ImportError:
        print("(sklearn не установлен: логистическая базовая линия пропущена)")
    return out


def run_backend(test, args):
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "llm"))
    from llm_server import SYSTEM_PROMPT, GPT4AllBackend, parse_decision
    backend = GPT4AllBackend()
    backend.model_dir = args.model_dir
    backend.model_file = args.model_file
    preds = []
    for i, r in enumerate(test):
        text = backend.generate(SYSTEM_PROMPT, r["messages"][1]["content"])
        d = parse_decision(text)
        preds.append((d["action"] if d["ok"] else "NONE", r["action"]))
        if (i + 1) % 100 == 0:
            print(f"  ... {i + 1}/{len(test)}", file=sys.stderr)
    return preds


def gate(model_m, best_baseline_acc, min_n):
    reasons = []
    if model_m["n_trade"] < min_n:
        reasons.append(f"мало сделок: {model_m['n_trade']} < {min_n}")
    lo = model_m["ci95"][0]
    if not (lo > model_m["breakeven"]):
        reasons.append(f"нижняя граница 95% ({100 * lo:.2f}%) не выше безубыточности ({100 * model_m['breakeven']:.2f}%)")
    if not (model_m["acc"] > best_baseline_acc):
        reasons.append(f"не лучше базовой линии ({100 * model_m['acc']:.2f}% <= {100 * best_baseline_acc:.2f}%)")
    return (len(reasons) == 0), reasons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--segment", required=True, choices=["currency", "otc"])
    ap.add_argument("--data", help="по умолчанию train/data/<сегмент>")
    ap.add_argument("--split", default="test", choices=["val", "test"])
    ap.add_argument("--payout", type=float, default=float(os.environ.get("PAYOUT", CONFIG["payout"])))
    ap.add_argument("--min-n", type=int)
    ap.add_argument("--baselines-only", action="store_true")
    ap.add_argument("--predictions")
    ap.add_argument("--backend", choices=["gpt4all"])
    ap.add_argument("--model-dir")
    ap.add_argument("--model-file")
    args = ap.parse_args()
    segment_config(args.segment)
    data = args.data or os.path.join("train", "data", args.segment)
    if args.min_n is None:
        args.min_n = CONFIG["segments"][args.segment]["min_test_trades"]

    train = read_jsonl(os.path.join(data, "train.jsonl"))
    evald = read_jsonl(os.path.join(data, f"{args.split}.jsonl"))
    print(f"сегмент: {args.segment}, сплит: {args.split}, примеров: {len(evald)}, точка безубыточности: {100 * breakeven(args.payout):.2f}%")

    bl = baselines(train, evald)
    bl_metrics = {name: summarize(name, pairs, args.payout) for name, pairs in bl.items()}
    print("\nБазовые линии:")
    for m in bl_metrics.values():
        print("  " + fmt(m))
    best_bl = max((m["acc"] for m in bl_metrics.values() if m["n_trade"] > 0), default=0.0)

    if args.baselines_only:
        return

    if args.predictions:
        by_t = {}
        for p in read_jsonl(args.predictions):
            by_t[p["t"]] = p["action"]
        preds = [(by_t.get(r["t"], "NONE"), r["action"]) for r in evald]
    elif args.backend == "gpt4all":
        if not (args.model_dir and args.model_file):
            ap.error("для --backend gpt4all нужны --model-dir и --model-file")
        preds = run_backend(evald, args)
    else:
        ap.error("укажите --baselines-only, --predictions или --backend")

    m = summarize("МОДЕЛЬ", preds, args.payout)
    print("\nМодель:")
    print("  " + fmt(m))
    ok, reasons = gate(m, best_bl, args.min_n)
    print("\nКритерий допуска в ядро:", "ПРОЙДЕН" if ok else "НЕ ПРОЙДЕН")
    for r in reasons:
        print("  - " + r)
    if args.split == "val":
        print("  (это сплит val: для допуска оценка делается один раз на test)")


if __name__ == "__main__":
    main()
