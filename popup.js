let isRunning = false;
let cachedVideoInfo = null;  // { bvid, aid, cid }
let cachedHasSubtitle = null; // true/false/null (null = not checked yet)
let transcribeService = 'aistudio'; // 'aistudio' | 'selfhosted'，从 storage 加载

// DOM
const runBtn = document.getElementById('runBtn');
const errorBox = document.getElementById('errorBox');
const statusText = document.getElementById('statusText');
const tempChatCheckbox = document.getElementById('tempChatCheckbox');
const forceAIStudioCheckbox = document.getElementById('forceAIStudioCheckbox');
const forceAIStudioLabel = document.getElementById('forceAIStudioLabel');
const forceAIStudioLabelText = document.getElementById('forceAIStudioLabelText');
const bgOpenCheckbox = document.getElementById('bgOpenCheckbox');

// Restore checkbox state from localStorage (synchronous, no flicker)
tempChatCheckbox.checked = localStorage.getItem('tempChat') !== 'false';
forceAIStudioCheckbox.checked = localStorage.getItem('forceAIStudio') === 'true';
bgOpenCheckbox.checked = localStorage.getItem('bgOpen') === 'true';

// Save checkbox state on change
tempChatCheckbox.addEventListener('change', () => {
  localStorage.setItem('tempChat', tempChatCheckbox.checked);
});

// 根据 transcribeService 和字幕状态更新按钮文案与复选框文案
function updateUI() {
  if (runBtn.disabled) return;
  const noSubtitle = cachedHasSubtitle === false;
  const forceChecked = forceAIStudioCheckbox.checked;

  if (transcribeService === 'selfhosted') {
    // 自建服务场景
    forceAIStudioLabelText.textContent = '始终音频转写';
    if (noSubtitle || forceChecked) {
      runBtn.textContent = '音频转写并发送到ChatGPT';
    } else {
      runBtn.textContent = '发送字幕到 ChatGPT';
    }
  } else {
    // AI Studio 场景（默认）
    forceAIStudioLabelText.textContent = '始终使用 AI Studio';
    if (noSubtitle || forceChecked) {
      runBtn.textContent = '发送音频到 AI Studio';
    } else {
      runBtn.textContent = '发送字幕到 ChatGPT';
    }
  }
}

forceAIStudioCheckbox.addEventListener('change', () => {
  localStorage.setItem('forceAIStudio', forceAIStudioCheckbox.checked);
  updateUI();
});

bgOpenCheckbox.addEventListener('change', () => {
  localStorage.setItem('bgOpen', bgOpenCheckbox.checked);
});

// Set initial UI based on restored checkbox state
updateUI();

// Load prompt: use custom prompt from storage, fallback to built-in prompt.txt
async function loadPrompt() {
  const result = await chrome.storage.local.get('customPrompt');
  if (result.customPrompt != null) {
    return result.customPrompt;
  }
  const res = await fetch(chrome.runtime.getURL('prompt.txt'));
  return res.text();
}

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

// Fetch video info (bvid, aid, cid) from Bilibili
async function fetchVideoInfo(pageUrl) {
  setStatus('正在获取视频信息...');

  const bvMatch = pageUrl.match(/\/video\/(BV[\w]+)/);
  if (!bvMatch) {
    throw new Error('URL 中未找到 BV 号');
  }
  const bvid = bvMatch[1];

  // Get aid and cid from view API
  const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const viewRes = await fetch(viewUrl);
  const viewData = await viewRes.json();

  const aid = viewData?.data?.aid;
  if (!aid) {
    throw new Error(`视频信息获取失败 (code: ${viewData?.code}, msg: ${viewData?.message || '未知'})`);
  }

  // Determine cid based on page number (for multi-part videos)
  const pMatch = pageUrl.match(/[?&]p=(\d+)/);
  const pageNum = pMatch ? parseInt(pMatch[1], 10) : 1;
  const pages = viewData?.data?.pages;
  const cid = pages?.[pageNum - 1]?.cid || viewData?.data?.cid;
  if (!cid) {
    throw new Error(`未找到第 ${pageNum} P 的视频信息`);
  }

  const title = viewData?.data?.title || '';
  return { bvid, aid, cid, title };
}

