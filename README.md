# User-Friendly Forces v2.0

A Chrome extension that analyzes website privacy policies and highlights suspicious patterns — using **local AI (Ollama)** with **Gemini as a cloud fallback**.

## Architecture

```
[Chrome Extension popup]
        │ POST /  (prompt + optional Gemini key)
        ▼
[Node.js server — index.mjs]
        │
        ├─► Ollama  (localhost:11434)   ← primary (free, private)
        │
        └─► Gemini API                 ← fallback (if Ollama is offline)
```

## Setup

### 1. Install dependencies

```bash
npm install
```

> The only runtime dependency is Node.js ≥18 (uses native `fetch`).  
> `express` and `cors` are installed via package.json.

### 2. (Recommended) Install Ollama

1. Download from [https://ollama.com](https://ollama.com)
2. Pull a model: `ollama pull llama3`
3. Ollama runs automatically at `http://localhost:11434`

You can change the model by setting the environment variable:

```bash
OLLAMA_MODEL=mistral node index.mjs
```

### 3. (Fallback) Get a free Gemini API key

1. Visit [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Copy your key
3. Either set it as an env variable:
   ```bash
   GEMINI_API_KEY=AIza… node index.mjs
   ```
   …or enter it directly in the extension's **⚙️ Settings** panel (it is saved locally in Chrome storage).

### 4. Start the server

```bash
node index.mjs
```

You should see: `✅  Server running at http://localhost:5000`

### 5. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder

---

## How it works

1. Click the extension icon on a **privacy policy page**
2. The popup sends the URL to the local Node server
3. The server tries **Ollama first** — if offline, **Gemini** is used automatically
4. Results are displayed as:
   - 📊 **Privacy Score** (0–100)
   - 📝 **Plain-English Summary**
   - 🚩 **Flagged Issues** (color-coded High / Medium / Low)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server address |
| `OLLAMA_MODEL` | `llama3` | Model to use with Ollama |
| `GEMINI_API_KEY` | *(empty)* | Gemini API key (fallback) |
| `GEMINI_MODEL` | `gemini-1.5-flash` | Gemini model |
| `PORT` | `5000` | Local server port |
