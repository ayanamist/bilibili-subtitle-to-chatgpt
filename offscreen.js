'use strict';

// ---- transformers.js 配置 ----
// 使用动态 import() 加载，offscreen.js 以 ES module 形式运行

let _transformersPromise = null;
function loadTransformers() {
  if (_transformersPromise) return _transformersPromise;
  _transformersPromise = (async () => {
    try {
      console.log('[offscreen] loadTransformers: 开始加载 transformers.js');
      const T = await import(chrome.runtime.getURL('lib/transformers-3.8.1.min.js'));
      console.log('[offscreen] loadTransformers: transformers.js 导入成功, version=', T.env?.version ?? '(未知)');

      // .mjs 是 JS 模块，必须本地（Chrome CSP 禁止从外部 URL 动态 import）
      const mjsUrl = chrome.runtime.getURL('lib/ort-wasm-simd-threaded-3.8.1.jsep.mjs');
      T.env.backends.onnx.wasm.wasmPaths = {
        'ort-wasm-simd-threaded.jsep.mjs': mjsUrl,
      };
      console.log('[offscreen] loadTransformers: wasmPaths 已设置, mjsUrl=', mjsUrl);

      // .wasm: 从 Cache Storage 读取（options 页面预下载时已存入）
      // 若缓存不存在则报错，用户应先在选项页完成运行时下载
      const WASM_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.wasm';
      const wasmCache = await caches.open('ort-wasm-v3.8.1');
      const wasmResp = await wasmCache.match(WASM_CDN_URL);
      if (!wasmResp) {
        console.error('[offscreen] loadTransformers: Cache Storage 中未找到 WASM，请先在设置页下载运行时');
        throw new Error('推理运行时未就绪，请在设置页等待 WASM 下载完成后重试。');
      }
      const wasmArrayBuffer = await wasmResp.arrayBuffer();
      const wasmBinary = new Uint8Array(wasmArrayBuffer);
      console.log('[offscreen] loadTransformers: WASM 读取成功, byteLength=', wasmBinary.byteLength,
        ', constructor=', wasmBinary.constructor.name);
      T.env.backends.onnx.wasm.wasmBinary = wasmBinary;

      // 只允许从 HuggingFace Hub 下载模型，不使用本地模型
      T.env.allowLocalModels = false;
      // 申请持久化存储，防止 Chrome 在磁盘紧张时静默驱逐模型缓存
      // 对扩展 origin 通常自动批准，无需用户确认
      navigator.storage.persist().catch(() => {});
      console.log('[offscreen] loadTransformers: 初始化完成');
      return T;
    } catch (err) {
      console.error('[offscreen] loadTransformers 失败:', err);
      _transformersPromise = null; // 失败时清除缓存，允许下次重试
      throw err;
    }
  })();
  return _transformersPromise;
}

// ---- 精度配置 ----
// 大模型在 WebGPU fp32 下单文件超过 700MB，Chrome 无法分配，需降级到 q4
function getDtype(model, device) {
  // 仅 large-v3-turbo 用 q4（fp32 单文件超出 Chrome ArrayBuffer 分配上限）
  // 其余模型 WebGPU 用 fp32，WASM 用 q8
  if (model.includes('large')) return 'q4';
  return device === 'webgpu' ? 'fp32' : 'q8';
}

// ---- Pipeline 单例管理 ----
// 缓存已加载的 pipeline，避免重复加载（model+device 相同时复用）
let _pipelineCache = null; // { model, device, pipe }
let _pipelineLoading = null; // 正在进行的加载 Promise

async function getPipeline(model, device, onProgress) {
  // 如果缓存命中，直接返回
  if (_pipelineCache && _pipelineCache.model === model && _pipelineCache.device === device) {
    return _pipelineCache.pipe;
  }
  // 等待已有的加载完成再决定
  if (_pipelineLoading) {
    try { await _pipelineLoading; } catch (e) {}
    if (_pipelineCache && _pipelineCache.model === model && _pipelineCache.device === device) {
      return _pipelineCache.pipe;
    }
  }

  _pipelineLoading = (async () => {
    const T = await loadTransformers();
    console.log('[offscreen] getPipeline: 开始加载 pipeline, model=', model, ', device=', device);

    const pipeOpts = {
      device,
      dtype: getDtype(model, device),
      progress_callback: onProgress,
    };

    // 仅允许离线加载（local_files_only），缓存命中时不发任何网络请求；
    // 若缓存不存在则报错，引导用户到选项页通过"测试推理"触发缓存下载。
    let pipe;
    try {
      // local_files_only 需要 allowLocalModels=true（transformers.js 内部会校验）；
      // 此处临时开启，仅用于从 Cache Storage 离线读取，不涉及本地文件路径。
      T.env.allowLocalModels = true;
      pipe = await T.pipeline('automatic-speech-recognition', model, {
        ...pipeOpts,
        local_files_only: true,
      });
      console.log('[offscreen] getPipeline: 命中本地缓存，离线加载成功');
    } catch (e) {
      // local_files_only 失败通常是 "Could not locate file" 类错误；
      // 若是其他类型错误（如 OOM、WebGPU 不支持）则不应静默吞掉，直接抛出。
      const isCacheMiss = /file was not found locally/i.test(e.message);
      if (!isCacheMiss) {
        console.error('[offscreen] getPipeline: 离线加载失败（非缓存缺失错误）:', e.message, '\n', e.stack ?? '');
        throw e;
      }
      console.warn('[offscreen] getPipeline: 本地缓存未命中，拒绝后台下载。原始错误:', e.message);
      throw new Error('模型尚未缓存，请先到扩展选项页点击"测试推理"完成模型下载后重试。');
    } finally {
      T.env.allowLocalModels = false;
    }

    console.log('[offscreen] getPipeline: pipeline 加载成功, type=', typeof pipe);
    _pipelineCache = { model, device, pipe };
    return pipe;
  })();

  try {
    return await _pipelineLoading;
  } finally {
    _pipelineLoading = null;
  }
}

