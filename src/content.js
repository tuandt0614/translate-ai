// YouTube VI Subtitles — batch transcript translation with timestamp rendering
(function () {
  'use strict';

  if (window.__viSubContentLoaded) return;
  window.__viSubContentLoaded = true;

  const CHUNK_SIZE = 8;
  const PRELOAD_CUES_BEFORE_RESUME = 16;
  const RENDER_INTERVAL = 50;
  const MAX_TRANSLATE_TEXT_LENGTH = 1800;
  const TRANSCRIPT_RETRY_DELAYS_MS = [0, 1200, 2500, 4000];
  // Drift trong khoảng này được coi là cue vừa xuất hiện (đo độ trễ hiển thị);
  // ngoài khoảng này nghĩa là tua/nhảy vào giữa cue nên bỏ qua khỏi thống kê.
  const DRIFT_SAMPLE_MIN_MS = -250;
  const DRIFT_SAMPLE_MAX_MS = RENDER_INTERVAL + 300;
  const LATENCY_LOG_INTERVAL = 3000;
  const SUBTITLE_FONT_FAMILIES = ['Arial', 'Roboto', 'Verdana', 'Tahoma', 'Times New Roman'];
  const DEFAULT_SETTINGS = {
    allowRealtimeFallback: true,
    localUrl: 'http://127.0.0.1:8000',
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

  let settings = null;
  let isActive = false;
  let runId = 0;
  let renderInterval = null;
  let overlayEl = null;
  let statusEl = null;
  let activeVideoId = '';
  let pendingVideoId = '';
  let translatedCues = [];
  let lastRenderedIndex = -1;
  let lastRenderedText = '';
  let activateStartedAt = 0;
  let resumedAt = 0;
  let lastLatencyLogAt = 0;
  let driftSampleCount = 0;
  let driftSumMs = 0;
  let driftMaxMs = 0;
  let shouldResumeAfterPreload = false;
  let preloadReleased = false;
  let fallbackInterval = null;
  let fallbackLastText = '';
  let fallbackTranslating = false;
  let fallbackPendingText = '';
  let fallbackCandidateText = '';
  let fallbackCandidateAt = 0;
  let fallbackPendingAt = 0;
  let fallbackStartedAt = 0;
  let fallbackNoTextLoggedAt = 0;
  let fallbackRequestVersion = 0;
  let fallbackVideo = null;
  let currentRequestId = null;
  let progressText = '';
  let busy = false;
  let dragStart = null;
  let navigationReloadTimer = null;
  let scheduledVideoId = '';
  let lastSeenVideoId = getVideoId() || '';
  let lastSeenEffectiveVideoId = getEffectiveVideoId() || '';

  const CAPTION_SELECTORS = [
    '.ytp-caption-segment',
    '.captions-text span',
    '.ytp-caption-window-container span'
  ];

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TOGGLE') {
      if (isActive) deactivate(); else activate();
      sendResponse(getStatusPayload());
    }
    if (msg.type === 'GET_STATUS') {
      sendResponse(getStatusPayload());
    }
    if (msg.type === 'CANCEL') {
      cancelCurrentTask();
      sendResponse({ ok: true });
    }
    if (msg.type === 'WATCH_NOW') {
      releasePreloadPause();
      sendResponse({ ok: true });
    }
    if (msg.type === 'COMMAND') {
      handleCommand(msg.command);
      sendResponse({ ok: true });
    }
    if (msg.type === 'YOUTUBE_VIDEO_CHANGED') {
      handleExternalVideoChange(msg.videoId);
      sendResponse({ ok: true });
    }
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    getSettings().then(newSettings => {
      settings = { ...(settings || {}), ...newSettings };
      applySubtitleStyle(settings);
      updateOriginalCaptionsVisibility();
      lastRenderedText = '';
      renderCurrentCue();
    }).catch(error => handleExtensionContextError(error));
  });

  async function activate() {
    if (isActive) return;
    isActive = true;
    busy = true;
    progressText = 'Đang tải transcript';
    runId += 1;
    activateStartedAt = Date.now();
    resumedAt = 0;
    lastLatencyLogAt = 0;
    resetDriftStats();
    activeVideoId = getVideoId() || '';
    pendingVideoId = '';
    scheduledVideoId = '';
    lastSeenVideoId = activeVideoId;
    lastSeenEffectiveVideoId = getEffectiveVideoId() || activeVideoId;
    translatedCues = [];
    resetRenderedCue();
    preloadReleased = false;
    settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    createOverlay();
    updateOriginalCaptionsVisibility();
    logEvent('info', 'Bật batch transcript mode local');
    pauseForPreload();
    showStatus('⏳ Đang tải transcript...');
    startRenderLoop();

    try {
      settings = await getSettings();
      if (!isActive) return;
      applySubtitleStyle(settings);
      updateOriginalCaptionsVisibility();
      await loadAndTranslateTranscript(runId);
    } catch (e) {
      if (e.message === 'Đã hủy dịch') return;
      await handleTranscriptLoadError(e, runId);
    }
  }

  function deactivate() {
    isActive = false;
    busy = false;
    progressText = '';
    runId += 1;
    activeVideoId = '';
    pendingVideoId = '';
    scheduledVideoId = '';
    translatedCues = [];
    resetRenderedCue();
    shouldResumeAfterPreload = false;
    preloadReleased = true;
    clearTimeout(navigationReloadTimer);
    logEvent('info', 'Tắt dịch');
    stopRenderLoop();
    stopDomFallback();
    cancelCurrentRequest();
    updateOriginalCaptionsVisibility(false);
    destroyOverlay();
    showStatus('⏹ Đã tắt phụ đề.');
    setTimeout(() => showStatus(''), 2000);
  }

  function getStatusPayload() {
    return { active: isActive, busy, progress: progressText };
  }

  async function loadAndTranslateTranscript(currentRunId, expectedVideoId = '') {
    if (expectedVideoId) await waitForUrlVideoId(expectedVideoId, currentRunId);
    const videoId = expectedVideoId || getVideoId();
    if (!videoId) throw new Error('Không lấy được videoId');
    activeVideoId = videoId;
    pendingVideoId = '';
    scheduledVideoId = '';
    logEvent('info', `Bắt đầu tải transcript video ${videoId}`);

    const transcript = await fetchTranscriptWithPanelFallback(videoId);
    if (!isCurrentVideoRun(currentRunId, videoId)) return;

    const cues = parseTranscript(transcript);
    if (!cues.length) throw new Error('Không parse được transcript');

    translatedCues = cues.map(cue => ({ ...cue, viText: '' }));
    logEvent('info', `Đã tải ${cues.length} subtitle cues (${transcript.format}/${transcript.lang}) cho video ${videoId}`);
    const video = document.querySelector('video');
    const startIndex = ViSubCore.findStartIndex(cues, video?.currentTime || 0);
    const chunkStarts = getPrefetchChunkStarts(cues.length, startIndex);
    showStatus(`⏳ Đang prefetch phụ đề sắp tới...`);

    for (const start of chunkStarts) {
      if (!isCurrentVideoRun(currentRunId, videoId)) return;

      const chunk = cues.slice(start, start + CHUNK_SIZE);
      if (chunk.every(cue => cue.viText)) continue;
      const translated = await translateCueTexts(chunk.map(cue => cue.text), settings);
      if (!isCurrentVideoRun(currentRunId, videoId)) return;
      translated.forEach((text, index) => {
        translatedCues[start + index].viText = text || chunk[index].text;
      });
      renderCurrentCue();

      const done = translatedCues.filter(cue => cue.viText).length;
      logEvent('info', `Prefetch dịch ${done}/${cues.length} cues`);
      setProgress(`Đã dịch ${done}/${cues.length} dòng`);
      if (countTranslatedAhead(startIndex) >= PRELOAD_CUES_BEFORE_RESUME) {
        releasePreloadPause();
      }
    }

    if (!isCurrentVideoRun(currentRunId, videoId)) return;
    logEvent('info', `Dịch transcript xong ${cues.length} cues cho video ${videoId}`);
    releasePreloadPause();
    busy = false;
    progressText = '';
    showStatus('✅ Đã dịch xong transcript');
    setTimeout(() => showStatus(''), 2200);
  }

  function findCueIndexForTime(cues, time) {
    return ViSubCore.findStartIndex(cues, time);
  }

  function getPrefetchChunkStarts(totalCues, startIndex) {
    const currentChunkStart = Math.floor(startIndex / CHUNK_SIZE) * CHUNK_SIZE;
    const starts = [];

    for (let index = currentChunkStart; index < totalCues; index += CHUNK_SIZE) {
      starts.push(index);
    }
    for (let index = 0; index < currentChunkStart; index += CHUNK_SIZE) {
      starts.push(index);
    }
    return starts;
  }

  function countTranslatedAhead(startIndex) {
    return translatedCues
      .slice(startIndex, startIndex + PRELOAD_CUES_BEFORE_RESUME)
      .filter(cue => cue.viText).length;
  }

  function fetchTranscript(videoId) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        document.removeEventListener('vi_sub_fetch_result', onResult);
        reject(new Error('Timeout khi tải transcript'));
      }, 25000);

      function onResult(event) {
        const detail = event.detail || {};
        if (detail.videoId !== videoId) return;
        clearTimeout(timeoutId);
        document.removeEventListener('vi_sub_fetch_result', onResult);
        if (detail.error) {
          const reason = detail.error === 'po_token_required'
            ? 'YouTube yêu cầu PO token cho phụ đề của video này'
            : detail.error;
          reject(new Error(`Không tải được transcript: ${reason}${detail.attempts ? ` (${detail.attempts})` : ''}`));
          return;
        }
        resolve(detail);
      }

      document.addEventListener('vi_sub_fetch_result', onResult);
      document.dispatchEvent(new CustomEvent('vi_sub_fetch_request', { detail: { videoId } }));
    });
  }

  async function fetchTranscriptWithPanelFallback(videoId) {
    try {
      return await fetchTranscriptWithRetry(videoId);
    } catch (error) {
      if (!error.message.includes('YouTube yêu cầu PO token')) throw error;
      logEvent('warn', 'YouTube yêu cầu PO token; thử đọc Transcript panel');
      try {
        const cues = await fetchTranscriptFromPanel(videoId);
        return { format: 'dom', lang: 'panel', kind: 'transcript-panel', cues };
      } catch (panelError) {
        throw new Error(`YouTube yêu cầu PO token và không đọc được Transcript panel: ${panelError.message}`);
      }
    }
  }

  async function fetchTranscriptWithRetry(videoId) {
    let lastError;
    for (let attempt = 0; attempt < TRANSCRIPT_RETRY_DELAYS_MS.length; attempt += 1) {
      if (TRANSCRIPT_RETRY_DELAYS_MS[attempt]) await sleep(TRANSCRIPT_RETRY_DELAYS_MS[attempt]);
      if (getVideoId() !== videoId) throw new Error('Đã hủy dịch');
      try {
        return await fetchTranscript(videoId);
      } catch (error) {
        lastError = error;
        if (!isTransientTranscriptError(error)) throw error;
        logEvent('warn', `Transcript chưa sẵn sàng, thử lại ${attempt + 1}/${TRANSCRIPT_RETRY_DELAYS_MS.length}`);
      }
    }
    throw lastError;
  }

  function isTransientTranscriptError(error) {
    const message = String(error?.message || '');
    return message.includes('no_track')
      || message.includes('empty_response')
      || message.includes('Timeout khi tải transcript')
      || message.includes('Không lấy được videoId');
  }

  async function fetchTranscriptFromPanel(videoId) {
    if (getVideoId() !== videoId) throw new Error('Đã hủy dịch');
    let segments = getTranscriptPanelSegments();

    if (!segments.length) {
      const expandButton = document.querySelector('ytd-watch-metadata #expand, ytd-text-inline-expander #expand');
      expandButton?.click();
      await sleep(300);
      if (getVideoId() !== videoId) throw new Error('Đã hủy dịch');

      const transcriptButton = findTranscriptButton();
      if (!transcriptButton) throw new Error('Không tìm thấy nút Transcript trên YouTube');
      transcriptButton.click();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(300);
        if (getVideoId() !== videoId) throw new Error('Đã hủy dịch');
        segments = getTranscriptPanelSegments();
        if (segments.length) break;
      }
    }

    const cues = segments.map(parseTranscriptPanelSegment)
      .filter(cue => Number.isFinite(cue.start) && cue.text);

    cues.forEach((cue, index) => {
      cue.end = cues[index + 1]?.start || cue.start + 3;
    });
    if (!cues.length) throw new Error(`Bảng Transcript không có subtitle segments (${segments.length} node)`);
    logEvent('info', `Đã đọc ${cues.length} cues từ bảng Transcript của YouTube`);
    return cues;
  }

  function findTranscriptButton() {
    const direct = document.querySelector(
      'ytd-video-description-transcript-section-renderer button, button[aria-label*="transcript" i]'
    );
    if (direct) return direct;

    return Array.from(document.querySelectorAll('button, tp-yt-paper-button')).find(element => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`;
      return /show transcript|open transcript|transcript|bản chép lời/i.test(label);
    }) || null;
  }

  function getTranscriptPanelSegments() {
    const selectors = [
      'ytd-transcript-segment-renderer',
      'ytd-transcript-segment-list-renderer ytd-button-renderer',
      'ytd-transcript-segment-list-renderer [role="button"]',
      'ytd-engagement-panel-section-list-renderer [class*="transcript"][class*="segment"]'
    ];
    const seen = new Set();
    return selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)))
      .filter(element => {
        if (seen.has(element)) return false;
        seen.add(element);
        return hasTimestampText(element.textContent || '');
      });
  }

  function parseTranscriptPanelSegment(segment) {
    const timestamp = readTranscriptTimestamp(segment);
    return {
      start: timestamp ? parseTimestamp(timestamp) : Number.NaN,
      text: readTranscriptSegmentText(segment, timestamp)
    };
  }

  function readTranscriptTimestamp(segment) {
    const explicit = segment.querySelector(
      '.segment-timestamp, [class*="segment-timestamp"], #timestamp, [id*="timestamp"], [class*="timestamp"]'
    )?.textContent?.trim();
    if (hasTimestampText(explicit)) return explicit.match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0] || explicit;
    return (segment.textContent || '').match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0] || '';
  }

  function readTranscriptSegmentText(segment, timestamp) {
    const explicit = segment.querySelector(
      '.segment-text, [class*="segment-text"], #content-text, yt-formatted-string:not(.segment-timestamp)'
    )?.textContent;
    const raw = explicit && !hasOnlyTimestamp(explicit) ? explicit : segment.textContent;
    return String(raw || '')
      .replace(timestamp || '', ' ')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasTimestampText(value) {
    return /\d{1,2}:\d{2}(?::\d{2})?/.test(String(value || ''));
  }

  function hasOnlyTimestamp(value) {
    return /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/.test(String(value || ''));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function shouldUseRealtimeFallback(error, currentSettings) {
    const message = String(error?.message || '');
    return currentSettings.allowRealtimeFallback === true
      || message.includes('YouTube yêu cầu PO token')
      || message.includes('Transcript panel')
      || message.includes('Bảng Transcript')
      || message.includes('Không tải được transcript')
      || message.includes('Không parse được transcript');
  }

  function parseTranscript(transcript) {
    if (transcript.format === 'dom') return transcript.cues || [];
    if (transcript.format === 'json3') return ViSubCore.parseJson3(transcript.text);
    if (transcript.format === 'vtt') return ViSubCore.parseVtt(transcript.text);
    return ViSubCore.parseXml(transcript.text);
  }

  function parseJson3(text) {
    const data = JSON.parse(text);
    return (data.events || [])
      .filter(event => event.segs?.length && Number.isFinite(event.tStartMs))
      .map(event => {
        const cueText = event.segs.map(seg => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        return {
          start: event.tStartMs / 1000,
          end: (event.tStartMs + (event.dDurationMs || 1800)) / 1000,
          text: cueText
        };
      })
      .filter(cue => cue.text);
  }

  function parseVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split('\n').filter(Boolean);
      const timeLine = lines.find(line => line.includes('-->'));
      if (!timeLine) continue;
      const timeIndex = lines.indexOf(timeLine);
      const [startRaw, endRaw] = timeLine.split('-->').map(part => part.trim().split(/\s+/)[0]);
      const cueText = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!cueText) continue;
      cues.push({ start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text: cueText });
    }
    return cues.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end));
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    return Array.from(doc.querySelectorAll('text'))
      .map(node => {
        const start = Number(node.getAttribute('start'));
        const duration = Number(node.getAttribute('dur') || 2);
        const cueText = decodeHtml(node.textContent || '').replace(/\s+/g, ' ').trim();
        return { start, end: start + duration, text: cueText };
      })
      .filter(cue => Number.isFinite(cue.start) && cue.text);
  }

  function parseTimestamp(value) {
    return ViSubCore.parseTimestamp(value);
  }

  function decodeHtml(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  async function translateCueTexts(texts, currentSettings) {
    const jobs = [];
    const partsByCue = texts.map(() => []);
    texts.forEach((text, cueIndex) => {
      splitTranslateText(text).forEach(part => {
        partsByCue[cueIndex].push(jobs.length);
        jobs.push({ cueIndex, text: part });
      });
    });

    if (!jobs.length) return texts.map(() => '');

    const translatedParts = [];
    for (let start = 0; start < jobs.length; start += CHUNK_SIZE) {
      const batch = jobs.slice(start, start + CHUNK_SIZE);
      const translated = await translateBatch(batch.map(job => job.text), currentSettings);
      translated.forEach((text, index) => {
        translatedParts[start + index] = text;
      });
    }

    return texts.map((original, cueIndex) => {
      const translated = partsByCue[cueIndex]
        .map(partIndex => translatedParts[partIndex])
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return translated || original;
    });
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
    logEvent('warn', `Chia subtitle quá dài thành ${parts.length} đoạn để dịch`);
    return parts;
  }

  function translateBatch(texts, currentSettings) {
    return new Promise((resolve, reject) => {
      currentRequestId = `${runId}:${Date.now()}:${Math.random()}`;
      try {
        chrome.runtime.sendMessage(
          { type: 'TRANSLATE_BATCH', texts, settings: currentSettings, requestId: currentRequestId },
          response => {
            currentRequestId = null;
            if (chrome.runtime.lastError || !response?.ok) {
              const error = chrome.runtime.lastError?.message || response?.error || 'Không rõ lỗi';
              logEvent('error', `Batch dịch lỗi: ${error}`);
              reject(new Error(error));
              return;
            }
            resolve(response.result || texts);
          }
        );
      } catch (error) {
        currentRequestId = null;
        handleExtensionContextError(error);
        reject(error);
      }
    });
  }

  function translateOne(text, currentSettings) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { type: 'TRANSLATE', text, settings: currentSettings, requestId: `${runId}:realtime:${Date.now()}` },
          response => {
            if (chrome.runtime.lastError || !response?.ok) {
              const error = chrome.runtime.lastError?.message || response?.error || 'Không rõ lỗi';
              logEvent('error', `Dịch realtime lỗi: ${error}`);
              resolve(text);
              return;
            }
            resolve(response.result || text);
          }
        );
      } catch (error) {
        handleExtensionContextError(error);
        resolve(text);
      }
    });
  }

  function startRenderLoop() {
    stopRenderLoop();
    renderInterval = setInterval(renderCurrentCue, RENDER_INTERVAL);
  }

  function pauseForPreload() {
    const video = document.querySelector('video');
    shouldResumeAfterPreload = Boolean(video && !video.paused);
    if (shouldResumeAfterPreload) {
      video.pause();
      logEvent('info', 'Tạm pause video để preload phụ đề dịch');
    }
  }

  function releasePreloadPause() {
    if (preloadReleased) return;
    preloadReleased = true;
    if (!shouldResumeAfterPreload) return;

    const video = document.querySelector('video');
    if (video && video.paused && isActive) {
      video.play().catch(() => {});
      resumedAt = Date.now();
      const startIndex = ViSubCore.findStartIndex(translatedCues, video.currentTime || 0);
      const ahead = countTranslatedAhead(startIndex);
      logEvent('info', `Latency preload: resume sau ${resumedAt - activateStartedAt}ms, có sẵn ${ahead} cue phía trước`);
    }
  }

  function startDomFallback(currentRunId) {
    stopDomFallback();
    busy = false;
    progressText = 'Realtime fallback';
    ensureOriginalCaptionsEnabled();
    logEvent('warn', 'Bắt đầu realtime DOM fallback');
    fallbackStartedAt = Date.now();
    fallbackNoTextLoggedAt = 0;
    fallbackVideo = document.querySelector('video');
    fallbackVideo?.addEventListener('seeking', resetFallbackAfterSeek);
    fallbackInterval = setInterval(() => {
      if (currentRunId !== runId || !isActive) return;
      const text = readCaptionText();
      if (!text) {
        logFallbackWaitingForCaptions();
        return;
      }
      if (text === fallbackCandidateText) return;
      fallbackCandidateText = text;
      fallbackCandidateAt = Date.now();
      fallbackRequestVersion += 1;
      if (text === fallbackLastText) return;
      fallbackLastText = text;
      fallbackPendingText = text;
      fallbackPendingAt = fallbackCandidateAt;
      processFallbackQueue(currentRunId);
    }, 100);
  }

  function stopDomFallback() {
    clearInterval(fallbackInterval);
    fallbackVideo?.removeEventListener('seeking', resetFallbackAfterSeek);
    fallbackInterval = null;
    fallbackVideo = null;
    fallbackLastText = '';
    fallbackCandidateText = '';
    fallbackPendingText = '';
    fallbackCandidateAt = 0;
    fallbackPendingAt = 0;
    fallbackStartedAt = 0;
    fallbackNoTextLoggedAt = 0;
    fallbackTranslating = false;
    fallbackRequestVersion += 1;
  }

  function resetFallbackAfterSeek() {
    fallbackLastText = '';
    fallbackCandidateText = '';
    fallbackPendingText = '';
    fallbackCandidateAt = 0;
    fallbackPendingAt = 0;
    fallbackStartedAt = Date.now();
    fallbackNoTextLoggedAt = 0;
    fallbackRequestVersion += 1;
    showOverlay('', false, activeVideoId);
    logEvent('info', 'Realtime fallback: reset sau khi tua video');
  }

  async function processFallbackQueue(currentRunId) {
    if (fallbackTranslating || !fallbackPendingText) return;
    fallbackTranslating = true;
    const text = fallbackPendingText;
    const detectedAt = fallbackPendingAt;
    const requestVersion = fallbackRequestVersion;
    fallbackPendingText = '';

    try {
      const translated = await translateOne(text, settings);
      if (currentRunId !== runId || requestVersion !== fallbackRequestVersion || !isActive) return;
      showOverlay(translated, translated.trim().toLowerCase() !== text.trim().toLowerCase(), activeVideoId);
      const delayMs = detectedAt ? Date.now() - detectedAt : 0;
      logEvent('warn', `Độ trễ realtime so với CC gốc: ${formatDelay(delayMs)} (đọc CC + dịch local)`);
    } finally {
      fallbackTranslating = false;
      if (fallbackPendingText && fallbackPendingText !== text) processFallbackQueue(currentRunId);
    }
  }

  function readCaptionText() {
    for (const selector of CAPTION_SELECTORS) {
      const elements = document.querySelectorAll(selector);
      if (elements.length) {
        const text = Array.from(elements).map(element => element.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    }
    return '';
  }

  function ensureOriginalCaptionsEnabled() {
    const button = document.querySelector('.ytp-subtitles-button');
    const pressed = button?.getAttribute('aria-pressed');
    if (button && pressed === 'false') {
      button.click();
      logEvent('info', 'Realtime fallback: tự bật CC YouTube');
    }
  }

  function logFallbackWaitingForCaptions() {
    const now = Date.now();
    if (!fallbackStartedAt || now - fallbackStartedAt < 5000 || now - fallbackNoTextLoggedAt < 5000) return;
    fallbackNoTextLoggedAt = now;
    showStatus('⏳ Đang chờ CC gốc của YouTube...');
    logEvent('warn', 'Realtime fallback: chưa đọc được CC gốc, hãy bật CC tiếng Anh nếu video có phụ đề');
  }

  function stopRenderLoop() {
    clearInterval(renderInterval);
    renderInterval = null;
  }

  function renderCurrentCue() {
    if (!isActive) return;
    if (pendingVideoId) {
      if (overlayEl?.textContent) showOverlay('', false, '');
      return;
    }
    if (!translatedCues.length) {
      if (overlayEl?.textContent) showOverlay('', false, '');
      return;
    }
    if (activeVideoId && !canShowOverlayForVideo(activeVideoId)) {
      clearActiveTranscript();
      return;
    }
    const video = document.querySelector('video');
    if (!video) return;

    const now = video.currentTime;
    const index = ViSubCore.findCueIndex(translatedCues, now);

    if (index === -1) {
      if (lastRenderedIndex === -1 && !lastRenderedText) return;
      lastRenderedIndex = -1;
      lastRenderedText = '';
      showOverlay('', false, activeVideoId);
      return;
    }

    const cue = translatedCues[index];
    const displayText = formatCueText(cue);
    if (index === lastRenderedIndex && displayText === lastRenderedText) return;
    lastRenderedIndex = index;
    lastRenderedText = displayText;
    showOverlay(displayText, Boolean(cue.viText), activeVideoId);
    logRenderLatency(cue, now);
  }

  function formatCueText(cue) {
    if (settings.subtitleDisplayMode === 'bilingual' && cue.viText) {
      return `${singleLine(cue.text)}\n${singleLine(cue.viText)}`;
    }
    return ViSubCore.limitLines(cue.viText || cue.text, settings.subtitleMaxLines || 2);
  }

  function singleLine(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function logRenderLatency(cue, currentTime) {
    const now = Date.now();

    if (!cue.viText) {
      if (now - lastLatencyLogAt < LATENCY_LOG_INTERVAL) return;
      lastLatencyLogAt = now;
      logEvent('warn', 'Độ trễ: cue đang phát nhưng chưa có bản dịch (đang prefetch)');
      return;
    }

    // Độ trễ hiển thị = thời điểm phụ đề lên màn so với lúc cue đáng lẽ bắt đầu.
    // Dương = hiện trễ, âm = hiện sớm (do dung sai -0.15s của findCueIndex).
    const driftMs = Math.round((currentTime - cue.start) * 1000);
    if (driftMs >= DRIFT_SAMPLE_MIN_MS && driftMs <= DRIFT_SAMPLE_MAX_MS) {
      driftSampleCount += 1;
      driftSumMs += driftMs;
      if (driftMs > driftMaxMs) driftMaxMs = driftMs;
    }

    if (now - lastLatencyLogAt < LATENCY_LOG_INTERVAL) return;
    lastLatencyLogAt = now;
    const avgMs = driftSampleCount ? Math.round(driftSumMs / driftSampleCount) : driftMs;
    logEvent('info', `Độ trễ hiển thị so với realtime: hiện tại ${formatDelay(driftMs)}, trung bình ${formatDelay(avgMs)}, tối đa ${formatDelay(driftMaxMs)} (${driftSampleCount} mẫu)`);
  }

  function resetDriftStats() {
    driftSampleCount = 0;
    driftSumMs = 0;
    driftMaxMs = 0;
  }

  function resetRenderedCue() {
    lastRenderedIndex = -1;
    lastRenderedText = '';
  }

  function isCurrentVideoRun(currentRunId, videoId) {
    return currentRunId === runId && isActive && activeVideoId === videoId && getVideoId() === videoId;
  }

  async function waitForUrlVideoId(videoId, currentRunId) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (currentRunId !== runId || !isActive) throw new Error('Đã hủy dịch');
      if (getVideoId() === videoId) return;
      await sleep(100);
    }
    throw new Error(`URL chưa chuyển sang video ${videoId}`);
  }

  function clearActiveTranscript() {
    translatedCues = [];
    resetRenderedCue();
    showOverlay('', false, '');
  }

  function formatDelay(ms) {
    const rounded = Math.round(ms);
    return Math.abs(rounded) >= 1000 ? `${(rounded / 1000).toFixed(2)}s (${rounded}ms)` : `${rounded}ms`;
  }

  function createOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'vi-sub-overlay';
    attachOverlayToPlayer();
    overlayEl.addEventListener('pointerdown', startOverlayDrag);
    overlayEl.addEventListener('dblclick', resetOverlayPosition);
    applySubtitleStyle(settings || {});
  }

  function attachOverlayToPlayer() {
    if (!overlayEl) return;
    const player = document.getElementById('movie_player');
    if (player) {
      if (overlayEl.parentElement !== player) player.appendChild(overlayEl);
      overlayEl.classList.remove('vi-sub-overlay-viewport');
    } else {
      if (overlayEl.parentElement !== document.body) document.body.appendChild(overlayEl);
      overlayEl.classList.add('vi-sub-overlay-viewport');
    }
  }

  function applySubtitleStyle(currentSettings) {
    if (!overlayEl) return;

    const fontFamily = SUBTITLE_FONT_FAMILIES.includes(currentSettings.subtitleFontFamily)
      ? currentSettings.subtitleFontFamily
      : 'Arial';
    const fontSize = clamp(Number(currentSettings.subtitleFontSize) || 20, 14, 48);
    const textColor = normalizeHexColor(currentSettings.subtitleTextColor, '#ffffff');
    const backgroundColor = normalizeHexColor(currentSettings.subtitleBackgroundColor, '#000000');
    const backgroundOpacity = clamp(Number(currentSettings.subtitleBackgroundOpacity ?? 45), 0, 100) / 100;
    const bottomPosition = clamp(Number(currentSettings.subtitleBottomPosition ?? 8), 3, 45);
    const maxLines = currentSettings.subtitleDisplayMode === 'bilingual'
      ? 2
      : clamp(Number(currentSettings.subtitleMaxLines) || 2, 1, 3);

    overlayEl.style.setProperty('--vi-sub-font-family', `"${fontFamily}"`);
    overlayEl.style.setProperty('--vi-sub-font-size', `${fontSize}px`);
    overlayEl.style.setProperty('--vi-sub-text-color', textColor);
    overlayEl.style.setProperty('--vi-sub-text-shadow', getTextShadow(textColor));
    overlayEl.style.setProperty('--vi-sub-background-rgb', hexToRgb(backgroundColor).join(', '));
    overlayEl.style.setProperty('--vi-sub-background-opacity', String(backgroundOpacity));
    overlayEl.style.setProperty('--vi-sub-bottom-position', `${bottomPosition}%`);
    overlayEl.style.setProperty('--vi-sub-max-lines', String(maxLines));
  }

  function normalizeHexColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
  }

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ];
  }

  function getTextShadow(textColor) {
    const outline = textColor.toLowerCase() === '#000000' ? '#fff' : '#000';
    return `-1px -1px 0 ${outline}, 1px -1px 0 ${outline}, -1px 1px 0 ${outline}, 1px 1px 0 ${outline}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function destroyOverlay() {
    window.removeEventListener('pointermove', moveOverlayDrag);
    window.removeEventListener('pointerup', endOverlayDrag);
    overlayEl?.remove();
    overlayEl = null;
  }

  function showOverlay(text, translated = false, videoId = activeVideoId) {
    if (!overlayEl) createOverlay();
    attachOverlayToPlayer();
    if (text && !canShowOverlayForVideo(videoId)) {
      text = '';
      translated = false;
    }
    document.body.classList.toggle('vi-sub-has-translation', Boolean(text && translated && settings?.hideOriginalCaptions !== false));
    updateOriginalCaptionsVisibility();
    if (overlayEl) overlayEl.textContent = text || '';
  }

  function canShowOverlayForVideo(videoId) {
    const playerVideoId = getPlayerVideoId();
    return Boolean(
      videoId
      && !pendingVideoId
      && activeVideoId === videoId
      && getVideoId() === videoId
      && (!playerVideoId || playerVideoId === videoId)
    );
  }

  function updateOriginalCaptionsVisibility(forceActive = isActive) {
    const shouldHide = Boolean(forceActive && settings?.hideOriginalCaptions !== false);
    document.body.classList.toggle('vi-sub-hide-original', shouldHide);
    if (!shouldHide) document.body.classList.remove('vi-sub-has-translation');
  }

  function startOverlayDrag(event) {
    if (!overlayEl) return;
    event.preventDefault();
    dragStart = { y: event.clientY, bottom: Number(settings.subtitleBottomPosition ?? 8) };
    overlayEl.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', moveOverlayDrag);
    window.addEventListener('pointerup', endOverlayDrag, { once: true });
  }

  function moveOverlayDrag(event) {
    if (!dragStart || !overlayEl) return;
    const player = document.getElementById('movie_player');
    const height = player?.getBoundingClientRect().height || window.innerHeight;
    const position = clamp(dragStart.bottom + ((dragStart.y - event.clientY) / height) * 100, 3, 45);
    settings.subtitleBottomPosition = Math.round(position);
    overlayEl.style.setProperty('--vi-sub-bottom-position', `${position}%`);
  }

  function endOverlayDrag() {
    window.removeEventListener('pointermove', moveOverlayDrag);
    dragStart = null;
    setSyncStorage({ subtitleBottomPosition: settings.subtitleBottomPosition });
  }

  function resetOverlayPosition() {
    settings.subtitleBottomPosition = 8;
    applySubtitleStyle(settings);
    setSyncStorage({ subtitleBottomPosition: 8 });
  }

  function showStatus(text) {
    if (!text) { statusEl?.remove(); statusEl = null; return; }
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = 'vi-sub-status';
      document.body.appendChild(statusEl);
    }
    statusEl.textContent = text;
  }

  function logEvent(level, message) {
    sendRuntimeMessage({ type: 'LOG', level, scope: 'content', message });
  }

  function setProgress(text) {
    progressText = text;
    showStatus(`⏳ ${text}...`);
  }

  function cancelCurrentRequest() {
    if (!currentRequestId) return;
    sendRuntimeMessage({ type: 'CANCEL_TRANSLATION', requestId: currentRequestId });
    currentRequestId = null;
  }

  function cancelCurrentTask() {
    runId += 1;
    cancelCurrentRequest();
    busy = false;
    progressText = '';
    releasePreloadPause();
    showStatus('Đã hủy tác vụ.');
    setTimeout(() => showStatus(''), 1800);
  }

  function handleCommand(command) {
    if (command === 'toggle-translation') {
      if (isActive) deactivate(); else activate();
      return;
    }
    settings = settings || {};
    if (command === 'increase-font') settings.subtitleFontSize = clamp(Number(settings.subtitleFontSize || 20) + 2, 14, 48);
    if (command === 'decrease-font') settings.subtitleFontSize = clamp(Number(settings.subtitleFontSize || 20) - 2, 14, 48);
    if (command === 'move-subtitle-up') settings.subtitleBottomPosition = clamp(Number(settings.subtitleBottomPosition || 8) + 2, 3, 45);
    if (command === 'move-subtitle-down') settings.subtitleBottomPosition = clamp(Number(settings.subtitleBottomPosition || 8) - 2, 3, 45);
    applySubtitleStyle(settings);
    setSyncStorage({ subtitleFontSize: settings.subtitleFontSize, subtitleBottomPosition: settings.subtitleBottomPosition });
  }

  function getSettings() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.get(
        [
          'allowRealtimeFallback', 'localUrl',
          'subtitleDisplayMode', 'subtitleMaxLines', 'hideOriginalCaptions',
          'subtitleFontFamily', 'subtitleFontSize', 'subtitleTextColor', 'subtitleBackgroundColor',
          'subtitleBackgroundOpacity', 'subtitleBottomPosition'
        ],
          result => {
            const lastError = getChromeLastError();
            if (lastError) {
              reject(new Error(lastError));
              return;
            }
            resolve({ ...DEFAULT_SETTINGS, ...result });
          }
        );
      } catch (error) {
        if (handleExtensionContextError(error)) resolve({ ...DEFAULT_SETTINGS });
        else reject(error);
      }
    });
  }

  function setSyncStorage(value) {
    try {
      chrome.storage.sync.set(value, () => getChromeLastError());
    } catch (error) {
      handleExtensionContextError(error);
    }
  }

  function sendRuntimeMessage(message, callback = () => {}) {
    try {
      chrome.runtime.sendMessage(message, response => {
        const lastError = getChromeLastError();
        if (lastError) {
          if (lastError.includes('Extension context invalidated')) {
            handleExtensionContextError(new Error(lastError));
          }
          callback(null);
          return;
        }
        callback(response);
      });
    } catch (error) {
      handleExtensionContextError(error);
      callback(null);
    }
  }

  function getChromeLastError() {
    try {
      return chrome.runtime.lastError?.message || '';
    } catch (_error) {
      return '';
    }
  }

  function handleExtensionContextError(error) {
    if (!String(error?.message || error).includes('Extension context invalidated')) return false;
    isActive = false;
    busy = false;
    progressText = '';
    runId += 1;
    clearTimeout(navigationReloadTimer);
    stopRenderLoop();
    stopDomFallback();
    updateOriginalCaptionsVisibility(false);
    pendingVideoId = '';
    scheduledVideoId = '';
    destroyOverlay();
    showStatus('');
    return true;
  }

  function getVideoId() {
    return new URL(location.href).searchParams.get('v');
  }

  function getPlayerVideoId() {
    const player = document.getElementById('movie_player');
    try {
      const data = player?.getVideoData?.();
      return data?.video_id || '';
    } catch (_error) {
      return '';
    }
  }

  function getEffectiveVideoId() {
    return getPlayerVideoId() || getVideoId() || '';
  }

  let lastUrl = location.href;
  function handleNavigationStart() {
    if (!isActive) return;
    if (pendingVideoId) return;
    prepareForVideoSwitch('', 'yt-navigate-start');
  }

  function handlePossibleNavigation() {
    const nextUrl = location.href;
    if (nextUrl === lastUrl) return;
    lastUrl = nextUrl;
    const nextVideoId = getVideoId() || '';
    lastSeenVideoId = nextVideoId;
    lastSeenEffectiveVideoId = getEffectiveVideoId() || nextVideoId;
    if (isActive && nextVideoId) {
      if (pendingVideoId && nextVideoId !== pendingVideoId) {
        logEvent('warn', `Bỏ qua URL navigation cũ: ${nextVideoId}, đang chờ ${pendingVideoId}`);
        return;
      }
      if (nextVideoId === activeVideoId && !pendingVideoId) return;
      prepareForVideoSwitch(nextVideoId, 'url-change');
      restartForCurrentVideo(nextVideoId);
    }
  }

  function handleExternalVideoChange(videoId) {
    if (!videoId || !isActive) return;
    if (pendingVideoId && videoId !== pendingVideoId) {
      logEvent('warn', `Bỏ qua webNavigation cũ: ${videoId}, đang chờ ${pendingVideoId}`);
      return;
    }
    if (videoId === activeVideoId && !pendingVideoId) return;
    lastUrl = location.href;
    lastSeenVideoId = videoId;
    lastSeenEffectiveVideoId = videoId;
    prepareForVideoSwitch(videoId, 'webNavigation');
    restartForCurrentVideo(videoId);
  }

  function watchVideoIdChange() {
    const currentVideoId = getEffectiveVideoId();
    if (currentVideoId === lastSeenEffectiveVideoId) return;
    lastSeenEffectiveVideoId = currentVideoId;
    lastSeenVideoId = getVideoId() || currentVideoId;
    if (!isActive) return;
    if (pendingVideoId && currentVideoId !== pendingVideoId) {
      if (overlayEl?.textContent) showOverlay('', false, '');
      return;
    }
    if (currentVideoId === activeVideoId && !pendingVideoId) return;
    prepareForVideoSwitch(currentVideoId, 'watchdog');
    if (currentVideoId) restartForCurrentVideo(currentVideoId);
  }

  function handleWatchLinkClick(event) {
    const anchor = getWatchAnchorFromEvent(event);
    if (!anchor) return;
    const nextVideoId = getVideoIdFromUrl(anchor.href);
    if (!nextVideoId || nextVideoId === (pendingVideoId || getVideoId())) return;
    prepareForVideoSwitch(nextVideoId, 'link-click');
  }

  function getWatchAnchorFromEvent(event) {
    const path = event.composedPath?.() || [];
    const fromPath = path.find(node => node?.tagName === 'A' && node.href);
    if (fromPath) return fromPath;
    return event.target?.closest?.('a[href*="/watch"]') || null;
  }

  function getVideoIdFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.hostname !== location.hostname || parsed.pathname !== '/watch') return '';
      return parsed.searchParams.get('v') || '';
    } catch (_error) {
      return '';
    }
  }

  function prepareForVideoSwitch(nextVideoId = '', source = 'navigation') {
    if (!isActive) return;
    if (nextVideoId && pendingVideoId === nextVideoId && !translatedCues.length) return;
    if (!nextVideoId && pendingVideoId && !translatedCues.length) return;
    clearTimeout(navigationReloadTimer);
    navigationReloadTimer = null;
    scheduledVideoId = '';
    runId += 1;
    cancelCurrentRequest();
    busy = true;
    progressText = 'Đang chuyển video';
    pendingVideoId = source === 'yt-navigate-start' && !nextVideoId
      ? ''
      : nextVideoId || pendingVideoId || getVideoId() || '';
    activeVideoId = '';
    translatedCues = [];
    resetRenderedCue();
    preloadReleased = true;
    stopDomFallback();
    showOverlay('', false, '');
    showStatus('⏳ Đang chuyển video...');
    logEvent('info', `Chuyển video: reset phụ đề cũ (${source}${pendingVideoId ? ` -> ${pendingVideoId}` : ''})`);
  }

  function restartForCurrentVideo(expectedVideoId = '') {
    const targetVideoId = expectedVideoId || getVideoId() || '';
    if (!targetVideoId) return;
    if (scheduledVideoId === targetVideoId && navigationReloadTimer) return;
    clearTimeout(navigationReloadTimer);
    busy = true;
    progressText = 'Đang tải transcript';
    runId += 1;
    cancelCurrentRequest();
    const currentRunId = runId;
    activeVideoId = targetVideoId;
    pendingVideoId = targetVideoId;
    scheduledVideoId = targetVideoId;
    const loadingVideoId = targetVideoId;
    activateStartedAt = Date.now();
    resumedAt = 0;
    lastLatencyLogAt = 0;
    resetDriftStats();
    clearActiveTranscript();
    preloadReleased = false;
    stopDomFallback();
    pauseForPreload();
    showStatus('⏳ Đang tải transcript...');
    navigationReloadTimer = setTimeout(() => {
      if (currentRunId !== runId || !isActive) return;
      scheduledVideoId = '';
      if (getVideoId() !== loadingVideoId) {
        logEvent('warn', `Bỏ qua tải transcript cũ: ${loadingVideoId}, URL hiện tại ${getVideoId() || 'none'}`);
        return;
      }
      loadAndTranslateTranscript(currentRunId, loadingVideoId).catch(error => handleTranscriptLoadError(error, currentRunId));
    }, 900);
  }

  async function handleTranscriptLoadError(error, currentRunId) {
    if (error.message === 'Đã hủy dịch') return;
    if (currentRunId !== runId || !isActive) return;
    releasePreloadPause();
    settings = await getSettings();
    if (currentRunId !== runId || !isActive) return;
    if (shouldUseRealtimeFallback(error, settings)) {
      logEvent('info', `Chuyển realtime fallback: ${error.message}`);
      showStatus('⏳ Đang dịch realtime từ CC gốc...');
      startDomFallback(currentRunId);
    } else {
      logEvent('error', `Batch transcript lỗi: ${error.message}`);
      busy = false;
      progressText = '';
      showStatus(`⚠️ Batch lỗi: ${error.message}`);
      logEvent('warn', `Latency strict: không chạy realtime fallback. Nguyên nhân: ${error.message}`);
    }
    setTimeout(() => showStatus(''), 5000);
  }

  new MutationObserver(handlePossibleNavigation).observe(document, { subtree: true, childList: true });
  document.addEventListener('click', handleWatchLinkClick, true);
  document.addEventListener('auxclick', handleWatchLinkClick, true);
  document.addEventListener('pointerdown', handleWatchLinkClick, true);
  window.addEventListener('yt-navigate-start', handleNavigationStart);
  window.addEventListener('yt-navigate-finish', handlePossibleNavigation);
  window.addEventListener('popstate', handlePossibleNavigation);
  setInterval(watchVideoIdChange, 100);
})();
