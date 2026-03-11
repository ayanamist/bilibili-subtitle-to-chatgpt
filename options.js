// ---- 提示词部分 ----
const promptTextarea = document.getElementById('promptTextarea');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const saveStatus = document.getElementById('saveStatus');

let defaultPrompt = '';

async function loadDefaultPrompt() {
  const res = await fetch(chrome.runtime.getURL('prompt.txt'));
  defaultPrompt = await res.text();
}

async function loadSavedPrompt() {
  const result = await chrome.storage.local.get('customPrompt');
  return result.customPrompt;
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

// ---- 自建服务配置部分 ----
const selfHostedApiUrlInput = document.getElementById('selfHostedApiUrl');
const selfHostedApiTokenInput = document.getElementById('selfHostedApiToken');
const saveSelfHostedBtn = document.getElementById('saveSelfHostedBtn');
const testServiceBtn = document.getElementById('testServiceBtn');
const selfHostedSaveStatus = document.getElementById('selfHostedSaveStatus');
const testResult = document.getElementById('testResult');
const selfHostedSection = document.getElementById('selfHostedSection');

// ---- 音频转写服务来源选择 ----
const radioAIStudio = document.getElementById('radioAIStudio');
const radioSelfHosted = document.getElementById('radioSelfHosted');

function updateSelfHostedSectionVisibility() {
  const isSelfHosted = radioSelfHosted.checked;
  selfHostedSection.style.display = isSelfHosted ? '' : 'none';
}

radioAIStudio.addEventListener('change', async () => {
  if (radioAIStudio.checked) {
    await chrome.storage.local.set({ transcribeService: 'aistudio' });
    updateSelfHostedSectionVisibility();
  }
});

radioSelfHosted.addEventListener('change', async () => {
  if (radioSelfHosted.checked) {
    // 检查是否已配置自建服务
    const url = selfHostedApiUrlInput.value.trim();
    if (!url) {
      // 先切换显示，提示用户填写
      updateSelfHostedSectionVisibility();
      selfHostedApiUrlInput.focus();
      return;
    }
    await chrome.storage.local.set({ transcribeService: 'selfhosted' });
    updateSelfHostedSectionVisibility();
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

// 保存自建服务配置
saveSelfHostedBtn.addEventListener('click', async () => {
  const url = selfHostedApiUrlInput.value.trim();
  const token = selfHostedApiTokenInput.value.trim();

  await chrome.storage.local.set({
    selfHostedApiUrl: url,
    selfHostedApiToken: token,
  });

  // 如果选择了自建服务但 URL 为空，切换回 AI Studio
  if (radioSelfHosted.checked && !url) {
    radioAIStudio.checked = true;
    await chrome.storage.local.set({ transcribeService: 'aistudio' });
    updateSelfHostedSectionVisibility();
    flashStatus(selfHostedSaveStatus, '已保存（已切换回 AI Studio）');
  } else {
    // 如果选择了自建服务，保存服务来源
    if (radioSelfHosted.checked) {
      await chrome.storage.local.set({ transcribeService: 'selfhosted' });
    }
    flashStatus(selfHostedSaveStatus, '已保存');
  }

  updateTestBtnState();
});

// 测试服务
testServiceBtn.addEventListener('click', async () => {
  const url = selfHostedApiUrlInput.value.trim();
  const token = selfHostedApiTokenInput.value.trim();

  if (!url || !token) return;

  testServiceBtn.disabled = true;
  testResult.className = 'test-result';
  testResult.textContent = '正在测试...';
  testResult.style.display = 'block';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_SELF_HOSTED_VERSION',
      apiUrl: url,
      apiToken: token,
    });

    if (!response) {
      testResult.className = 'test-result error';
      testResult.textContent = '✗ 未收到响应，扩展内部错误，请尝试重新加载扩展';
    } else if (response.ok) {
      testResult.className = 'test-result success';
      testResult.textContent = `✓ 连接成功，服务版本：${response.version}`;
    } else if (response.status === 401 || response.status === 403) {
      testResult.className = 'test-result error';
      const detail = response.error ? `：${response.error}` : '';
      testResult.textContent = `✗ Token 不正确，请检查配置${detail}`;
    } else {
      testResult.className = 'test-result error';
      testResult.textContent = `✗ 连接失败：${response.error || '未知错误'}`;
    }
  } catch (e) {
    testResult.className = 'test-result error';
    testResult.textContent = `✗ 连接失败，请检查 API 地址是否正确及服务是否已启动：${e.message}`;
  } finally {
    testServiceBtn.disabled = false;
    updateTestBtnState();
  }
});

// ---- 初始化 ----
async function init() {
  // 加载提示词
  promptTextarea.disabled = true;
  promptTextarea.placeholder = '正在加载...';
  saveBtn.disabled = true;
  resetBtn.disabled = true;

  await loadDefaultPrompt();
  const saved = await loadSavedPrompt();
  promptTextarea.value = saved != null ? saved : defaultPrompt;

  promptTextarea.placeholder = '';
  promptTextarea.disabled = false;
  saveBtn.disabled = false;
  resetBtn.disabled = false;

  // 加载自建服务配置
  const result = await chrome.storage.local.get([
    'selfHostedApiUrl',
    'selfHostedApiToken',
    'transcribeService',
  ]);

  selfHostedApiUrlInput.value = result.selfHostedApiUrl || '';
  selfHostedApiTokenInput.value = result.selfHostedApiToken || '';

  // 默认 AI Studio
  const service = result.transcribeService || 'aistudio';
  if (service === 'selfhosted') {
    radioSelfHosted.checked = true;
  } else {
    radioAIStudio.checked = true;
  }

  updateSelfHostedSectionVisibility();
  updateTestBtnState();
}

init();
