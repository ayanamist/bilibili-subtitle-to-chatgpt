let outputLang = 'zh';
let currentText = '';
let isRunning = false;
let chatgptTabId = null;
let currentRequestId = null;
let messageListener = null;

// DOM
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const outputLangSelect = document.getElementById('outputLang');
const saveSettingsBtn = document.getElementById('saveSettings');
const pageTitle = document.getElementById('pageTitle');
const promptInput = document.getElementById('promptInput');
const runBtn = document.getElementById('runBtn');
const resultArea = document.getElementById('resultArea');
const resultContent = document.getElementById('resultContent');
const errorBox = document.getElementById('errorBox');
const spinner = document.getElementById('spinner');
const copyBtn = document.getElementById('copyBtn');
const clearBtn = document.getElementById('clearBtn');
const copiedToast = document.getElementById('copiedToast');
const footerInfo = document.getElementById('footerInfo');
const chips = document.querySelectorAll('.chip');

// Load settings
async function loadSettings() {
  const data = await chrome.storage.local.get(['outputLang']);
  outputLang = data.outputLang || 'zh';
  outputLangSelect.value = outputLang;
}

// Save settings
saveSettingsBtn.addEventListener('click', async () => {
  outputLang = outputLangSelect.value;
  await chrome.storage.local.set({ outputLang });
  saveSettingsBtn.textContent = '✓ 已保存';
  setTimeout(() => { saveSettingsBtn.textContent = '保存设置'; }, 1500);
});

// Toggle settings
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

// Find or open a ChatGPT tab, navigate to new conversation
async function findOrOpenChatGPTTab() {
  // Search for existing chatgpt.com tabs
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });

  if (tabs.length > 0) {
    const tab = tabs[0];
    // Navigate to root to start a new conversation
    await chrome.tabs.update(tab.id, { url: 'https://chatgpt.com/', active: true });
    // Wait for the page to load
    await waitForTabLoad(tab.id);
    return tab.id;
  }

  // No existing tab, create one
  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
  await waitForTabLoad(tab.id);
  return tab.id;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra delay for SPA hydration
        setTimeout(resolve, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Ensure the content script is injected and ChatGPT is ready
async function ensureChatGPTReady(tabId) {
  // Try sending a check message; if content script isn't loaded, inject it
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_CHECK_READY' });
    if (response && response.ready) return true;
    if (response && !response.loggedIn) {
      showError('请先登录 chatgpt.com，然后重试。');
      return false;
    }
  } catch (e) {
    // Content script not injected, inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['chatgpt-content.js']
      });
      // Wait for script to initialize
      await new Promise(r => setTimeout(r, 500));
      const response = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_CHECK_READY' });
      if (response && response.ready) return true;
      if (response && !response.loggedIn) {
        showError('请先登录 chatgpt.com，然后重试。');
        return false;
      }
    } catch (e2) {
      showError('无法连接到 ChatGPT 页面，请刷新 chatgpt.com 后重试。');
      return false;
    }
  }

  showError('ChatGPT 页面未就绪，请等待页面加载完成后重试。');
  return false;
}

// Check ChatGPT status for the status indicator
async function checkChatGPTStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
    if (tabs.length === 0) {
      statusDot.className = 'status-dot offline';
      statusText.textContent = '无标签页';
      return;
    }
    const tab = tabs[0];
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'CHATGPT_CHECK_READY' });
      if (response && response.ready) {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'ChatGPT ready';
      } else {
        statusDot.className = 'status-dot offline';
        statusText.textContent = '未登录';
      }
    } catch (e) {
      statusDot.className = 'status-dot offline';
      statusText.textContent = '未连接';
    }
  } catch (e) {
    statusDot.className = 'status-dot offline';
    statusText.textContent = '检查失败';
  }
}

// Get page content from the active tab
async function getPageContent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageTitle.textContent = tab.title || tab.url;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch(e) {}

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { action: 'getPageContent' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve({ content: '', title: tab.title, url: tab.url });
      } else {
        resolve(response);
      }
    });
  });
}

