// ---- 提示词部分 ----
const promptTextarea = document.getElementById('promptTextarea');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const saveStatus = document.getElementById('saveStatus');

const aiStudioPromptTextarea = document.getElementById('aiStudioPromptTextarea');
const saveAIStudioBtn = document.getElementById('saveAIStudioBtn');
const resetAIStudioBtn = document.getElementById('resetAIStudioBtn');
const aiStudioSaveStatus = document.getElementById('aiStudioSaveStatus');

let defaultPrompt = '';
let defaultAIStudioPrompt = '';

async function loadDefaultPrompt() {
  const res = await fetch(chrome.runtime.getURL('prompt_chatgpt.txt'));
  defaultPrompt = await res.text();
}

async function loadDefaultAIStudioPrompt() {
  const res = await fetch(chrome.runtime.getURL('prompt_aistudio.txt'));
  defaultAIStudioPrompt = await res.text();
}

async function loadSavedPrompt() {
  const result = await chrome.storage.local.get('customPrompt');
  return result.customPrompt;
}

async function loadSavedAIStudioPrompt() {
  const result = await chrome.storage.local.get('customAIStudioPrompt');
  return result.customAIStudioPrompt;
}

function flashStatus(el, msg, isError = false) {
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

saveBtn.addEventListener('click', async () => {
  const value = promptTextarea.value;
  if (value === defaultPrompt) {
    await chrome.storage.local.remove('customPrompt');
  } else {
    await chrome.storage.local.set({ customPrompt: value });
  }
  flashStatus(saveStatus, '已保存');
});

resetBtn.addEventListener('click', async () => {
  promptTextarea.value = defaultPrompt;
  await chrome.storage.local.remove('customPrompt');
  flashStatus(saveStatus, '已恢复默认');
});

saveAIStudioBtn.addEventListener('click', async () => {
  const value = aiStudioPromptTextarea.value;
  if (value === defaultAIStudioPrompt) {
    await chrome.storage.local.remove('customAIStudioPrompt');
  } else {
    await chrome.storage.local.set({ customAIStudioPrompt: value });
  }
  flashStatus(aiStudioSaveStatus, '已保存');
});

resetAIStudioBtn.addEventListener('click', async () => {
  aiStudioPromptTextarea.value = defaultAIStudioPrompt;
  await chrome.storage.local.remove('customAIStudioPrompt');
  flashStatus(aiStudioSaveStatus, '已恢复默认');
});

// ---- 自建服务配置部分 ----
const selfHostedApiUrlInput = document.getElementById('selfHostedApiUrl');
const selfHostedApiTokenInput = document.getElementById('selfHostedApiToken');
const saveSelfHostedBtn = document.getElementById('saveSelfHostedBtn');
const testServiceBtn = document.getElementById('testServiceBtn');
const selfHostedSaveStatus = document.getElementById('selfHostedSaveStatus');
const selfHostedSection = document.getElementById('selfHostedSection');

// ---- 本地推理配置部分 ----
const localSection = document.getElementById('localSection');
const radioDeviceWebGPU = document.getElementById('radioDeviceWebGPU');
const radioDeviceWasm = document.getElementById('radioDeviceWasm');
const webgpuStatus = document.getElementById('webgpuStatus');
const hfPermissionNote = document.getElementById('hfPermissionNote');
const testLocalBtn = document.getElementById('testLocalBtn');
const testLocalStatus = document.getElementById('testLocalStatus');
const localConcurrencyInput = document.getElementById('localConcurrencyInput');

const modelRadios = document.querySelectorAll('input[name="localModel"]');

// ---- 运行时 + 模型缓存状态 ----
const wasmCacheBadge = document.getElementById('wasmCacheBadge');

function setWasmBadge(text, state) {
  if (!wasmCacheBadge) return;
  wasmCacheBadge.textContent = text;
  wasmCacheBadge.className = 'model-cache-badge' + (state ? ' ' + state : '');
}

async function refreshWasmCacheStatus() {
  try {
    const cache = await caches.open(WASM_CACHE_NAME);
    const hit = await cache.match(WASM_CDN_URL);
    setWasmBadge(hit ? '✓ 已就绪' : '未缓存', hit ? 'cached' : 'not-cached');
  } catch (e) {
    setWasmBadge('未缓存', 'not-cached');
  }
}

const MODEL_CACHE_BADGES = {
  'onnx-community/whisper-tiny':           document.getElementById('modelCacheTiny'),
  'onnx-community/whisper-base':           document.getElementById('modelCacheBase'),
  'onnx-community/whisper-small':          document.getElementById('modelCacheSmall'),
  'onnx-community/whisper-large-v3-turbo': document.getElementById('modelCacheLarge'),
};

async function refreshModelCacheStatus() {
  let urls;
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    urls = keys.map(r => r.url);
  } catch (e) {
    urls = [];
  }
  for (const [modelId, badge] of Object.entries(MODEL_CACHE_BADGES)) {
    if (!badge) continue;
    const count = urls.filter(u => u.includes('/' + modelId + '/')).length;
    if (count > 0) {
      badge.textContent = `✓ 已缓存 (${count} 个文件)`;
      badge.className = 'model-cache-badge cached';
    } else {
      badge.textContent = '未缓存';
      badge.className = 'model-cache-badge not-cached';
    }
  }
  refreshWasmCacheStatus();
}

