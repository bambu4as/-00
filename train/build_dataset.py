"""
build_dataset.py — CSV закрытых свечей -> train/val/test (jsonl) для обучения.

Вход:  CSV с колонками time,open,high,low,close (из tools/collect_candles.js), сортировка по времени.
Выход: <out>/train.jsonl, val.jsonl, test.jsonl. Каждая строка:
       {"pair","t","prompt","action","messages":[system,user,assistant]}

Правила без утечек:
  * пример: окно из RETURNS_COUNT+1 закрытий, метка — направление следующего бара;
  * каждый пример целиком лежит в одном сплите: и окно, и бар метки;
  * сплиты идут по времени (train -> val -> test), без перемешивания;
  * окна, пересекающие разрыв во времени, отбрасываются;
  * ничьи (close == close) отбрасываются.
"""
import argparse
import csv
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import RETURNS_COUNT, SYSTEM_PROMPT, make_prompt, segment_config, segment_of, target_json  # noqa: E402


def load_bars(path):
    bars = {}
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            t = int(float(row["time"]))
            bars[t] = float(row["close"])          # дубликаты по времени: последний побеждает
    times = sorted(bars)
    return times, [bars[t] for t in times]


def infer_step(times):
    diffs = Counter(b - a for a, b in zip(times, times[1:]))
    if not diffs:
        raise SystemExit("В файле меньше двух свечей")
    return diffs.most_common(1)[0][0]


def build(times, closes, step, pair, period_sec, ratio=(0.70, 0.15)):
    n = len(closes)
    b1 = int(n * ratio[0])
    b2 = int(n * (ratio[0] + ratio[1]))
    splits = {"train": [], "val": [], "test": []}
    dropped = Counter()

    for i in range(RETURNS_COUNT, n - 1):
        start = i - RETURNS_COUNT
        # разрыв во времени внутри окна или между баром i и i+1
        if any(times[k + 1] - times[k] != step for k in range(start, i + 1)):
            dropped["gap"] += 1
            continue
        if times[i + 1] - times[i] != step:
            dropped["gap"] += 1
            continue
        if closes[i + 1] == closes[i]:
            dropped["tie"] += 1
            continue
        action = "CALL" if closes[i + 1] > closes[i] else "PUT"

        # сплит определяется по ВСЕМУ примеру: и по окну (start), и по метке (i+1)
        if i + 1 < b1:
            split = "train"
        elif start >= b1 and i + 1 < b2:
            split = "val"
        elif start >= b2:
            split = "test"
        else:
            dropped["purge"] += 1       # пример на границе сплитов: отбрасываем
            continue

        prompt = make_prompt(pair, period_sec, closes[start:i + 1])
        splits[split].append({
            "pair": pair,
            "t": times[i],
            "prompt": prompt,
            "action": action,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": target_json(action)},
            ],
        })
    return splits, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--pair", required=True, help="имя пары, например 'EUR/USD OTC'")
    ap.add_argument("--segment", required=True, choices=["currency", "otc"])
    ap.add_argument("--period", type=int, default=60, help="период свечей, сек (60 = 1 минута, 5 = 5 секунд)")
    ap.add_argument("--out", help="по умолчанию train/data/<сегмент>")
    ap.add_argument("--min-per-split", type=int, default=1000)
    args = ap.parse_args()

    if segment_of(args.pair) != args.segment:
        raise SystemExit(f"пара '{args.pair}' относится к сегменту '{segment_of(args.pair)}', а не '{args.segment}'")
    segment_config(args.segment)               # проверка признаков
    out = args.out or os.path.join("train", "data", args.segment)

    times, closes = load_bars(args.csv)
    step = infer_step(times)
    if step != args.period:
        raise SystemExit(f"шаг в файле {step} с, а --period {args.period}: проверьте файл и период")
    splits, dropped = build(times, closes, step, args.pair, args.period)

    os.makedirs(out, exist_ok=True)
    print(f"баров: {len(times)}, шаг: {step} с, отброшено: {dict(dropped)}")
    for name, rows in splits.items():
        path = os.path.join(out, f"{name}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        c = Counter(r["action"] for r in rows)
        base = c["CALL"] / len(rows) if rows else float("nan")
        print(f"{name:5s} n={len(rows):6d}  CALL={c['CALL']}  PUT={c['PUT']}  доля CALL={base:.3f}  -> {path}")
        if len(rows) < args.min_per_split:
            print(f"  ВНИМАНИЕ: в '{name}' меньше {args.min_per_split} примеров, оценка будет слабой")


if __name__ == "__main__":
    main()
