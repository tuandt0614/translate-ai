# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome Manifest V3 extension that translates YouTube English subtitles to
Vietnamese. Local-only, no build step, no `package.json`.

## Commands

```bash
# Tests
node tests/background.test.js
node tests/subtitle-core.test.js
python3 tests/technical_terms.test.py

# Syntax checks
node --check background.js popup.js src/content.js src/page-bridge.js src/subtitle-core.js
python3 -m py_compile local-server/server.py local-server/technical_terms.py

# Run the local server
cd local-server
.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

## Loading the Extension

Load the root directory from `chrome://extensions` using **Load unpacked**. After
JS changes click **Reload** on the extensions page, then refresh the YouTube tab.
`background.js` (service worker) and content scripts reload independently — always
refresh the YouTube tab to pick up content script changes.

## Architecture

```text
YouTube caption track / Transcript panel
  -> src/page-bridge.js     (MAIN world, reads YouTube player API via CustomEvents)
  -> src/content.js         (parses cues, drives prefetch loop and render)
  -> background.js          (batches requests, retries, cache lifecycle, logs)
  -> local-server/server.py (FastAPI + VinAI model, POST /translate)
  -> chrome.storage.local   (caches translated cues, 30-day TTL, 25 MB cap)
  -> src/content.js         (renders draggable overlay, hides native CC)
```

### Subtitle fetch fallback chain

1. `page-bridge.js` fetches the caption track URL directly (tries JSON3, VTT, XML).
2. If YouTube blocks the URL with a PO-token requirement, `content.js` scrapes
   the Transcript panel DOM.
3. If neither works, `content.js` polls visible CC every 220 ms (realtime DOM
   fallback, debounced 350 ms before translating).

### Prefetch strategy

`content.js` pauses playback, then requests 8-cue batches in priority order:
current chunk first, earlier chunks second, later chunks last. Playback resumes
once 16 cues ahead are translated. Cache writes are debounced 2500 ms to batch
incremental updates during a prefetch run.

### Key state patterns in `src/content.js`

- **`runId`** — incremented on each new video or deactivation. Every async path
  checks `runId` on resume so stale promises from the previous video are silently
  abandoned.
- **`translatedCues`** — `{start, end, text, viText}[]`, searched by binary search
  every 100 ms (`RENDER_INTERVAL`) in the render loop.
- **`currentRequestId`** → maps to an AbortController in `background.js` for
  mid-flight cancellation via `CANCEL_TRANSLATION`.

### IPC overview

`page-bridge.js` ↔ `content.js` communicate via DOM `CustomEvent`:
- `vi_sub_fetch_request` — content → bridge (request caption URL for videoId)
- `vi_sub_fetch_result` — bridge → content (track text, format, lang; or error:
  `no_track` / `po_token_required` / `empty_response`)

`content.js` / `popup.js` ↔ `background.js` use `chrome.runtime.sendMessage`
with uppercase `type` values: `TRANSLATE_BATCH`, `CANCEL_TRANSLATION`,
`CHECK_LOCAL`, `GET_CACHE_INFO`, `CLEAR_CACHE`, `GET_LOGS`, `CLEAR_LOGS`,
`TOGGLE`, `GET_STATUS`, `CANCEL`, `WATCH_NOW`.

## Local Server

- Model: `vinai/vinai-translate-en2vi-v2`, revision pinned via
  `TRANSLATE_MODEL_REVISION`
- `NUM_BEAMS=1` favors latency; increase to 5 for quality
- Model cache: `local-server/.hf-cache/` (~2 GB, downloaded on first run)
- `technical_terms.py` replaces technical terms with `ZXQ{idx}QXZ` placeholders
  before translation and restores them afterward; handles the model inserting
  spaces inside placeholders via a whitespace-tolerant regex on restore

## Cache

Key: `viSubTranscript:<videoId>:local:vi`  
Entry: `{version: 4, complete: bool, videoId, cues: [{start, end, text, viText}], updatedAt}`  
Current version: `4`. Increment when the cue schema changes and add a migration or
eviction for old entries.

## Style

- Plain JavaScript, HTML and CSS
- Two-space indentation; semicolons in JavaScript
- Uppercase extension message types
- Kebab-case DOM IDs and CSS classes
- Preserve Vietnamese UI text unless intentionally changing copy

## Manual Checks

- Normal caption batch/prefetch path
- PO-token Transcript-panel fallback
- Seek, pause and resume while translating or transcribing
- Cache clearing and expiry behavior
- Dragging and resetting the subtitle position
- Theater and fullscreen layouts
- Local server unavailable, timeout and cancellation behavior
