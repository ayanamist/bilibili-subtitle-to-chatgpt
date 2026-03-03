// ChatGPT page content script: manipulates chatgpt.com to submit prompts and stream responses
(() => {
  let observer = null;
  let pollTimer = null;
  let debounceTimer = null;
  let currentRequestId = null;

  // --- Selectors (multiple fallbacks) ---

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

  function findStopButton() {
    return document.querySelector('button[data-testid="stop-button"]')
      || document.querySelector('button[aria-label*="Stop"]')
      || document.querySelector('button[aria-label*="stop"]');
  }

  function getLatestAssistantMessage() {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    return msgs.length ? msgs[msgs.length - 1] : null;
  }

  function getMarkdownContent(msgEl) {
    if (!msgEl) return '';
    const md = msgEl.querySelector('.markdown')
      || msgEl.querySelector('.prose')
      || msgEl.querySelector('[class*="markdown"]');
    return md ? md.innerText : msgEl.innerText;
  }

  // --- Core logic ---

  function checkReady() {
    const textarea = findTextarea();
    return { ready: !!textarea, loggedIn: !!textarea };
  }

  function inputPrompt(text) {
    const textarea = findTextarea();
    if (!textarea) throw new Error('找不到 ChatGPT 输入框');

    textarea.focus();

    if (textarea.tagName === 'TEXTAREA') {
      // Native textarea
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable div (ProseMirror)
      // Clear existing content
      textarea.innerHTML = '';
      textarea.focus();

      // Try execCommand first
      const success = document.execCommand('insertText', false, text);
      if (!success || !textarea.textContent.trim()) {
        // Fallback: set innerHTML + dispatch events
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
    // Small delay to let input events propagate
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const btn = findSendButton();
        if (btn && !btn.disabled) {
          btn.click();
          resolve();
        } else {
          // Fallback: simulate Enter key on textarea
          const textarea = findTextarea();
          if (textarea) {
            textarea.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
              bubbles: true, cancelable: true
            }));
            resolve();
          } else {
            reject(new Error('找不到发送按钮'));
          }
        }
      }, 200);
    });
  }

  function startStreaming(requestId) {
    currentRequestId = requestId;
    let lastText = '';
    let assistantEl = null;

    function sendDelta(text) {
      if (text && text !== lastText) {
        lastText = text;
        chrome.runtime.sendMessage({
          type: 'CHATGPT_STREAM_DELTA',
          requestId,
          text
        });
        resetDebounce();
      }
    }

    function sendDone() {
      cleanup();
      chrome.runtime.sendMessage({
        type: 'CHATGPT_STREAM_DONE',
        requestId,
        text: lastText
      });
    }

    function resetDebounce() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // 3s no change → consider done
        if (!findStopButton()) {
          sendDone();
        }
      }, 3000);
    }

    function cleanup() {
      if (observer) { observer.disconnect(); observer = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      currentRequestId = null;
    }

    // MutationObserver on the conversation container
    function setupObserver() {
      const container = document.querySelector('[class*="react-scroll-to-bottom"]')
        || document.querySelector('main')
        || document.body;

      observer = new MutationObserver(() => {
        const el = getLatestAssistantMessage();
        if (el) {
          assistantEl = el;
          const text = getMarkdownContent(el);
          sendDelta(text);
        }
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    // Poll for stop button disappearing (= generation complete)
    function setupPoll() {
      pollTimer = setInterval(() => {
        // Check if a new assistant message appeared
        const el = getLatestAssistantMessage();
        if (el) {
          assistantEl = el;
          const text = getMarkdownContent(el);
          sendDelta(text);
        }

        // If stop button is gone, generation is complete
        if (!findStopButton() && lastText) {
          sendDone();
        }
      }, 500);
    }

    setupObserver();
    setupPoll();
    resetDebounce();
  }

  function cancelGeneration() {
    const stopBtn = findStopButton();
    if (stopBtn) stopBtn.click();

    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    currentRequestId = null;
  }

  // --- Message listener ---

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHATGPT_CHECK_READY') {
      const status = checkReady();
      sendResponse(status);
      return;
    }

    if (msg.type === 'CHATGPT_SUBMIT_PROMPT') {
      (async () => {
        try {
          inputPrompt(msg.prompt);
          await clickSend();
          // Wait a bit for the assistant message to start appearing
          setTimeout(() => {
            startStreaming(msg.requestId);
          }, 500);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async response
    }

    if (msg.type === 'CHATGPT_CANCEL') {
      cancelGeneration();
      sendResponse({ ok: true });
      return;
    }
  });
})();
