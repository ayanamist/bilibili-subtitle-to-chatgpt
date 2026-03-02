const DEFAULT_SERVER = 'http://localhost:4096';

let serverUrl = DEFAULT_SERVER;
let outputLang = 'zh';
let currentText = '';
let isRunning = false;
let abortController = null;

// DOM
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const serverUrlInput = document.getElementById('serverUrl');
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
  const data = await chrome.storage.local.get(['serverUrl', 'outputLang']);
  serverUrl = data.serverUrl || DEFAULT_SERVER;
  outputLang = data.outputLang || 'zh';
  serverUrlInput.value = serverUrl;
  outputLangSelect.value = outputLang;
}

// Save settings
saveSettingsBtn.addEventListener('click', async () => {
  serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER;
  outputLang = outputLangSelect.value;
  await chrome.storage.local.set({ serverUrl, outputLang });
  saveSettingsBtn.textContent = '✓ 已保存';
  setTimeout(() => { saveSettingsBtn.textContent = '保存设置'; }, 1500);
  checkServer();
});

// Toggle settings
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

// Check server health
async function checkServer() {
  try {
    const res = await fetch(`${serverUrl}/global/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      statusDot.className = 'status-dot online';
      statusText.textContent = `v${data.version || 'online'}`;
      return true;
    }
  } catch (e) {}
  statusDot.className = 'status-dot offline';
  statusText.textContent = 'offline';
  return false;
}

// Get page content
async function getPageContent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageTitle.textContent = tab.title || tab.url;

  try {
    const result = await chrome.scripting.executeScript({
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
    abortController?.abort();
    return;
  }

  hideError();
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  const online = await checkServer();
  if (!online) {
    showError(`无法连接到 OpenCode 服务器。\n请先运行：\n\nopencode serve --cors chrome-extension://`);
    return;
  }

  isRunning = true;
  runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" fill="currentColor"/></svg> 停止`;
  spinner.classList.add('show');
  resultArea.classList.add('show');
  resultContent.innerHTML = '<span class="cursor"></span>';
  abortController = new AbortController();

  let fullText = '';

  try {
    // Get page content
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
        return;
      }
    }

    currentText = pageData.content;

    const contentLabel = pageData.type === 'video-subtitle' ? '视频字幕' : '网页文章内容';
    const fullPrompt = `以下是${contentLabel}：\n\n标题：${pageData.title}\n链接：${pageData.url}\n\n---\n\n${currentText}\n\n---\n\n${prompt}`;

    // Step 1: Create session
    const sessionRes = await fetch(`${serverUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Summarize: ${pageData.title?.slice(0, 40)}` }),
      signal: abortController.signal
    });

    if (!sessionRes.ok) throw new Error(`创建会话失败: ${sessionRes.status}`);
    const session = await sessionRes.json();
    const sessionId = session.id;

    // Step 2: Connect to global SSE event stream
    const eventRes = await fetch(`${serverUrl}/event`, {
      signal: abortController.signal
    });

    // Step 3: Send message asynchronously
    const promptRes = await fetch(`${serverUrl}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: fullPrompt }] }),
      signal: abortController.signal
    });

    if (!promptRes.ok && promptRes.status !== 204) {
      throw new Error(`发送消息失败: ${promptRes.status}`);
    }

    // Step 4: Read SSE stream
    const reader = eventRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sessionDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr || dataStr === '[DONE]') continue;

        try {
          const event = JSON.parse(dataStr);
          const props = event.properties || {};

          // Filter events for our session
          const eventSessionId = props.sessionID || props.part?.sessionID || props.info?.sessionID;
          if (eventSessionId && eventSessionId !== sessionId) continue;

          // Incremental text delta
          if (event.type === 'message.part.delta' && props.field === 'text') {
            fullText += props.delta;
            resultContent.innerHTML = escapeHtml(fullText) + '<span class="cursor"></span>';
            resultArea.scrollTop = resultArea.scrollHeight;
          }

          // Full part update (text)
          if (event.type === 'message.part.updated') {
            const part = props.part || props;
            if (part.type === 'text' && part.text) {
              fullText = part.text;
              resultContent.innerHTML = escapeHtml(fullText) + '<span class="cursor"></span>';
              resultArea.scrollTop = resultArea.scrollHeight;
            }
          }

          // Session idle = done
          if (event.type === 'session.status') {
            if (props.status?.type === 'idle' && fullText) {
              resultContent.innerHTML = escapeHtml(fullText);
              sessionDone = true;
              break;
            }
          }
        } catch (e) {}
      }

      if (sessionDone) break;
    }

    // Final cleanup
    if (fullText) {
      resultContent.innerHTML = escapeHtml(fullText);
    } else if (!resultContent.innerHTML || resultContent.innerHTML === '<span class="cursor"></span>') {
      showError('没有收到响应，请检查 OpenCode 是否正常运行。');
    }

  } catch (e) {
    if (e.name === 'AbortError') {
      if (fullText) {
        resultContent.innerHTML = escapeHtml(fullText) + '\n\n<em style="color:var(--text-muted)">[已停止]</em>';
      } else {
        resultArea.classList.remove('show');
      }
    } else {
      showError(`错误：${e.message}`);
    }
  } finally {
    isRunning = false;
    runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 2l11 6-11 6V2z" fill="currentColor"/></svg> 运行`;
    spinner.classList.remove('show');
    abortController = null;
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
footerInfo.textContent = `opencode serve --cors chrome-extension://`;

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
loadSettings().then(() => checkServer());
getPageContent().then(data => {
  if (data.title) pageTitle.textContent = data.title;
});
