'use strict';

// Runs in the ISOLATED world — bridges chrome.tabs.sendMessage from the
// background to the MAIN world content script via window.postMessage.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'BILIBILI_FETCH_AUDIO') return false;

  const requestId = crypto.randomUUID();

  const handler = (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type !== 'BILIBILI_FETCH_RESULT' || event.data.requestId !== requestId) return;
    window.removeEventListener('message', handler);
    sendResponse(event.data.result);
  };
  window.addEventListener('message', handler);

  window.postMessage({ type: 'BILIBILI_FETCH_AUDIO', urls: msg.urls, requestId }, '*');
  return true; // keep channel open for async sendResponse
});