// Show error
function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
  resultArea.classList.remove('show');
}

function hideError() {
  errorBox.classList.remove('show');
}

// Main summarize function
async function summarize() {
  if (isRunning) {
    // Cancel
    if (chatgptTabId) {
      try {
        chrome.tabs.sendMessage(chatgptTabId, { type: 'CHATGPT_CANCEL' });
      } catch (e) {}
    }
    cleanupRun();
    return;
  }

  hideError();
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  isRunning = true;
  runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" fill="currentColor"/></svg> 停止`;
  spinner.classList.add('show');
  resultArea.classList.add('show');
  resultContent.innerHTML = '<span class="cursor"></span>';

  let fullText = '';
  const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  currentRequestId = requestId;

  try {
    // Get page content from active tab
    const pageData = await getPageContent();

    // Bilibili video: fetch subtitles from extension context
    if (pageData.type === 'bilibili-video') {
      const subtitleResult = await fetchBilibiliSubtitle(pageData.url);
      console.log('[Summarizer] Subtitle result length:', subtitleResult?.length || 0);

      if (subtitleResult) {
        pageData.content = (pageData.description ? `视频简介：${pageData.description}\n\n` : '') + `字幕内容：\n${subtitleResult}`;
        pageData.type = 'video-subtitle';
      } else {
        showError('未能获取 B 站字幕。请确认：\n1. 已登录 B 站\n2. 该视频有 AI 字幕（播放器右下角有"字幕"按钮）');
        cleanupRun();
        return;
      }
    }

    currentText = pageData.content;

    const contentLabel = pageData.type === 'video-subtitle' ? '视频字幕' : '网页文章内容';
    const fullPrompt = `以下是${contentLabel}：\n\n标题：${pageData.title}\n链接：${pageData.url}\n\n---\n\n${currentText}\n\n---\n\n${prompt}`;

    // Find or open ChatGPT tab
    resultContent.innerHTML = '正在打开 ChatGPT...<span class="cursor"></span>';
    chatgptTabId = await findOrOpenChatGPTTab();

    // Ensure ready
    resultContent.innerHTML = '正在连接 ChatGPT...<span class="cursor"></span>';
    const ready = await ensureChatGPTReady(chatgptTabId);
    if (!ready) {
      cleanupRun();
      return;
    }

    // Set up message listener for streaming
    messageListener = (msg) => {
      if (msg.requestId !== requestId) return;

      if (msg.type === 'CHATGPT_STREAM_DELTA') {
        fullText = msg.text;
        resultContent.innerHTML = escapeHtml(fullText) + '<span class="cursor"></span>';
        resultArea.scrollTop = resultArea.scrollHeight;
      }

      if (msg.type === 'CHATGPT_STREAM_DONE') {
        fullText = msg.text || fullText;
        if (fullText) {
          resultContent.innerHTML = escapeHtml(fullText);
        } else {
          showError('没有收到 ChatGPT 的响应，请检查 ChatGPT 页面是否正常。');
        }
        cleanupRun();
      }

      if (msg.type === 'CHATGPT_ERROR') {
        showError(`ChatGPT 错误：${msg.error}`);
        cleanupRun();
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    // Submit prompt to ChatGPT
    resultContent.innerHTML = '正在发送到 ChatGPT...<span class="cursor"></span>';
    const submitResult = await chrome.tabs.sendMessage(chatgptTabId, {
      type: 'CHATGPT_SUBMIT_PROMPT',
      prompt: fullPrompt,
      requestId
    });

    if (!submitResult || !submitResult.ok) {
      showError(`发送失败：${submitResult?.error || '未知错误'}`);
      cleanupRun();
      return;
    }

    resultContent.innerHTML = '等待 ChatGPT 回复...<span class="cursor"></span>';

  } catch (e) {
    showError(`错误：${e.message}`);
    cleanupRun();
  }
}

function cleanupRun() {
  isRunning = false;
  currentRequestId = null;
  chatgptTabId = null;
  runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 2l11 6-11 6V2z" fill="currentColor"/></svg> 运行`;
  spinner.classList.remove('show');
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
    messageListener = null;
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

// Quick prompt chips
chips.forEach(chip => {
  chip.addEventListener('click', () => {
    promptInput.value = chip.dataset.prompt;
    promptInput.style.height = 'auto';
    promptInput.style.height = promptInput.scrollHeight + 'px';
  });
});

// Auto resize textarea
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 80) + 'px';
});

