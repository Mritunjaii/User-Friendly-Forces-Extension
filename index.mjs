// server.mjs — Privacy Policy Summarizer Backend
// Uses Ollama (primary) → Gemini (fallback)

import http from 'http';
import express from 'express';
import cors from 'cors';

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─── Config ──────────────────────────────────────────────────────────────────
const OLLAMA_BASE_URL   = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const PREFERRED_MODEL   = process.env.OLLAMA_MODEL    || '';
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY  || '';

// Gemini models to try in order (some may not be available in all regions)
const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-pro',
  'gemini-1.0-pro',
];

const SYSTEM_PROMPT = `You are a privacy policy expert.
Analyze the provided privacy policy URL and return ONLY a valid JSON object with this exact shape (no markdown, no code fences, no extra text):
{
  "summary": "2-3 sentence plain-English overview",
  "flags": [
    { "severity": "high", "title": "short title", "detail": "explanation" }
  ],
  "score": 42
}
severity must be "high", "medium", or "low".
score is 0-100 where 100 = most privacy-friendly.
Focus on: data selling, tracking, third-party sharing, retention periods, user rights, vague language.`;

// ─── Ollama: auto-detect installed model ──────────────────────────────────────
let cachedModel = null;

async function resolveOllamaModel() {
  if (cachedModel) return cachedModel;

  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Ollama /api/tags HTTP ${res.status}`);

  const data   = await res.json();
  const models = (data.models ?? []).map(m => m.name);
  if (models.length === 0) {
    throw new Error('Ollama has no models installed. Run: ollama pull llama3');
  }

  cachedModel = (PREFERRED_MODEL && models.some(m => m.startsWith(PREFERRED_MODEL)))
    ? models.find(m => m.startsWith(PREFERRED_MODEL))
    : models[0];

  console.log(`[Ollama] Resolved model: ${cachedModel}  (installed: ${models.join(', ')})`);
  return cachedModel;
}

// ─── Ollama generate — tries /api/chat, falls back to /api/generate ───────────
async function generateWithOllama(prompt) {
  const model = await resolveOllamaModel();

  // ── Try /api/chat (Ollama ≥ 0.1.14) ────────────────────────────────────────
  try {
    console.log(`[Ollama] POST /api/chat  model=${model}`);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
        stream: false,
        options: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(180_000),  // 3 min — llama3.2 is slow on CPU-only machines
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.message?.content ?? '';
      if (text) { console.log('[Ollama] /api/chat OK'); return { text, model }; }
      console.warn('[Ollama] /api/chat returned empty content');
    } else {
      const body = await res.text().catch(() => '');
      console.warn(`[Ollama] /api/chat HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (chatErr) {
    console.warn(`[Ollama] /api/chat threw: ${chatErr.message} — retrying with /api/generate`);
  }

  // ── Fall back to /api/generate (older Ollama) ───────────────────────────────
  console.log(`[Ollama] POST /api/generate  model=${model}`);
  const res2 = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `${SYSTEM_PROMPT}\n\nUser request: ${prompt}`,
      stream: false,
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(180_000),  // 3 min — llama3.2 slow on CPU
  });

  if (!res2.ok) {
    const body = await res2.text().catch(() => '');
    throw new Error(`Ollama /api/generate HTTP ${res2.status}: ${body.slice(0, 300)}`);
  }

  const data2 = await res2.json();
  const text2 = data2.response ?? '';
  if (!text2) throw new Error('Ollama returned an empty response from /api/generate');
  console.log('[Ollama] /api/generate OK');
  return { text: text2, model };
}

// ─── Gemini generate — auto-tries multiple model names ───────────────────────
async function generateWithGemini(prompt, apiKey) {
  const key = apiKey || GEMINI_API_KEY;
  if (!key) throw new Error('No Gemini API key provided');

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    try {
      console.log(`[Gemini] Trying model: ${model}`);
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const msg = errData?.error?.message ?? `HTTP ${res.status}`;
        // 404 = model not found in this region → try next
        if (res.status === 404) {
          console.warn(`[Gemini] ${model} not available: ${msg}`);
          lastError = new Error(`Gemini HTTP 404: ${msg}`);
          continue;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${msg}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) { lastError = new Error(`${model} returned empty text`); continue; }

      console.log(`[Gemini] OK with model: ${model}`);
      return { text, model };
    } catch (err) {
      if (err.name === 'TimeoutError') throw err; // don't retry on timeout
      lastError = err;
    }
  }

  throw lastError ?? new Error('All Gemini models failed');
}

// ─── JSON extractor (handles markdown fences + preamble text) ─────────────────
function extractJSON(raw) {
  let cleaned = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/```\s*$/im, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

// ─── Health endpoint ──────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  let ollamaOk    = false;
  let ollamaModel = null;
  let ollamaError = null;

  try {
    ollamaModel = await resolveOllamaModel();
    ollamaOk    = true;
  } catch (e) {
    ollamaError = e.message;
    cachedModel = null;
  }

  res.json({ ollama: ollamaOk, ollamaModel, ollamaError, gemini: !!GEMINI_API_KEY });
});

// ─── Main summarize endpoint ──────────────────────────────────────────────────
app.post('/', async (req, res) => {
  const { data: prompt, geminiKey } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: 'Missing `data` field' });

  // ── Try Ollama first ─────────────────────────────────────────────────────
  try {
    const { text, model } = await generateWithOllama(prompt);
    let parsed;
    try { parsed = extractJSON(text); }
    catch {
      parsed = { summary: text.slice(0, 500), flags: [], score: null };
    }
    return res.json({ message: { ...parsed, provider: 'ollama', model } });
  } catch (ollamaErr) {
    console.warn(`[Ollama] FAILED: ${ollamaErr.message}`);
    cachedModel = null;

    // ── Fall back to Gemini only if a key exists ─────────────────────────
    const key = geminiKey || GEMINI_API_KEY;
    if (!key) {
      return res.status(500).json({
        error: `Ollama failed and no Gemini key is set.`,
        ollamaError: ollamaErr.message,
        hint: 'Check the server terminal for the Ollama error details, or add a Gemini API key in ⚙️ Settings.',
      });
    }

    try {
      const { text, model } = await generateWithGemini(prompt, key);
      let parsed;
      try { parsed = extractJSON(text); }
      catch {
        parsed = { summary: text.slice(0, 500), flags: [], score: null };
      }
      return res.json({ message: { ...parsed, provider: 'gemini', model } });
    } catch (geminiErr) {
      return res.status(500).json({
        error: `Both providers failed.`,
        ollamaError: ollamaErr.message,
        geminiError: geminiErr.message,
      });
    }
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n✅  Server running at http://localhost:${PORT}`);
  console.log(`    Ollama URL : ${OLLAMA_BASE_URL}`);
  console.log(`    Gemini key : ${GEMINI_API_KEY ? '✓ set via env' : '(none — use Settings in extension)'}\n`);
});
