// Local-only service worker for translation and logging.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRANSLATE' || msg.type === 'TRANSLATE_BATCH') {
    const texts = msg.type === 'TRANSLATE' ? [msg.text] : (msg.texts || []);
    translateBatch(texts, msg.settings || {}, msg.requestId)
      .then(result => sendResponse({ ok: true, result: msg.type === 'TRANSLATE' ? result[0] : result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'CANCEL_TRANSLATION') {
    cancelRequest(msg.requestId);
    sendResponse({ ok: true });
  }
  if (msg.type === 'CHECK_LOCAL') {
    checkLocalHealth(msg.localUrl)
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'LOG') {
    appendLog(msg.level || 'info', msg.scope || 'content', msg.message);
    sendResponse({ ok: true });
  }
  if (msg.type === 'GET_LOGS') {
    getLogs().then(logs => sendResponse({ ok: true, logs }));
    return true;
  }
  if (msg.type === 'CLEAR_LOGS') {
    chrome.storage.local.set({ [LOG_KEY]: [] }, () => sendResponse({ ok: true }));
    return true;
  }
});

if (chrome.webNavigation) {
  const filter = { url: [{ hostEquals: 'www.youtube.com', pathPrefix: '/watch' }] };
  chrome.webNavigation.onHistoryStateUpdated?.addListener(notifyYouTubeVideoChanged, filter);
  chrome.webNavigation.onCommitted?.addListener(notifyYouTubeVideoChanged, filter);
}

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8000';
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_RETRIES = 2;
const LOG_KEY = 'viSubLogs';
const MAX_LOGS = 80;
const CACHE_PREFIX = 'viSubTranscript:';
const MAX_TRANSLATE_TEXT_LENGTH = 1800;
const LOCAL_BATCH_LIMIT = 64;
const activeRequests = new Map();
let logWriteQueue = Promise.resolve();

async function translateBatch(texts, settings = {}, requestId) {
  const cleanTexts = texts.map(text => String(text || '').trim());
  if (!cleanTexts.length) return [];

  const jobs = [];
  const partsByText = cleanTexts.map(() => []);
  cleanTexts.forEach((text, textIndex) => {
    splitTranslateText(text).forEach(part => {
      partsByText[textIndex].push(jobs.length);
      jobs.push(part);
    });
  });
  if (!jobs.length) return cleanTexts.map(() => '');

  const translatedParts = [];
  for (let start = 0; start < jobs.length; start += LOCAL_BATCH_LIMIT) {
    const batch = jobs.slice(start, start + LOCAL_BATCH_LIMIT);
    const translated = await translateLocalBatch(batch, settings, requestId);
    translated.forEach((text, index) => {
      translatedParts[start + index] = text;
    });
  }

  return cleanTexts.map((original, textIndex) => {
    const translated = partsByText[textIndex]
      .map(partIndex => translatedParts[partIndex])
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return translated || original;
  });
}

