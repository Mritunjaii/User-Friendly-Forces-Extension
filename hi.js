// hi.js — Extension popup script

const SERVER_URL = 'http://localhost:5000/';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPrivacyPolicyPage(url) {
  const lower = url.toLowerCase();
  return [
    'privacy', 'data-protection', 'data_protection', 'dataprivacy',
    'cookie-policy', 'cookie_policy', 'cookiepolicy',
    'data-collection', 'gdpr', 'ccpa', 'caloppa',
    'terms-of-service', 'termsofservice', 'tos',
  ].some(kw => lower.includes(kw));
}

function severityColor(sev) {
  return { high: '#ff4d4d', medium: '#ffaa33', low: '#66cc88' }[sev] ?? '#aaa';
}

function severityIcon(sev) {
  return { high: '🔴', medium: '🟡', low: '🟢' }[sev] ?? '⚪';
}

function setStatus(msg, type = 'info') {
  // type: 'info' | 'error' | 'warn' | 'success'
  const el = document.getElementById('status_msg');
  el.textContent = msg;
  el.className = 'status-' + type;
  el.style.display = msg ? 'block' : 'none';
}

function setLoading(loading) {
  const btn = document.getElementById('summarize_privacy_button');
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<span class="spinner"></span> Analyzing…'
    : '🔍 Analyze Privacy Policy';
}

// ─── Settings (Gemini key) ────────────────────────────────────────────────────

function loadGeminiKey() {
  return new Promise(resolve =>
    chrome.storage.local.get(['geminiKey'], res => resolve(res.geminiKey || ''))
  );
}

function saveGeminiKey(key) {
  return new Promise(resolve => chrome.storage.local.set({ geminiKey: key }, resolve));
}

