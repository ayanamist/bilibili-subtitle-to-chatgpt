// AI Studio page content script: drop audio file, type prompt, click Run
(() => {
  // --- Audio download ---

  async function downloadAudio({ baseUrl, backupUrl }) {
    for (const url of [baseUrl, backupUrl].filter(Boolean)) {
      try {
        console.log('[bili-content] Downloading audio from:', url.slice(0, 80) + '...');
        const res = await fetch(url, {
          headers: { 'Referer': 'https://www.bilibili.com/' }
        });
        console.log('[bili-content] Audio download status:', res.status);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          console.log('[bili-content] Audio downloaded, size:', buf.byteLength);
          return buf;
        }
      } catch (e) {
        console.warn('[bili-content] Audio download error:', e.message);
      }
    }
    throw new Error('音频下载失败');
  }

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
      document.body.appendChild(statusOverlay);
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
    console.warn('[bili-content] waitForFileAttached timed out — proceeding anyway');
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

  // --- Main handler ---

  async function handleUploadAndRun(audioUrls, prompt) {
    showStatus('正在下载音频...');
    const audioBuffer = await downloadAudio(audioUrls);

    const fileName = `bili_audio_${crypto.randomUUID().slice(0, 8)}.m4s`;

    showStatus('正在上传音频...');
    await dropAudioFile(audioBuffer, fileName);

    showStatus('正在等待文件就绪...');
    await waitForFileAttached(fileName);

    showStatus('正在输入提示词...');
    await typePrompt(prompt);

    showStatus('正在运行...');
    await clickRunButton();

    hideStatus();
  }

  // --- Check readiness ---

  function checkReady() {
    const textarea = document.querySelector('textarea');
    return { ready: !!textarea };
  }

  // --- Message listener ---

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'AISTUDIO_CHECK_READY') {
      sendResponse(checkReady());
      return;
    }

    if (msg.type === 'AISTUDIO_UPLOAD_AND_RUN') {
      sendResponse({ ok: true });
      (async () => {
        try {
          await handleUploadAndRun(msg.audioUrls, msg.prompt);
        } catch (e) {
          console.error('AISTUDIO_UPLOAD_AND_RUN failed:', e);
          showError(`错误：${e.message}`);
        }
      })();
      return;
    }
  });
})();
