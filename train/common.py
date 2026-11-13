"""Общие части обучения и оценки. Не дублирует логику сервиса: импортирует её из llm/llm_server.py."""
import math
import os
import sys

import json
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "llm"))

from llm_server import SYSTEM_PROMPT, build_user_prompt  # noqa: E402

with open(os.path.join(ROOT, "config", "segments.json"), encoding="utf-8") as _f:
    CONFIG = json.load(_f)

RETURNS_COUNT = 20           # совпадает с RETURNS_COUNT в llmCore.js
PAYOUT_DEFAULT = CONFIG["payout"]


def segment_of(pair: str) -> str:
    """Совпадает с segmentOf() в config/index.js: OTC в имени -> otc, иначе currency."""
    return "otc" if re.search(r"otc", pair or "", re.I) else "currency"


def segment_config(segment: str) -> dict:
    cfg = CONFIG["segments"].get(segment)
    if cfg is None:
        raise ValueError(f"неизвестный сегмент: {segment}")
    for f in cfg["features"]:
        if f not in CONFIG["implemented_features"]:
            raise ValueError(f"сегмент {segment}: признак '{f}' не реализован")
    return cfg


def js_round(x: float) -> int:
    """Math.round из JavaScript: .5 округляется в сторону +∞ (Python round этого не делает)."""
    return math.floor(x + 0.5)


def breakeven(payout: float = PAYOUT_DEFAULT) -> float:
    """Доля успешных сделок, при которой бинарный опцион выходит в ноль."""
    return 1.0 / (1.0 + payout)


def returns_bp(closes):
    """Доходности в б.п. по закрытиям, как в buildRequest() (llmCore.js)."""
    out = []
    for i in range(1, len(closes)):
        out.append(js_round((closes[i] / closes[i - 1] - 1.0) * 1e4))
    return out


def make_prompt(pair: str, period_sec: int, window_closes):
    """Промпт для одного примера. window_closes: RETURNS_COUNT + 1 закрытий, последнее — текущий бар."""
    tail = window_closes[-(RETURNS_COUNT + 1):]
    return build_user_prompt({
        "pair": pair,
        "tf": period_sec,
        "returns_bp": returns_bp(tail),
        "indicators": {},            # пока индикаторы не используются (см. LLM_USE_INDICATORS)
    })


def target_json(action: str) -> str:
    """Ответ для обучения. Уверенность и причина фиксированы: модель учится только направлению."""
    return '{"action":"%s","confidence":0.5,"reason":"returns"}' % action


def wilson(k: int, n: int, z: float = 1.96):
    """Доверительный интервал Уилсона для доли k/n (в долях, не в процентах)."""
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def binom_two_sided_p(k: int, n: int, p0: float = 0.5) -> float:
    """Точный двусторонний биномиальный тест против p0. Считается в логарифмах (без переполнения)."""
    if n == 0:
        return float("nan")
    lp0, lp1 = math.log(p0), math.log(1 - p0)

    def logpmf(i):
        return (math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1)
                + i * lp0 + (n - i) * lp1)

    obs = logpmf(k)
    total = 0.0
    for i in range(n + 1):
        lp = logpmf(i)
        if lp <= obs + 1e-9:
            total += math.exp(lp)
    return min(1.0, total)