// ---- 本地推理进度/结果通知（来自 background service worker）----
// file → { loaded (bytes), total (bytes), done }
const _fileProgressMap = new Map();
let _testingModel = null; // 当前正在测试的模型 ID
let _lastProgressRender = 0;

function renderModelDownloadProgress() {
  const now = Date.now();
  if (now - _lastProgressRender < 250) return; // 节流 250ms
  _lastProgressRender = now;
  if (!_testingModel || _fileProgressMap.size === 0) return;
  const badge = MODEL_CACHE_BADGES[_testingModel];
  if (!badge) return;

  let totalCount = _fileProgressMap.size;
  let doneCount = 0;
  let sumLoaded = 0, sumTotal = 0;
  for (const info of _fileProgressMap.values()) {
    if (info.done) doneCount++;
    if (info.total > 0) { sumLoaded += info.loaded; sumTotal += info.total; }
  }

  // sumTotal=0 说明全部文件从缓存装载（无字节流量），显示"加载"而非"下载"
  if (sumTotal === 0) {
    badge.textContent = doneCount === totalCount
      ? `加载中 ${doneCount}/${totalCount} 文件`
      : `加载中 ${doneCount}/${totalCount} 文件`;
    badge.className = 'model-cache-badge downloading';
    return;
  }

  const countStr = `${doneCount}/${totalCount} 文件`;
  const loadedMB = (sumLoaded / 1024 / 1024).toFixed(1);
  const totalMB  = (sumTotal  / 1024 / 1024).toFixed(1);
  const pct = Math.round(sumLoaded / sumTotal * 100);
  badge.textContent = `↓ ${countStr}  ${loadedMB}/${totalMB} MB  ${pct}%`;
  badge.className = 'model-cache-badge downloading';
}

function clearModelDownloadProgress() {
  _fileProgressMap.clear();
  _testingModel = null;
  _lastProgressRender = 0;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'options') return;
  if (msg.action === 'selfhosted_test_progress') {
    testLocalStatus.classList.remove('error');
    testLocalStatus.textContent = msg.text;
    testLocalStatus.classList.add('show');
  } else if (msg.action === 'selfhosted_test_result') {
    console.log('[selfhosted-test] received result msg:', msg);
    testServiceBtn.disabled = false;
    updateTestBtnState();
    if (msg.ok) {
      testLocalStatus.classList.remove('error');
      const textStr = msg.text ? `：${msg.text}` : '';
      testLocalStatus.textContent = `✓ 转写测试成功，服务版本：${msg.versionStr}${textStr}`;
      testLocalStatus.classList.add('show');
    } else {
      testLocalStatus.textContent = `✗ 转写测试失败：${msg.error}`;
      testLocalStatus.classList.add('error', 'show');
    }
  } else if (msg.action === 'test_progress') {
    testLocalStatus.textContent = msg.text;
    testLocalStatus.classList.add('show');
  } else if (msg.action === 'test_file_progress') {
    _fileProgressMap.set(msg.file, { loaded: msg.loaded || 0, total: msg.total || 0, done: msg.done });
    renderModelDownloadProgress();
  } else if (msg.action === 'test_result') {
    clearModelDownloadProgress();
    testLocalBtn.disabled = false;
    if (msg.ok) {
      testLocalStatus.classList.remove('error');
      const elapsedStr = msg.elapsed ? `（耗时 ${msg.elapsed}s）` : '';
      testLocalStatus.textContent = `✓ 推理成功${elapsedStr}：${msg.text}`;
      testLocalStatus.classList.add('show');
    } else {
      testLocalStatus.textContent = `✗ 推理失败：${msg.error}`;
      testLocalStatus.classList.add('error', 'show');
    }
    // 测试完成后刷新缓存状态（可能刚下载了模型）
    refreshModelCacheStatus();
  }
});

