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
        'max-width:360px;line-height:1.4;transition:opacity .3s;';
      document.body.appendChild(statusOverlay);
    }
    statusOverlay.style.background = '#10a37f';
    statusOverlay.style.opacity = '1';
    statusOverlay.textContent = msg;
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

  // After clicking send, if bgOpen and the tab is in the background,
  // scroll the new response turn into view the first time the user switches to this tab.
  // If the tab is already visible, do nothing.
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
