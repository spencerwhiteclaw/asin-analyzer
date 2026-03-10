// ═══ ASIN Analyzer Extension — Product Page Overlay ═══
// Injects score badge on Amazon product pages (/dp/)

(function() {
  'use strict';

  // Extract ASIN from URL
  function extractAsin() {
    const match = window.location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return match ? match[1].toUpperCase() : null;
  }

  const asin = extractAsin();
  if (!asin) return;

  // Don't inject twice
  if (document.getElementById('aa-ext-badge')) return;

  // Create badge container
  const badge = document.createElement('div');
  badge.id = 'aa-ext-badge';
  badge.className = 'aa-badge aa-badge-loading';
  badge.innerHTML = `
    <div class="aa-badge-inner">
      <div class="aa-badge-header">
        <div class="aa-logo">ASIN<span>A</span></div>
        <button class="aa-badge-close" id="aa-close" title="Close">×</button>
      </div>
      <div class="aa-badge-body" id="aa-body">
        <div class="aa-loading">
          <div class="aa-spinner"></div>
          <div class="aa-loading-text">Checking score...</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(badge);

  // Close button
  document.getElementById('aa-close').addEventListener('click', () => {
    badge.style.display = 'none';
  });

  // Make badge draggable
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  const header = badge.querySelector('.aa-badge-header');

  header.addEventListener('mousedown', (e) => {
    if (e.target.id === 'aa-close') return;
    isDragging = true;
    dragOffset.x = e.clientX - badge.offsetLeft;
    dragOffset.y = e.clientY - badge.offsetTop;
    badge.style.transition = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    badge.style.right = 'auto';
    badge.style.left = (e.clientX - dragOffset.x) + 'px';
    badge.style.top = (e.clientY - dragOffset.y) + 'px';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    badge.style.transition = '';
  });

  // Fetch score
  chrome.runtime.sendMessage({ action: 'getScore', asin }, (data) => {
    const body = document.getElementById('aa-body');
    badge.classList.remove('aa-badge-loading');

    if (!data || data.error) {
      if (data?.error?.includes('Not authenticated')) {
        body.innerHTML = `
          <div class="aa-auth-prompt">
            <div class="aa-auth-text">Enter your API key in the extension popup to see scores.</div>
          </div>
        `;
      } else {
        body.innerHTML = `<div class="aa-error">${data?.error || 'Failed to load'}</div>`;
      }
      return;
    }

    if (!data.found) {
      // No analysis exists — show scan button
      body.innerHTML = `
        <div class="aa-no-data">
          <div class="aa-no-data-text">No score yet for ${asin}</div>
          <button class="aa-scan-btn" id="aa-scan">Scan Now →</button>
        </div>
      `;
      document.getElementById('aa-scan').addEventListener('click', () => scanAsin(asin));
      return;
    }

    // Show score
    renderScore(body, data);
  });

  function renderScore(container, data) {
    const gc = gradeColor(data.grade);
    const hasScore = data.score != null;

    container.innerHTML = `
      <div class="aa-score-display">
        <div class="aa-grade" style="color:${gc}">${data.grade}</div>
        ${hasScore ? `<div class="aa-score-num" style="color:${scoreColor(data.score)}">${data.score}<span>/100</span></div>` : ''}
      </div>
      ${data.title ? `<div class="aa-title">${data.title.substring(0, 60)}${data.title.length > 60 ? '...' : ''}</div>` : ''}
      <div class="aa-badge-actions">
        ${data.reportUrl ? `<a href="${data.reportUrl}" target="_blank" class="aa-report-link">View Report →</a>` : ''}
        ${hasScore ? `<button class="aa-rescan-btn" id="aa-rescan">Re-scan</button>` : ''}
      </div>
    `;

    const rescanBtn = document.getElementById('aa-rescan');
    if (rescanBtn) {
      rescanBtn.addEventListener('click', () => scanAsin(asin));
    }
  }

  function scanAsin(asin) {
    const body = document.getElementById('aa-body');
    body.innerHTML = `
      <div class="aa-loading">
        <div class="aa-spinner"></div>
        <div class="aa-loading-text">Analyzing listing...</div>
      </div>
    `;

    chrome.runtime.sendMessage({ action: 'analyze', asin }, (data) => {
      if (!data || data.error) {
        body.innerHTML = `<div class="aa-error">${data?.error || 'Analysis failed'}</div>`;
        return;
      }
      renderScore(body, data);
    });
  }
})();
