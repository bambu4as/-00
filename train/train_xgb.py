import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.metrics import accuracy_score, classification_report, roc_auc_score
import joblib
import warnings

warnings.filterwarnings('ignore')

# ==========================================
# 1. НАСТРОЙКИ (Адаптируйте под ваш формат данных)
# ==========================================
DATA_PATH = '../data/otc_data.csv'  # Путь к вашим историческим данным
MODEL_PATH = '../ml/xgb_otc_model.json'
TARGET_SHIFT = 3  # На сколько свечей вперед предсказываем (горизонт прогноза)
TRAIN_RATIO = 0.8 # 80% данных на обучение, 20% на тест (строго по времени!)

# ==========================================
# 2. ЗАГРУЗКА И ПОДГОТОВКА ДАННЫХ
# ==========================================
print("📊 Загрузка данных...")
try:
    # Ожидаем колонки: 'timestamp', 'open', 'high', 'low', 'close', 'volume'
    df = pd.read_csv(DATA_PATH, parse_dates=['timestamp'])
    df = df.sort_values('timestamp').reset_index(drop=True)
    print(f"✅ Загружено {len(df)} строк.")
except Exception as e:
    print(f"❌ Ошибка загрузки данных: {e}")
    print("💡 Убедитесь, что файл существует и имеет колонки: timestamp, open, high, low, close, volume")
    exit()

# ==========================================
# 3. ГЕНЕРАЦИЯ ПРИЗНАКОВ (Feature Engineering)
# ==========================================
print("🛠 Расчет индикаторов...")
# Используем pandas_ta для быстрого расчета. Если нет, можно написать свои функции.
import pandas_ta as ta

df['rsi'] = ta.rsi(df['close'], length=14)
df['macd'], df['macd_signal'], df['macd_hist'] = ta.macd(df['close'], fast=12, slow=26, signal=9)
df['bb_upper'], df['bb_middle'], df['bb_lower'] = ta.bbands(df['close'], length=20, std=2).iloc[:, 0:3].values.T
df['atr'] = ta.atr(df['high'], df['low'], df['close'], length=14)

# Дополнительные признаки: доходность и волатильность
df['return_1'] = df['close'].pct_change(1)
df['return_5'] = df['close'].pct_change(5)
df['volatility'] = df['return_1'].rolling(window=10).std()

# ==========================================
# 4. СОЗДАНИЕ ЦЕЛЕВОЙ ПЕРЕМЕННОЙ (Target)
# ==========================================
# Задача классификации: 1 = цена вырастет через TARGET_SHIFT свечей, 0 = упадет или останется на месте
df['target'] = (df['close'].shift(-TARGET_SHIFT) > df['close']).astype(int)

# ==========================================
# 5. ОЧИСТКА ДАННЫХ (КРИТИЧЕСКИ ВАЖНО ДЛЯ XGBOOST)
# ==========================================
print("🧹 Очистка данных от NaN и Inf...")
initial_len = len(df)
df = df.replace([np.inf, -np.inf], np.nan)
df = df.dropna(subset=['rsi', 'macd', 'bb_upper', 'atr', 'target']) # Удаляем строки с NaN
print(f"✅ Удалено {initial_len - len(df)} строк с пропущенными значениями. Осталось: {len(df)}")

# ==========================================
# 6. РАЗДЕЛЕНИЕ НА ОБУЧЕНИЕ И ТЕСТ (TIME-SERIES SPLIT)
# ==========================================
# НИКОГДА не используйте shuffle=True для временных рядов!
split_idx = int(len(df) * TRAIN_RATIO)
train_df = df.iloc[:split_idx]
test_df = df.iloc[split_idx:]

# Определяем колонки-признаки (все кроме служебных и target)
exclude_cols = ['timestamp', 'target', 'open', 'high', 'low', 'close', 'volume']
features = [col for col in df.columns if col not in exclude_cols]

X_train, y_train = train_df[features], train_df['target']
X_test, y_test = test_df[features], test_df['target']

print(f"📈 Обучение на {len(X_train)} примерах, тест на {len(X_test)} примерах.")
print(f"🎯 Признаки: {features}")

# ==========================================
# 7. ОБУЧЕНИЕ XGBOOST (БЕЗОПАСНЫЕ ГИПЕРПАРАМЕТРЫ)
# ==========================================
print("🚀 Запуск обучения XGBoost...")

# Для OTC и шумных данных нужны КОНСЕРВАТИВНЫЕ параметры, чтобы не переобучиться
model = xgb.XGBClassifier(
    n_estimators=500,          # Количество деревьев
    max_depth=4,               # Глубина дерева (4-5 идеально для шума, не больше!)
    learning_rate=0.05,        # Скорость обучения (медленнее = стабильнее)
    subsample=0.8,             # Доля строк для каждого дерева
    colsample_bytree=0.8,      # Доля признаков для каждого дерева
    min_child_weight=5,        # Минимальное кол-во наблюдений в листе (защита от шума)
    gamma=0.1,                 # Минимальная потеря для дальнейшего разбиения узла
    scale_pos_weight=1.0,      # Если классов 0 и 1 сильно неравное кол-во, поставьте здесь соотношение (напр. 2.0)
    eval_metric='auc',         # Метрика для early stopping
    use_label_encoder=False,
    random_state=42
)

# Обучение с ранней остановкой (Early Stopping)
eval_set = [(X_train, y_train), (X_test, y_test)]
model.fit(
    X_train, y_train,
    eval_set=eval_set,
    early_stopping_rounds=50,  # Остановить, если 50 эпох нет улучшения
    verbose=50                 # Печатать прогресс каждые 50 итераций
)

# ==========================================
# 8. ОЦЕНКА И СОХРАНЕНИЕ
# ==========================================
print("\n📊 Результаты на тестовой выборке:")
y_pred = model.predict(X_test)
y_pred_proba = model.predict_proba(X_test)[:, 1]

print(f"Accuracy: {accuracy_score(y_test, y_pred):.4f}")
print(f"ROC-AUC:  {roc_auc_score(y_test, y_pred_proba):.4f}")
print("\nClassification Report:\n", classification_report(y_test, y_pred))

# Важность признаков
print("\n🏆 Топ-5 самых важных признаков:")
importance = model.feature_importances_
feature_imp = pd.DataFrame({'feature': features, 'importance': importance}).sort_values('importance', ascending=False)
print(feature_imp.head(5))

# Сохранение модели
model.save_model(MODEL_PATH)
print(f"\n💾 Модель успешно сохранена в: {MODEL_PATH}")