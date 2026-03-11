'use strict';

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

// Main task handler — runs in the service worker, independent of popup lifecycle
async function handleTask(msg, notify) {
  const { taskType, openerTabIndex, bgOpen, tempChat, file, audioUrls, biliTabId, prompt, videoTitle } = msg;
  let targetTabId = null;

  try {
    if (taskType === 'chatgpt') {
      let url = 'https://chatgpt.com/';
      if (tempChat) url += '?temporary-chat=true';

      notify('STATUS', '正在打开 ChatGPT...');
      const tab = await chrome.tabs.create({ url, active: false, index: openerTabIndex + 1 });
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
      });

      notify('DONE', bgOpen ? '已在后台打开 ChatGPT 页面。' : '已切换到 ChatGPT 页面。');

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
      const tab = await chrome.tabs.create({
        url: 'https://aistudio.google.com/prompts/new_chat',
        active: false,
        index: openerTabIndex + 1,
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
