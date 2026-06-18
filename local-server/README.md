# Local Translation Server

Runs an English-to-Vietnamese model locally and exposes it to the Chrome extension.

## Setup

```bash
cd local-server
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

The first start downloads the translation model. The default `NUM_BEAMS=1` favors subtitle
latency. Use `NUM_BEAMS=5` if you prefer quality over speed.

## Device selection

The server selects the best available device by default:

```text
TRANSLATE_DEVICE=auto  # CUDA -> Apple MPS -> CPU
```

You can force a device:

```bash
TRANSLATE_DEVICE=cuda python -m uvicorn server:app --host 127.0.0.1 --port 8000
TRANSLATE_DEVICE=mps python -m uvicorn server:app --host 127.0.0.1 --port 8000
TRANSLATE_DEVICE=cpu BATCH_SIZE=4 python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

NVIDIA GPUs use CUDA. Apple Silicon can use MPS. Intel/AMD integrated graphics
normally run through CPU mode unless you install and validate a compatible PyTorch
backend yourself.

Default model:

```text
vinai/vinai-translate-en2vi-v2
```

The model is pinned to a reviewed Hugging Face commit through
`TRANSLATE_MODEL_REVISION`. Update that revision deliberately when upgrading.

The server currently configures VinAI's `en_XX` to `vi_VN` language tokens.
Do not override `TRANSLATE_MODEL` with NLLB until matching language-token support
is added.

Keep the server bound to `127.0.0.1`. Do not expose port 8000 publicly. Requests
are limited by `MAX_BATCH_ITEMS` and `MAX_TEXT_LENGTH`.

## Test

```bash
curl http://127.0.0.1:8000/health
curl -X POST http://127.0.0.1:8000/translate \
  -H 'Content-Type: application/json' \
  -d '{"texts":["Hello everyone","This is a subtitle"]}'
```

Set the local server URL in the extension popup. All processing stays local.
