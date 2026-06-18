// Chạy trong MAIN world — cùng context với YouTube, fetch được mọi URL
(function () {
  function getPlayerResponse(videoId) {
    var candidates = [];
    var player = document.getElementById('movie_player');
    if (player && typeof player.getVideoData === 'function') {
      try {
        var videoData = player.getVideoData();
        if (videoData && videoData.video_id && videoData.video_id !== videoId) return null;
      } catch (_e) {}
    }
    if (player && typeof player.getPlayerResponse === 'function') {
      try { candidates.push(player.getPlayerResponse()); } catch (_e) {}
    }
    if (window.ytInitialPlayerResponse) candidates.push(window.ytInitialPlayerResponse);

    var flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && flexy.playerData) candidates.push(flexy.playerData);

    var raw = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args &&
      window.ytplayer.config.args.raw_player_response;
    if (raw) {
      try { candidates.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (_e) {}
    }

    return candidates.find(function(pr) {
      return pr && pr.videoDetails && pr.videoDetails.videoId === videoId;
    }) || null;
  }

  function getEnTrack(videoId) {
    var pr = getPlayerResponse(videoId);
    if (!pr) return null;
    var tracks = (pr.captions &&
      pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    tracks = tracks.filter(function(t) { return trackMatchesVideo(t, videoId); });
    return tracks.find(function(t) { return t.languageCode && t.languageCode.startsWith('en') && !t.kind; })
      || tracks.find(function(t) { return t.languageCode && t.languageCode.startsWith('en'); })
      || tracks.find(function(t) { return !t.kind; });
  }

  function trackMatchesVideo(track, videoId) {
    if (!track || !track.baseUrl) return false;
    try {
      var urlVideoId = new URL(track.baseUrl).searchParams.get('v');
      return urlVideoId === videoId;
    } catch (_e) {
      return track.baseUrl.indexOf('v=' + encodeURIComponent(videoId)) !== -1
        || track.baseUrl.indexOf('v%3D' + encodeURIComponent(videoId)) !== -1;
    }
  }

  function withFormat(baseUrl, format) {
    try {
      var url = new URL(baseUrl);
      url.searchParams.set('fmt', format);
      return url.toString();
    } catch (_e) {
      return baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + 'fmt=' + format;
    }
  }

  // Nhận request từ content script → fetch subtitle → trả về data qua CustomEvent
  document.addEventListener('vi_sub_fetch_request', async function (e) {
    var videoId = e.detail && e.detail.videoId;
    var track = null;

    for (var attempt = 0; attempt < 12; attempt++) {
      track = getEnTrack(videoId);
      if (track && track.baseUrl) break;
      await sleep(500);
    }

    if (!track || !track.baseUrl) {
      document.dispatchEvent(new CustomEvent('vi_sub_fetch_result', {
        detail: { videoId: videoId, error: 'no_track' }
      }));
      return;
    }

    if (hasPoTokenRequirement(track.baseUrl)) {
      document.dispatchEvent(new CustomEvent('vi_sub_fetch_result', {
        detail: {
          videoId: videoId,
          error: 'po_token_required',
          lang: track.languageCode,
          kind: track.kind || 'manual'
        }
      }));
      return;
    }

    // Thử các format: json3, xml (default), vtt
    var urls = [
      withFormat(track.baseUrl, 'json3'),
      withFormat(track.baseUrl, 'vtt'),
      track.baseUrl
    ];
    var attempts = [];

    for (var round = 0; round < 3; round++) {
      for (var i = 0; i < urls.length; i++) {
        try {
          var res = await fetchWithTimeout(urls[i], 4000);
          var text = await res.text();
          attempts.push('r' + round + ':' + (res.status || 'ok') + ':' + (text ? text.trim().length : 0));
          if (text && text.trim().length > 10) {
            document.dispatchEvent(new CustomEvent('vi_sub_fetch_result', {
              detail: {
                videoId: videoId,
                text: text,
                format: text.trim().startsWith('{') ? 'json3' : text.trim().startsWith('WEBVTT') ? 'vtt' : 'xml',
                lang: track.languageCode,
                kind: track.kind || 'manual'
              }
            }));
            return;
          }
        } catch (err) {
          attempts.push('r' + round + ':err:' + (err && err.message ? err.message : 'fetch failed'));
        }
      }
      await sleep(800);
    }

    document.dispatchEvent(new CustomEvent('vi_sub_fetch_result', {
      detail: {
        videoId: videoId,
        error: 'empty_response',
        attempts: attempts.join(', '),
        lang: track.languageCode,
        kind: track.kind || 'manual'
      }
    }));
  });

  // Gửi danh sách tracks khi được hỏi (dùng cho debug)
  document.addEventListener('vi_sub_request', function () {
    var videoId = new URL(location.href).searchParams.get('v');
    var pr = getPlayerResponse(videoId);
    var tracks = (pr && pr.captions &&
      pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    document.dispatchEvent(new CustomEvent('vi_sub_tracks', {
      detail: { tracks: tracks, videoId: videoId }
    }));
  });

  window.addEventListener('yt-navigate-finish', function () {
    // Reset để content script tự request lại khi cần
  });

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  function fetchWithTimeout(url, timeoutMs) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal }).finally(function() {
      clearTimeout(timeoutId);
    });
  }

  function hasPoTokenRequirement(baseUrl) {
    try {
      var url = new URL(baseUrl);
      return url.searchParams.get('exp') === 'xpe' && !url.searchParams.get('pot');
    } catch (_e) {
      return /(?:[?&])exp=xpe(?:&|$)/.test(baseUrl) && !/(?:[?&])pot=/.test(baseUrl);
    }
  }
})();