// Run on Enter (Shift+Enter for newline)
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    summarize();
  }
});

runBtn.addEventListener('click', summarize);

// Copy result
copyBtn.addEventListener('click', () => {
  const text = resultContent.innerText.replace('[已停止]', '').trim();
  navigator.clipboard.writeText(text).then(() => {
    copiedToast.classList.add('show');
    setTimeout(() => copiedToast.classList.remove('show'), 2000);
  });
});

// Clear result
clearBtn.addEventListener('click', () => {
  resultArea.classList.remove('show');
  resultContent.innerHTML = '';
  hideError();
});

// Footer info
footerInfo.textContent = '需要登录 chatgpt.com';

// Fetch Bilibili subtitle from extension context (bypasses page CSP)
async function fetchBilibiliSubtitle(pageUrl) {
  try {
    // Extract BV id from URL
    const bvMatch = pageUrl.match(/\/video\/(BV[\w]+)/);
    if (!bvMatch) {
      console.warn('[Summarizer] No BV id found in URL');
      return null;
    }
    const bvid = bvMatch[1];
    console.log('[Summarizer] BV id:', bvid);

    // Step 1: Get aid and cid from view API
    const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    console.log('[Summarizer] Fetching view info:', viewUrl);
    const viewRes = await fetch(viewUrl);
    const viewData = await viewRes.json();
    console.log('[Summarizer] View API code:', viewData?.code);

    const aid = viewData?.data?.aid;
    const cid = viewData?.data?.cid;
    if (!aid || !cid) {
      console.warn('[Summarizer] Missing aid/cid from view API');
      return null;
    }
    console.log('[Summarizer] aid:', aid, 'cid:', cid);

    // Step 2: Get subtitle list from player API
    const playerUrl = `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`;
    console.log('[Summarizer] Fetching player info:', playerUrl);
    const playerRes = await fetch(playerUrl);
    const playerData = await playerRes.json();
    console.log('[Summarizer] Player API code:', playerData?.code);
    console.log('[Summarizer] Subtitle info:', JSON.stringify(playerData?.data?.subtitle));

    const subtitles = playerData?.data?.subtitle?.subtitles;
    if (!subtitles || subtitles.length === 0) {
      console.warn('[Summarizer] No subtitles available');
      return null;
    }

    console.log('[Summarizer] Available subtitles:', subtitles.map(s => `${s.lan}: ${s.lan_doc}`));

    // Prefer Chinese subtitle
    const zhSub = subtitles.find(s => /zh/.test(s.lan)) || subtitles[0];
    let subtitleUrl = zhSub.subtitle_url;
    if (subtitleUrl.startsWith('//')) subtitleUrl = 'https:' + subtitleUrl;

    // Step 3: Fetch subtitle content
    console.log('[Summarizer] Fetching subtitle:', subtitleUrl);
    const subRes = await fetch(subtitleUrl);
    const subData = await subRes.json();

    if (!subData?.body || subData.body.length === 0) {
      console.warn('[Summarizer] Subtitle body is empty');
      return null;
    }

    console.log('[Summarizer] Got subtitle lines:', subData.body.length);
    return subData.body.map(item => item.content).join('\n');
  } catch (e) {
    console.error('[Summarizer] Bilibili subtitle fetch error:', e);
    return null;
  }
}

// Init
loadSettings();
checkChatGPTStatus();
getPageContent().then(data => {
  if (data.title) pageTitle.textContent = data.title;
});
