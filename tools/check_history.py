"""
check_history.py — проверка скачанной истории перед обучением.

  python3 tools/check_history.py data/otc/hist_EUR_USD_OTC_1m.csv [--step 60]

Печатает: число свечей, период, охват в днях, дубли, порядок, пропуски (разрывы
больше шага), долю разрывов. Выход с кодом 1, если файл непригоден для обучения.
"""
import argparse
import csv
import datetime as dt
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--step", type=int, default=60, help="ожидаемый шаг, сек (1 мин = 60)")
    ap.add_argument("--max-gap-share", type=float, default=0.02, help="допустимая доля разрывов")
    args = ap.parse_args()

    with open(args.csv, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print("файл пуст")
        return 1

    times = [int(float(r["time"])) for r in rows]
    dups = len(times) - len(set(times))
    unsorted = sum(1 for a, b in zip(times, times[1:]) if b < a)
    uniq = sorted(set(times))
    diffs = [b - a for a, b in zip(uniq, uniq[1:])]
    gaps = [d for d in diffs if d != args.step]
    gap_share = len(gaps) / max(1, len(diffs))
    span_days = (uniq[-1] - uniq[0]) / 86400
    fmt = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d %H:%M")

    print(f"файл:        {args.csv}")
    print(f"свечей:      {len(uniq)} (строк {len(rows)})")
    print(f"период:      {fmt(uniq[0])} .. {fmt(uniq[-1])} UTC  ({span_days:.1f} дн.)")
    print(f"дубли:       {dups}")
    print(f"не по порядку: {unsorted}")
    print(f"разрывов:    {len(gaps)} из {len(diffs)} ({100 * gap_share:.2f}%)")
    if gaps:
        print(f"  самый большой разрыв: {max(gaps) / args.step:.0f} шагов, {fmt(uniq[diffs.index(max(gaps))])} UTC")

    ok = dups == 0 and unsorted == 0 and gap_share <= args.max_gap_share
    print("вердикт:", "годен" if ok else "НЕ годен для обучения")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
