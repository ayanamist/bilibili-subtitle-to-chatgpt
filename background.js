'use strict';

// Resolve the current index of a tab by its stable ID.
// Tab IDs never change, but indices shift when tabs are opened/closed/moved.
async function getTabIndex(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return t.index;
  } catch (e) {
    return 0;
  }
}

// Wait for a tab to fully load (status=complete) + extra SPA hydration delay
function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, timeout);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        setTimeout(resolve, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Poll until ChatGPT content script reports ready
// Returns 'ready' | 'not-logged-in' | 'timeout'
async function ensureChatGPTReady(tabId) {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_CHECK_READY' });
      if (response && response.ready) return 'ready';
      if (response && !response.loggedIn) return 'not-logged-in';
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return 'timeout';
}

// Send a message to the target tab's overlay (fire-and-forget)
function overlayMsg(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// Receive download progress from bilibili-content.js and forward to popup.
// Keyed by biliTabId to support concurrent tasks.
const _progressNotifyMap = new Map();
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'BILIBILI_FETCH_PROGRESS') return;
  const tabId = sender.tab?.id;
  const notify = tabId != null && _progressNotifyMap.get(tabId);
  if (!notify) return;
  const loadedMB = (msg.loaded / 1024 / 1024).toFixed(1);
  const totalStr = msg.total ? ` / ${(msg.total / 1024 / 1024).toFixed(1)} MB` : '';
  notify('STATUS', `正在下载音频... ${loadedMB} MB${totalStr}`);
});

// Download audio by messaging the Bilibili tab's MAIN-world content script.
// fetch() in MAIN world carries the correct Referer automatically.
// Result is a plain number array (JSON-safe throughout the message chain).
async function downloadAudio(biliTabId, audioUrls) {
  const urls = [audioUrls.baseUrl, audioUrls.backupUrl].filter(Boolean);
  const result = await chrome.tabs.sendMessage(biliTabId, { type: 'BILIBILI_FETCH_AUDIO', urls });
  if (!result.ok) throw new Error(`音频下载失败：${result.error}`);
  return result.data; // plain number array
}

// Handle one-shot messages (version test, SSE proxy from content script)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TEST_SELF_HOSTED_VERSION') {
    // options 页面请求测试自建服务 /version 接口
    const { apiUrl, apiToken } = msg;
    fetch(`${apiUrl}/version`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    }).then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        sendResponse({ ok: true, version: data.version });
      } else {
        sendResponse({ ok: false, status: res.status });
      }
    }).catch((e) => {
      sendResponse({ ok: false, error: e.message });
    });
    return true; // async
  }
});

// Main task handler — runs in the service worker, independent of popup lifecycle
async function handleTask(msg, notify) {
  const { taskType, openerTabId, bgOpen, tempChat, file, audioUrls, biliTabId, prompt, videoTitle, bvid } = msg;
  let targetTabId = null;

  try {
    if (taskType === 'chatgpt') {
      let url = 'https://chatgpt.com/';
      if (tempChat) url += '?temporary-chat=true';

      notify('STATUS', '正在打开 ChatGPT...');
      const openerIndex = await getTabIndex(openerTabId);
      const tab = await chrome.tabs.create({ url, active: false, index: openerIndex + 1 });
      targetTabId = tab.id;
      if (!bgOpen) await chrome.tabs.update(targetTabId, { active: true });
      await waitForTabLoad(targetTabId);

      notify('STATUS', '正在连接 ChatGPT...');
      overlayMsg(targetTabId, { type: 'EXT_STATUS', text: '正在连接 ChatGPT...' });
      const readyResult = await ensureChatGPTReady(targetTabId);
      if (readyResult !== 'ready') {
        const errMsg = readyResult === 'not-logged-in'
          ? '请先登录 chatgpt.com，然后重试。'
          : '无法连接到 ChatGPT 页面，请刷新 chatgpt.com 后重试。';
        notify('ERROR', errMsg);
        overlayMsg(targetTabId, { type: 'EXT_ERROR', text: errMsg });
        return;
      }

      notify('STATUS', '正在发送字幕文件...');
      await chrome.tabs.sendMessage(targetTabId, {
        type: 'CHATGPT_PREPARE_PROMPT',
        file,
        prompt,
        bgOpen,
        tempChat,
        videoTitle,
        bvid,
      });

      notify('DONE', bgOpen ? '已在后台打开 ChatGPT 页面。' : '已切换到 ChatGPT 页面。');

    } else if (taskType === 'selfhosted') {
      // 自建服务：通知 bilibili content script 发起 SSE 转写请求
      const { selfHostedUrl, selfHostedToken } = msg;

      // 通知 bilibili content script 开始转写流程
      // content script 会通过 port 'bilibili-sse-proxy' 与 background 通信
      await chrome.tabs.sendMessage(biliTabId, {
        type: 'SELF_HOSTED_TRANSCRIBE',
        audioUrls,
        selfHostedUrl,
        selfHostedToken,
        prompt,
        videoTitle,
        openerTabId,
        bgOpen,
        tempChat,
      });

      // 通知 popup 任务已移交给 content script
      notify('DONE', '已移交给页面处理。');

    } else if (taskType === 'aistudio') {
      notify('STATUS', '正在下载音频...');
      _progressNotifyMap.set(biliTabId, notify);
      let audioData;
      try {
        audioData = await downloadAudio(biliTabId, audioUrls);
      } finally {
        _progressNotifyMap.delete(biliTabId);
      }

      notify('STATUS', '正在打开 AI Studio...');
      const openerIndex = await getTabIndex(openerTabId);
      const tab = await chrome.tabs.create({
        url: 'https://aistudio.google.com/prompts/new_chat',
        active: false,
        index: openerIndex + 1,
      });
      targetTabId = tab.id;
      await waitForTabLoad(targetTabId);
      if (!bgOpen) await chrome.tabs.update(targetTabId, { active: true });

      // Content script is injected at document_start and handles DOM readiness internally.
      notify('STATUS', '正在发送音频到 AI Studio...');
      await chrome.tabs.sendMessage(targetTabId, {
        type: 'AISTUDIO_UPLOAD_AND_RUN',
        audioData,
        prompt,
        tempChat,
        bgOpen,
        videoTitle,
        bvid,
      });

      notify('DONE', bgOpen ? '已在后台打开 AI Studio 页面。' : '已切换到 AI Studio 页面。');
    }
  } catch (e) {
    notify('ERROR', `错误：${e.message}`);
    if (targetTabId) {
      overlayMsg(targetTabId, { type: 'EXT_ERROR', text: `错误：${e.message}` });
    }
  }
}

