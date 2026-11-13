#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Обучение ядра бота (XGBoost) на классических индикаторах для OTC валютных пар.
Вход: CSV с OHLC (timestamp,open,high,low,close[,volume]).
Запуск:  python otc_train.py --csv EURUSD_otc_M1.csv --horizon 3 --payout 0.85
Проверка среды: python otc_train.py --selftest
"""
import argparse, json, os
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import accuracy_score, roc_auc_score

# ---------- Индикаторы (чистый pandas, без TA-Lib) ----------
def rsi(c, n):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1/n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1/n, adjust=False).mean()
    return 100 - 100/(1 + up/(dn + 1e-12))

def add_indicators(df):
    c, h, l, o = df["close"], df["high"], df["low"], df["open"]
    f = pd.DataFrame(index=df.index)
    for n in (7, 14, 21): f[f"rsi_{n}"] = rsi(c, n)
    ema12, ema26 = c.ewm(span=12).mean(), c.ewm(span=26).mean()
    macd = ema12 - ema26; sig = macd.ewm(span=9).mean()
    f["macd"], f["macd_signal"], f["macd_hist"] = macd/c, sig/c, (macd-sig)/c
    ma20, sd20 = c.rolling(20).mean(), c.rolling(20).std()
    f["bb_width"] = 4*sd20/ma20
    f["bb_pctb"] = (c - (ma20-2*sd20))/(4*sd20 + 1e-12)
    ln, hn = l.rolling(14).min(), h.rolling(14).max()
    k = 100*(c-ln)/(hn-ln+1e-12)
    f["stoch_k"], f["stoch_d"] = k.rolling(3).mean(), k.rolling(3).mean().rolling(3).mean()
    for n in (9, 21, 50): f[f"ema_dist_{n}"] = c/c.ewm(span=n).mean() - 1
    tr = pd.concat([h-l, (h-c.shift()).abs(), (l-c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1/14, adjust=False).mean()
    f["atr_norm"] = atr/c
    up, dn = h.diff(), -l.diff()
    plus = pd.Series(np.where((up>dn)&(up>0), up, 0.0), index=df.index)
    minus = pd.Series(np.where((dn>up)&(dn>0), dn, 0.0), index=df.index)
    di_p = 100*plus.ewm(alpha=1/14).mean()/(atr+1e-12)
    di_m = 100*minus.ewm(alpha=1/14).mean()/(atr+1e-12)
    dx = 100*(di_p-di_m).abs()/(di_p+di_m+1e-12)
    f["adx"] = dx.ewm(alpha=1/14).mean(); f["di_diff"] = di_p-di_m
    tp = (h+l+c)/3
    f["cci"] = (tp-tp.rolling(20).mean())/(0.015*tp.rolling(20).std()+1e-12)
    f["wpr"] = -100*(hn-c)/(hn-ln+1e-12)
    for n in (1, 3, 5, 10): f[f"ret_{n}"] = c.pct_change(n)
    f["vol_10"] = c.pct_change().rolling(10).std()
    f["body"] = (c-o)/(h-l+1e-12)
    f["wick_up"] = (h-np.maximum(c,o))/(h-l+1e-12)
    f["wick_dn"] = (np.minimum(c,o)-l)/(h-l+1e-12)
    if "timestamp" in df:
        t = pd.to_datetime(df["timestamp"], unit="s", errors="coerce")
        if t.isna().mean() > 0.5: t = pd.to_datetime(df["timestamp"], errors="coerce")
        f["hour_sin"] = np.sin(2*np.pi*t.dt.hour/24); f["hour_cos"] = np.cos(2*np.pi*t.dt.hour/24)
        f["dow"] = t.dt.dayofweek
    return f

# ---------- Разметка: направление через horizon свечей (экспирация) ----------
def make_dataset(df, horizon):
    X = add_indicators(df)
    fwd = df["close"].shift(-horizon)
    y = (fwd > df["close"]).astype(int)
    ok = fwd.notna() & (fwd != df["close"])   # ничьи выбрасываем
    X, y = X[ok], y[ok]
    data = X.replace([np.inf, -np.inf], np.nan).dropna()
    return data, y.loc[data.index]

# ---------- Walk-forward с эмбарго (без утечки будущего) ----------
def walk_forward(n, folds=3, test_frac=0.15, embargo=10):
    test_size = int(n*test_frac)
    for i in range(folds):
        te_end = n - (folds-1-i)*test_size
        te_start = te_end - test_size
        tr_end = te_start - embargo
        yield np.arange(0, tr_end), np.arange(te_start, te_end)

def train_core(X, y, horizon, payout, folds=3):
    print(f"Данных: {len(X)} строк, {X.shape[1]} фич | класс 1 (вверх): {y.mean():.3f}")
    breakeven = 1/(1+payout)
    print(f"Безубыточная точность при выплате {payout:.0%}: {breakeven:.3f}\n")
    results, best_iters = [], []
    for k, (tr, te) in enumerate(walk_forward(len(X), folds=folds, embargo=horizon+5), 1):
        cut = int(len(tr)*0.85)              # val из хвоста train для early stopping
        model = xgb.XGBClassifier(
            n_estimators=600, learning_rate=0.05, max_depth=4,
            subsample=0.8, colsample_bytree=0.8, min_child_weight=20,
            reg_lambda=2.0, tree_method="hist", eval_metric="logloss",
            early_stopping_rounds=50, n_jobs=-1)
        model.fit(X.iloc[tr[:cut]], y.iloc[tr[:cut]],
                  eval_set=[(X.iloc[tr[cut:]], y.iloc[tr[cut:]])], verbose=False)
        p = model.predict_proba(X.iloc[te])[:, 1]
        acc = accuracy_score(y.iloc[te], p > 0.5)
        auc = roc_auc_score(y.iloc[te], p)
        conf = np.maximum(p, 1-p)
        sel = conf >= 0.55                   # торгуем только уверенные сигналы
        acc_sel = accuracy_score(y.iloc[te][sel], p[sel] > 0.5) if sel.sum() else float("nan")
        results.append((acc, auc, acc_sel, sel.mean()))
        best_iters.append(model.best_iteration)
        print(f"Fold {k}: acc={acc:.4f}  AUC={auc:.4f}  acc@conf>=0.55={acc_sel:.4f}  "
              f"покрытие={sel.mean():.2%}  best_iter={model.best_iteration}")
    m = np.nanmean(results, axis=0)
    print(f"\nСреднее: acc={m[0]:.4f}  AUC={m[1]:.4f}  acc_sel={m[2]:.4f}  покрытие={m[3]:.2%}")
    print("Вердикт:", "ЕСТЬ сигнал (проверить на форварде!)" if m[2] > breakeven + 0.01
          else "сигнала недостаточно для безубытка при такой выплате")
    final = xgb.XGBClassifier(
        n_estimators=max(50, int(np.mean(best_iters))), learning_rate=0.05, max_depth=4,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=20,
        reg_lambda=2.0, tree_method="hist", n_jobs=-1)
    final.fit(X, y)
    os.makedirs("model_out", exist_ok=True)
    final.save_model("model_out/otc_core.json")
    imp = [(n, float(v)) for n, v in sorted(zip(X.columns, final.feature_importances_), key=lambda t: -t[1])]
    json.dump({"features": list(X.columns), "horizon": horizon,
               "importance": imp[:15]}, open("model_out/meta.json", "w"), indent=1)
    print("\nТоп-10 фич:", ", ".join(f"{n}({v:.3f})" for n, v in imp[:10]))
    print("Модель: model_out/otc_core.json + meta.json (порядок фич для бота)")

def synthetic(n=30000, seed=7):
    rng = np.random.default_rng(seed)
    regime = np.repeat(rng.normal(0, 0.0004, n//500+1), 500)[:n]
    r = regime + rng.normal(0, 0.0008, n)
    c = 1.10*np.exp(np.cumsum(r))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c)*(1+np.abs(rng.normal(0, 0.0004, n)))
    l = np.minimum(o, c)*(1-np.abs(rng.normal(0, 0.0004, n)))
    return pd.DataFrame({"timestamp": np.arange(n)*60+1700000000,
                         "open": o, "high": h, "low": l, "close": c})

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv"); ap.add_argument("--horizon", type=int, default=3)
    ap.add_argument("--payout", type=float, default=0.85)
    ap.add_argument("--folds", type=int, default=3); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    print(f"xgboost {xgb.__version__} | pandas {pd.__version__}")
    df = synthetic() if a.selftest or not a.csv else pd.read_csv(a.csv)
    df.columns = [s.strip().lower() for s in df.columns]
    X, y = make_dataset(df, a.horizon)
    train_core(X, y, a.horizon, a.payout, a.folds)