// ---- 音频解码 ----
// 将 ArrayBuffer 解码并重采样为 Float32Array（16kHz PCM）
async function decodeAudioBuffer(arrayBuffer) {
  const targetSampleRate = 16000;
  const tempCtx = new AudioContext();
  const originalBuffer = await tempCtx.decodeAudioData(arrayBuffer);
  tempCtx.close();
  const numFrames = Math.ceil(originalBuffer.duration * targetSampleRate);
  const offlineCtx = new OfflineAudioContext(1, numFrames, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = originalBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0); // Float32Array
}

// 将 base64 编码的音频数据解码为 Float32Array（16kHz PCM）
async function decodeAudioBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decodeAudioBuffer(bytes.buffer);
}

// ---- 捕获 transformers.js 内部逃逸的 Promise 异常 ----
// transformers.js 在加载大文件时若 ArrayBuffer 分配失败，错误会以 unhandledrejection
// 的形式逃出，无法被普通 try/catch 捕获；此处用 Promise.race 接入错误通道。
let _pendingReject = null;
self.addEventListener('unhandledrejection', (event) => {
  console.error('[offscreen] unhandled rejection:', event.reason);
  if (_pendingReject) {
    event.preventDefault();
    const fn = _pendingReject;
    _pendingReject = null;
    // 清除已损坏的 pipeline 缓存，允许下次重试
    _pipelineCache = null;
    _pipelineLoading = null;
    fn(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
  }
});

// ---- Whisper 快速语言检测 ----
// 模拟 faster-whisper 的预检测：对前 30s 音频跑一次 encoder + 单步 decoder，
// 从语言 token logits 取 argmax；全程只用 ONNX 底层 session，不走完整推理流程。
// 任意异常均 fallback 到 'chinese'。
async function detectWhisperLanguage(pipe, audioArray) {
  try {
    const genConfig = pipe.model.generation_config;
    if (!genConfig || !genConfig.is_multilingual || !genConfig.lang_to_id) {
      return 'chinese'; // 英语单语模型，无需检测
    }

    // 取前 30s（与 faster-whisper 相同窗口）
    const slice = audioArray.length > 16000 * 30
      ? audioArray.slice(0, 16000 * 30)
      : audioArray;

    // 提取梅尔频谱（WhisperProcessor callable）
    const { input_features } = await pipe.processor(slice);

    // 运行 encoder
    const encoderOut = await pipe.model.sessions.model.run({ input_features });
    const encoderHidden = encoderOut.last_hidden_state;

    // 构造 decoder_input_ids = [[sot_token_id]] (int64)
    const sotId = BigInt(genConfig.decoder_start_token_id);
    const T = await loadTransformers();
    const decoderInputIds = new T.Tensor('int64', BigInt64Array.from([sotId]), [1, 1]);

    // 运行 decoder 单步（不使用 KV cache）
    // decoder_model_merged 的 ONNX 图要求所有 past_key_values 输入必须存在（即使
    // use_cache_branch=false 时不会实际使用），需提供 seq_len=0 的空张量占位。
    const session = pipe.model.sessions.decoder_model_merged;
    const numHeads = pipe.model.config.decoder_attention_heads;
    const headDim = Math.round(pipe.model.config.d_model / numHeads);
    const emptyKV = new T.Tensor('float32', new Float32Array(0), [1, numHeads, 0, headDim]);

    const feeds = {
      input_ids: decoderInputIds,
      encoder_hidden_states: encoderHidden,
      use_cache_branch: new T.Tensor('bool', [false], [1]),
    };
    for (const name of session.inputNames) {
      if (name.startsWith('past_key_values.')) feeds[name] = emptyKV;
    }

    const decoderOut = await session.run(feeds);

    // logits: [1, 1, vocab_size] → 取 [0][0][:]
    const logits = decoderOut.logits.data; // Float32Array

    // 从 lang_to_id 遍历，取 logit 最大的语言
    const langToId = genConfig.lang_to_id; // {"<|zh|>": 50260, "<|en|>": 50259, ...}
    let bestLang = 'chinese';
    let bestScore = -Infinity;
    for (const [token, id] of Object.entries(langToId)) {
      if (id >= logits.length) continue;
      const score = logits[id];
      if (score > bestScore) {
        bestScore = score;
        const m = token.match(/\|(\w+)\|/);
        if (m) bestLang = m[1]; // "zh", "en", "ja" ...
      }
    }
    console.log('[offscreen] detectWhisperLanguage: bestLang=', bestLang, 'score=', bestScore);
    return bestLang;
  } catch (e) {
    console.warn('[offscreen] detectWhisperLanguage 失败，回退到 chinese:', e.message);
    return 'chinese';
  }
}

// ---- 消息处理 ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  if (msg.action === 'transcribe') {
    const { model, device, audioBase64, requestId } = msg;

    (async () => {
      // 建立逃逸错误接收通道
      const escapedError = new Promise((_, rej) => { _pendingReject = rej; });
      try {
        // 进度回调：下载/加载模型时发送进度通知
        const onProgress = (data) => {
          if (data.status === 'progress' || data.status === 'initiate' || data.status === 'done') {
            chrome.runtime.sendMessage({
              target: 'background',
              action: 'transcribe_progress',
              requestId,
              data,
            }).catch(() => {});
          }
        };

        // 加载 pipeline（首次会触发模型下载）
        sendProgressToBackground(requestId, { status: 'loading_model', text: '正在加载模型...' });
        const pipe = await Promise.race([getPipeline(model, device, onProgress), escapedError]);

        // 解码音频
        sendProgressToBackground(requestId, { status: 'decoding_audio', text: '正在解码音频...' });
        let audioArray;
        if (audioBase64) {
          audioArray = await decodeAudioBase64(audioBase64);
        } else if (msg.audioUrl) {
          const resp = await fetch(msg.audioUrl);
          if (!resp.ok) throw new Error(`音频文件加载失败：HTTP ${resp.status}`);
          audioArray = await decodeAudioBuffer(await resp.arrayBuffer());
        } else {
          console.error('[offscreen] 缺少音频数据, msg 字段:',
            'audioBase64=', typeof audioBase64, audioBase64?.length ?? 0, '字节',
            'audioUrl=', msg.audioUrl,
            'action=', msg.action, 'target=', msg.target);
          throw new Error('缺少音频数据（audioBase64 或 audioUrl）');
        }

        // 推理
        const CHUNK_LEN = 30, STRIDE_LEN = 5;
        // transformers.js 的分块步长为 chunk_length_s - 2*stride_length_s（两侧各去掉一个 stride）
        const STEP = CHUNK_LEN - 2 * STRIDE_LEN; // 20s
        const durationS = audioArray.length / 16000;
        const totalChunks = durationS <= CHUNK_LEN
          ? 1
          : 1 + Math.ceil((durationS - CHUNK_LEN) / STEP);
        let processedChunks = 0;

        sendProgressToBackground(requestId, { status: 'transcribing', text: `正在转写... 0/${totalChunks} 块` });
        console.log('[offscreen] transcribe: 开始推理, audioArray type=', audioArray.constructor.name,
          ', length=', audioArray.length, ', sampling_rate=16000, totalChunks=', totalChunks);

        // transformers.js 3.8.1 的 ASR pipeline 无内置 chunk_callback，
        // 通过临时包装 pipe.model.generate（每个 30s 音频块调用一次）实现分块进度。
        pipe.model.generate = new Proxy(pipe.model.generate, {
          apply(target, thisArg, args) {
            return Reflect.apply(target, thisArg, args).then((r) => {
              processedChunks++;
              sendProgressToBackground(requestId, {
                status: 'transcribing',
                text: `正在转写... ${processedChunks}/${totalChunks} 块`,
              });
              return r;
            });
          },
        });

        // 快速语言检测：仅对前 30s 音频跑一次 encoder + 单步 decoder，
        // 从语言 token logits 取 argmax，等同于 faster-whisper 的预检测逻辑。
        // 检测失败时回退到 'chinese'（适合 B 站内容）。
        const detectedLang = await detectWhisperLanguage(pipe, audioArray);
        console.log('[offscreen] 检测到语言:', detectedLang);

        let result;
        try {
          result = await pipe(audioArray, {
            sampling_rate: 16000,
            return_timestamps: true,
            chunk_length_s: CHUNK_LEN,
            stride_length_s: STRIDE_LEN,
            language: detectedLang,
            task: 'transcribe',
          });
        } finally {
          // 恢复原始 generate（删除 Proxy 实例属性，恢复原型链上的方法）
          delete pipe.model.generate;
        }
        console.log('[offscreen] transcribe: 推理完成, text=', result.text);

        sendResponse({ ok: true, chunks: result.chunks || [], text: result.text || '' });
      } catch (e) {
        console.error('[offscreen] transcribe 失败:', e.message, '\n', e.stack ?? '');
        sendResponse({ ok: false, error: e.message });
      } finally {
        _pendingReject = null;
      }
    })();

    return true; // 异步 sendResponse
  }

  return false;
});

function sendProgressToBackground(requestId, data) {
  chrome.runtime.sendMessage({
    target: 'background',
    action: 'transcribe_progress',
    requestId,
    data,
  }).catch(() => {});
}
