# Bilibili Subtitle to ChatGPT

一个 Chrome 浏览器扩展，自动提取 Bilibili 视频的 AI 字幕，转换为 SRT 格式后发送到 ChatGPT 进行结构化总结。

## 功能

- **自动提取字幕** — 通过 Bilibili API 获取视频的 AI 生成中文字幕
- **SRT 格式转换** — 将字幕 JSON 转换为标准 SRT 字幕格式
- **一键发送到 ChatGPT** — 自动打开 ChatGPT 页面，以文件附件方式上传字幕，并附带预设的分析提示词
- **多分P支持** — 正确识别多分P视频的当前分P并提取对应字幕
- **结构化总结** — 内置提示词引导 ChatGPT 按内容推进节点进行分段时间线分析

## 安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目目录

## 使用方法

1. 在 Bilibili 打开一个有 AI 字幕的视频页面
2. 点击浏览器工具栏中的扩展图标
3. 点击「运行」按钮
4. 扩展会自动提取字幕、打开 ChatGPT 页面、上传字幕文件并发送分析请求

## 项目结构

```
bilibili-subtitle-to-chatgpt/
├── manifest.json         # 扩展清单 (Manifest V3)
├── popup.html            # 弹出窗口 UI
├── popup.css             # 样式
├── popup.js              # 主逻辑：URL 解析、字幕获取、SRT 转换
├── chatgpt-content.js    # 内容脚本：在 ChatGPT 页面注入字幕文件并发送
├── prompt.txt            # 预设提示词（结构化总结指令）
└── icons/                # 扩展图标
```

## 技术栈

- Chrome Extension Manifest V3
- 原生 JavaScript，无需构建工具
- Bilibili Web API（字幕获取）
- DataTransfer API（模拟文件拖放上传）

## License

MIT
