// AI Studio page content script: drop audio file, type prompt, click Run
(() => {
  // --- Status overlay ---

  let statusOverlay = null;

  function showStatus(msg) {
    if (!statusOverlay) {
      statusOverlay = document.createElement('div');
      statusOverlay.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:999999;' +
        'background:#1a73e8;color:#fff;padding:10px 16px;border-radius:8px;' +
        'font-size:14px;font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
        'max-width:360px;line-height:1.4;transition:opacity .3s;';
    }
    // document_start: body may not exist yet; attach/re-attach when available
    if (!statusOverlay.parentNode) {
      (document.body || document.documentElement).appendChild(statusOverlay);
    }
    statusOverlay.style.background = '#1a73e8';
    statusOverlay.style.opacity = '1';
    statusOverlay.textContent = msg;
  }

  function showError(msg) {
    showStatus(msg);
    statusOverlay.style.background = '#d93025';
  }

  function hideStatus() {
    if (statusOverlay) {
      statusOverlay.style.opacity = '0';
      setTimeout(() => statusOverlay?.remove(), 300);
      statusOverlay = null;
    }
  }

  // --- DOM automation helpers ---

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function findButtonByText(text) {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim().includes(text)) return btn;
    }
    return null;
  }

  // --- Drop file onto prompt area ---

  async function dropAudioFile(audioBuffer, fileName) {
    const file = new File([audioBuffer], fileName, { type: 'audio/mp4' });
    const dt = new DataTransfer();
    dt.items.add(file);

    const dropTarget = document.querySelector('main') || document.querySelector('textarea');
    if (!dropTarget) throw new Error('Cannot find drop target');

    dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  }

  // --- Wait for file to be attached (filename appears on page) ---

  async function waitForFileAttached(fileName, timeout = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (document.body.innerText.includes(fileName)) {
        await sleep(500);
        return;
      }
      await sleep(500);
    }
    throw new Error('音频文件未能成功上传，请重试');
  }

  // --- Type prompt into textarea ---

  async function typePrompt(promptText) {
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('Cannot find textarea');

    textarea.focus();
    textarea.value = promptText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
  }

  // --- Click Run button ---

  async function clickRunButton(timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const runBtn = findButtonByText('Run');
      if (runBtn && !runBtn.disabled) {
        runBtn.click();
        return;
      }
      await sleep(300);
    }
    throw new Error('Run button not found or not enabled');
  }

  // --- Enable or disable temporary chat as needed ---

  function setTempChat(enabled) {
    const btn = document.querySelector('button[aria-label="Temporary chat toggle"]');
    if (!btn) return;
    const isActive = btn.classList.contains('ms-button-active');
    if (enabled && !isActive) {
      btn.click();
    } else if (!enabled && isActive) {
      btn.click();
    }
  }

  // --- Main handler ---

  async function handleUploadAndRun(audioBuffer, fileName, prompt, tempChat, bgOpen, videoTitle, bvid) {
    if (!(audioBuffer.byteLength >= 1024)) {
      throw new Error(`音频数据异常（byteLength=${audioBuffer.byteLength}），下载可能失败，已中止`);
    }

    setTempChat(!!tempChat);

    showStatus('正在上传音频...');
    await dropAudioFile(audioBuffer, fileName);

    showStatus('正在等待文件就绪...');
    await waitForFileAttached(fileName);

    showStatus('正在输入提示词...');
    await typePrompt(prompt);

    if (videoTitle) {
      console.log('[ext] renaming before run, videoTitle:', videoTitle, 'bvid:', bvid);
      showStatus('正在设置标题...');
      await renamePromptTitle(videoTitle, bvid);
    } else {
      console.log('[ext] videoTitle is empty, skipping rename');
    }

    showStatus('正在运行...');
    await clickRunButton();

    if (bgOpen) scrollToResponseOnTabFocus();
    hideStatus();
  }

  // After clicking Run, scroll the new response turn into view the first time
  // the user switches to this tab. If the tab is already visible, do nothing.
  function scrollToResponseOnTabFocus() {
    if (document.visibilityState === 'visible') return;

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisibilityChange);

      // Find model response turns that are NOT the thoughts/thinking section.
      // Thought turns contain ms-thought-chunk; the actual response turn does not.
      const modelTurns = document.querySelectorAll(
        'ms-chat-turn:has(.chat-turn-container.model):not(:has(ms-thought-chunk))'
      );
      const turn = modelTurns[modelTurns.length - 1];
      if (turn) {
        turn.scrollIntoView({ behavior: 'instant', block: 'start' });
        setTimeout(() => {
          turn.scrollIntoView({ behavior: 'instant', block: 'start' });
        }, 200);
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  // --- Rename the prompt title via the Edit dialog ---

  async function renamePromptTitle(title, bvid) {
    console.log('[ext] renamePromptTitle: start, title:', title, 'bvid:', bvid);
    const editBtn = document.querySelector('button[aria-label="Edit prompt title and description"]');
    if (!editBtn) {
      console.warn('[ext] renamePromptTitle: edit button not found');
      return;
    }
    editBtn.click();
    console.log('[ext] renamePromptTitle: clicked edit button');

    // Wait for the dialog input to appear
    const start = Date.now();
    let nameInput = null;
    while (Date.now() - start < 5000) {
      nameInput = document.querySelector('input[aria-label="Prompt name text field"]');
      if (nameInput) break;
      await sleep(100);
    }
    if (!nameInput) {
      console.warn('[ext] renamePromptTitle: dialog input not found after 5s');
      return;
    }
    console.log('[ext] renamePromptTitle: dialog opened, current value:', nameInput.value);

    // Set the title using the native setter so Angular picks up the change
    const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputSetter.call(nameInput, title);
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    console.log('[ext] renamePromptTitle: set title to:', nameInput.value);

    // Fill the description with bvid for easy backtracking
    if (bvid) {
      const descInput = document.querySelector('textarea[aria-label="Prompt description text field"]');
      if (descInput) {
        const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeTextareaSetter.call(descInput, bvid);
        descInput.dispatchEvent(new Event('input', { bubbles: true }));
        console.log('[ext] renamePromptTitle: set description to:', descInput.value);
      } else {
        console.warn('[ext] renamePromptTitle: description textarea not found');
      }
    }

    await sleep(100);

    const saveBtn = document.querySelector('button[aria-label="Save title and description"]');
    if (saveBtn) {
      saveBtn.click();
      console.log('[ext] renamePromptTitle: clicked save button');
    } else {
      console.warn('[ext] renamePromptTitle: save button not found');
    }
  }

  // --- Wait for AI Studio to become interactive ---

  function waitForReady(timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('textarea')) { resolve(); return; }
      const start = Date.now();
      const timer = setInterval(() => {
        if (document.querySelector('textarea')) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error('AI Studio 页面加载超时，请确认已登录后重试'));
        }
      }, 200);
    });
  }

  // --- Message listener ---

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'AISTUDIO_UPLOAD_AND_RUN') {
      sendResponse({ ok: true });
      (async () => {
        try {
          showStatus('正在等待页面就绪...');
          await waitForReady();
          const fileName = `bili_audio_${crypto.randomUUID().slice(0, 8)}.m4s`;
          const binary = atob(msg.audioData);
          const u8 = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
          const audioBuffer = u8.buffer;
          await handleUploadAndRun(audioBuffer, fileName, msg.prompt, msg.tempChat, msg.bgOpen, msg.videoTitle, msg.bvid);
        } catch (e) {
          console.error('AISTUDIO_UPLOAD_AND_RUN failed:', e);
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
