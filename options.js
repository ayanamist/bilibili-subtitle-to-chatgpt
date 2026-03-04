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

function flashStatus(msg) {
  saveStatus.textContent = msg;
  saveStatus.classList.add('show');
  setTimeout(() => saveStatus.classList.remove('show'), 1500);
}

async function init() {
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
}

saveBtn.addEventListener('click', async () => {
  const value = promptTextarea.value;
  // If the content matches the default, remove the custom entry
  if (value === defaultPrompt) {
    await chrome.storage.local.remove('customPrompt');
  } else {
    await chrome.storage.local.set({ customPrompt: value });
  }
  flashStatus('已保存');
});

resetBtn.addEventListener('click', async () => {
  promptTextarea.value = defaultPrompt;
  await chrome.storage.local.remove('customPrompt');
  flashStatus('已恢复默认');
});

init();