// 检测 WebGPU 支持
(async () => {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        webgpuStatus.textContent = '✓ 支持';
        webgpuStatus.className = 'webgpu-status supported';
        return;
      }
    } catch (e) {}
  }
  webgpuStatus.textContent = '✗ 不支持（建议使用 WASM/CPU）';
  webgpuStatus.className = 'webgpu-status unsupported';
  // 自动切换到 WASM
  if (radioDeviceWebGPU.checked) radioDeviceWasm.checked = true;
})();

// ---- 音频转写服务来源选择 ----
const radioAIStudio = document.getElementById('radioAIStudio');
const radioSelfHosted = document.getElementById('radioSelfHosted');
const radioLocal = document.getElementById('radioLocal');

const testSection = document.getElementById('testSection');
const testSectionTitle = document.getElementById('testSectionTitle');
const localTestDesc = document.getElementById('localTestDesc');
const selfHostedTestDesc = document.getElementById('selfHostedTestDesc');

let _currentTestMode = null; // 'local' | 'selfhosted' | null

function updateSelfHostedSectionVisibility() {
  const isLocal = radioLocal.checked;
  const isSelfHosted = radioSelfHosted.checked;
  const newMode = isLocal ? 'local' : isSelfHosted ? 'selfhosted' : null;
  if (newMode !== _currentTestMode) {
    testLocalStatus.textContent = '';
    testLocalStatus.classList.remove('show', 'error');
    _currentTestMode = newMode;
  }
  selfHostedSection.style.display = isSelfHosted ? '' : 'none';
  localSection.style.display = isLocal ? '' : 'none';
  hfPermissionNote.style.display = isLocal ? '' : 'none';
  testSection.style.display = (isLocal || isSelfHosted) ? '' : 'none';
  testSectionTitle.textContent = isLocal ? '推理测试' : '测试服务';
  localTestDesc.style.display = (isLocal || isSelfHosted) ? '' : 'none';
  selfHostedTestDesc.style.display = isSelfHosted ? '' : 'none';
  testLocalBtn.style.display = isLocal ? '' : 'none';
  testServiceBtn.style.display = isSelfHosted ? '' : 'none';
}

radioAIStudio.addEventListener('change', async () => {
  if (radioAIStudio.checked) {
    await chrome.storage.local.set({ transcribeService: 'aistudio' });
    updateSelfHostedSectionVisibility();
  }
});

// HuggingFace 域名权限（选择本地推理时动态申请）
// 使用通配符覆盖主站 + 所有 CDN/LFS 子域名（cdn-lfs、cdn-lfs-us-1、cdn-lfs-eu-1 等）
const HF_ORIGINS = [
  'https://*.huggingface.co/*',
];

// WASM 文件从 jsDelivr CDN 动态下载（避免打包 ~20MB 进扩展）
const CDN_ORIGINS = [
  'https://cdn.jsdelivr.net/*',
];

const WASM_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.wasm';
const WASM_CACHE_NAME = 'ort-wasm-v3.8.1';

