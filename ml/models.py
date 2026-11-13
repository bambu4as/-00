"""Модели: Random Forest (sklearn) и XGBoost. Параметры умеренно регуляризованы: данные шумные."""
import numpy as np


def make_models(names, seed=0):
    out = {}
    for name in names:
        if name == "rf":
            from sklearn.ensemble import RandomForestClassifier
            out["rf"] = RandomForestClassifier(
                n_estimators=300, max_depth=8, min_samples_leaf=50,
                random_state=seed, n_jobs=-1)
        elif name == "xgb":
            try:
                from xgboost import XGBClassifier
            except ImportError:
                raise SystemExit("xgboost не установлен: pip install xgboost")
            out["xgb"] = XGBClassifier(
                n_estimators=300, max_depth=4, learning_rate=0.03,
                subsample=0.8, colsample_bytree=0.8, eval_metric="logloss",
                random_state=seed, n_jobs=2)
        else:
            raise ValueError(f"неизвестная модель: {name}")
    return out


def predict_p_call(models: dict, X):
    """Среднее P(CALL) по моделям. X — список векторов признаков."""
    arr = np.asarray(X, dtype=float)
    probs = [m.predict_proba(arr)[:, 1] for m in models.values()]
    return np.mean(probs, axis=0)