function toggleSettings() {
  const panel = document.getElementById('settings_panel');
  panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

// ─── Render result ────────────────────────────────────────────────────────────

function renderResult(url, result) {
  const domain = new URL(url).hostname;
  document.getElementById('domain').textContent = `📋 ${domain}`;
  document.getElementById('domain').style.display = 'block';

  const container = document.getElementById('privacy_summary');
  container.style.display = 'block';

  // Provider tag
  const providerLabel = result.provider === 'ollama'
    ? `🦙 Ollama · ${result.model ?? ''}`
    : `✨ Gemini · ${result.model ?? ''}`;
  const providerHTML = `<div class="provider-tag">${providerLabel}</div>`;

  // Score badge
  const scoreColor = result.score != null
    ? (result.score >= 60 ? '#66cc88' : result.score >= 35 ? '#ffaa33' : '#ff4d4d')
    : '#aaa';
  const scoreHTML = result.score != null
    ? `<div class="score-badge" style="--score-color:${scoreColor}">Privacy Score: <strong>${result.score}/100</strong></div>`
    : '';

  // Summary
  const summaryHTML = result.summary
    ? `<p class="summary-text">${result.summary}</p>`
    : '';

  // Flags
  const flagsHTML = (result.flags ?? []).length > 0
    ? `<ul class="flags-list">${result.flags.map(f => `
        <li class="flag-item">
          <span class="flag-icon">${severityIcon(f.severity)}</span>
          <span class="flag-body">
            <strong style="color:${severityColor(f.severity)}">${f.title}</strong>
            <span class="flag-detail">${f.detail}</span>
          </span>
        </li>`).join('')}</ul>`
    : '<p style="color:#aaa;font-size:12px">No specific flags found.</p>';

  container.innerHTML = `${providerHTML}${scoreHTML}${summaryHTML}<hr class="divider">${flagsHTML}`;
}

// ─── Main summarize flow ──────────────────────────────────────────────────────

async function summarizePrivacyPolicy() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url ?? '';

  if (!url) return setStatus('Cannot detect current tab URL.', 'error');

  if (!isPrivacyPolicyPage(url)) {
    return setStatus("⚠️ Navigate to a privacy policy page first, then click Analyze.", 'warn');
  }

  setLoading(true);
  setStatus('🦙 Asking Ollama… (this may take 1-2 min on CPU)', 'info');
  document.getElementById('privacy_summary').style.display = 'none';
  document.getElementById('domain').style.display = 'none';

  // Animate the status to show progress
  let dots = 0;
  const progressTimer = setInterval(() => {
    dots = (dots + 1) % 4;
    const base = '🦙 Asking Ollama… (this may take 1-2 min on CPU)';
    setStatus(base + '.'.repeat(dots), 'info');
  }, 1500);

  try {
    const geminiKey = await loadGeminiKey();
    const prompt = `Analyze the privacy policy at this URL and return JSON as instructed:\n${url}`;

    const response = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: prompt, geminiKey }),
      signal: AbortSignal.timeout(180_000),  // 3 min — llama3.2 is slow on CPU
    });

    clearInterval(progressTimer);

    const data = await response.json();

    if (!response.ok) {
      // Show real Ollama error + Gemini error if both failed
      let errMsg = '';
      if (data.ollamaError && data.geminiError) {
        errMsg = `🦙 Ollama: ${data.ollamaError}\n✨ Gemini: ${data.geminiError}`;
      } else if (data.ollamaError) {
        errMsg = `🦙 Ollama failed: ${data.ollamaError}`;
        if (data.hint) errMsg += `\n${data.hint}`;
      } else {
        errMsg = `❌ ${data.error ?? 'Unknown server error'}`;
      }
      return setStatus(errMsg, 'error');
    }

    const result = typeof data.message === 'string' ? JSON.parse(data.message) : data.message;
    renderResult(url, result);
    setStatus('');
  } catch (err) {
    clearInterval(progressTimer);
    console.error(err);
    if (err.name === 'TimeoutError') {
      setStatus('⏱️ Timed out. The model may be slow — try again or use a smaller model.', 'error');
    } else if (err.message.includes('fetch') || err.message.includes('Failed to fetch')) {
      setStatus('❌ Cannot reach server at localhost:5000. Start it with: node index.mjs', 'error');
    } else {
      setStatus(`❌ ${err.message}`, 'error');
    }
  } finally {
    clearInterval(progressTimer);
    setLoading(false);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load saved Gemini key
  const savedKey = await loadGeminiKey();
  document.getElementById('gemini_key_input').value = savedKey;

  // Check server health and show provider status
  try {
    const health = await fetch('http://localhost:5000/health', {
      signal: AbortSignal.timeout(4000),
    }).then(r => r.json());

    if (health.ollama) {
      setStatus(`🦙 Ollama ready · ${health.ollamaModel}`, 'success');
    } else if (health.ollamaError) {
      // Ollama is reachable but something is wrong (e.g. no models)
      if (savedKey || health.gemini) {
        setStatus(`🦙 Ollama issue: ${health.ollamaError} — will use Gemini`, 'warn');
      } else {
        setStatus(`🦙 Ollama issue: ${health.ollamaError}`, 'error');
      }
    } else if (health.gemini || savedKey) {
      setStatus('✨ Gemini ready (Ollama offline)', 'warn');
    } else {
      setStatus('⚠️ Ollama offline. Add a Gemini key in ⚙️ Settings as fallback.', 'warn');
    }
  } catch {
    setStatus('❌ Server offline. Run: node index.mjs', 'error');
  }

  // Events
  document.getElementById('summarize_privacy_button').addEventListener('click', summarizePrivacyPolicy);
  document.getElementById('settings_btn').addEventListener('click', toggleSettings);

  document.getElementById('save_key_btn').addEventListener('click', async () => {
    const key = document.getElementById('gemini_key_input').value.trim();
    await saveGeminiKey(key);
    setStatus(key ? '✅ Gemini key saved!' : '✅ Key cleared.', 'success');
    toggleSettings();
  });
});
