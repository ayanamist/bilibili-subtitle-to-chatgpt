'use strict';

// Resolve the current index and windowId of a tab by its stable ID.
// Tab IDs never change, but indices shift when tabs are opened/closed/moved.
// Capture windowId early (before long async operations) so new tabs always
// open in the original window even if the user switches focus elsewhere.
async function getTabInfo(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { index: t.index, windowId: t.windowId };
  } catch (e) {
    return { index: 0, windowId: undefined };
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

// For local transcribe: map requestId -> notify function
const _localProgressMap = new Map();

// ---- 本地推理并发队列 ----
// 限制同时运行的推理数（默认 1），防止显存溢出
let _inferenceRunning = 0;
const _inferenceQueue = []; // { run: () => void }[]

async function _runWithConcurrencyLimit(fn, notify) {
  const { localConcurrency } = await chrome.storage.local.get('localConcurrency');
  const limit = Math.max(1, Math.min(8, parseInt(localConcurrency, 10) || 1));

  if (_inferenceRunning < limit) {
    _inferenceRunning++;
    try { return await fn(); }
    finally {
      _inferenceRunning--;
      if (_inferenceQueue.length > 0) _inferenceQueue.shift().run();
    }
  }

  // 排队等待
  notify('STATUS', `等待推理槽位（当前排队第 ${_inferenceQueue.length + 1} 位）...`);
  return new Promise((resolve, reject) => {
    _inferenceQueue.push({
      run: async () => {
        _inferenceRunning++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          _inferenceRunning--;
          if (_inferenceQueue.length > 0) _inferenceQueue.shift().run();
        }
      },
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'BILIBILI_FETCH_PROGRESS') {
    const tabId = sender.tab?.id;
    const notify = tabId != null && _progressNotifyMap.get(tabId);
    if (!notify) return;
    const loadedMB = (msg.loaded / 1024 / 1024).toFixed(1);
    const totalStr = msg.total ? ` / ${(msg.total / 1024 / 1024).toFixed(1)} MB` : '';
    notify('STATUS', `正在下载音频... ${loadedMB} MB${totalStr}`);
    return;
  }
  if (msg.target === 'background' && msg.action === 'transcribe_progress') {
    const notify = _localProgressMap.get(msg.requestId);
    if (!notify) return;
    const { data } = msg;
    if (data.status === 'loading_model') {
      notify('STATUS', data.text || '正在加载模型...');
    } else if (data.status === 'decoding_audio') {
      notify('STATUS', '正在解码音频...');
    } else if (data.status === 'transcribing') {
      notify('STATUS', data.text || '正在转写中...');
    } else if (data.status === 'initiate' && data.file) {
      notify('STATUS', '正在下载模型文件...');
      if (String(msg.requestId).startsWith('test_')) {
        chrome.runtime.sendMessage({ target: 'options', action: 'test_file_progress', file: data.file, progress: 0, done: false }).catch(() => {});
      }
    } else if (data.status === 'progress' && data.file && data.progress != null) {
      notify('STATUS', '正在下载模型文件...');
      if (String(msg.requestId).startsWith('test_')) {
        chrome.runtime.sendMessage({ target: 'options', action: 'test_file_progress', file: data.file, loaded: data.loaded || 0, total: data.total || 0, done: false }).catch(() => {});
      }
    } else if (data.status === 'done' && data.file) {
      if (String(msg.requestId).startsWith('test_')) {
        chrome.runtime.sendMessage({ target: 'options', action: 'test_file_progress', file: data.file, loaded: data.total || 0, total: data.total || 0, done: true }).catch(() => {});
      }
    }
    return;
  }
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

// ---- Offscreen document management ----
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['BLOBS'],
    justification: 'Audio decoding and local ML inference via transformers.js',
  });
}

// ---- SRT 格式化 ----
function secondsToSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function chunksToSrt(chunks) {
  if (!chunks || chunks.length === 0) return '';
  return chunks.map((chunk, i) => {
    const [start, end] = chunk.timestamp || [0, 0];
    const from = secondsToSrtTime(start ?? 0);
    const to = secondsToSrtTime(end ?? (start + 5) ?? 5);
    return `${i + 1}\n${from} --> ${to}\n${(chunk.text || '').trim()}`;
  }).join('\n\n');
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
  if (msg.type === 'TEST_SELF_HOSTED_TRANSCRIBE') {
    // options 页面请求测试自建服务 /transcribe 接口（上传 sample.m4a）
    const { apiUrl, apiToken, versionStr } = msg;
    const notifyProgress = (text) => {
      chrome.runtime.sendMessage({ target: 'options', action: 'selfhosted_test_progress', text }).catch(() => {});
    };
    const notifyResult = (ok, extra) => {
      chrome.runtime.sendMessage({ target: 'options', action: 'selfhosted_test_result', ok, versionStr, ...extra }).catch(() => {});
    };
    (async () => {
      try {
        notifyProgress(`服务版本：${versionStr}，正在获取测试音频...`);
        const sampleResp = await fetch(chrome.runtime.getURL('test/sample.m4a'));
        if (!sampleResp.ok) throw new Error('无法加载测试音频文件');
        const sampleBlob = await sampleResp.blob();

        const formData = new FormData();
        formData.append('audio', sampleBlob, 'sample.m4a');

        notifyProgress(`服务版本：${versionStr}，正在上传音频进行转写测试...`);
        const response = await fetch(`${apiUrl}/transcribe`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiToken}` },
          body: formData,
        });

        if (!response.ok) {
          let errBody = '';
          try { errBody = await response.text(); } catch (e) {}
          throw new Error(errBody ? `HTTP ${response.status}: ${errBody.trim()}` : `HTTP ${response.status}`);
        }

        // 读取 SSE 响应流
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
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              currentData = line.slice(6).trim();
            } else if (line === '' || line === '\r') {
              if (currentEvent) {
                if (currentEvent === 'queue') {
                  try {
                    const p = JSON.parse(currentData);
                    notifyProgress(`服务版本：${versionStr}，排在第 ${p.position} 位等待转写...`);
                  } catch {}
                } else if (currentEvent === 'converting') {
                  notifyProgress(`服务版本：${versionStr}，正在转写中...`);
                } else if (currentEvent === 'result') {
                  let text = '';
                  try {
                    const parsed = JSON.parse(currentData);
                    console.log('[selfhosted-test] result event parsed:', parsed);
                    if (parsed.text) {
                      text = parsed.text.trim();
                    } else if (parsed.srt) {
                      text = parsed.srt.split('\n')
                        .filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes('-->'))
                        .join(' ').trim();
                    }
                    console.log('[selfhosted-test] extracted text:', text);
                  } catch(e) {
                    console.error('[selfhosted-test] failed to parse result data:', e, 'currentData was:', currentData);
                  }
                  console.log('[selfhosted-test] calling notifyResult with text, returning');
                  notifyResult(true, { text });
                  return;
                } else if (currentEvent === 'error') {
                  let errMsg = currentData;
                  try { errMsg = JSON.parse(currentData).error || currentData; } catch {}
                  throw new Error(errMsg);
                }
                currentEvent = '';
                currentData = '';
              }
            }
          }
        }
        notifyResult(true, {});
        console.warn('[selfhosted-test] stream ended without result event (fallback notifyResult)');
      } catch (e) {
        notifyResult(false, { error: e.message });
      }
    })();
    return false; // 结果通过消息返回，不使用 sendResponse
  }
  if (msg.type === 'TEST_LOCAL_INFERENCE') {
    const { model, device } = msg;
    (async () => {
      const requestId = 'test_' + Date.now();
      let inferenceStartTime = null; // 模型加载完成后开始计时（排除下载时间）
      const notifyOptions = (text) => {
        chrome.runtime.sendMessage({ target: 'options', action: 'test_progress', text }).catch(() => {});
      };
      try {
        await ensureOffscreenDocument();
        _localProgressMap.set(requestId, (_type, text) => {
          // decoding_audio 表示模型已就绪，开始计时
          if (text === '正在解码音频...' && inferenceStartTime === null) {
            inferenceStartTime = Date.now();
          }
          notifyOptions(text);
        });
        try {
          const result = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'transcribe',
            audioUrl: chrome.runtime.getURL('test/sample.m4a'),
            model,
            device,
            requestId,
            allowDownload: true,
          });
          const elapsed = inferenceStartTime ? ((Date.now() - inferenceStartTime) / 1000).toFixed(1) : null;
          if (!result || !result.ok) {
            chrome.runtime.sendMessage({ target: 'options', action: 'test_result', ok: false, error: result?.error || '推理失败' }).catch(() => {});
          } else {
            chrome.runtime.sendMessage({ target: 'options', action: 'test_result', ok: true, text: result.text, elapsed }).catch(() => {});
          }
        } finally {
          _localProgressMap.delete(requestId);
        }
      } catch (e) {
        chrome.runtime.sendMessage({ target: 'options', action: 'test_result', ok: false, error: e.message }).catch(() => {});
      }
    })();
    return false; // 通过单独消息返回结果，不使用 sendResponse
  }
});

// 打开 ChatGPT 标签页并发送文件（核心逻辑，供多处复用）
// 返回 { ok: boolean, error?: string }
async function _openChatGPTAndSend({ file, openerTabId, bgOpen, tempChat, biliTabId, videoTitle, bvid }) {
  let targetTabId = null;
  try {
    let url = 'https://chatgpt.com/';
    if (tempChat) url += '?temporary-chat=true';

    const { index: openerIndex, windowId } = await getTabInfo(openerTabId);
    const tab = await chrome.tabs.create({ url, active: !bgOpen, index: openerIndex + 1, openerTabId: biliTabId, windowId });
    targetTabId = tab.id;
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
      file,
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

// Main task handler — runs in the service worker, independent of popup lifecycle
async function handleTask(msg, notify) {
  const { taskType, openerTabId, bgOpen, tempChat, file, audioUrls, biliTabId, videoTitle, bvid } = msg;
  let targetTabId = null;

  try {
    if (taskType === 'chatgpt') {
      notify('STATUS', '正在打开 ChatGPT...');
      const result = await _openChatGPTAndSend({ file, openerTabId, bgOpen, tempChat, biliTabId, videoTitle, bvid });
      if (!result.ok) {
        notify('ERROR', result.error);
        return;
      }
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
        videoTitle,
        openerTabId,
        bgOpen,
        tempChat,
      });

      // 通知 popup 任务已移交给 content script
      notify('DONE', '已移交给页面处理。');

    } else if (taskType === 'local') {
      // 本地推理：下载音频 → offscreen document 推理 → 发送 SRT 到 ChatGPT
      const { model, device } = msg;
      const requestId = `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const biliOverlay = (type, text) => {
        if (type === 'STATUS') overlayMsg(biliTabId, { type: 'EXT_STATUS', text });
        else if (type === 'ERROR') overlayMsg(biliTabId, { type: 'EXT_ERROR', text });
        else if (type === 'DONE') overlayMsg(biliTabId, { type: 'EXT_STATUS', text });
      };

      // 下载音频（复用现有流程）
      biliOverlay('STATUS', '正在下载音频...');
      _progressNotifyMap.set(biliTabId, biliOverlay);
      let audioData;
      try {
        audioData = await downloadAudio(biliTabId, audioUrls);
      } finally {
        _progressNotifyMap.delete(biliTabId);
      }

      // bilibili-content-main.js 已将音频转为 base64 字符串返回，直接使用
      notify('STATUS', '正在准备本地推理...');
      biliOverlay('STATUS', '正在准备本地推理...');
      if (!audioData || audioData.length === 0) {
        throw new Error('音频数据为空，下载可能失败，请重试。');
      }
      const audioBase64 = audioData; // audioData 本身就是 base64 字符串

      // 确保 offscreen document 已创建
      await ensureOffscreenDocument();

      // 注册进度监听
      _localProgressMap.set(requestId, (type, text) => {
        notify(type, text);
        if (type === 'STATUS') biliOverlay('STATUS', text);
      });

      const transcribeStartTime = Date.now();
      try {
        const result = await _runWithConcurrencyLimit(async () => {
          return await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'transcribe',
            model,
            device,
            audioBase64,
            requestId,
          });
        }, notify);

        if (!result || !result.ok) {
          const errMsg = result?.error || '本地推理失败';
          notify('ERROR', errMsg);
          biliOverlay('ERROR', errMsg);
          return;
        }

        const transcribeElapsed = ((Date.now() - transcribeStartTime) / 1000).toFixed(1);

        // 转为 SRT
        const srtContent = chunksToSrt(result.chunks);
        if (!srtContent) {
          notify('ERROR', '转写结果为空，请检查音频或换一个模型重试。');
          biliOverlay('ERROR', '转写结果为空');
          return;
        }

        notify('STATUS', `转写完成（耗时 ${transcribeElapsed}s），正在打开 ChatGPT...`);
        biliOverlay('STATUS', `转写完成（耗时 ${transcribeElapsed}s），正在打开 ChatGPT...`);

        // 复用发送 SRT 到 ChatGPT 的流程
        const title = videoTitle || 'bilibili-audio';
        const fileName = bvid ? `${bvid}_${title}.srt` : `${title}.srt`;
        const chatResult = await sendSrtToChatGPT({
          srtContent,
          videoTitle,
          bvid,
          openerTabId,
          bgOpen,
          tempChat,
          biliTabId,
        });

        if (!chatResult.ok) {
          notify('ERROR', chatResult.error || '发送到 ChatGPT 失败');
          return;
        }

        const doneMsg = bgOpen ? '已在后台打开 ChatGPT 页面。' : '已切换到 ChatGPT 页面。';
        const doneWithTime = `${doneMsg}（转写耗时 ${transcribeElapsed}s）`;
        notify('DONE', doneWithTime);
        biliOverlay('DONE', doneWithTime);
      } finally {
        _localProgressMap.delete(requestId);
      }

    } else if (taskType === 'aistudio') {
      const biliOverlay = (type, text) => {
        if (type === 'STATUS') overlayMsg(biliTabId, { type: 'EXT_STATUS', text });
        else if (type === 'ERROR') overlayMsg(biliTabId, { type: 'EXT_ERROR', text });
        else if (type === 'DONE') overlayMsg(biliTabId, { type: 'EXT_STATUS', text });
      };
      biliOverlay('STATUS', '正在下载音频...');
      _progressNotifyMap.set(biliTabId, biliOverlay);
      let audioData;
      try {
        audioData = await downloadAudio(biliTabId, audioUrls);
      } finally {
        _progressNotifyMap.delete(biliTabId);
      }

      biliOverlay('STATUS', '正在打开 AI Studio...');
      const { index: openerIndex, windowId: openerWindowId } = await getTabInfo(openerTabId);
      const tab = await chrome.tabs.create({
        url: 'https://aistudio.google.com/prompts/new_chat',
        active: !bgOpen,
        index: openerIndex + 1,
        openerTabId: biliTabId,
        windowId: openerWindowId,
      });
      targetTabId = tab.id;
      await waitForTabLoad(targetTabId);

      // Content script is injected at document_start and handles DOM readiness internally.
      biliOverlay('STATUS', '正在发送音频到 AI Studio...');
      await chrome.tabs.sendMessage(targetTabId, {
        type: 'AISTUDIO_UPLOAD_AND_RUN',
        audioData,
        tempChat,
        bgOpen,
        videoTitle,
        bvid,
      });

      const doneMsg = bgOpen ? '已在后台打开 AI Studio 页面。' : '已切换到 AI Studio 页面。';
      notify('DONE', doneMsg); // 通知 popup 重新启用按钮
      biliOverlay('DONE', doneMsg);
    }
  } catch (e) {
    notify('ERROR', `错误：${e.message}`); // 通知 popup 重新启用按钮并展示错误
    if (biliTabId) {
      overlayMsg(biliTabId, { type: 'EXT_ERROR', text: `错误：${e.message}` });
    }
    if (targetTabId) {
      overlayMsg(targetTabId, { type: 'EXT_ERROR', text: `错误：${e.message}` });
    }
  }
}

// 发送 SRT 字幕到 ChatGPT（供 bilibili content script 调用）
async function sendSrtToChatGPT({ srtContent, videoTitle, bvid, openerTabId, bgOpen, tempChat, biliTabId }) {
  const title = videoTitle || 'bilibili-subtitle';
  const fileName = bvid ? `${bvid}_${title}.srt` : `${title}.srt`;
  return _openChatGPTAndSend({
    file: { name: fileName, content: srtContent },
    openerTabId,
    bgOpen,
    tempChat,
    biliTabId,
    videoTitle,
    bvid,
  });
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
  const { srtContent, videoTitle, bvid, openerTabId, bgOpen, tempChat } = msg;
  const biliTabId = sender.tab?.id;
  sendSrtToChatGPT({ srtContent, videoTitle, bvid, openerTabId, bgOpen, tempChat, biliTabId })
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
