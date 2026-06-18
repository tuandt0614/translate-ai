(function (root) {
  function parseTimestamp(value) {
    const parts = String(value).split(':').map(Number);
    const seconds = parts.pop() || 0;
    const minutes = parts.pop() || 0;
    const hours = parts.pop() || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function parseJson3(text) {
    const data = JSON.parse(text);
    return (data.events || []).filter(event => event.segs?.length && Number.isFinite(event.tStartMs)).map(event => ({
      start: event.tStartMs / 1000,
      end: (event.tStartMs + (event.dDurationMs || 1800)) / 1000,
      text: event.segs.map(segment => segment.utf8 || '').join('').replace(/\s+/g, ' ').trim()
    })).filter(cue => cue.text);
  }

  function parseVtt(text) {
    const cues = [];
    for (const block of String(text).replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n').filter(Boolean);
      const timeLine = lines.find(line => line.includes('-->'));
      if (!timeLine) continue;
      const timeIndex = lines.indexOf(timeLine);
      const [startRaw, endRaw] = timeLine.split('-->').map(part => part.trim().split(/\s+/)[0]);
      const cueText = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (cueText) cues.push({ start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text: cueText });
    }
    return cues.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end));
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    return Array.from(doc.querySelectorAll('text')).map(node => {
      const start = Number(node.getAttribute('start'));
      const duration = Number(node.getAttribute('dur') || 2);
      const cueText = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      return { start, end: start + duration, text: cueText };
    }).filter(cue => Number.isFinite(cue.start) && cue.text);
  }

  function findCueIndex(cues, time) {
    let low = 0;
    let high = cues.length;
    const latestStart = time + 0.15;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start <= latestStart) low = middle + 1; else high = middle;
    }

    for (let index = low - 1; index >= 0; index -= 1) {
      const cue = cues[index];
      if (time > cue.end + 0.25) continue;
      if (time >= cue.start - 0.15) return index;
      break;
    }
    return -1;
  }

  function findStartIndex(cues, time) {
    const active = findCueIndex(cues, time);
    if (active !== -1) return active;
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start < time) low = middle + 1; else high = middle;
    }
    return low < cues.length ? low : 0;
  }

  function limitLines(text, maxLines) {
    const lines = String(text || '').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Number(maxLines) || 2)).join('\n');
  }

  const api = { parseTimestamp, parseJson3, parseVtt, parseXml, findCueIndex, findStartIndex, limitLines };
  root.ViSubCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
