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

  // Rename the conversation via ChatGPT internal API.
  async function renameConversationViaAPI(conversationId, title) {
    const sessionResp = await fetch('/api/auth/session');
    if (!sessionResp.ok) throw new Error(`获取 session token 失败：HTTP ${sessionResp.status}`);
    const session = await sessionResp.json();
    const token = session?.accessToken;
    if (!token) throw new Error('session 中未找到 accessToken');

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

  // Rename the active conversation via the sidebar UI (options menu → 重命名).
  // Throws on failure so the caller can surface an error.
  async function renameConversationViaUI(conversationId, title) {
    // Locate by the conversation-specific data attribute — position in the list is unreliable.
    // The sidebar entry may not appear immediately after conversation creation — poll for it.
    showStatus('正在等待侧边栏会话条目出现...');
    const optionsBtn = await new Promise((resolve) => {
      function check() {
        const btn = document.querySelector(`button[data-conversation-options-trigger="${conversationId}"]`);
        if (btn) { resolve(btn); return; }
        setTimeout(check, 200);
      }
      check();
    });

    // Open the dropdown menu with pointer events (React needs these)
    showStatus('正在打开会话选项菜单...');
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const rect = optionsBtn.getBoundingClientRect();
      optionsBtn.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, isPrimary: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
    }
    await new Promise(r => setTimeout(r, 400));

    // Click the rename menu item.
    // Match by visible text to support multiple UI languages (zh: 重命名, en: Rename).
    const allItems = [...document.querySelectorAll('[role="menuitem"]')];
    const renameItem = allItems.find(el => /^\s*(重命名|Rename)\s*$/i.test(el.textContent));
    if (!renameItem) throw new Error('下拉菜单中找不到重命名选项（未匹配到"重命名"或"Rename"）');
    showStatus('正在点击重命名选项...');
    renameItem.click();

    // Wait for the title-editor input to appear (up to 30 seconds)
    showStatus('正在等待重命名输入框出现...');
    const input = await new Promise((resolve) => {
      function check() {
        const el = document.querySelector('input[name="title-editor"]');
        if (el) { resolve(el); return; }
        setTimeout(check, 200);
      }
      check();
    });
    showStatus('正在输入新会话名称...');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, title);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    showStatus('正在提交新会话名称...');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup',  { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    // Verify the input is gone (renamed successfully)
    if (document.querySelector('input[name="title-editor"]')) throw new Error('重命名操作未能完成');
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
            try {
                await renameConversationViaAPI(conversationId, msg.videoTitle);
                document.title = msg.videoTitle;
            } catch (e) {
                console.warn('[ext] renameConversationViaAPI failed:', e);
            }
            showStatus('正在通过侧边栏 UI 修改会话名...');
            try {
              await renameConversationViaUI(conversationId, msg.videoTitle);
            } catch (e) {
              console.error('[ext] renameConversationViaUI failed:', e);
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
