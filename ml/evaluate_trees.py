"""
evaluate_trees.py — оценка бандла деревьев на ТЕСТЕ и одобрение сегмента.

  python3 ml/evaluate_trees.py --segment otc            # только отчёт
  python3 ml/evaluate_trees.py --segment otc --approve  # записать APPROVED.json, если критерий пройден

Каждый запуск на тесте пишется в trees/test_log.jsonl: тест должен использоваться один раз.
Критерий тот же, что в train/README.md (нижняя граница 95% > безубыточности, выше базовых линий, сделок >= min).
Одобрение привязано к sha256 бандла: подмена модели после проверки делает сервис неактивным.
"""
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "train"))

import joblib  # noqa: E402
import numpy as np  # noqa: E402

from evaluate import baselines, fmt, gate, read_jsonl, summarize  # noqa: E402
from common import CONFIG, breakeven  # noqa: E402
from features import decide, features, returns_from_prompt  # noqa: E402
from models import predict_p_call  # noqa: E402


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--segment", required=True, choices=["currency", "otc"])
    ap.add_argument("--payout", type=float, default=float(os.environ.get("PAYOUT", CONFIG["payout"])))
    ap.add_argument("--approve", action="store_true")
    args = ap.parse_args()

    out = os.path.join(ROOT, "train", "out", args.segment, "trees")
    bundle_path = os.path.join(out, "bundle.joblib")
    if not os.path.exists(bundle_path):
        raise SystemExit(f"нет бандла: {bundle_path}. Сначала ml/train_trees.py")
    bundle = joblib.load(bundle_path)
    thr = bundle["threshold"]

    data = os.path.join(ROOT, "train", "data", args.segment)
    train = read_jsonl(os.path.join(data, "train.jsonl"))
    test = read_jsonl(os.path.join(data, "test.jsonl"))

    pairs = []
    for r in test:
        x = returns_from_prompt(r["prompt"])
        if x is None:
            pairs.append(("NONE", r["action"]))
            continue
        p = float(predict_p_call(bundle["models"], [features(x)])[0])
        action, _ = decide(p, thr)
        pairs.append((action, r["action"]))

    model_m = summarize("ДЕРЕВЬЯ (XGB+RF)", pairs, args.payout)
    bl = baselines(train, test)
    bl_metrics = {name: summarize(name, p, args.payout) for name, p in bl.items()}
    print(f"сегмент {args.segment}, порог {thr:.2f}, тест {len(test)} примеров, "
          f"безубыточность {100 * breakeven(args.payout):.2f}%")
    print("\nБазовые линии:")
    for m in bl_metrics.values():
        print("  " + fmt(m))
    print("\nМодель:")
    print("  " + fmt(model_m))
    best_bl = max((m["acc"] for m in bl_metrics.values() if m["n_trade"] > 0), default=0.0)
    ok, reasons = gate(model_m, best_bl, CONFIG["segments"][args.segment]["min_test_trades"])

    log_path = os.path.join(out, "test_log.jsonl")
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "passed": ok,
                            "n_trade": model_m["n_trade"], "acc": model_m["acc"],
                            "ci_low": model_m["ci95"][0], "bundle_sha256": sha256(bundle_path)},
                           ensure_ascii=False) + "\n")
    with open(log_path, encoding="utf-8") as f:
        uses = sum(1 for _ in f)
    print(f"\nкритерий допуска: {'ПРОЙДЕН' if ok else 'НЕ ПРОЙДЕН'}")
    for r in reasons:
        print("  - " + r)
    print(f"тест использован раз: {uses} (журнал: {log_path})")
    if uses > 1:
        print("  ВНИМАНИЕ: тест уже использовался. Повторная оценка на тесте уменьшает доверие к результату.")

    if args.approve:
        if not ok:
            raise SystemExit("одобрение отклонено: критерий не пройден")
        approval = {
            "segment": args.segment,
            "bundle_sha256": sha256(bundle_path),
            "threshold": thr,
            "test_acc": model_m["acc"],
            "test_ci_low": model_m["ci95"][0],
            "test_trades": model_m["n_trade"],
            "approved_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(os.path.join(out, "APPROVED.json"), "w", encoding="utf-8") as f:
            json.dump(approval, f, ensure_ascii=False, indent=2)
        print("сегмент одобрен: APPROVED.json записан, сервис деревьев может торговать этот сегмент")


if __name__ == "__main__":
    main()