// Fetch subtitle for given aid/cid, returns subtitle body or null
async function fetchSubtitle(bvid, aid, cid) {
  setStatus(`正在获取字幕... (${bvid})`);

  const playerUrl = `https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`;
  const playerRes = await fetch(playerUrl);
  const playerData = await playerRes.json();

  const subtitles = playerData?.data?.subtitle?.subtitles;
  if (!subtitles || subtitles.length === 0) {
    return null;
  }

  // Prefer Chinese AI subtitle
  const zhSub = subtitles.find(s => /zh/.test(s.lan));
  if (!zhSub) {
    return null;
  }

  let subtitleUrl = zhSub.subtitle_url;
  if (subtitleUrl.startsWith('//')) subtitleUrl = 'https:' + subtitleUrl;

  const subRes = await fetch(subtitleUrl);
  const subData = await subRes.json();

  if (!subData?.body || subData.body.length === 0) {
    return null;
  }

  return { body: subData.body, lan: zhSub.lan };
}

// Fetch the smallest audio stream URL from playurl API
async function fetchSmallestAudioUrl(aid, cid) {
  const url = `https://api.bilibili.com/x/player/wbi/playurl?avid=${aid}&cid=${cid}&qn=32&fnver=0&fnval=4048&fourk=1`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`playurl API error: ${data.message}`);
  const audio = data.data.dash.audio;
  const smallest = audio.reduce((min, a) => a.bandwidth < min.bandwidth ? a : min);

  // 过滤掉 mcdn.bilivideo.cn 域名的 URL，优先使用其他 CDN
  const isMcdn = (u) => { if (!u) return false; const h = new URL(u).hostname; return h === 'mcdn.bilivideo.cn' || h.endsWith('.mcdn.bilivideo.cn'); };
  const allUrls = [smallest.baseUrl, ...(smallest.backupUrl || [])];
  const filtered = allUrls.filter(u => !isMcdn(u));
  const candidates = filtered.length > 0 ? filtered : allUrls;
  return { baseUrl: candidates[0], backupUrl: candidates[1] };
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
  let handedOff = false;

  try {
    // Get current tab URL
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab.url || '';

    if (!/bilibili\.com\/video\//.test(pageUrl)) {
      showError('请在 B 站视频页面使用此扩展。');
      return;
    }

    // Get video info (use cache from init if available)
    const { bvid, aid, cid, title: videoTitle } = cachedVideoInfo || await fetchVideoInfo(pageUrl);

    // 判断是否使用自建服务（无字幕 or 强制勾选，且服务来源为 selfhosted）
    const forceChecked = forceAIStudioCheckbox.checked;

    // Try fetching subtitles (skip if forced)
    let subtitle = null;
    if (!forceChecked) {
      subtitle = cachedHasSubtitle === false ? null : await fetchSubtitle(bvid, aid, cid);
    }

    const noSubtitle = !subtitle;
    const promptText = await loadPrompt();

    // Connect to background service worker
    setStatus('正在移交任务，请勿关闭此窗口...');
    const port = chrome.runtime.connect({ name: 'bilibili-subtitle' });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'STATUS') setStatus(msg.text);
      if (msg.type === 'ERROR') {
        showError(msg.text);
        isRunning = false;
        runBtn.disabled = false;
      }
      if (msg.type === 'DONE') {
        setStatus(msg.text + '（可关闭此窗口）');
        isRunning = false;
        runBtn.disabled = false;
      }
    });

    port.onDisconnect.addListener(() => {
      if (isRunning) {
        showError('后台任务连接已断开，请重试。');
        isRunning = false;
        runBtn.disabled = false;
      }
    });

    if (!noSubtitle && !forceChecked) {
      // 有字幕 → 发送字幕到 ChatGPT（两种服务来源均走此流程）
      const srtContent = subtitleToSrt(subtitle.body);
      const title = videoTitle || tab.title || 'bilibili-subtitle';
      const fileName = bvid ? `${bvid}_${title}.srt` : `${title}.srt`;

      port.postMessage({
        type: 'START_TASK',
        taskType: 'chatgpt',
        openerTabIndex: tab.index,
        bgOpen: bgOpenCheckbox.checked,
        tempChat: tempChatCheckbox.checked,
        file: { name: fileName, content: srtContent },
        prompt: promptText,
        videoTitle,
        bvid,
      });
    } else if (transcribeService === 'selfhosted') {
      // 无字幕 + 自建服务 → 音频转写并发送到 ChatGPT
      setStatus('正在获取音频 URL...');
      const audioUrls = await fetchSmallestAudioUrl(aid, cid);

      // 读取自建服务配置
      const storageResult = await chrome.storage.local.get(['selfHostedApiUrl', 'selfHostedApiToken']);
      const selfHostedUrl = storageResult.selfHostedApiUrl || '';
      const selfHostedToken = storageResult.selfHostedApiToken || '';

      if (!selfHostedUrl) {
        showError('请先在设置页配置自建服务 API 地址。');
        return;
      }

      port.postMessage({
        type: 'START_TASK',
        taskType: 'selfhosted',
        openerTabIndex: tab.index,
        bgOpen: bgOpenCheckbox.checked,
        tempChat: tempChatCheckbox.checked,
        audioUrls,
        biliTabId: tab.id,
        prompt: promptText,
        videoTitle,
        selfHostedUrl,
        selfHostedToken,
      });
    } else {
      // 无字幕 + AI Studio → 发送音频到 AI Studio
      setStatus('正在获取音频 URL...');
      const audioUrls = await fetchSmallestAudioUrl(aid, cid);

      port.postMessage({
        type: 'START_TASK',
        taskType: 'aistudio',
        openerTabIndex: tab.index,
        bgOpen: bgOpenCheckbox.checked,
        tempChat: tempChatCheckbox.checked,
        audioUrls,
        biliTabId: tab.id,
        prompt: promptText,
      });
    }

    handedOff = true;
    // Status will be updated by background notify messages
  } catch (e) {
    showError(`错误：${e.message}`);
  } finally {
    if (!handedOff) {
      isRunning = false;
      runBtn.disabled = false;
    }
  }
}

runBtn.addEventListener('click', run);

// Init: load transcribeService config, check if current page is bilibili video, pre-check subtitle
(async () => {
  try {
    // 先加载服务来源配置
    const storageResult = await chrome.storage.local.get('transcribeService');
    transcribeService = storageResult.transcribeService || 'aistudio';
    updateUI();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab.url || '';
    if (!/bilibili\.com\/video\//.test(pageUrl)) {
      runBtn.disabled = true;
      setStatus('请在 B 站视频页面使用');
      return;
    }

    try {
      cachedVideoInfo = await fetchVideoInfo(pageUrl);
      const subtitle = await fetchSubtitle(cachedVideoInfo.bvid, cachedVideoInfo.aid, cachedVideoInfo.cid);
      cachedHasSubtitle = !!subtitle;
      updateUI();
      if (cachedHasSubtitle) {
        forceAIStudioLabel.style.display = '';
        setStatus(`发现 ${subtitle.lan} 字幕 `);
      } else {
        setStatus('未发现中文字幕');
      }
    } catch (e) {
      // Pre-check failed, run() will retry
      setStatus('字幕探测失败，将在点击时重试');
    } finally {
      runBtn.disabled = false;
      updateUI();
    }
  } catch (e) {
    // ignore
  }
})();
