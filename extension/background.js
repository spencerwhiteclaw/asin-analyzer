// ═══ ASIN Analyzer Extension — Background Service Worker ═══
// Handles message passing between content scripts and API

const API_BASE = 'https://www.asinanalyzer.app';

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getScore') {
    handleGetScore(message.asin).then(sendResponse);
    return true; // Keep channel open for async response
  }

  if (message.action === 'getBatchScores') {
    handleBatchScores(message.asins).then(sendResponse);
    return true;
  }

  if (message.action === 'analyze') {
    handleAnalyze(message.asin).then(sendResponse);
    return true;
  }

  if (message.action === 'checkAuth') {
    chrome.storage.local.get(['aa_api_key'], (result) => {
      sendResponse({ authenticated: !!result.aa_api_key });
    });
    return true;
  }
});

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['aa_api_key'], (result) => {
      resolve(result.aa_api_key || null);
    });
  });
}

async function apiFetch(path, options = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) return { error: 'Not authenticated' };

  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        ...(options.headers || {}),
      },
    });
    return await resp.json();
  } catch (err) {
    return { error: 'Connection failed' };
  }
}

async function handleGetScore(asin) {
  return apiFetch(`/api/extension/score/${asin}`);
}

async function handleBatchScores(asins) {
  return apiFetch('/api/extension/batch-scores', {
    method: 'POST',
    body: JSON.stringify({ asins }),
  });
}

async function handleAnalyze(asin) {
  return apiFetch(`/api/extension/analyze/${asin}`, { method: 'POST' });
}

// Badge click — open popup
chrome.action.onClicked.addListener(() => {
  // Default action opens popup.html (defined in manifest)
});
