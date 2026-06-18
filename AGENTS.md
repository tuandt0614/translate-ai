# Repository Guidelines

## Project Structure & Module Organization

This is a local-only Chrome Manifest V3 extension that translates English
YouTube subtitles to Vietnamese.

- `manifest.json` defines narrow YouTube/localhost access, content scripts and
  keyboard commands.
- `background.js` calls the local translation server and manages retries,
  cancellation, logs and subtitle cache lifecycle.
- `popup.html`, `popup.css` and `popup.js` implement settings, local server
  status, cache controls and translation progress.
- `src/page-bridge.js` runs in YouTube's page context and reads caption tracks.
- `src/subtitle-core.js` contains testable subtitle parsers and cue lookup logic.
- `src/content.js` manages transcript loading, prefetch, rendering, fallback and
  YouTube SPA navigation.
- `src/subtitle.css` styles the draggable subtitle overlay.
- `local-server/` contains the required FastAPI/VinAI translation backend.
- `tests/` contains Node and Python tests.

YouTube may require a Proof-of-Origin token for direct subtitle URLs. In that
case, `src/content.js` tries timestamped cues from YouTube's Transcript panel,
then optionally reads visible English CC as a realtime fallback. Videos without
English captions or a usable Transcript panel are not supported.

## Build, Test, and Development Commands

There is no `package.json` or build step.

- Load the root directory from `chrome://extensions` using **Load unpacked**.
- After extension changes, click **Reload** and refresh the YouTube tab.
- `node tests/background.test.js` tests local requests, retries and responses.
- `node tests/subtitle-core.test.js` tests JSON3/VTT/XML parsing and cue lookup.
- `python3 tests/technical_terms.test.py` tests automatic technical-term
  preservation.
- `python3 -m py_compile local-server/server.py local-server/technical_terms.py`
  checks backend syntax.
- `cd local-server && .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000`
  runs the local server.

## Coding Style & Naming Conventions

Use plain JavaScript, HTML, CSS and Python. Match existing style:

- Two-space indentation in JavaScript, JSON and Python files.
- Prefer `const`/`let`, arrow callbacks and semicolons in JavaScript.
- Message `type` values use uppercase strings such as `TRANSLATE_BATCH`,
  `GET_STATUS` and `CANCEL`.
- DOM IDs and CSS classes use kebab-case.
- Keep comments short and preserve Vietnamese UI text unless intentionally
  changing user-facing copy.

## Testing Guidelines

Run all automated tests, then validate manually in Chrome:

- Confirm the extension and service worker load without errors.
- Confirm the local server status reports the expected CPU/GPU and model commit.
- Test a normal English caption track and verify batch prefetch before playback.
- Test a PO-token video and verify Transcript-panel extraction is attempted.
- Test realtime visible-CC fallback, including forward/backward seeking.
- Verify cancellation and **Xem ngay** release a preloaded video correctly.
- Verify cache information, manual clearing and reuse on a second viewing.
- Test Vietnamese-only and bilingual display, CC hiding and maximum line count.
- Drag the subtitle overlay, double-click to reset it, and test theater/fullscreen.
- Confirm keyboard commands and popup settings persist through
  `chrome.storage.sync`.

## Commit & Pull Request Guidelines

Use short imperative commit messages such as `Harden local translation cache` or
`Fix subtitle drag position`.

Pull requests should include:

- A concise behavior summary.
- Automated and manual validation steps.
- Browser and operating system tested.
- Screenshots or recordings for popup/subtitle UI changes.
- Notes for manifest permission, model revision or local-server changes.

## Security & Configuration Tips

The extension does not use Gemini, Claude, OpenAI or any cloud API key. Do not
add cloud credentials or hard-code secrets. Keep manifest permissions limited to
YouTube and `localhost`/`127.0.0.1`.

The VinAI model is downloaded from Hugging Face on the first server start and
stored in `local-server/.hf-cache/`. Translation then runs on the local CPU/GPU.
The model revision is pinned through `TRANSLATE_MODEL_REVISION`; review and
update that commit deliberately. Keep `trust_remote_code=True` paired with a
pinned revision.

Never commit `.venv/`, `.hf-cache/`, `__pycache__/`, `.env`, keys, logs or model
weights. Root `.gitignore` already excludes these. Bind FastAPI only to
`127.0.0.1`; do not expose port 8000 publicly. Request size is limited by
`MAX_BATCH_ITEMS` and `MAX_TEXT_LENGTH`.

The VinAI model uses AGPL-3.0. Review redistribution and commercial-use
obligations before distributing a bundle that includes model files or server
components.
