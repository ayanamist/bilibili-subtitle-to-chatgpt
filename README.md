# Bilibili Subtitle to AI

一个 Chrome 浏览器扩展，自动提取 Bilibili 视频的 AI 字幕或音频，发送到 ChatGPT / Google AI Studio 进行结构化总结。

## 功能

- **自动提取字幕** — 通过 Bilibili API 获取视频的 AI 生成中文字幕，转换为 SRT 格式
- **音频回退** — 无字幕时自动回退为提取音频流，发送到 Google AI Studio 分析
- **多 AI 服务支持** — 支持 ChatGPT（字幕）和 Google AI Studio（音频）
- **强制 AI Studio 模式** — 可手动选择始终使用音频上传至 AI Studio，而非字幕
- **临时对话** — 支持以临时对话模式打开，保护隐私
- **自定义提示词** — 可在设置页自定义分析提示词，也可一键恢复默认
- **多分P支持** — 正确识别多分P视频的当前分P并提取对应字幕
- **字幕预检测** — 打开弹窗时即预检字幕可用性，显示字幕语言

## 安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目目录

## 使用方法

1. 在 Bilibili 打开一个视频页面
2. 点击浏览器工具栏中的扩展图标
3. 弹窗会自动检测字幕可用性并显示状态
4. 按需勾选「临时对话」或「强制 AI Studio」
5. 点击「运行」按钮
   - 有中文字幕时：提取字幕 → 转换 SRT → 上传至 ChatGPT 并发送分析请求
   - 无字幕或强制 AI Studio 时：提取音频 → 上传至 Google AI Studio 并发送分析请求

## 项目结构

```
bilibili-subtitle-to-ai/
├── manifest.json           # 扩展清单 (Manifest V3)
├── popup.html              # 弹出窗口 UI
├── popup.css               # 样式
├── popup.js                # 主逻辑：URL 解析、字幕获取、SRT 转换、音频提取
├── chatgpt-content.js      # 内容脚本：在 ChatGPT 页面注入字幕文件并发送
├── aistudio-content.js     # 内容脚本：在 AI Studio 页面注入音频文件并发送
├── options.html            # 设置页面：自定义提示词
├── options.js              # 设置页面逻辑
├── prompt.txt              # 默认提示词（结构化总结指令）
├── PRIVACY_POLICY.md       # 隐私政策
└── icons/                  # 扩展图标
```

## 技术栈

- Chrome Extension Manifest V3
- 原生 JavaScript，无需构建工具
- Bilibili Web API（字幕获取、音频流获取）
- DataTransfer API（模拟文件拖放上传）

## License

MIT
