# Privacy Policy

## Bilibili Subtitle to AI

**Last updated: April 29, 2026**

This Privacy Policy describes how the "Bilibili Subtitle to AI" browser extension ("the Extension") handles user data. By using the Extension, you agree to the practices described below.

---

## 1. Data Collection

The Extension does **not** collect, transmit, or store any personal or sensitive user data on servers controlled by the developer.

The following data is processed exclusively within your browser:

- **Bilibili video subtitle text** — read from the current Bilibili video page you are viewing.
- **Bilibili video audio** — downloaded from Bilibili's CDN solely for the purpose of local transcription or self-hosted server transcription, then discarded.
- **User preferences** — custom prompt templates, self-hosted service URL and authentication token, and local inference settings (device, model, concurrency).

---

## 2. Data Handling

All core processing occurs locally inside your browser:

- Subtitle text and audio are retrieved from Bilibili's servers in the same way your browser would load them normally.
- When local inference is selected, audio is decoded and transcribed entirely within the browser using WebAssembly / WebGPU (via [Transformers.js](https://huggingface.co/docs/transformers.js)). No audio data leaves your device.
- Subtitle text (or transcribed text) is injected into the AI chat interface — ChatGPT or Google AI Studio — **only when you click the send button**. This action is equivalent to you manually pasting the text yourself.
- When a user-configured self-hosted transcription server is enabled, audio data is sent **only to the server URL you specify**. The developer has no access to that server or the data transmitted to it.

---

## 3. Data Storage

The Extension stores the following data **locally on your device** using the browser's `chrome.storage.local` API (never synced to any remote server):

| Data | Purpose |
|---|---|
| Custom prompt templates | Personalize the prompt sent to the AI service |
| Self-hosted server URL and authentication token | Connect to a user-operated transcription service |
| Local inference settings (device, model, concurrency) | Configure on-device audio transcription |

Additionally, when local inference is used, Whisper model files are cached in the browser's Cache Storage (`transformers-cache`) to avoid redundant downloads. These files are downloaded from Hugging Face's public CDN (`huggingface.co`) and contain no personal data.

You can clear all stored data at any time by removing the Extension or clearing your browser's extension storage.

---

## 4. Data Sharing

The Extension shares data with third parties **only as a direct result of your own actions**:

| Recipient | Data Shared | Condition |
|---|---|---|
| OpenAI / ChatGPT (`chatgpt.com`, `chat.openai.com`) | Subtitle or transcribed text, plus your prompt | When you choose ChatGPT and click send |
| Google AI Studio (`aistudio.google.com`) | Subtitle or transcribed text, plus your prompt | When you choose Google AI Studio and click send |
| Your self-hosted server (URL you configure) | Audio file for transcription | When you enable and use the self-hosted transcription feature |
| Hugging Face CDN (`huggingface.co`) | No personal data — model files only | When you download a Whisper model for local inference |

The developer of this Extension does **not** receive, access, or process any of the above data.

The privacy practices of OpenAI, Google, and any self-hosted service you configure are governed by their respective policies, not this one.

---

## 5. Permissions

The Extension requests only the permissions necessary for its functionality:

- **`activeTab` / `tabs`** — to interact with the current Bilibili video tab.
- **`storage`** — to save your preferences locally.
- **`offscreen`** — to perform audio decoding and ML inference in a background context.
- **Host permissions for `bilibili.com`, `chatgpt.com`, `chat.openai.com`, `aistudio.google.com`, `bilivideo.com`** — to read subtitles/audio and to inject text into AI chat interfaces.
- **Optional host permissions (`https://*/*`, `http://*/*`)** — only requested if you configure a self-hosted transcription server, to allow the Extension to reach that server.

---

## 6. Children's Privacy

The Extension is not directed at children under the age of 13 and does not knowingly collect data from children.

---

## 7. Changes to This Policy

If this policy is updated, the "Last updated" date at the top will be revised. Continued use of the Extension after changes constitutes acceptance of the updated policy.

---

## 8. Contact

If you have any questions or concerns about this privacy policy, please open an issue at:
https://github.com/ayanamist/bilibili-subtitle-to-chatgpt/issues
