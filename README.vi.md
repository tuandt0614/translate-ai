# YouTube VI Subtitles

Extension Chrome Manifest V3 chạy local để dịch phụ đề tiếng Anh trên YouTube sang tiếng Việt. Extension đọc caption track hoặc bảng Transcript của YouTube, gửi subtitle theo batch tới server FastAPI chạy trên máy bạn, rồi hiển thị lớp phụ đề tiếng Việt có thể kéo thả trên video.

English documentation: [README.md](README.md)

## Tính năng

- Dịch phụ đề YouTube từ tiếng Anh sang tiếng Việt.
- Server dịch local dùng `vinai/vinai-translate-en2vi-v2`.
- Không dùng Gemini, Claude, OpenAI hay cloud API key.
- Prefetch theo batch cho video có caption track bình thường.
- Fallback đọc bảng Transcript khi YouTube yêu cầu PO-token.
- Fallback realtime từ CC đang hiển thị khi không lấy được transcript.
- Hiển thị chỉ tiếng Việt hoặc song ngữ Anh + Việt.
- Overlay phụ đề kéo thả được, chỉnh font/màu/vị trí, xem log và phím tắt.

## Hỗ trợ phần cứng

Không bắt buộc có card đồ họa rời. Server tự chọn device tốt nhất có sẵn:

| Máy | Chế độ hỗ trợ | Ghi chú |
| --- | --- | --- |
| NVIDIA GPU có CUDA | `cuda` | Nhanh nhất. Cần driver NVIDIA và bản PyTorch phù hợp CUDA. |
| Mac Apple Silicon | `mps` | Dùng Apple Metal Performance Shaders nếu có. |
| Intel/AMD card tích hợp | `cpu` | Chạy được bằng CPU. Server hiện không dùng iGPU Intel/AMD theo mặc định. |
| AMD GPU trên Linux | thường là `cpu` | ROCm chỉ khả thi nếu GPU và PyTorch build tương thích. |
| Laptop/desktop chỉ có CPU | `cpu` | Chạy được nhưng chậm hơn. Máy yếu nên giảm `BATCH_SIZE`. |

Chọn device bằng biến môi trường `TRANSLATE_DEVICE`:

```bash
TRANSLATE_DEVICE=auto  # mặc định: CUDA -> MPS -> CPU
TRANSLATE_DEVICE=cuda  # ép chạy NVIDIA CUDA
TRANSLATE_DEVICE=mps   # ép chạy Apple Silicon MPS
TRANSLATE_DEVICE=cpu   # ép chạy CPU
```

Kiểm tra server đang dùng device nào:

```bash
curl http://127.0.0.1:8000/health
```

## Yêu cầu

- Chrome hoặc trình duyệt Chromium hỗ trợ Manifest V3.
- Khuyến nghị Python 3.10+.
- Lần chạy server đầu tiên cần mạng để tải model VinAI từ Hugging Face.
- Cần đủ dung lượng cho model cache trong `local-server/.hf-cache/`.

## Cài local server

Linux/macOS/WSL:

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

## Chạy local server

Tự chọn device:

```bash
cd local-server
.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Chế độ nhẹ hơn cho CPU:

```bash
cd local-server
TRANSLATE_DEVICE=cpu BATCH_SIZE=4 .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

NVIDIA CUDA:

```bash
cd local-server
TRANSLATE_DEVICE=cuda .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Mac Apple Silicon:

```bash
cd local-server
TRANSLATE_DEVICE=mps .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Luôn bind server vào `127.0.0.1`. Không mở port `8000` ra public.

## Load extension trong Chrome

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Bấm **Load unpacked**.
4. Chọn thư mục root của repo này.
5. Mở một video YouTube.
6. Mở popup extension và bấm **Bật dịch**.

Sau khi sửa code extension, bấm **Reload** trong `chrome://extensions` rồi refresh tab YouTube.

## Cài đặt trong popup

- **Địa chỉ server**: mặc định `http://127.0.0.1:8000`.
- **Dùng CC đang hiển thị khi transcript lỗi**: fallback realtime nếu YouTube chặn transcript.
- **Nội dung**: chỉ tiếng Việt hoặc song ngữ Anh + Việt.
- **Ẩn CC YouTube khi bật dịch**: ẩn CC gốc khi đã có bản dịch.
- Font, màu chữ, màu nền, độ mờ và vị trí phụ đề được lưu trong `chrome.storage.sync`.

## Xử lý lỗi thường gặp

### Local server chưa sẵn sàng

Chạy server trước, rồi kiểm tra:

```bash
curl http://127.0.0.1:8000/health
```

### Video yêu cầu PO-token

Một số video YouTube chặn URL subtitle trực tiếp. Extension sẽ thử bảng Transcript, sau đó fallback realtime từ CC đang hiển thị. Nếu dùng realtime fallback, video cần có CC tiếng Anh.

### CPU chạy chậm

Giảm batch:

```bash
TRANSLATE_DEVICE=cpu BATCH_SIZE=4 NUM_BEAMS=1 .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

### Ép CUDA nhưng không có CUDA

Cài driver NVIDIA và PyTorch bản CUDA phù hợp, hoặc chạy CPU:

```bash
TRANSLATE_DEVICE=cpu
```

### Mở video mới vẫn thấy phụ đề cũ

Reload extension và refresh tab YouTube. Content script đã chặn render theo cả URL videoId và videoId thật của YouTube player, nên bản dịch chỉ được hiện khi đúng video đang phát.

## Chạy test

Từ thư mục root:

```bash
node tests/background.test.js
node tests/subtitle-core.test.js
python3 tests/technical_terms.test.py
python3 -m py_compile local-server/server.py local-server/technical_terms.py
```

## GitHub Actions Workflow

Repo có sẵn `.github/workflows/ci.yml`. Workflow chạy khi push hoặc tạo pull
request vào nhánh `main`, và cũng có thể chạy thủ công bằng `workflow_dispatch`.

CI được giữ nhẹ:

- Kiểm tra `manifest.json` hợp lệ.
- Kiểm tra cú pháp JavaScript bằng `node --check`.
- Chạy test Node cho `background.js` và `src/subtitle-core.js`.
- Chạy test Python cho technical terms.
- Compile file Python backend bằng `py_compile`.

CI không tải model VinAI và không start FastAPI server local. Cách này giúp
GitHub Actions chạy nhanh, không cần GPU và không cần model cache.

## Lưu ý bảo mật

- Không cần cloud API credential.
- Không commit `.venv/`, `.hf-cache/`, `__pycache__/`, `.env`, log, model file hoặc key.
- `.gitignore` mặc định đã loại môi trường local và model cache.
- FastAPI nên luôn chạy ở `127.0.0.1`.
- Model revision được pin qua `TRANSLATE_MODEL_REVISION`; chỉ update khi đã review.
- `trust_remote_code=True` chỉ dùng cùng revision đã pin.

## License model

Model VinAI mặc định dùng AGPL-3.0. Hãy kiểm tra nghĩa vụ redistributing/commercial-use trước khi phân phối bundle có kèm model hoặc server component.
