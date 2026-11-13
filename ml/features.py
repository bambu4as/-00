"""
features.py — признаки и решение для деревьев. Версия признаков зафиксирована в бандле модели.

Признаки v1: 20 доходностей в б.п. (то же представление, что у LLM и в buildRequest() в llmCore.js).
Решение: P(CALL) — среднее по моделям; воздержание, если |P - 0.5| < порога.
"""
import re

FEATURE_VERSION = "returns20-v1"
FEATURE_LEN = 20
_RE = re.compile(r"oldest to newest: ([^\n]*)")


def returns_from_prompt(prompt: str):
    """Доходности из промпта датасета. None, если окно неполное. Совпадает с train/evaluate.py:features_of."""
    m = _RE.search(prompt)
    if not m or m.group(1).strip() == "none":
        return None
    vals = [float(x) for x in m.group(1).split(",")]
    return vals if len(vals) == FEATURE_LEN else None


def features(returns_bp):
    """Вектор признаков из запроса сервиса. Бросает ValueError при неверной длине."""
    if not isinstance(returns_bp, list) or len(returns_bp) != FEATURE_LEN:
        raise ValueError(f"нужно {FEATURE_LEN} доходностей")
    try:
        return [float(x) for x in returns_bp]
    except (TypeError, ValueError):
        raise ValueError("доходности должны быть числами")


def decide(p_call: float, threshold: float):
    """
    Направление по вероятности CALL.
    |P - 0.5| < threshold -> NONE (воздержание). confidence = |P - 0.5| * 2, в [0, 1].
    """
    edge = p_call - 0.5
    confidence = min(1.0, abs(edge) * 2)
    if edge == 0 or abs(edge) < threshold:
        return "NONE", confidence
    return ("CALL" if edge > 0 else "PUT"), confidence
