const $ = id => document.getElementById(id);
const DEFAULTS = {
  localUrl: 'http://127.0.0.1:8000',
  allowRealtimeFallback: true,
  subtitleDisplayMode: 'vi',
  subtitleMaxLines: 2,
  hideOriginalCaptions: true,
  subtitleFontFamily: 'Arial',
  subtitleFontSize: 20,
  subtitleTextColor: '#ffffff',
  subtitleBackgroundColor: '#000000',
  subtitleBackgroundOpacity: 45,
  subtitleBottomPosition: 8
};
const SETTING_KEYS = Object.keys(DEFAULTS);
const STYLE_IDS = ['subtitle-display-mode', 'subtitle-font-family', 'subtitle-font-size', 'subtitle-text-color', 'subtitle-background-color', 'subtitle-background-opacity', 'subtitle-bottom-position'];
const TEXT_COLORS = ['#ffffff', '#ffeb3b', '#00ffff', '#90ee90', '#ffb6c1', '#ffb347'];
const BACKGROUND_COLORS = ['#000000', '#303030', '#0b1f3a', '#4a1018'];
let lastStatus = { active: false, busy: false, progress: '' };
let togglePending = false;

chrome.storage.sync.get(SETTING_KEYS, values => {
  const settings = { ...DEFAULTS, ...values };
  if (!TEXT_COLORS.includes(settings.subtitleTextColor)) settings.subtitleTextColor = DEFAULTS.subtitleTextColor;
  if (!BACKGROUND_COLORS.includes(settings.subtitleBackgroundColor)) settings.subtitleBackgroundColor = DEFAULTS.subtitleBackgroundColor;
  Object.entries(settings).forEach(([key, value]) => {
    const element = $(toKebab(key));
    if (!element) return;
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else element.value = value;
  });
  updatePreview();
});

