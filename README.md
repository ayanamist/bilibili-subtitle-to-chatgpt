# Bilibili Subtitle to AI

一个 Chrome 浏览器扩展，自动提取 Bilibili 视频的 AI 字幕或音频，发送到 ChatGPT / Google AI Studio 进行结构化总结。

## 功能

- **自动提取字幕** — 通过 Bilibili API 获取视频的 AI 生成中文字幕，转换为 SRT 格式
- **音频转写（自建服务）** — 无字幕时可调用自建转写服务，将音频转为 SRT 字幕后发送到 ChatGPT
- **音频回退（AI Studio）** — 无字幕时也可回退为提取音频流，发送到 Google AI Studio 分析
- **多 AI 服务支持** — 支持 ChatGPT（字幕）和 Google AI Studio（音频）
- **音频转写服务来源选择** — 可在设置页选择使用自建服务或 AI Studio
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
4. 按需勾选「临时对话」
5. 点击按钮
   - 有中文字幕时：提取字幕 → 转换 SRT → 上传至 ChatGPT 并发送分析请求
   - 无字幕且选择自建服务时：调用自建转写服务 → 获取 SRT → 上传至 ChatGPT
   - 无字幕且选择 AI Studio 时：提取音频 → 上传至 Google AI Studio 并发送分析请求

## 项目结构

```
bilibili-subtitle-to-ai/
├── manifest.json           # 扩展清单 (Manifest V3)
├── popup.html              # 弹出窗口 UI
├── popup.css               # 样式
├── popup.js                # 主逻辑：URL 解析、字幕获取、SRT 转换、音频提取
├── background.js           # Service Worker：任务调度、自建服务代理
├── bilibili-content.js     # B站内容脚本（隔离世界）：SSE 接收、状态浮层
├── bilibili-content-main.js# B站内容脚本（主世界）：音频下载
├── chatgpt-content.js      # 内容脚本：在 ChatGPT 页面注入字幕文件并发送
├── aistudio-content.js     # 内容脚本：在 AI Studio 页面注入音频文件并发送
├── options.html            # 设置页面：自定义提示词、自建服务配置
├── options.js              # 设置页面逻辑
├── prompt_chatgpt.txt      # ChatGPT使用的默认提示词（结构化总结指令）
├── prompt_aistudio.txt     # AI Studio使用的默认提示词（结构化总结指令）
├── server/                 # 自建音频转字幕 Go 服务
│   ├── main.go             # 服务主程序
│   ├── go.mod
│   └── config.example.toml # 配置文件示例
├── PRIVACY_POLICY.md       # 隐私政策
└── icons/                  # 扩展图标
```

## 自建音频转字幕服务

扩展支持对接自建的音频转字幕 HTTP 服务，在无 AI 字幕时将音频转为 SRT 后发送到 ChatGPT。

### 环境要求

- Go 1.21+
- 一个支持命令行调用的音频转写程序（如 [Whisper](https://github.com/openai/whisper) 或 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)）
  - 要求：接受音频文件路径作为最后一个参数，并在同目录下生成同名 `.srt` 文件

### 编译

```bash
cd server
go build -o transcribe-server .
```

### 配置文件

复制示例配置并按需修改：

```bash
cp server/config.example.toml config.toml
```

TOML 配置项说明：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `addr` | string | `:8080` | 服务监听地址 |
| `token` | string | 必填 | Bearer Token 鉴权密钥 |
| `exec` | string 或 string[] | 必填 | 转写程序命令 |

`exec` 支持两种格式：

```toml
# 格式一：字符串（支持带空格的路径，按 shell 规则拆分）
exec = "C:\\Program Files\\whisper\\whisper.exe --model large --output_format srt"

# 格式二：字符串数组（推荐，避免路径空格问题）
exec = ["whisper", "--model", "large", "--output_format", "srt"]
```

### 启动服务

```bash
./transcribe-server config.toml
```

服务启动后会输出监听地址，例如：`服务启动，监听地址: :8080`

### 在扩展中配置

1. 打开扩展设置页（点击扩展图标旁的「⋯」→「选项」）
2. 在「自建字幕服务」区域填写：
   - **API 地址**：如 `http://localhost:8080`
   - **Token**：与配置文件中 `token` 一致
3. 点击「测试服务」验证连接是否正常
4. 在「音频转写服务」区域选择「自建服务」
5. 保存设置

配置完成后，在 B 站视频页面无 AI 字幕时，popup 将显示「音频转写并发送到ChatGPT」按钮，点击后转写进度会在 B 站页面以浮层形式展示，关闭 popup 后流程仍继续运行。

## 技术栈

- Chrome Extension Manifest V3
- 原生 JavaScript，无需构建工具
- Bilibili Web API（字幕获取、音频流获取）
- DataTransfer API（模拟文件拖放上传）

## License

MIT