async function translateLocalBatch(cleanTexts, settings = {}, requestId) {
  const data = await fetchJsonWithRetry(`${normalizeLocalUrl(settings.localUrl)}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: cleanTexts })
  }, requestId);
  const translations = data.translations || [];
  if (!Array.isArray(translations) || translations.length !== cleanTexts.length) {
    throw new Error(`Local response lệch ${translations.length}/${cleanTexts.length}`);
  }
  appendLog('info', 'background', `Local latency: ${data.latency_ms ?? '?'}ms cho ${cleanTexts.length} dòng`);
  return translations.map(text => String(text || '').trim());
}

function splitTranslateText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= MAX_TRANSLATE_TEXT_LENGTH) return [clean];

  const parts = [];
  let remaining = clean;
  while (remaining.length > MAX_TRANSLATE_TEXT_LENGTH) {
    let splitAt = Math.max(
      remaining.lastIndexOf('. ', MAX_TRANSLATE_TEXT_LENGTH),
      remaining.lastIndexOf('? ', MAX_TRANSLATE_TEXT_LENGTH),
      remaining.lastIndexOf('! ', MAX_TRANSLATE_TEXT_LENGTH),
      remaining.lastIndexOf('; ', MAX_TRANSLATE_TEXT_LENGTH),
      remaining.lastIndexOf(', ', MAX_TRANSLATE_TEXT_LENGTH),
      remaining.lastIndexOf(' ', MAX_TRANSLATE_TEXT_LENGTH)
    );
    if (splitAt < Math.floor(MAX_TRANSLATE_TEXT_LENGTH * 0.6)) splitAt = MAX_TRANSLATE_TEXT_LENGTH;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  appendLog('warn', 'background', `Chia text quá dài thành ${parts.length} đoạn trước khi gọi local server`);
  return parts;
}

async function checkLocalHealth(baseUrl) {
  const data = await fetchJsonWithRetry(`${normalizeLocalUrl(baseUrl)}/health`, {}, null, 1, 10000);
  if (!data.ok) throw new Error('Local server chưa sẵn sàng');
  return data;
}

async function fetchJsonWithRetry(url, options = {}, requestId, retries = REQUEST_RETRIES, timeoutMs = REQUEST_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
    if (requestId) activeRequests.set(requestId, controller);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`Local ${response.status}: ${await readApiError(response)}`);
      return await response.json();
    } catch (error) {
      lastError = error.name === 'AbortError' ? new Error('Local server timeout') : error;
      if (controller.signal.aborted && controller.signal.reason === 'cancelled') throw new Error('Đã hủy dịch');
      if (attempt < retries) await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timeoutId);
      if (requestId && activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
    }
  }
  throw lastError;
}

function cancelRequest(requestId) {
  const controller = activeRequests.get(requestId);
  if (controller) controller.abort('cancelled');
}

function normalizeLocalUrl(baseUrl) {
  return String(baseUrl || DEFAULT_LOCAL_URL).replace(/\/+$/, '');
}

async function readApiError(response) {
  try {
    const data = await response.json();
    return data.detail || data.error?.message || JSON.stringify(data).slice(0, 200);
  } catch (_error) {
    return response.statusText || 'Unknown error';
  }
}

async function clearLegacySubtitleCache() {
  const all = await storageGet(null);
  const keys = Object.keys(all).filter(key => key.startsWith(CACHE_PREFIX));
  if (keys.length) await storageRemove(keys);
  if (keys.length) appendLog('info', 'background', `Đã xóa ${keys.length} cache phụ đề cũ`);
}

function appendLog(level, scope, message) {
  if (!message || !chrome.storage?.local) return;
  logWriteQueue = logWriteQueue.then(async () => {
    const logs = await getLogs();
    const entry = {
      time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
      level,
      scope,
      message: String(message).slice(0, 500)
    };
    await storageSet({ [LOG_KEY]: [...logs, entry].slice(-MAX_LOGS) });
  }).catch(() => {});
}

async function getLogs() {
  const result = await storageGet([LOG_KEY]);
  return Array.isArray(result[LOG_KEY]) ? result[LOG_KEY] : [];
}

const storageGet = keys => new Promise(resolve => chrome.storage.local.get(keys, resolve));
const storageSet = value => new Promise(resolve => chrome.storage.local.set(value, resolve));
const storageRemove = keys => new Promise(resolve => chrome.storage.local.remove(keys, resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function getYouTubeVideoId(url) {
  try {
    return new URL(url).searchParams.get('v') || '';
  } catch (_error) {
    return '';
  }
}

function notifyYouTubeVideoChanged(details) {
  if (details.frameId !== 0) return;
  const videoId = getYouTubeVideoId(details.url);
  if (!videoId) return;
  chrome.tabs.sendMessage(details.tabId, {
    type: 'YOUTUBE_VIDEO_CHANGED',
    videoId,
    url: details.url
  }).catch(() => {});
}

function cleanLegacyCloudSettings() {
  chrome.storage.sync?.remove(['geminiKey', 'claudeKey', 'openaiKey', 'preferredProvider', 'glossary']);
}

clearLegacySubtitleCache();
cleanLegacyCloudSettings();
if (chrome.runtime?.onInstalled) chrome.runtime.onInstalled.addListener(() => {
  clearLegacySubtitleCache();
  cleanLegacyCloudSettings();
});
if (chrome.commands) chrome.commands.onCommand.addListener(command => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: 'COMMAND', command }).catch(() => {});
  });
});
