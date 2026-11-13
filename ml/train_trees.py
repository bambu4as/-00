"""
train_trees.py — обучение XGBoost + Random Forest на train, выбор порога воздержания на val.

  python3 ml/train_trees.py --segment otc --models xgb,rf

Тест НЕ используется. Результат: train/out/<сегмент>/trees/bundle.joblib и meta.json.
Порог выбирается так: максимум точности на val среди порогов, при которых на val
есть не меньше --min-val-trades сделок и доля сделок не меньше --min-coverage.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import joblib  # noqa: E402
import numpy as np  # noqa: E402

from features import FEATURE_VERSION, decide, features, returns_from_prompt  # noqa: E402
from models import make_models, predict_p_call  # noqa: E402

GRID = [round(x * 0.01, 2) for x in range(0, 21)]   # 0.00 .. 0.20


def load(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            x = returns_from_prompt(r["prompt"])
            if x is not None:
                rows.append((x, 1 if r["action"] == "CALL" else 0))
    if not rows:
        raise SystemExit(f"в {path} нет пригодных примеров")
    X = np.array([r[0] for r in rows], dtype=float)
    y = np.array([r[1] for r in rows], dtype=int)
    return X, y


def pick_threshold(p_val, y_val, min_trades, min_cov):
    """Порог с максимальной точностью на val при ограничениях на число и долю сделок."""
    best = None
    n = len(y_val)
    for t in GRID:
        preds, truth = [], []
        for p, y in zip(p_val, y_val):
            action, _ = decide(float(p), t)
            if action == "NONE":
                continue
            preds.append(action == "CALL")
            truth.append(bool(y))
        k = len(preds)
        if k < min_trades or k / n < min_cov:
            continue
        acc = sum(p == t_ for p, t_ in zip(preds, truth)) / k
        cand = {"threshold": t, "val_acc": acc, "val_trades": k, "val_coverage": k / n}
        if best is None or (acc, k) > (best["val_acc"], best["val_trades"]):
            best = cand
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--segment", required=True, choices=["currency", "otc"])
    ap.add_argument("--models", default="xgb,rf")
    ap.add_argument("--data", help="по умолчанию train/data/<сегмент>")
    ap.add_argument("--out", help="по умолчанию train/out/<сегмент>/trees")
    ap.add_argument("--min-val-trades", type=int, default=300)
    ap.add_argument("--min-coverage", type=float, default=0.20)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    data = args.data or os.path.join(ROOT, "train", "data", args.segment)
    out = args.out or os.path.join(ROOT, "train", "out", args.segment, "trees")
    os.makedirs(out, exist_ok=True)

    Xtr, ytr = load(os.path.join(data, "train.jsonl"))
    Xva, yva = load(os.path.join(data, "val.jsonl"))
    print(f"сегмент {args.segment}: train {len(ytr)}, val {len(yva)}, доля CALL train {ytr.mean():.3f}")

    names = [m.strip() for m in args.models.split(",") if m.strip()]
    models = make_models(names, seed=args.seed)
    for name, m in models.items():
        print(f"обучение {name} ...")
        m.fit(Xtr, ytr)

    p_val = predict_p_call(models, Xva)
    best = pick_threshold(p_val, yva, args.min_val_trades, args.min_coverage)
    if best is None:
        raise SystemExit("ни один порог не дал достаточно сделок на val: данных мало или сигнала нет")

    bundle = {
        "segment": args.segment,
        "models": models,
        "threshold": best["threshold"],
        "feature_version": FEATURE_VERSION,
        "model_names": names,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_train": int(len(ytr)),
        "n_val": int(len(yva)),
    }
    bundle_path = os.path.join(out, "bundle.joblib")
    joblib.dump(bundle, bundle_path)

    meta = {"segment": args.segment, "models": names, "feature_version": FEATURE_VERSION,
            "threshold": best["threshold"], "val": best, "n_train": int(len(ytr)), "n_val": int(len(yva)),
            "trained_at": bundle["trained_at"]}
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"порог: {best['threshold']:.2f}, val: точность {100 * best['val_acc']:.2f}%, "
          f"сделок {best['val_trades']} ({100 * best['val_coverage']:.1f}%)")
    print(f"бандл: {bundle_path}")
    print("дальше: python3 ml/evaluate_trees.py --segment " + args.segment + " (тест, один раз)")


if __name__ == "__main__":
    main()
