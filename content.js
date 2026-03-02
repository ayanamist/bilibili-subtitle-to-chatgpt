// Content script: extract readable text from the page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getPageContent') {
    const result = getPageContent();
    sendResponse(result);
  }
  return true;
});

function getPageContent() {
  const url = window.location.href;
  const title = document.title;

  // Bilibili video page: extract aid/cid for subtitle fetching in popup
  if (/bilibili\.com\/video\//.test(url)) {
    const ids = getBilibiliIds();
    const desc = getVideoDescription();
    return {
      title, url,
      type: 'bilibili-video',
      bilibiliIds: ids,
      description: desc,
      content: desc || ''
    };
  }

  // Default: extract page text
  return { content: extractPageContent(), title, url, type: 'article' };
}

// --- Bilibili ID extraction (from page data, no fetch needed) ---

function getBilibiliIds() {
  let aid = null;
  let cid = null;

  // Try window.__INITIAL_STATE__
  try {
    const state = window.__INITIAL_STATE__;
    if (state?.videoData) {
      aid = state.videoData.aid;
      cid = state.videoData.cid;
    }
  } catch (e) {}

  // Fallback: parse from page script tags
  if (!aid || !cid) {
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const aidMatch = text.match(/"aid"\s*:\s*(\d+)/);
        const cidMatch = text.match(/"cid"\s*:\s*(\d+)/);
        if (aidMatch && !aid) aid = aidMatch[1];
        if (cidMatch && !cid) cid = cidMatch[1];
        if (aid && cid) break;
      }
    } catch (e) {}
  }

  return { aid, cid };
}

function getVideoDescription() {
  const selectors = [
    '.basic-desc-info',
    '.desc-info-text',
    '[class*="desc"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim()) {
      return el.innerText.trim().slice(0, 500);
    }
  }
  return '';
}

// --- Generic page content extraction ---

function extractPageContent() {
  const selectors = [
    'article',
    'main',
    '[role="main"]',
    '.article-content',
    '.post-content',
    '.entry-content',
    '#content',
    '.content'
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      return cleanText(el.innerText);
    }
  }

  const clone = document.body.cloneNode(true);
  const remove = clone.querySelectorAll('nav, footer, aside, header, script, style, .nav, .header, .footer, .sidebar, .menu, .ad, .advertisement, .cookie-banner');
  remove.forEach(el => el.remove());

  return cleanText(clone.innerText);
}

function cleanText(text) {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 15000);
}
