let isRunning = false;

// DOM
const runBtn = document.getElementById('runBtn');
const errorBox = document.getElementById('errorBox');
const statusText = document.getElementById('statusText');

// Show/hide error
function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
}

function hideError() {
  errorBox.classList.remove('show');
}

function setStatus(msg) {
  statusText.textContent = msg;
}

// Create a new ChatGPT tab (inactive so popup stays open)
async function openChatGPTTab() {
  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
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
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_CHECK_READY' });
    if (response && response.ready) return true;
    if (response && !response.loggedIn) {
      showError('请先登录 chatgpt.com，然后重试。');
      return false;
    }
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['chatgpt-content.js']
      });
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

// Fetch Bilibili subtitle from extension context (bypasses page CSP)
async function fetchBilibiliSubtitle(pageUrl) {
  try {
    const bvMatch = pageUrl.match(/\/video\/(BV[\w]+)/);
    if (!bvMatch) {
      console.warn('[Subtitle] No BV id found in URL');
      return null;
    }
    const bvid = bvMatch[1];
    console.log('[Subtitle] BV id:', bvid);

    // Step 1: Get aid and cid from view API
    const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const viewRes = await fetch(viewUrl);
    const viewData = await viewRes.json();

    const aid = viewData?.data?.aid;
    const cid = viewData?.data?.cid;
    if (!aid || !cid) {
      console.warn('[Subtitle] Missing aid/cid from view API');
      return null;
    }

    // Step 2: Get subtitle list from player API
    const playerUrl = `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`;
    const playerRes = await fetch(playerUrl);
    const playerData = await playerRes.json();

    const subtitles = playerData?.data?.subtitle?.subtitles;
    if (!subtitles || subtitles.length === 0) {
      console.warn('[Subtitle] No subtitles available');
      return null;
    }

    // Prefer Chinese subtitle
    const zhSub = subtitles.find(s => /zh/.test(s.lan)) || subtitles[0];
    let subtitleUrl = zhSub.subtitle_url;
    if (subtitleUrl.startsWith('//')) subtitleUrl = 'https:' + subtitleUrl;

    // Step 3: Fetch subtitle content
    const subRes = await fetch(subtitleUrl);
    const subData = await subRes.json();

    if (!subData?.body || subData.body.length === 0) {
      console.warn('[Subtitle] Subtitle body is empty');
      return null;
    }

    return subData.body;
  } catch (e) {
    console.error('[Subtitle] Bilibili subtitle fetch error:', e);
    return null;
  }
}

// Convert seconds to SRT time format: HH:MM:SS,mmm
function secondsToSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// Convert Bilibili subtitle JSON array to SRT format string
function subtitleToSrt(body) {
  return body.map((item, i) => {
    return `${i + 1}\n${secondsToSrtTime(item.from)} --> ${secondsToSrtTime(item.to)}\n${item.content}`;
  }).join('\n\n');
}

// Main flow
async function run() {
  if (isRunning) return;

  hideError();
  isRunning = true;
  runBtn.disabled = true;

  try {
    // Get current tab URL
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab.url || '';

    if (!/bilibili\.com\/video\//.test(pageUrl)) {
      showError('请在 B 站视频页面使用此扩展。');
      return;
    }

    // Fetch subtitle
    setStatus('正在获取字幕...');
    const subtitleBody = await fetchBilibiliSubtitle(pageUrl);

    if (!subtitleBody) {
      showError('未能获取 B 站字幕。请确认：\n1. 已登录 B 站\n2. 该视频有 AI 字幕（播放器右下角有"字幕"按钮）');
      return;
    }

    const srtContent = subtitleToSrt(subtitleBody);
    const fileName = `${tab.title || 'bilibili-subtitle'}.srt`;

    // Open new ChatGPT tab
    setStatus('正在打开 ChatGPT...');
    const chatgptTabId = await openChatGPTTab();

    // Ensure ready
    setStatus('正在连接 ChatGPT...');
    const ready = await ensureChatGPTReady(chatgptTabId);
    if (!ready) return;

    // Submit file
    setStatus('正在发送字幕文件...');
    const submitResult = await chrome.tabs.sendMessage(chatgptTabId, {
      type: 'CHATGPT_SUBMIT_PROMPT',
      file: { name: fileName, content: srtContent }
    });

    if (!submitResult || !submitResult.ok) {
      showError(`发送失败：${submitResult?.error || '未知错误'}`);
      return;
    }

    // Activate the ChatGPT tab now that submission is done
    await chrome.tabs.update(chatgptTabId, { active: true });
    setStatus('已发送，请在 ChatGPT 页面查看结果。');
  } catch (e) {
    showError(`错误：${e.message}`);
  } finally {
    isRunning = false;
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', run);

// Init: check if current page is bilibili video
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab.url || '';
    if (!/bilibili\.com\/video\//.test(pageUrl)) {
      runBtn.disabled = true;
      setStatus('请在 B 站视频页面使用');
    }
  } catch (e) {
    // ignore
  }
})();
