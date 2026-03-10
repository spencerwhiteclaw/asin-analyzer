// ═══ ASIN Analyzer Extension — Popup Logic ═══

const API_BASE = 'https://www.asinanalyzer.app';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const result = await chrome.storage.local.get(['aa_api_key', 'aa_user_email', 'aa_user_tier']);

  if (result.aa_api_key) {
    showConnectedView(result);
  } else {
    showAuthView();
  }
}

function showAuthView() {
  document.getElementById('authView').style.display = 'block';
  document.getElementById('connectedView').style.display = 'none';

  document.getElementById('saveKeyBtn').addEventListener('click', saveApiKey);
  document.getElementById('apiKeyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveApiKey();
  });
}

function showConnectedView(data) {
  document.getElementById('authView').style.display = 'none';
  document.getElementById('connectedView').style.display = 'block';

  const info = document.getElementById('userInfo');
  info.textContent = data.aa_user_email || 'API key connected';

  document.getElementById('disconnectBtn').addEventListener('click', disconnect);
  document.getElementById('quickScanBtn').addEventListener('click', quickScan);
  document.getElementById('quickAsinInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') quickScan();
  });
}

async function saveApiKey() {
  const input = document.getElementById('apiKeyInput');
  const errEl = document.getElementById('authError');
  const btn = document.getElementById('saveKeyBtn');
  const apiKey = input.value.trim();

  errEl.style.display = 'none';

  if (!apiKey || !apiKey.startsWith('aa_')) {
    errEl.textContent = 'API key should start with "aa_"';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    // Validate key by making a test request
    const resp = await fetch(`${API_BASE}/api/extension/score/B0BSHF7WHW`, {
      headers: { 'X-Api-Key': apiKey },
    });

    if (resp.status === 401) {
      errEl.textContent = 'Invalid API key. Check your key and try again.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Connect →';
      return;
    }

    // Key works — save it
    await chrome.storage.local.set({
      aa_api_key: apiKey,
      aa_connected_at: Date.now(),
    });

    // Reload popup
    init();
  } catch (err) {
    errEl.textContent = 'Connection failed. Check your internet.';
    errEl.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = 'Connect →';
}

async function disconnect() {
  await chrome.storage.local.remove(['aa_api_key', 'aa_user_email', 'aa_user_tier', 'aa_connected_at']);
  init();
}

async function quickScan() {
  const input = document.getElementById('quickAsinInput');
  const btn = document.getElementById('quickScanBtn');
  const resultEl = document.getElementById('quickResult');
  let asin = input.value.trim().toUpperCase();

  // Extract from URL
  const urlMatch = asin.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (urlMatch) asin = urlMatch[1].toUpperCase();

  if (!asin || !/^B0[A-Z0-9]{8}$/i.test(asin)) {
    resultEl.innerHTML = '<div class="qr-error">Enter a valid ASIN (B0...)</div>';
    return;
  }

  btn.disabled = true;
  btn.textContent = '...';
  resultEl.innerHTML = '<div class="qr-loading">Checking score...</div>';

  try {
    const apiKey = (await chrome.storage.local.get(['aa_api_key'])).aa_api_key;
    const resp = await fetch(`${API_BASE}/api/extension/score/${asin}`, {
      headers: { 'X-Api-Key': apiKey },
    });
    const data = await resp.json();

    if (data.error) {
      resultEl.innerHTML = `<div class="qr-error">${data.error}</div>`;
    } else if (!data.found) {
      // No cached score — offer to run full scan
      resultEl.innerHTML = `<div class="qr-loading">No score cached. <a href="${API_BASE}/?asin=${asin}" target="_blank" style="color:#3B82F6;font-weight:600;text-decoration:none;">Run full analysis →</a></div>`;
    } else {
      const gc = data.grade?.replace('+', '') === 'A' ? '#10B981' : data.grade?.replace('+', '') === 'B' ? '#3B82F6' : data.grade?.replace('+', '') === 'C' ? '#F59E0B' : '#EF4444';
      resultEl.innerHTML = `
        <div class="qr-card">
          <div class="qr-grade" style="color:${gc}">${data.grade}</div>
          <div class="qr-info">
            <div class="qr-score">${data.score != null ? data.score + '/100' : data.grade}</div>
            <div class="qr-title">${data.title || asin}</div>
          </div>
        </div>
        ${data.reportUrl ? `<a href="${data.reportUrl}" target="_blank" class="qr-link" style="display:block;margin-top:6px;">View full report →</a>` : ''}
      `;
    }
  } catch (err) {
    resultEl.innerHTML = '<div class="qr-error">Connection failed.</div>';
  }

  btn.disabled = false;
  btn.textContent = 'Scan';
}
