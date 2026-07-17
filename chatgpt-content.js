// ChatGPT page content script: attach SRT file and send
(() => {
  // --- Last received subtitle file (for manual save) ---
  let _lastFile = null; // { name: string, content: string }

  // --- Save subtitle button ---
  let _saveBtn = null;
  let _retryUploadBtn = null;

  function getFloatingActionButtonStyle(bottomPx, background) {
    return 'position:fixed;right:16px;z-index:999999;' +
      `bottom:${bottomPx}px;` +
      `background:${background};color:#fff;border:none;cursor:pointer;` +
      'padding:8px 14px;border-radius:8px;font-size:13px;' +
      'font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
      'display:flex;align-items:center;gap:6px;';
  }

  function showSaveButton(fileName, fileContent) {
    _lastFile = { name: fileName, content: fileContent };
    if (_saveBtn && _retryUploadBtn) return; // already shown

    if (!_retryUploadBtn) {
      _retryUploadBtn = document.createElement('button');
      _retryUploadBtn.textContent = '⤴ 重新上传字幕';
      _retryUploadBtn.title = '再次触发字幕文件上传，但不会自动提交';
      _retryUploadBtn.style.cssText = getFloatingActionButtonStyle(128, '#2563eb');
      _retryUploadBtn.addEventListener('click', async () => {
        if (!_lastFile) return;
        const originalText = _retryUploadBtn.textContent;
        _retryUploadBtn.disabled = true;
        _retryUploadBtn.style.opacity = '0.7';
        _retryUploadBtn.style.cursor = 'not-allowed';
        try {
          showStatus('正在重新上传字幕文件...');
          await attachFileWithRetry(_lastFile.name, _lastFile.content);
          showStatus('字幕文件已重新上传，可继续手动发送。');
        } catch (e) {
          console.error('[ext] manual retry upload failed:', e);
          showError(`重新上传失败：${e.message}`);
        } finally {
          _retryUploadBtn.disabled = false;
          _retryUploadBtn.style.opacity = '1';
          _retryUploadBtn.style.cursor = 'pointer';
          _retryUploadBtn.textContent = originalText;
        }
      });
      document.body.appendChild(_retryUploadBtn);
    }

    if (!_saveBtn) {
      _saveBtn = document.createElement('button');
      _saveBtn.textContent = '⬇ 保存字幕文件';
      _saveBtn.title = '字幕文件上传失败时，可手动下载后再上传';
      _saveBtn.style.cssText = getFloatingActionButtonStyle(80, '#10a37f');
      _saveBtn.addEventListener('click', () => {
        if (!_lastFile) return;
        const blob = new Blob([_lastFile.content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = _lastFile.name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
      });
      document.body.appendChild(_saveBtn);
    }
  }

  function hideSaveButton() {
    if (_retryUploadBtn) {
      _retryUploadBtn.remove();
      _retryUploadBtn = null;
    }
    if (_saveBtn) {
      _saveBtn.remove();
      _saveBtn = null;
    }
    _lastFile = null;
  }

  // --- Status overlay ---

  let statusOverlay = null;

  function showStatus(msg) {
    if (!statusOverlay) {
      statusOverlay = document.createElement('div');
      statusOverlay.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:999999;' +
        'background:#10a37f;color:#fff;padding:10px 16px;border-radius:8px;' +
        'font-size:14px;font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
        'max-width:360px;line-height:1.4;transition:opacity .3s;' +
        'display:flex;align-items:flex-start;gap:10px;';

      const textNode = document.createElement('span');
      textNode.className = '__ext-status-text';
      textNode.style.flex = '1';

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText =
        'background:none;border:none;color:inherit;cursor:pointer;' +
        'font-size:14px;line-height:1;padding:0;opacity:.8;flex-shrink:0;';
      closeBtn.addEventListener('click', hideStatus);

      statusOverlay.appendChild(textNode);
      statusOverlay.appendChild(closeBtn);
      document.body.appendChild(statusOverlay);
    }
    statusOverlay.style.background = '#10a37f';
    statusOverlay.style.opacity = '1';
    statusOverlay.querySelector('.__ext-status-text').textContent = msg;
  }

  function showError(msg) {
    showStatus(msg);
    statusOverlay.style.background = '#e53935';
  }

  function hideStatus() {
    if (statusOverlay) {
      statusOverlay.style.opacity = '0';
      setTimeout(() => statusOverlay?.remove(), 300);
      statusOverlay = null;
    }
  }

  function findTextarea() {
    return document.querySelector('#prompt-textarea')
      || document.querySelector('div[contenteditable][data-placeholder]')
      || document.querySelector('.ProseMirror');
  }

  function findSendButton() {
    return document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('button[aria-label*="Send"]')
      || document.querySelector('button[aria-label*="send"]');
  }

  function getVisibleFileTiles() {
    return Array.from(document.querySelectorAll('[class*="file-tile"][role="group"]'));
  }

  function findFileTileByName(fileName, tiles = getVisibleFileTiles()) {
    return tiles.find(tile => {
      const ariaLabel = tile.getAttribute('aria-label') || '';
      const text = tile.textContent || '';
      return ariaLabel === fileName || ariaLabel.includes(fileName) || text.includes(fileName);
    }) || null;
  }

  function checkReady() {
    const textarea = findTextarea();
    return { ready: !!textarea };
  }

  function inputPrompt(text) {
    const textarea = findTextarea();
    if (!textarea) return;

    textarea.focus();

    if (textarea.tagName === 'TEXTAREA') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable div (ProseMirror)
      textarea.innerHTML = '';
      textarea.focus();
      const success = document.execCommand('insertText', false, text);
      if (!success || !textarea.textContent.trim()) {
        const p = document.createElement('p');
        p.textContent = text;
        textarea.innerHTML = '';
        textarea.appendChild(p);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  function clickSend() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 60; // 30 seconds max
      const timer = setInterval(() => {
        attempts++;
        const btn = findSendButton();
        if (btn && !btn.disabled) {
          clearInterval(timer);
          btn.click();
          resolve();
          return;
        }
        if (attempts >= maxAttempts) {
          clearInterval(timer);
          reject(new Error('发送按钮超时未就绪'));
        }
      }, 200);
    });
  }

  async function attachFile(fileName, fileContent) {
    const contentType = typeof fileContent;
    const contentLen = contentType === 'string' ? fileContent.length : (fileContent instanceof Uint8Array || Array.isArray(fileContent)) ? fileContent.length : -1;
    console.log('[ext] attachFile: fileName=', fileName,
      'contentType=', contentType,
      'contentLength=', contentLen,
      'preview=', contentType === 'string' ? fileContent.slice(0, 100) : '(non-string)');

    const file = new File([fileContent], fileName, { type: 'text/plain' });
    console.log('[ext] attachFile: File object size=', file.size, 'name=', file.name);
    const dt = new DataTransfer();
    dt.items.add(file);

    // Snapshot existing tiles before dispatching so we only wait for NEW ones
    const existingTiles = new Set(getVisibleFileTiles());
    console.log('[ext] attachFile: existingTiles count=', existingTiles.size);

    const fileInput = document.querySelector('#upload-files') || document.querySelector('input[type="file"]');
    if (!fileInput) throw new Error('找不到文件上传入口（#upload-files）');
    console.log('[ext] attachFile: using fileInput strategy, id=', fileInput.id);
    try {
      fileInput.value = '';
    } catch (e) {
      console.warn('[ext] attachFile: failed to clear file input value before upload', e);
    }
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Return existingTiles so the caller can verify attachment later (right before send).
    console.log('[ext] attachFile: upload triggered, returning existingTiles for later verification');
    return existingTiles;
  }

  async function attachFileWithRetry(fileName, fileContent, maxAttempts = 2) {
    let lastError = null;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptsMade = attempt;
      try {
        console.log('[ext] attachFileWithRetry: starting attempt', attempt, 'of', maxAttempts);
        const existingTiles = await attachFile(fileName, fileContent);
        await waitForFileAttachment(fileName, existingTiles);
        console.log('[ext] attachFileWithRetry: upload succeeded on attempt', attempt);
        return;
      } catch (e) {
        lastError = e;
        console.warn('[ext] attachFileWithRetry: upload attempt failed', attempt, 'of', maxAttempts, e);
        // A timed-out upload may still be owned and processed by ChatGPT. Starting
        // another attempt in that state creates duplicate attachments because the
        // original browser upload cannot be cancelled from this content script.
        // Only retry after the UI has positively shown that the attachment failed.
        if (attempt >= maxAttempts || !e.retryable) break;
      }
    }

    throw new Error(`字幕文件上传失败，已自动重试 ${Math.max(0, attemptsMade - 1)} 次：${lastError?.message || '未知错误'}`);
  }

  // Wait until the file upload is complete, using the send button's disabled state as the
  // authoritative signal: ChatGPT keeps the send button disabled while any upload is in
  // progress, and re-enables it only when all uploads finish (success or failure).
  //
  // After the send button re-enables we then verify the file tile is still in the DOM.
  // If the tile is gone → upload failed (ChatGPT removed it on error).
  //
  // NOTE: behavior-btn appears immediately on tile creation, NOT after upload completes,
  // so it cannot be used as an upload-success signal.
  //
  // existingTiles: Set of tile elements already in the DOM before this upload started.
  function waitForFileAttachment(fileName, existingTiles = new Set()) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      let newFileTile = null;
      let missingSince = null;
      let reportedSlowUpload = false;
      const slowUploadAttempts = 150; // 30 seconds: log only, do not retry
      const maxAttempts = 1500; // 5 minutes hard limit

      function fail(message, retryable) {
        clearInterval(timer);
        const error = new Error(message);
        error.retryable = retryable;
        reject(error);
      }

      const timer = setInterval(() => {
        attempts++;
        const btn = findSendButton();
        const allTiles = getVisibleFileTiles();
        const newTiles = allTiles.filter(t => !existingTiles.has(t));
        if (!newFileTile || !allTiles.includes(newFileTile)) {
          newFileTile = findFileTileByName(fileName, newTiles) || newFileTile;
        }
        const tileStillPresent = !!newFileTile && allTiles.includes(newFileTile);

        if (attempts <= 5 || attempts % 10 === 0) {
          console.log('[ext] waitForFileAttachment: attempt', attempts,
            'sendDisabled=', btn?.disabled,
            'newTiles=', newTiles.length,
            'newFileTile=', newFileTile?.getAttribute('aria-label') ?? 'none',
            'tileStillPresent=', tileStillPresent);
        }

        // Send button enabled → upload finished (success or failure)
        if (btn && !btn.disabled) {
          if (tileStillPresent) {
            clearInterval(timer);
            console.log('[ext] waitForFileAttachment: upload success, tile=', newFileTile.getAttribute('aria-label'));
            resolve();
          } else if (newFileTile) {
            console.warn('[ext] waitForFileAttachment: send button enabled but file tile is gone → upload failed');
            fail('字幕文件上传失败（文件块已消失），请重试', true);
          } else {
            // The change event and ChatGPT's tile rendering are asynchronous. Give
            // the UI a short grace period before treating "no tile" as a real failure.
            missingSince ??= Date.now();
            if (Date.now() - missingSince >= 5000) {
              console.warn('[ext] waitForFileAttachment: no new file tile appeared');
              fail('字幕文件上传失败（未出现文件块），请重试', true);
            }
          }
          return;
        }
        missingSince = null;

        if (attempts >= slowUploadAttempts && !reportedSlowUpload) {
          reportedSlowUpload = true;
          console.warn('[ext] waitForFileAttachment: upload is taking longer than 30 seconds; continuing to wait without retrying');
        }

        if (attempts >= maxAttempts) {
          console.warn('[ext] waitForFileAttachment: hard timeout. sendDisabled=', btn?.disabled,
            'newTiles=', newTiles.length, 'tileStillPresent=', tileStillPresent);
          fail('字幕文件上传等待超过 5 分钟；为避免重复文件，已停止自动重试', false);
        }
      }, 200);
    });
  }

  // Wait for the URL to switch to a new /c/{uuid} path.
  // Returns the conversation ID, or null on timeout (e.g. temporary chat).
  function waitForConversationId(timeoutMs = 30000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const initialPath = location.pathname;

      function check() {
        const match = location.pathname.match(/^\/c\/([0-9a-f-]{36})/i);
        if (match && location.pathname !== initialPath) { resolve(match[1]); return; }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(check, 200);
      }
      check();
    });
  }

  // 获取 ChatGPT session token（带缓存，5 分钟内复用）
  let _cachedToken = null;
  let _cachedTokenExpiry = 0;
  async function getAccessToken() {
    if (_cachedToken && Date.now() < _cachedTokenExpiry) {
      return _cachedToken;
    }
    const sessionResp = await fetch('/api/auth/session');
    if (!sessionResp.ok) throw new Error(`获取 session token 失败：HTTP ${sessionResp.status}`);
    const session = await sessionResp.json();
    const token = session?.accessToken;
    if (!token) throw new Error('session 中未找到 accessToken');
    _cachedToken = token;
    _cachedTokenExpiry = Date.now() + 5 * 60 * 1000; // 缓存 5 分钟
    return token;
  }

  // 新会话的默认标题
  const DEFAULT_TITLE = 'New chat';

  // 检查对话中是否存在至少一个已完成的助手回复。
  // 遍历所有 mapping 节点而非只看 current_node，
  // 避免轮询间隔中用户又提交新问题导致 current_node 指向未完成的新回复。
  function hasAnyFinishedAssistantResponse(data) {
    if (!data.mapping) return false;
    return Object.values(data.mapping).some(node => {
      const msg = node.message;
      return msg
        && msg.author?.role === 'assistant'
        && msg.status === 'finished_successfully'
        && msg.end_turn === true;
    });
  }

  // 等待 ChatGPT 自动标题生成完成。
  // ChatGPT 服务端在流式响应中会推送 title_generation 事件来自动命名新会话，
  // 如果我们在该事件之前就 PATCH 了标题，会被覆盖。
  // 策略：
  //   1. 标题已从 "New chat" 变为其他值 → 自动标题已生成，直接返回。
  //   2. 标题仍为 "New chat"，但助手回复已完成（finished_successfully + end_turn）
  //      → 服务端标题生成可能有延迟，再多等几轮给它一个窗口期，
  //        如果窗口期内标题仍未变化，则放弃等待。
  async function waitForTitleGeneration(conversationId, token) {
    // 回复完成后额外等待的轮数（每轮 2 秒）
    const GRACE_ROUNDS = 3;
    let graceCountdown = -1; // -1 表示尚未进入宽限期

    while (true) {
      try {
        const resp = await fetch(`/backend-api/conversation/${conversationId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.title && data.title !== DEFAULT_TITLE) {
            console.log('[ext] ChatGPT 自动标题已生成:', data.title);
            return;
          }
          // 标题仍为默认值，检查助手回复是否已完成
          if (hasAnyFinishedAssistantResponse(data)) {
            if (graceCountdown < 0) {
              // 刚检测到回复完成，进入宽限期
              graceCountdown = GRACE_ROUNDS;
              console.log('[ext] 助手回复已完成，标题仍为默认值，进入宽限期等待标题生成...');
            } else {
              graceCountdown--;
            }
            if (graceCountdown <= 0) {
              console.log('[ext] 宽限期结束，标题仍为默认值，放弃等待标题生成');
              return;
            }
            console.log(`[ext] 宽限期剩余 ${graceCountdown} 轮...`);
          } else {
            console.log('[ext] 当前标题仍为默认值，助手回复尚未完成，继续等待...');
          }
        }
      } catch (e) {
        console.warn('[ext] waitForTitleGeneration 轮询出错:', e);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Rename the conversation via ChatGPT internal API.
  // 重命名后会再确认一次，如果被服务端自动标题覆盖则重试。
  async function renameConversationViaAPI(conversationId, title) {
    const token = await getAccessToken();

    // 先等待 ChatGPT 自动标题生成完成，避免被覆盖
    await waitForTitleGeneration(conversationId, token);

    async function patchTitle() {
      const resp = await fetch(`/backend-api/conversation/${conversationId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ title }),
      });
      if (!resp.ok) throw new Error(`API 重命名失败：HTTP ${resp.status}`);
    }

    await patchTitle();

    // 确认标题是否生效（服务端 title_generation 可能在我们 PATCH 之后才到达）
    // 等待一小段时间后检查，如果被覆盖则重试一次
    await new Promise(r => setTimeout(r, 3000));
    try {
      const checkResp = await fetch(`/backend-api/conversation/${conversationId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (checkResp.ok) {
        const data = await checkResp.json();
        if (data.title !== title) {
          console.log(`[ext] 标题被覆盖为 "${data.title}"，重新设置为 "${title}"`);
          await patchTitle();
        } else {
          console.log('[ext] 标题确认生效:', title);
        }
      }
    } catch (e) {
      console.warn('[ext] 标题确认检查出错:', e);
    }
  }

  // After clicking send, scroll the new response turn into view the first time
  // the user switches to this tab. If the tab is already visible, do nothing.
  function scrollToResponseOnTabFocus() {
    console.log('[ext] scrollToResponseOnTabFocus called, visibilityState=', document.visibilityState);
    if (document.visibilityState === 'visible') {
      console.log('[ext] tab already visible, doing nothing');
      return;
    }

    function onVisibilityChange() {
      console.log('[ext] visibilitychange fired, visibilityState=', document.visibilityState);
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      
      let article = document.querySelector('#thread .text-token-text-primary.w-full[data-turn=assistant]');
      if (article) {
        console.log("[ext] start scroll", article)
        article.scrollIntoView({"behavior": "instant", "block": "start"});
        setTimeout(function() {
          // 滚动2次，第一次不灵
          article.scrollIntoView({"behavior": "instant", "block": "start"});
        }, 200)
      } else {
        console.log('[ext] not found response')
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    console.log('[ext] visibilitychange listener registered');
  }

  async function loadPrompt() {
    const result = await chrome.storage.local.get('customPrompt');
    if (result.customPrompt != null) return result.customPrompt;
    const res = await fetch(chrome.runtime.getURL('prompt_chatgpt.txt'));
    return res.text();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHATGPT_CHECK_READY') {
      sendResponse(checkReady());
      return;
    }

    if (msg.type === 'CHATGPT_PREPARE_PROMPT') {
      // Reply immediately so popup can switch tab without waiting
      sendResponse({ ok: true });

      (async () => {
        let titleTimer = null;
        const bvidPrefix = msg.bvid ? `[${msg.bvid}] ` : '';
        console.log('[ext] CHATGPT_PREPARE_PROMPT received:',
          'file.name=', msg.file?.name,
          'file.content type=', typeof msg.file?.content,
          'file.content length=', typeof msg.file?.content === 'string' ? msg.file.content.length : '(non-string)',
          'bgOpen=', msg.bgOpen, 'tempChat=', msg.tempChat);
        let fileAttached = false;
        try {
          showSaveButton(msg.file.name, msg.file.content);
          showStatus('正在添加字幕文件...');
          showStatus('正在输入提示词...');
          inputPrompt(await loadPrompt());
          showStatus('正在等待文件上传...');
          await attachFileWithRetry(msg.file.name, msg.file.content);
          fileAttached = true;
          console.log('[ext] CHATGPT_PREPARE_PROMPT: file attached successfully, proceeding to send');
          showStatus('正在发送...');
          await clickSend();
          // Submission succeeded — hide the save button now regardless of what happens next
          hideSaveButton();
          // Set tab title after send button is successfully clicked
          if (msg.videoTitle && !msg.tempChat) {
            document.title = msg.videoTitle;
            titleTimer = setInterval(() => {
              if (document.title !== msg.videoTitle) {
                document.title = msg.videoTitle;
              }
            }, 200);
          }
          if (msg.bgOpen) scrollToResponseOnTabFocus();
          // Rename the new conversation to the video title via the sidebar UI (skip for temporary chats)
          if (msg.videoTitle && !msg.tempChat) {
            const conversationId = await waitForConversationId();
            if (!conversationId) {
              clearInterval(titleTimer);
              showError(`${bvidPrefix}修改会话名失败：等待对话 ID 超时`);
              return;
            }
            showStatus('正在通过 API 修改会话名...');
            try {
              await renameConversationViaAPI(conversationId, msg.videoTitle);
              clearInterval(titleTimer);
              document.title = msg.videoTitle;
            } catch (e) {
              clearInterval(titleTimer);
              console.error('[ext] renameConversationViaAPI failed:', e);
              showError(`${bvidPrefix}修改会话名失败：${e.message}`);
              return;
            }
          }
          hideStatus();
        } catch (e) {
          clearInterval(titleTimer);
          console.error('[ext] CHATGPT_PREPARE_PROMPT failed, fileAttached=', fileAttached, 'error=', e);
          if (!fileAttached) {
            console.warn('[ext] 文件未成功附加，已跳过自动提交。请检查 DevTools Console 中的 debug 日志。');
            showError(`${bvidPrefix}字幕文件附加失败（未自动提交）：${e.message}`);
          } else {
            showError(`${bvidPrefix}错误：${e.message}`);
          }
        }
      })();
      return;
    }

    if (msg.type === 'EXT_STATUS') {
      showStatus(msg.text);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'EXT_ERROR') {
      showError(msg.text);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'EXT_HIDE_STATUS') {
      hideStatus();
      sendResponse({ ok: true });
      return;
    }
  });
})();
