// ChatGPT page content script: attach SRT file and send
(() => {
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

  function checkReady() {
    const textarea = findTextarea();
    return { ready: !!textarea, loggedIn: !!textarea };
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
    const file = new File([fileContent], fileName, { type: 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);

    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const dropTarget = findTextarea() || document.querySelector('main');
      if (!dropTarget) throw new Error('找不到文件上传区域');

      const dragEnter = new DragEvent('dragenter', { bubbles: true, dataTransfer: dt });
      const dragOver = new DragEvent('dragover', { bubbles: true, dataTransfer: dt });
      const drop = new DragEvent('drop', { bubbles: true, dataTransfer: dt });
      dropTarget.dispatchEvent(dragEnter);
      dropTarget.dispatchEvent(dragOver);
      dropTarget.dispatchEvent(drop);
    }

    await waitForFileAttachment(fileName);
  }

  // Wait until the file tile card appears AND its remove button is interactive,
  // which reliably indicates the upload is complete.
  function waitForFileAttachment(fileName) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 60; // 12 seconds max
      const timer = setInterval(() => {
        attempts++;
        // Prefer matching by exact filename aria-label; fall back to any file-tile
        const fileTile = document.querySelector(`[class*="file-tile"][role="group"][aria-label="${CSS.escape(fileName)}"]`)
          || document.querySelector('[class*="file-tile"][role="group"]');
        // The remove/action button (class "behavior-btn") only appears once the upload is fully complete
        const removeBtn = fileTile?.querySelector('button[class*="behavior-btn"]');
        if (fileTile && removeBtn) {
          clearInterval(timer);
          setTimeout(resolve, 200);
          return;
        }
        if (attempts >= maxAttempts) {
          clearInterval(timer);
          reject(new Error('字幕文件未能成功附加，请重试'));
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
      
      let article = document.querySelector('#thread article.text-token-text-primary.w-full:nth-child(2)');
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

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHATGPT_CHECK_READY') {
      sendResponse(checkReady());
      return;
    }

    if (msg.type === 'CHATGPT_PREPARE_PROMPT') {
      // Reply immediately so popup can switch tab without waiting
      sendResponse({ ok: true });
      (async () => {
        try {
          showStatus('正在添加字幕文件...');
          await attachFile(msg.file.name, msg.file.content);
          if (msg.prompt) {
            showStatus('正在输入提示词...');
            inputPrompt(msg.prompt);
          }
          showStatus('正在发送...');
          await clickSend();
          if (msg.bgOpen) scrollToResponseOnTabFocus();
          // Rename the new conversation to the video title via the sidebar UI (skip for temporary chats)
          if (msg.videoTitle && !msg.tempChat) {
            const conversationId = await waitForConversationId();
            if (!conversationId) {
              showError('修改会话名失败：等待对话 ID 超时');
              return;
            }
            showStatus('正在通过 API 修改会话名...');
            try {
                await renameConversationViaAPI(conversationId, msg.videoTitle);
                document.title = msg.videoTitle;
            } catch (e) {
                console.error('[ext] renameConversationViaAPI failed:', e);
                showError(`修改会话名失败：${e.message}`);
                return;
            }
          }
          hideStatus();
        } catch (e) {
          console.error('CHATGPT_PREPARE_PROMPT failed:', e);
          showError(`错误：${e.message}`);
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
