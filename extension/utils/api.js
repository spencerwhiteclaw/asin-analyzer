// ═══ ASIN Analyzer Extension — API Client ═══
// Shared module for all content scripts and background worker

const AA_API_BASE = 'https://www.asinanalyzer.app';
const AA_REPORT_BASE = 'https://www.asinanalyzer.app/report';

// Get API key from chrome.storage.local
async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['aa_api_key'], (result) => {
      resolve(result.aa_api_key || null);
    });
  });
}

// Save API key
async function saveApiKey(key) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ aa_api_key: key }, resolve);
  });
}

// Clear API key (logout)
async function clearApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(['aa_api_key'], resolve);
  });
}

// Generic API fetch with auth
async function aaFetch(path, options = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { error: 'Not authenticated. Open extension popup to enter your API key.' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    ...(options.headers || {}),
  };

  try {
    const resp = await fetch(`${AA_API_BASE}${path}`, {
      ...options,
      headers,
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { error: data.error || `Request failed (${resp.status})` };
    }
    return data;
  } catch (err) {
    return { error: 'Connection failed. Check your internet connection.' };
  }
}

// Get cached score for a single ASIN
async function getScore(asin) {
  return aaFetch(`/api/extension/score/${asin}`);
}

// Get batch scores for multiple ASINs
async function getBatchScores(asins) {
  return aaFetch('/api/extension/batch-scores', {
    method: 'POST',
    body: JSON.stringify({ asins }),
  });
}

// Trigger full analysis for an ASIN
async function analyzeAsin(asin) {
  return aaFetch(`/api/extension/analyze/${asin}`, { method: 'POST' });
}

// Grade color helper
function gradeColor(grade) {
  if (!grade) return '#94A3B8';
  const g = grade.replace('+', '');
  if (g === 'A') return '#10B981';
  if (g === 'B') return '#3B82F6';
  if (g === 'C') return '#F59E0B';
  return '#EF4444';
}

function scoreColor(score) {
  if (score >= 80) return '#10B981';
  if (score >= 60) return '#3B82F6';
  if (score >= 40) return '#F59E0B';
  return '#EF4444';
}
