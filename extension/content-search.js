// ═══ ASIN Analyzer Extension — Search Results Overlay ═══
// Injects score badges on Amazon search result pages (/s?)

(function() {
  'use strict';

  // Don't run twice
  if (document.querySelector('.aa-search-badge')) return;

  // Find all product cards with data-asin
  const productCards = document.querySelectorAll('[data-asin]');
  const asins = [];
  const asinElements = {};

  productCards.forEach(card => {
    const asin = card.getAttribute('data-asin');
    if (asin && asin.length === 10 && asin !== 'undefined' && /^[A-Z0-9]{10}$/i.test(asin)) {
      asins.push(asin.toUpperCase());
      asinElements[asin.toUpperCase()] = card;
    }
  });

  if (asins.length === 0) return;

  // De-duplicate
  const uniqueAsins = [...new Set(asins)];

  // Request batch scores from background
  chrome.runtime.sendMessage({ action: 'getBatchScores', asins: uniqueAsins }, (data) => {
    if (!data || data.error || !data.scores) return;

    Object.entries(data.scores).forEach(([asin, info]) => {
      const card = asinElements[asin];
      if (!card) return;

      // Find the title or price area to inject badge
      const titleEl = card.querySelector('h2') ||
                       card.querySelector('[data-cy="title-recipe"]') ||
                       card.querySelector('.a-text-normal') ||
                       card.querySelector('.s-title-instructions-style');

      if (!titleEl) return;

      // Don't inject twice
      if (card.querySelector('.aa-search-badge')) return;

      const gc = gradeColor(info.grade);
      const badge = document.createElement('a');
      badge.className = 'aa-search-badge';
      badge.href = info.reportUrl || '#';
      badge.target = '_blank';
      badge.title = `ASIN Analyzer: ${info.grade}${info.score ? ' (' + info.score + '/100)' : ''} — Click for full report`;
      badge.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 4px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 12px;
        font-weight: 700;
        text-decoration: none;
        margin-left: 6px;
        vertical-align: middle;
        background: ${gc}15;
        color: ${gc};
        border: 1px solid ${gc}40;
        cursor: pointer;
        transition: all 0.15s;
        line-height: 1;
      `;

      // Badge content
      let badgeText = info.grade;
      if (info.score != null) {
        badgeText += ` ${info.score}`;
      }

      badge.innerHTML = `
        <span style="font-size:10px;opacity:0.7;">AA</span>
        <span>${badgeText}</span>
      `;

      // Hover effect
      badge.addEventListener('mouseenter', () => {
        badge.style.transform = 'scale(1.05)';
        badge.style.boxShadow = `0 2px 8px ${gc}30`;
      });
      badge.addEventListener('mouseleave', () => {
        badge.style.transform = 'scale(1)';
        badge.style.boxShadow = 'none';
      });

      // Insert after title
      if (titleEl.parentElement) {
        titleEl.parentElement.insertBefore(badge, titleEl.nextSibling);
      } else {
        titleEl.after(badge);
      }
    });
  });
})();
