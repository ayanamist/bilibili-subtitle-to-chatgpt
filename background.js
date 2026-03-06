'use strict';

// Wait for a tab to fully load (status=complete) + extra SPA hydration delay
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Poll until ChatGPT content script reports ready
async function ensureChatGPTReady(tabId) {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_CHECK_READY' });
      if (response && response.ready) return true;
      if (response && !response.loggedIn) return false;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Poll until AI Studio content script reports ready
async function ensureAIStudioReady(tabId) {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'AISTUDIO_CHECK_READY' });
      if (response && response.ready) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Send a message to the target tab's overlay (fire-and-forget)
function overlayMsg(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// Download audio from Bilibili CDN in the service worker context
async function downloadAudio(audioUrls) {
  const urls = [audioUrls.baseUrl, audioUrls.backupUrl].filter(Boolean);
  const errors = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'Referer': 'https://www.bilibili.com/' }
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        return buf;
      }
      errors.push(`HTTP ${res.status} ${res.statusText} (${new URL(url).hostname})`);
    } catch (e) {
      errors.push(`${e.message} (${new URL(url).hostname})`);
    }
  }
  throw new Error(`音频下载失败：${errors.join('；')}`);
}

// Main task handler — runs in the service worker, independent of popup lifecycle
async function handleTask(msg, notify) {
  const { taskType, openerTabIndex, bgOpen, tempChat, file, audioUrls, prompt } = msg;
  let targetTabId = null;

  try {
    if (taskType === 'chatgpt') {
      let url = 'https://chatgpt.com/';
      if (tempChat) url += '?temporary-chat=true';

      notify('STATUS', '正在打开 ChatGPT...');
      const tab = await chrome.tabs.create({ url, active: false, index: openerTabIndex + 1 });
      targetTabId = tab.id;
      await waitForTabLoad(targetTabId);

      notify('STATUS', '正在连接 ChatGPT...');
      overlayMsg(targetTabId, { type: 'EXT_STATUS', text: '正在连接 ChatGPT...' });
      const ready = await ensureChatGPTReady(targetTabId);
      if (!ready) {
        const errMsg = '无法连接到 ChatGPT，请先登录 chatgpt.com 后重试。';
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
      });

      if (!bgOpen) await chrome.tabs.update(targetTabId, { active: true });
      notify('DONE', bgOpen ? '已在后台打开 ChatGPT 页面。' : '已切换到 ChatGPT 页面。');

    } else if (taskType === 'aistudio') {
      // Download audio in the background before opening AI Studio
      notify('STATUS', '正在下载音频...');
      const audioBuffer = await downloadAudio(audioUrls);

      notify('STATUS', '正在打开 AI Studio...');
      const tab = await chrome.tabs.create({
        url: 'https://aistudio.google.com/prompts/new_chat',
        active: false,
        index: openerTabIndex + 1,
      });
      targetTabId = tab.id;
      await waitForTabLoad(targetTabId);

      notify('STATUS', '正在连接 AI Studio...');
      overlayMsg(targetTabId, { type: 'EXT_STATUS', text: '正在连接 AI Studio...' });
      const ready = await ensureAIStudioReady(targetTabId);
      if (!ready) {
        const errMsg = '无法连接到 AI Studio，请先登录 aistudio.google.com 后重试。';
        notify('ERROR', errMsg);
        overlayMsg(targetTabId, { type: 'EXT_ERROR', text: errMsg });
        return;
      }

      notify('STATUS', '正在发送音频到 AI Studio...');
      await chrome.tabs.sendMessage(targetTabId, {
        type: 'AISTUDIO_UPLOAD_AND_RUN',
        audioBuffer,
        prompt,
        tempChat,
      });

      if (!bgOpen) await chrome.tabs.update(targetTabId, { active: true });
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
