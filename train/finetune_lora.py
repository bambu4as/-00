"""
finetune_lora.py — LoRA-дообучение Qwen2.5-3B-Instruct на train.jsonl (валидация на val.jsonl).

ВНИМАНИЕ: скрипт не проверен на реальном железе (в среде разработки нет GPU/torch).
Перед запуском проверьте версии: transformers, peft, datasets, torch.

Установка (пример, GPU с 12+ ГБ или CPU, очень медленно):
  pip install "torch" "transformers>=4.44" "peft>=0.12" "datasets>=2.20" accelerate

Запуск:
  python3 train/finetune_lora.py --data train/data --out train/out/lora

Потери считаются ТОЛЬКО по токенам ответа (промпт маскируется как -100).
Низкий eval_loss не означает прибыльность: выбирайте чекпойнт по tools/оценке на val
(train/evaluate.py --split val), а тест используйте один раз.
"""
import argparse
import json
import os

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model
from transformers import (AutoModelForCausalLM, AutoTokenizer, DataCollatorForSeq2Seq,
                          Trainer, TrainingArguments)

BASE = "Qwen/Qwen2.5-3B-Instruct"


def load(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def make_encoder(tok, max_len):
    def encode(ex):
        msgs = ex["messages"]
        prompt = tok.apply_chat_template(msgs[:2], tokenize=False, add_generation_prompt=True)
        full = prompt + msgs[2]["content"] + tok.eos_token
        p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
        f_ids = tok(full, add_special_tokens=False)["input_ids"][:max_len]
        labels = ([-100] * len(p_ids) + f_ids[len(p_ids):])[:max_len]
        return {"input_ids": f_ids, "attention_mask": [1] * len(f_ids), "labels": labels}
    return encode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--segment", required=True, choices=["currency", "otc"])
    ap.add_argument("--data", help="по умолчанию train/data/<сегмент>")
    ap.add_argument("--out", help="по умолчанию train/out/<сегмент>/lora")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--rank", type=int, default=16)
    args = ap.parse_args()
    args.data = args.data or os.path.join("train", "data", args.segment)
    args.out = args.out or os.path.join("train", "out", args.segment, "lora")

    tok = AutoTokenizer.from_pretrained(BASE)
    tok.pad_token = tok.pad_token or tok.eos_token
    enc = make_encoder(tok, args.max_len)

    train_ds = Dataset.from_list(load(os.path.join(args.data, "train.jsonl"))).map(enc, remove_columns=["pair", "t", "prompt", "action", "messages"])
    val_ds = Dataset.from_list(load(os.path.join(args.data, "val.jsonl"))).map(enc, remove_columns=["pair", "t", "prompt", "action", "messages"])

    use_bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    model = AutoModelForCausalLM.from_pretrained(
        BASE, torch_dtype=torch.bfloat16 if use_bf16 else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None)
    model.config.use_cache = False

    lcfg = LoraConfig(r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0.05,
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
                      task_type="CAUSAL_LM")
    model = get_peft_model(model, lcfg)
    model.print_trainable_parameters()

    targs = TrainingArguments(
        output_dir=os.path.join(args.out, "ckpt"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        per_device_eval_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=50,
        eval_strategy="steps",
        eval_steps=500,
        save_strategy="steps",
        save_steps=500,
        save_total_limit=3,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        bf16=use_bf16,
        report_to="none",
        remove_unused_columns=False,
    )
    trainer = Trainer(model=model, args=targs, train_dataset=train_ds, eval_dataset=val_ds,
                      data_collator=DataCollatorForSeq2Seq(tok, padding=True, label_pad_token_id=-100))
    trainer.train()

    adapter_dir = os.path.join(args.out, "adapter")
    model.save_pretrained(adapter_dir)
    tok.save_pretrained(adapter_dir)
    print(f"адаптер сохранён: {adapter_dir}")
    print("Дальше: слить с базой (merge_and_unload) и конвертировать в GGUF Q4_K_M, см. train/README.md")


if __name__ == "__main__":
    main()