// 发送 SRT 字幕到 ChatGPT（供 bilibili content script 调用）
async function sendSrtToChatGPT({ srtContent, videoTitle, bvid, openerTabId, bgOpen, tempChat, prompt }) {
  const title = videoTitle || 'bilibili-subtitle';
  const fileName = bvid ? `${bvid}_${title}.srt` : `${title}.srt`;

  let targetTabId = null;
  try {
    let url = 'https://chatgpt.com/';
    if (tempChat) url += '?temporary-chat=true';

    const openerIndex = await getTabIndex(openerTabId);
    const tab = await chrome.tabs.create({ url, active: false, index: openerIndex + 1 });
    targetTabId = tab.id;
    if (!bgOpen) await chrome.tabs.update(targetTabId, { active: true });
    await waitForTabLoad(targetTabId);

    overlayMsg(targetTabId, { type: 'EXT_STATUS', text: '正在连接 ChatGPT...' });
    const readyResult = await ensureChatGPTReady(targetTabId);
    if (readyResult !== 'ready') {
      const errMsg = readyResult === 'not-logged-in'
        ? '请先登录 chatgpt.com，然后重试。'
        : '无法连接到 ChatGPT 页面，请刷新 chatgpt.com 后重试。';
      overlayMsg(targetTabId, { type: 'EXT_ERROR', text: errMsg });
      return { ok: false, error: errMsg };
    }

    await chrome.tabs.sendMessage(targetTabId, {
      type: 'CHATGPT_PREPARE_PROMPT',
      file: { name: fileName, content: srtContent },
      prompt,
      bgOpen,
      tempChat,
      videoTitle,
      bvid,
    });
    return { ok: true };
  } catch (e) {
    if (targetTabId) overlayMsg(targetTabId, { type: 'EXT_ERROR', text: `错误：${e.message}` });
    return { ok: false, error: e.message };
  }
}

// 处理来自 bilibili content script 的 SSE 代理 port 连接
// content script 通过 port 'bilibili-sse-proxy' 请求 background 代理 SSE 请求
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bilibili-sse-proxy') return;

  let abortController = null;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'START_SSE') return;

    const { url, headers } = msg;
    abortController = new AbortController();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: msg.body,
        signal: abortController.signal,
      });

      if (!response.ok) {
        let errBody = '';
        try { errBody = await response.text(); } catch (e) {}
        const errMsg = errBody ? `HTTP ${response.status}: ${errBody.trim()}` : `HTTP ${response.status}`;
        port.postMessage({ type: 'SSE_ERROR', error: errMsg });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留未完整的行

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6).trim();
          } else if (line === '' || line === '\r') {
            if (currentEvent) {
              try { port.postMessage({ type: 'SSE_EVENT', event: currentEvent, data: currentData }); } catch (e) { return; }
              currentEvent = '';
              currentData = '';
            }
          }
        }
      }
      try { port.postMessage({ type: 'SSE_DONE' }); } catch (e) {}
    } catch (e) {
      if (e.name !== 'AbortError') {
        try { port.postMessage({ type: 'SSE_ERROR', error: e.message }); } catch (_) {}
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (abortController) abortController.abort();
  });
});

// 处理来自 bilibili content script 的 SRT 结果，发送到 ChatGPT
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'SELF_HOSTED_SRT_RESULT') return false;
  const { srtContent, videoTitle, bvid, openerTabId, bgOpen, tempChat, prompt } = msg;
  sendSrtToChatGPT({ srtContent, videoTitle, bvid, openerTabId, bgOpen, tempChat, prompt })
    .then(result => sendResponse(result))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true; // async
});

// Listen for connections from the popup
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bilibili-subtitle') return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'START_TASK') return;

    let portAlive = true;
    port.onDisconnect.addListener(() => { portAlive = false; });

    function notify(type, text) {
      if (!portAlive) return;
      try { port.postMessage({ type, text }); } catch (e) {}
    }

    await handleTask(msg, notify);
  });
});
