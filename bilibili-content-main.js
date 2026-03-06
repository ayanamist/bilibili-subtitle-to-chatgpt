'use strict';

// Runs in the Bilibili page's MAIN world. The browser automatically sets the
// correct Referer (https://www.bilibili.com/) on fetch requests made here,
// which the bilivideo CDN requires. No scripting or declarativeNetRequest needed.
//
// Receives requests from the ISOLATED world bridge via window.postMessage and
// returns the audio as a plain number array (JSON-safe, no ArrayBuffer issues).
window.addEventListener('message', async (event) => {
  if (event.source !== window || !event.data) return;
  if (event.data.type !== 'BILIBILI_FETCH_AUDIO') return;

  const { urls, requestId } = event.data;
  const errors = [];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        window.postMessage({
          type: 'BILIBILI_FETCH_RESULT',
          requestId,
          result: { ok: true, data: Array.from(new Uint8Array(buf)) },
        }, '*');
        return;
      }
      errors.push(`HTTP ${res.status} ${res.statusText} (${new URL(url).hostname})`);
    } catch (e) {
      errors.push(`${e.message} (${new URL(url).hostname})`);
    }
  }

  window.postMessage({
    type: 'BILIBILI_FETCH_RESULT',
    requestId,
    result: { ok: false, error: errors.join('；') },
  }, '*');
});