STYLE_IDS.forEach(id => $(id).addEventListener('input', updatePreview));
$('subtitle-display-mode').addEventListener('change', syncDisplayModeControls);
$('save-btn').addEventListener('click', () => saveSettings(showSaved));
$('toggle-btn').addEventListener('click', () => {
  if (togglePending) return;
  togglePending = true;
  const willActivate = !lastStatus.active;
  $('toggle-btn').disabled = true;
  $('toggle-btn').textContent = willActivate ? 'Đang bật...' : 'Đang tắt...';
  $('status-text').textContent = willActivate ? 'Đang bật dịch' : 'Đang tắt dịch';
  $('progress-text').textContent = willActivate ? 'Đang gửi lệnh tới tab YouTube' : '';
  saveSettings(() => withYoutubeTab(tab => {
    sendToContent(tab.id, { type: 'TOGGLE' }, response => {
      togglePending = false;
      $('toggle-btn').disabled = false;
      if (!response) {
        updateStatus(lastStatus);
        return showMessage('Reload trang YouTube rồi thử lại.', true);
      }
      updateStatus(response);
    });
  }, true, () => {
    togglePending = false;
    $('toggle-btn').disabled = false;
    updateStatus(lastStatus);
  }));
});
$('check-local-btn').addEventListener('click', checkLocal);
$('refresh-logs-btn').addEventListener('click', loadLogs);
$('clear-logs-btn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, loadLogs));
$('copy-logs-btn').addEventListener('click', () => navigator.clipboard.writeText($('logs-output').textContent));

function saveSettings(callback) {
  const settings = {};
  Object.keys(DEFAULTS).forEach(key => {
    const element = $(toKebab(key));
    if (!element) return;
    settings[key] = element.type === 'checkbox' ? element.checked
      : element.type === 'range' || element.id === 'subtitle-max-lines' ? Number(element.value)
        : element.value.trim();
  });
  if (settings.subtitleDisplayMode === 'bilingual') settings.subtitleMaxLines = 2;
  chrome.storage.sync.set(settings, callback);
}

function updatePreview() {
  syncDisplayModeControls();
  const size = Number($('subtitle-font-size').value);
  const opacity = Number($('subtitle-background-opacity').value);
  const bottom = Number($('subtitle-bottom-position').value);
  $('font-size-value').textContent = `${size}px`;
  $('background-opacity-value').textContent = `${opacity}%`;
  $('bottom-position-value').textContent = `${bottom}%`;
  const preview = $('subtitle-preview');
  preview.style.fontFamily = $('subtitle-font-family').value;
  preview.style.fontSize = `${Math.min(size, 30)}px`;
  preview.style.color = $('subtitle-text-color').value;
  preview.style.backgroundColor = hexToRgba($('subtitle-background-color').value, opacity / 100);
  preview.textContent = $('subtitle-display-mode').value === 'bilingual'
    ? 'English sample\nBản dịch phụ đề mẫu'
    : 'Bản dịch phụ đề mẫu';
}

function syncDisplayModeControls() {
  const bilingual = $('subtitle-display-mode').value === 'bilingual';
  $('subtitle-max-lines').value = bilingual ? '2' : $('subtitle-max-lines').value;
  $('subtitle-max-lines').disabled = bilingual;
}

function checkLocal() {
  $('local-status').textContent = 'Đang kiểm tra...';
  chrome.runtime.sendMessage({ type: 'CHECK_LOCAL', localUrl: $('local-url').value.trim() }, response => {
    if (!response?.ok) return showMessage(`Không kết nối được: ${response?.error || 'unknown error'}`, true, 'local-status');
    const result = response.result;
    const device = result.device_name ? `${String(result.device).toUpperCase()} - ${result.device_name}` : result.device;
    $('local-status').textContent = `Sẵn sàng: ${device}`;
  });
}

function loadLogs() {
  chrome.runtime.sendMessage({ type: 'GET_LOGS' }, response => {
    const logs = response?.logs || [];
    $('logs-output').textContent = logs.length ? logs.slice(-30).map(log => `[${log.time}] ${log.level.toUpperCase()} ${log.scope}: ${log.message}`).join('\n') : 'Chưa có log.';
  });
}

function pollStatus() {
  withYoutubeTab(tab => sendToContent(tab.id, { type: 'GET_STATUS' }, response => {
    if (response) updateStatus(response);
    else updateStatus({ active: false, busy: false, progress: '' });
  }), false);
}

function updateStatus(response) {
  const active = Boolean(response?.active);
  const busy = Boolean(response?.busy);
  lastStatus = { active, busy, progress: response?.progress || '' };
  if (!togglePending) {
    $('toggle-btn').disabled = false;
    $('toggle-btn').textContent = active ? 'Tắt dịch' : 'Bật dịch';
  }
  $('toggle-btn').className = `btn-toggle ${active ? 'on' : 'off'}`;
  $('status-text').textContent = active ? (busy ? 'Đang tải phụ đề' : 'Đang dịch') : 'Đang tắt';
  $('progress-text').textContent = response?.progress || (active && busy ? 'Đang chuẩn bị transcript' : '');
}

function withYoutubeTab(callback, alertOnMissing = true, onMissing = () => {}) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab?.url?.includes('youtube.com/watch')) {
      if (alertOnMissing) showMessage('Hãy mở một video YouTube trước.', true);
      onMissing();
      return;
    }
    callback(tab);
  });
}

function sendToContent(tabId, message, callback = () => {}) {
  chrome.tabs.sendMessage(tabId, message, response => {
    if (chrome.runtime.lastError) {
      callback(null);
      return;
    }
    callback(response);
  });
}

function showSaved() { showMessage('Đã lưu cài đặt.'); }
function showMessage(text, error = false, target = 'save-msg') {
  const element = $(target);
  element.textContent = text;
  element.classList.toggle('error', error);
  setTimeout(() => { if (element.textContent === text) element.textContent = ''; }, 2500);
}
function toKebab(value) { return value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`); }
function hexToRgba(hex, alpha) { const value = hex.slice(1); return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${alpha})`; }

loadLogs();
pollStatus();
setInterval(pollStatus, 1000);