// 确保 WASM 文件已缓存入 Cache Storage（含下载进度显示）
async function ensureWasmCached() {
  const cache = await caches.open(WASM_CACHE_NAME);
  const existing = await cache.match(WASM_CDN_URL);
  if (existing) {
    setWasmBadge('✓ 已就绪', 'cached');
    return;
  }
  setWasmBadge('正在下载...', 'downloading');
  let lastUpdate = 0;
  try {
    const response = await fetch(WASM_CDN_URL);
    const total = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      const now = Date.now();
      if (now - lastUpdate > 500) {
        lastUpdate = now;
        if (total > 0) {
          const loadedMB = (loaded / 1024 / 1024).toFixed(1);
          const totalMB  = (total  / 1024 / 1024).toFixed(1);
          const pct = Math.round(loaded / total * 100);
          setWasmBadge(`↓ ${loadedMB}/${totalMB} MB  ${pct}%`, 'downloading');
        } else {
          setWasmBadge(`↓ ${(loaded / 1024 / 1024).toFixed(1)} MB`, 'downloading');
        }
      }
    }
    const blob = new Blob(chunks, { type: 'application/wasm' });
    await cache.put(WASM_CDN_URL, new Response(blob, { headers: { 'content-type': 'application/wasm' } }));
    setWasmBadge('✓ 已就绪', 'cached');
  } catch (e) {
    setWasmBadge('✗ 下载失败', 'error');
    throw e;
  }
}

async function requestLocalInferencePermissions() {
  try {
    // 同时申请 HuggingFace（模型文件）和 jsDelivr（WASM 文件）权限
    return await chrome.permissions.request({ origins: [...HF_ORIGINS, ...CDN_ORIGINS] });
  } catch (e) {
    return false;
  }
}

radioLocal.addEventListener('change', async () => {
  if (!radioLocal.checked) return;
  // 申请 HuggingFace（模型）+ jsDelivr CDN（WASM 文件）权限
  const granted = await requestLocalInferencePermissions();
  if (!granted) {
    // 用户拒绝，回退到 AI Studio
    radioAIStudio.checked = true;
    await chrome.storage.local.set({ transcribeService: 'aistudio' });
    updateSelfHostedSectionVisibility();
    return;
  }
  await chrome.storage.local.set({ transcribeService: 'local' });
  updateSelfHostedSectionVisibility();
  await saveLocalSettings();
  ensureWasmCached().catch(() => {}); // 选中后即开始预下载，不阻塞
});

// 存储本地推理设备和模型设置
async function saveLocalSettings() {
  const device = radioDeviceWebGPU.checked ? 'webgpu' : 'wasm';
  let model = 'onnx-community/whisper-small';
  modelRadios.forEach(r => { if (r.checked) model = r.value; });
  const concurrency = Math.max(1, Math.min(8, parseInt(localConcurrencyInput.value, 10) || 1));
  localConcurrencyInput.value = concurrency;
  await chrome.storage.local.set({ localDevice: device, localModel: model, localConcurrency: concurrency });
}

radioDeviceWebGPU.addEventListener('change', saveLocalSettings);
radioDeviceWasm.addEventListener('change', saveLocalSettings);
modelRadios.forEach(r => r.addEventListener('change', saveLocalSettings));
localConcurrencyInput.addEventListener('change', saveLocalSettings);

testLocalBtn.addEventListener('click', async () => {
  const device = radioDeviceWebGPU.checked ? 'webgpu' : 'wasm';
  let model = 'onnx-community/whisper-small';
  modelRadios.forEach(r => { if (r.checked) model = r.value; });
  clearModelDownloadProgress();
  _testingModel = model;
  testLocalBtn.disabled = true;
  testLocalStatus.classList.remove('error');
  testLocalStatus.textContent = '正在检查权限...';
  testLocalStatus.classList.add('show');
  const granted = await requestLocalInferencePermissions();
  if (!granted) {
    testLocalBtn.disabled = false;
    _testingModel = null;
    testLocalStatus.textContent = '✗ 权限未授予，无法访问模型下载服务';
    testLocalStatus.classList.add('error', 'show');
    refreshModelCacheStatus();
    return;
  }
  testLocalStatus.textContent = '正在初始化...';
  try {
    await ensureWasmCached();
  } catch (e) {
    testLocalBtn.disabled = false;
    clearModelDownloadProgress();
    testLocalStatus.textContent = `✗ 运行时下载失败：${e.message}`;
    testLocalStatus.classList.add('error', 'show');
    refreshModelCacheStatus();
    return;
  }
  chrome.runtime.sendMessage({ type: 'TEST_LOCAL_INFERENCE', model, device }).catch(() => {});
});

