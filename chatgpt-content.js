// ChatGPT page content script: attach SRT file and send
(() => {
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
      setTimeout(() => {
        const btn = findSendButton();
        if (btn && !btn.disabled) {
          btn.click();
          resolve();
        } else {
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

    await waitForFileAttachment();
  }

  function waitForFileAttachment() {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 30;
      const timer = setInterval(() => {
        attempts++;
        const attached = document.querySelector('[data-testid*="file"]')
          || document.querySelector('[class*="attachment"]')
          || document.querySelector('[class*="file"]');
        if (attached) {
          clearInterval(timer);
          setTimeout(resolve, 500);
          return;
        }
        if (attempts >= maxAttempts) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHATGPT_CHECK_READY') {
      sendResponse(checkReady());
      return;
    }

    if (msg.type === 'CHATGPT_SUBMIT_PROMPT') {
      (async () => {
        try {
          await attachFile(msg.file.name, msg.file.content);
          if (msg.prompt) {
            inputPrompt(msg.prompt);
          }
          await clickSend();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async response
    }
  });
})();
