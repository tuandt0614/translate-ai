from __future__ import annotations

import os
import time
from typing import List

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("HF_HOME", os.path.join(SERVER_DIR, ".hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

from technical_terms import protect_technical_terms, restore_technical_terms


MODEL_NAME = os.getenv("TRANSLATE_MODEL", "vinai/vinai-translate-en2vi-v2")
MODEL_REVISION = os.getenv("TRANSLATE_MODEL_REVISION", "82f8c91bd22e82085186b45a8a76373f5a79f667")
MAX_LENGTH = int(os.getenv("MAX_LENGTH", "256"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "8"))
NUM_BEAMS = int(os.getenv("NUM_BEAMS", "1"))
MAX_BATCH_ITEMS = int(os.getenv("MAX_BATCH_ITEMS", "128"))
MAX_TEXT_LENGTH = int(os.getenv("MAX_TEXT_LENGTH", "2000"))
REQUESTED_DEVICE = os.getenv("TRANSLATE_DEVICE", "auto").strip().lower()


app = FastAPI(title="Local EN-VI Translator")


def select_device(requested_device: str) -> torch.device:
  if requested_device in ("", "auto"):
    if torch.cuda.is_available():
      return torch.device("cuda")
    if is_mps_available():
      return torch.device("mps")
    return torch.device("cpu")

  if requested_device == "cuda":
    if not torch.cuda.is_available():
      raise RuntimeError("TRANSLATE_DEVICE=cuda was requested, but CUDA is not available")
    return torch.device("cuda")

  if requested_device == "mps":
    if not is_mps_available():
      raise RuntimeError("TRANSLATE_DEVICE=mps was requested, but Apple MPS is not available")
    return torch.device("mps")

  if requested_device == "cpu":
    return torch.device("cpu")

  raise RuntimeError("TRANSLATE_DEVICE must be one of: auto, cuda, mps, cpu")


def is_mps_available() -> bool:
  return bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())


def get_device_name(current_device: torch.device) -> str:
  if current_device.type == "cuda":
    return torch.cuda.get_device_name(0)
  if current_device.type == "mps":
    return "Apple Metal Performance Shaders"
  return "CPU"


device = select_device(REQUESTED_DEVICE)
tokenizer = AutoTokenizer.from_pretrained(
  MODEL_NAME,
  src_lang="en_XX",
  revision=MODEL_REVISION,
  use_fast=False,
  trust_remote_code=True,
)
model = AutoModelForSeq2SeqLM.from_pretrained(
  MODEL_NAME,
  revision=MODEL_REVISION,
  trust_remote_code=True,
)
model.to(device)
model.eval()

if device.type == "cuda":
  model.half()


class TranslateRequest(BaseModel):
  texts: List[str]


@app.get("/health")
def health() -> dict:
  return {
    "ok": True,
    "model": MODEL_NAME,
    "model_revision": MODEL_REVISION,
    "requested_device": REQUESTED_DEVICE,
    "device": device.type,
    "device_name": get_device_name(device),
    "cuda_available": torch.cuda.is_available(),
    "mps_available": is_mps_available(),
    "cuda_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
  }


@app.post("/translate")
def translate(req: TranslateRequest) -> dict:
  started_at = time.perf_counter()
  if len(req.texts) > MAX_BATCH_ITEMS:
    raise HTTPException(status_code=413, detail=f"Too many texts; maximum is {MAX_BATCH_ITEMS}")
  if any(len(text) > MAX_TEXT_LENGTH for text in req.texts):
    raise HTTPException(status_code=413, detail=f"Text is too long; maximum is {MAX_TEXT_LENGTH} characters")
  texts = [text.strip() for text in req.texts]
  translations = [""] * len(texts)
  non_empty = [(index, text) for index, text in enumerate(texts) if text]

  for start in range(0, len(non_empty), BATCH_SIZE):
    batch_items = non_empty[start:start + BATCH_SIZE]
    batch_translations = translate_batch([text for _, text in batch_items])
    for (index, _text), translated in zip(batch_items, batch_translations):
      translations[index] = translated

  return {
    "translations": translations,
    "latency_ms": round((time.perf_counter() - started_at) * 1000),
  }


def translate_batch(texts: List[str]) -> List[str]:
  if not texts:
    return []

  protected_texts = []
  protected_terms = []
  for text in texts:
    protected, terms = protect_technical_terms(text)
    protected_texts.append(protected)
    protected_terms.append(terms)

  inputs = tokenizer(
    protected_texts,
    return_tensors="pt",
    padding=True,
    truncation=True,
    max_length=MAX_LENGTH,
  ).to(device)

  generation_options = {
    "decoder_start_token_id": tokenizer.lang_code_to_id["vi_VN"],
    "max_length": MAX_LENGTH,
    "num_return_sequences": 1,
    "num_beams": NUM_BEAMS,
  }
  if NUM_BEAMS > 1:
    generation_options["early_stopping"] = True

  with torch.inference_mode():
    outputs = model.generate(
      **inputs,
      **generation_options,
    )

  decoded = tokenizer.batch_decode(outputs, skip_special_tokens=True)
  return [restore_technical_terms(text, terms) for text, terms in zip(decoded, protected_terms)]