radioSelfHosted.addEventListener('change', async () => {
  if (radioSelfHosted.checked) {
    // 从 storage 重新加载自建服务配置，避免切换时输入框内容丢失
    const result = await chrome.storage.local.get(['selfHostedApiUrl', 'selfHostedApiToken']);
    selfHostedApiUrlInput.value = result.selfHostedApiUrl || '';
    selfHostedApiTokenInput.value = result.selfHostedApiToken || '';

    const url = selfHostedApiUrlInput.value.trim();
    if (!url) {
      // 先切换显示，提示用户填写
      updateSelfHostedSectionVisibility();
      selfHostedApiUrlInput.focus();
      updateTestBtnState();
      return;
    }
    await chrome.storage.local.set({ transcribeService: 'selfhosted' });
    updateSelfHostedSectionVisibility();
    updateTestBtnState();
  }
});

// 更新测试按钮状态
function updateTestBtnState() {
  const url = selfHostedApiUrlInput.value.trim();
  const token = selfHostedApiTokenInput.value.trim();
  testServiceBtn.disabled = !url || !token;
}

selfHostedApiUrlInput.addEventListener('input', updateTestBtnState);
selfHostedApiTokenInput.addEventListener('input', updateTestBtnState);

// 将 URL 转换为 host permission 格式，如 http://localhost:8080/ → http://localhost:8080/*
function urlToHostPermission(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

// 申请对指定 URL 的访问权限
async function requestHostPermission(url) {
  const origin = urlToHostPermission(url);
  if (!origin) return false;
  return chrome.permissions.request({ origins: [origin] });
}

// 保存自建服务配置
saveSelfHostedBtn.addEventListener('click', async () => {
  const url = selfHostedApiUrlInput.value.trim();
  const token = selfHostedApiTokenInput.value.trim();

  // 如果选择了自建服务但 URL 为空，切换回 AI Studio
  if (radioSelfHosted.checked && !url) {
    await chrome.storage.local.set({ transcribeService: 'aistudio' });
    radioAIStudio.checked = true;
    updateSelfHostedSectionVisibility();
    await chrome.storage.local.set({ selfHostedApiUrl: url, selfHostedApiToken: token });
    flashStatus(selfHostedSaveStatus, '已保存（已切换回 AI Studio）');
    updateTestBtnState();
    return;
  }

  // 如果有 URL，先申请权限，失败则拒绝保存
  if (url) {
    const granted = await requestHostPermission(url);
    if (!granted) {
      flashStatus(selfHostedSaveStatus, '权限未授予，保存失败', true);
      updateTestBtnState();
      return;
    }
  }

  // 权限已获取，写入配置
  await chrome.storage.local.set({ selfHostedApiUrl: url, selfHostedApiToken: token });
  if (radioSelfHosted.checked) {
    await chrome.storage.local.set({ transcribeService: 'selfhosted' });
  }
  flashStatus(selfHostedSaveStatus, '已保存');
  updateTestBtnState();
});

// 测试服务
testServiceBtn.addEventListener('click', async () => {
  const url = selfHostedApiUrlInput.value.trim();
  const token = selfHostedApiTokenInput.value.trim();

  if (!url || !token) return;

  // 先申请权限，失败则中止
  const granted = await requestHostPermission(url);
  if (!granted) {
    testLocalStatus.textContent = '✗ 权限未授予，无法测试';
    testLocalStatus.classList.add('error', 'show');
    return;
  }

  testServiceBtn.disabled = true;
  testLocalStatus.classList.remove('error');
  testLocalStatus.textContent = '正在连接服务...';
  testLocalStatus.classList.add('show');

  // 第一阶段：版本检查
  let versionStr = '';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_SELF_HOSTED_VERSION',
      apiUrl: url,
      apiToken: token,
    });

    if (!response) {
      testLocalStatus.textContent = '✗ 未收到响应，扩展内部错误，请尝试重新加载扩展';
      testLocalStatus.classList.add('error', 'show');
      testServiceBtn.disabled = false;
      updateTestBtnState();
      return;
    } else if (response.ok) {
      versionStr = response.version;
    } else if (response.status === 401 || response.status === 403) {
      const detail = response.error ? `：${response.error}` : '';
      testLocalStatus.textContent = `✗ Token 不正确，请检查配置${detail}`;
      testLocalStatus.classList.add('error', 'show');
      testServiceBtn.disabled = false;
      updateTestBtnState();
      return;
    } else {
      testLocalStatus.textContent = `✗ 连接失败：${response.error || '未知错误'}`;
      testLocalStatus.classList.add('error', 'show');
      testServiceBtn.disabled = false;
      updateTestBtnState();
      return;
    }
  } catch (e) {
    testLocalStatus.textContent = `✗ 连接失败，请检查 API 地址是否正确及服务是否已启动：${e.message}`;
    testLocalStatus.classList.add('error', 'show');
    testServiceBtn.disabled = false;
    updateTestBtnState();
    return;
  }

  // 第二阶段：上传 sample.m4a 测试转写（结果通过消息返回）
  testLocalStatus.classList.remove('error');
  testLocalStatus.textContent = `服务版本：${versionStr}，正在上传音频进行转写测试...`;
  testLocalStatus.classList.add('show');
  chrome.runtime.sendMessage({
    type: 'TEST_SELF_HOSTED_TRANSCRIBE',
    apiUrl: url,
    apiToken: token,
    versionStr,
  }).catch(() => {});
});

