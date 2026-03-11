'use strict';

// Track the active download's requestId to filter spurious progress messages.
let _activeRequestId = null;

// Forward download progress from MAIN world to background service worker.
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;
  if (event.data.type !== 'BILIBILI_FETCH_PROGRESS') return;
  if (_activeRequestId && event.data.requestId !== _activeRequestId) return;
  chrome.runtime.sendMessage({
    type: 'BILIBILI_FETCH_PROGRESS',
    loaded: event.data.loaded,
    total: event.data.total,
  }).catch(() => {});
});

// Runs in the ISOLATED world — bridges chrome.tabs.sendMessage from the
// background to the MAIN world content script via window.postMessage.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'BILIBILI_FETCH_AUDIO') {
    const requestId = crypto.randomUUID();
    _activeRequestId = requestId;

    const handler = (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type !== 'BILIBILI_FETCH_RESULT' || event.data.requestId !== requestId) return;
      window.removeEventListener('message', handler);
      _activeRequestId = null;
      sendResponse(event.data.result);
    };
    window.addEventListener('message', handler);

    window.postMessage({ type: 'BILIBILI_FETCH_AUDIO', urls: msg.urls, requestId }, '*');
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === 'SELF_HOSTED_TRANSCRIBE') {
    handleSelfHostedTranscribe(msg);
    sendResponse({ ok: true });
    return false;
  }
});

// ---- 状态浮层 ----

let _overlay = null;
let _overlayText = null;
let _overlayClose = null;

function ensureOverlay() {
  if (_overlay) return;

  _overlay = document.createElement('div');
  _overlay.style.cssText = [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483647',
    'background:rgba(0,0,0,0.82)', 'color:#fff', 'border-radius:10px',
    'padding:14px 18px', 'font-size:14px', 'line-height:1.6',
    'max-width:320px', 'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
    'font-family:system-ui,sans-serif', 'display:flex',
    'align-items:flex-start', 'gap:10px',
  ].join(';');

  _overlayText = document.createElement('span');
  _overlayText.style.cssText = 'flex:1;word-break:break-all';

  _overlayClose = document.createElement('button');
  _overlayClose.textContent = '×';
  _overlayClose.style.cssText = [
    'background:none', 'border:none', 'color:#aaa', 'cursor:pointer',
    'font-size:18px', 'line-height:1', 'padding:0', 'flex-shrink:0',
  ].join(';');
  _overlayClose.addEventListener('click', hideOverlay);

  _overlay.appendChild(_overlayText);
  _overlay.appendChild(_overlayClose);
  document.body.appendChild(_overlay);
}

function showOverlay(text) {
  ensureOverlay();
  _overlayText.textContent = text;
  _overlay.style.display = 'flex';
}

function hideOverlay() {
  if (_overlay) _overlay.style.display = 'none';
}

// ---- 自建服务转写流程 ----

async function handleSelfHostedTranscribe(msg) {
  const {
    audioUrls, selfHostedUrl, selfHostedToken,
    prompt, videoTitle, openerTabIndex, bgOpen, tempChat,
  } = msg;

  // 获取当前页面 URL 用于提取 bvid
  const bvMatch = location.href.match(/\/video\/(BV[\w]+)/);
  const bvid = bvMatch ? bvMatch[1] : '';

  showOverlay('正在准备音频转写...');

  // 通过 background 代理 SSE 请求（service worker 可访问任意 URL）
  const port = chrome.runtime.connect({ name: 'bilibili-sse-proxy' });

  // 构造请求体：音频 URL + 仅传递必要 headers
  const headers = {
    'Authorization': `Bearer ${selfHostedToken}`,
    'Content-Type': 'application/json',
  };

  const requestBody = JSON.stringify({
    url: audioUrls.baseUrl,
    headers: {
      'User-Agent': navigator.userAgent,
      'Referer': location.href,
      'Origin': location.origin,
    },
  });

  port.postMessage({
    type: 'START_SSE',
    url: `${selfHostedUrl}/transcribe`,
    headers,
    body: requestBody,
  });

  port.onMessage.addListener(async (sseMsg) => {
    if (sseMsg.type === 'SSE_EVENT') {
      const { event, data } = sseMsg;

      if (event === 'queue') {
        try {
          const parsed = JSON.parse(data);
          showOverlay(`排在第 ${parsed.position} 位，等待转写...`);
        } catch (e) {
          showOverlay('排队等待中...');
        }
      } else if (event === 'converting') {
        showOverlay('正在转换中...');
      } else if (event === 'result') {
        try {
          const parsed = JSON.parse(data);
          const srtContent = parsed.srt || '';
          showOverlay('转写完成，正在发送到 ChatGPT...');
          port.disconnect();

          // 将 SRT 发送给 background，由 background 打开 ChatGPT 并发送
          const result = await chrome.runtime.sendMessage({
            type: 'SELF_HOSTED_SRT_RESULT',
            srtContent,
            videoTitle,
            bvid,
            openerTabIndex,
            bgOpen,
            tempChat,
            prompt,
          });

          if (result && result.ok) {
            showOverlay('已发送到 ChatGPT！');
            setTimeout(hideOverlay, 3000);
          } else {
            showOverlay(`发送失败：${result?.error || '未知错误'}`);
          }
        } catch (e) {
          showOverlay(`解析结果失败：${e.message}`);
        }
      } else if (event === 'error') {
        try {
          const parsed = JSON.parse(data);
          showOverlay(`转写失败：${parsed.error || data}`);
        } catch (e) {
          showOverlay(`转写失败：${data}`);
        }
        port.disconnect();
      }
    } else if (sseMsg.type === 'SSE_ERROR') {
      showOverlay(`连接失败：${sseMsg.error}`);
      port.disconnect();
    } else if (sseMsg.type === 'SSE_DONE') {
      // 正常结束（result 事件已处理）
    }
  });

  port.onDisconnect.addListener(() => {
    // port 断开时如果浮层还在显示"转换中"，说明异常断开
    if (_overlay && _overlay.style.display !== 'none' &&
        _overlayText && _overlayText.textContent.includes('转换中')) {
      showOverlay('连接已断开，请重试。');
    }
  });
}