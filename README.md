# YouTube VI Subtitles

Local-only Chrome Manifest V3 extension that translates English YouTube subtitles to Vietnamese. The extension reads YouTube caption tracks or the Transcript panel, sends subtitle batches to a local FastAPI server, and renders a draggable Vietnamese subtitle overlay on the video.

Vietnamese documentation: [README.vi.md](README.vi.md)

## Features

- English-to-Vietnamese subtitle translation for YouTube videos.
- Local translation server using `vinai/vinai-translate-en2vi-v2`.
- No Gemini, Claude, OpenAI, or cloud API keys.
- Batch prefetch for normal caption tracks.
- PO-token fallback through YouTube's Transcript panel.
- Realtime visible-CC fallback when transcript extraction is blocked.
- Vietnamese-only or bilingual English/Vietnamese display.
- Draggable subtitle overlay, font/color controls, cache/log controls, and keyboard commands.

## Hardware Support

The server can run without a dedicated GPU. It selects the best available device automatically:

| Machine | Supported mode | Notes |
| --- | --- | --- |
| NVIDIA GPU with CUDA | `cuda` | Fastest option. Install a PyTorch build matching your CUDA setup. |
| Apple Silicon Mac | `mps` | Uses Apple Metal Performance Shaders when available. |
| Intel/AMD integrated graphics | `cpu` | Works through CPU mode. Integrated GPUs are not used by this server by default. |
| AMD GPU on Linux | usually `cpu` | ROCm may work only with a compatible PyTorch install and supported AMD GPU. |
| Any laptop/desktop CPU | `cpu` | Slower but supported. Reduce `BATCH_SIZE` if the machine is weak. |

Device selection is controlled by `TRANSLATE_DEVICE`:

```bash
TRANSLATE_DEVICE=auto  # default: CUDA -> MPS -> CPU
TRANSLATE_DEVICE=cuda  # force NVIDIA CUDA
TRANSLATE_DEVICE=mps   # force Apple Silicon MPS
TRANSLATE_DEVICE=cpu   # force CPU
```

Check the active device:

```bash
curl http://127.0.0.1:8000/health
```

## Requirements

- Chrome or another Chromium browser that supports Manifest V3 extensions.
- Python 3.10+ recommended.
- Internet access on first server start to download the VinAI model from Hugging Face.
- Enough disk space for the model cache in `local-server/.hf-cache/`.

## Install the Local Server

```bash
cd local-server
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows PowerShell:

```powershell
cd local-server
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Run the Local Server

Default auto device selection:

```bash
cd local-server
.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

CPU-friendly mode:

```bash
cd local-server
TRANSLATE_DEVICE=cpu BATCH_SIZE=4 .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

NVIDIA CUDA:

```bash
cd local-server
TRANSLATE_DEVICE=cuda .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Apple Silicon:

```bash
cd local-server
TRANSLATE_DEVICE=mps .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Keep the server bound to `127.0.0.1`. Do not expose port `8000` publicly.

## Load the Chrome Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository root directory.
5. Open a YouTube video.
6. Open the extension popup and click **Bật dịch**.

After changing extension files, click **Reload** on `chrome://extensions` and refresh the YouTube tab.

## Popup Settings

- **Địa chỉ server**: defaults to `http://127.0.0.1:8000`.
- **Dùng CC đang hiển thị khi transcript lỗi**: realtime fallback when YouTube blocks transcript extraction.
- **Nội dung**: Vietnamese only or bilingual English + Vietnamese.
- **Ẩn CC YouTube khi bật dịch**: hides original YouTube captions when translated text is available.
- Font, text color, background color, opacity, and bottom position are saved in `chrome.storage.sync`.

## Troubleshooting

### Local server is not ready

Start the server first, then check:

```bash
curl http://127.0.0.1:8000/health
```

### Video requires PO token

Some YouTube videos block direct subtitle URLs. The extension tries the Transcript panel, then falls back to realtime visible CC. If realtime fallback is used, make sure English CC is available on the video.

### CPU is too slow

Use smaller batches:

```bash
TRANSLATE_DEVICE=cpu BATCH_SIZE=4 NUM_BEAMS=1 .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

### CUDA was requested but is unavailable

Install the correct NVIDIA driver and a CUDA-compatible PyTorch build, or run with:

```bash
TRANSLATE_DEVICE=cpu
```

### New video shows old subtitles

Reload the extension and refresh the YouTube tab. The content script guards subtitle rendering by URL and YouTube player video ID, so translated text should only display for the active video.

## Tests

From the repository root:

```bash
node tests/background.test.js
node tests/subtitle-core.test.js
python3 tests/technical_terms.test.py
python3 -m py_compile local-server/server.py local-server/technical_terms.py
```

## GitHub Actions Workflow

This repository includes `.github/workflows/ci.yml`. The workflow runs on pushes
and pull requests to `main`, plus manual `workflow_dispatch`.

The CI job intentionally stays lightweight:

- Validates `manifest.json`.
- Checks JavaScript syntax with `node --check`.
- Runs Node tests for `background.js` and `src/subtitle-core.js`.
- Runs the Python technical-term test.
- Compiles backend Python files with `py_compile`.

CI does not download the VinAI model and does not start the local FastAPI server.
That keeps GitHub Actions fast and avoids requiring GPU/model cache in CI.

## Security Notes

- No cloud API credentials are required.
- Do not commit `.venv/`, `.hf-cache/`, `__pycache__/`, `.env`, logs, model files, or keys.
- The default `.gitignore` excludes local environments and model cache.
- FastAPI should remain bound to `127.0.0.1`.
- The model revision is pinned through `TRANSLATE_MODEL_REVISION`; update it deliberately.
- `trust_remote_code=True` is used only with the pinned model revision.

## Model License

The default VinAI model uses AGPL-3.0. Review redistribution and commercial-use obligations before distributing a bundle that includes model files or server components.