// ---- 初始化 ----
async function init() {
  // 加载提示词
  promptTextarea.disabled = true;
  promptTextarea.placeholder = '正在加载...';
  saveBtn.disabled = true;
  resetBtn.disabled = true;
  aiStudioPromptTextarea.disabled = true;
  aiStudioPromptTextarea.placeholder = '正在加载...';
  saveAIStudioBtn.disabled = true;
  resetAIStudioBtn.disabled = true;

  await loadDefaultPrompt();
  const saved = await loadSavedPrompt();
  promptTextarea.value = saved != null ? saved : defaultPrompt;
  promptTextarea.placeholder = '';
  promptTextarea.disabled = false;
  saveBtn.disabled = false;
  resetBtn.disabled = false;

  await loadDefaultAIStudioPrompt();
  const savedAIStudio = await loadSavedAIStudioPrompt();
  aiStudioPromptTextarea.value = savedAIStudio != null ? savedAIStudio : defaultAIStudioPrompt;
  aiStudioPromptTextarea.placeholder = '';
  aiStudioPromptTextarea.disabled = false;
  saveAIStudioBtn.disabled = false;
  resetAIStudioBtn.disabled = false;

  // 加载自建服务配置
  const result = await chrome.storage.local.get([
    'selfHostedApiUrl',
    'selfHostedApiToken',
    'transcribeService',
    'localDevice',
    'localModel',
    'localConcurrency',
  ]);

  selfHostedApiUrlInput.value = result.selfHostedApiUrl || '';
  selfHostedApiTokenInput.value = result.selfHostedApiToken || '';

  // 恢复本地推理设备选择
  const savedDevice = result.localDevice || 'webgpu';
  if (savedDevice === 'wasm') {
    radioDeviceWasm.checked = true;
  } else {
    radioDeviceWebGPU.checked = true;
  }

  // 恢复本地推理模型选择
  const savedModel = result.localModel || 'onnx-community/whisper-small';
  let modelFound = false;
  modelRadios.forEach(r => {
    if (r.value === savedModel) { r.checked = true; modelFound = true; }
    else r.checked = false;
  });
  if (!modelFound) {
    const defaultRadio = document.getElementById('modelSmall');
    if (defaultRadio) defaultRadio.checked = true;
  }

  // 恢复并发数
  localConcurrencyInput.value = Math.max(1, Math.min(8, parseInt(result.localConcurrency, 10) || 1));

  // 默认 AI Studio
  const service = result.transcribeService || 'aistudio';
  if (service === 'selfhosted') {
    radioSelfHosted.checked = true;
  } else if (service === 'local') {
    radioLocal.checked = true;
  } else {
    radioAIStudio.checked = true;
  }

  // service=local 时检查 WASM 缓存状态
  if (service === 'local') refreshWasmCacheStatus();

  updateSelfHostedSectionVisibility();
  updateTestBtnState();

  // 刷新各模型缓存状态徽章
  refreshModelCacheStatus();
}

init();
