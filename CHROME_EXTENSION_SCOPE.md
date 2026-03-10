# Chrome Extension — Sprint 6.1 Scoping Document

## What It Does

A Chrome Extension that overlays ASIN Analyzer scores directly on Amazon product pages and search results. Users see listing grades without leaving Amazon.

---

## File Structure

```
asin-analyzer-extension/
├── manifest.json          # Extension manifest (Manifest V3)
├── background.js          # Service worker — handles API calls to asinanalyzer.app
├── content-product.js     # Content script for Amazon product pages (/dp/)
├── content-search.js      # Content script for Amazon search results (/s?)
├── popup.html             # Extension popup (login, quick scan, settings)
├── popup.js               # Popup logic
├── popup.css              # Popup styles
├── styles.css             # Injected styles for score overlays
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── utils/
    └── api.js             # Shared API client module
```

## Authentication

**Approach: Token-based via popup login**

1. User clicks extension icon → popup shows login form (email + password) or "Login with ASIN Analyzer" button
2. Popup sends credentials to `POST https://asinanalyzer.app/api/auth/login`
3. Backend returns Supabase access token
4. Token stored in `chrome.storage.local` (persists across sessions)
5. All API calls from background.js include `Authorization: Bearer {token}` header
6. Token refresh handled automatically — if 401 returned, prompt re-login

**Alternative (simpler):** API key approach. Generate a persistent API key per user in the dashboard (new endpoint `POST /api/auth/extension-key`), user pastes it into extension settings. No session management needed.

**Recommendation:** Start with API key approach — simpler, fewer edge cases, no token refresh logic.

## Score Overlay — Product Pages (/dp/)

**How it works:**

1. `content-product.js` runs on `https://www.amazon.com/dp/*` and `https://www.amazon.com/gp/product/*`
2. Extracts ASIN from URL (`/dp/B0XXXXXXXX`)
3. Sends message to `background.js`: `{ action: "getScore", asin: "B0XXXXXXXX" }`
4. `background.js` calls `GET https://asinanalyzer.app/api/extension/score/{asin}` (new lightweight endpoint — returns just score + grade, no full scrape)
5. If cached score exists (< 24 hours old), return immediately from DB
6. If no cache, return `{ status: "not_analyzed" }` with a "Scan Now" button
7. Content script injects a floating badge in the top-right of the product page:
   - Grade letter (A+, B, C, etc.) with color coding
   - Overall score (72/100)
   - "View Full Report →" link to asinanalyzer.app/report/{id}
   - "Re-scan" button (triggers fresh analysis)

**Injected DOM:**
```html
<div id="asin-analyzer-badge" style="position:fixed;top:80px;right:20px;z-index:9999;">
  <div class="aa-grade">B+</div>
  <div class="aa-score">72/100</div>
  <a href="https://asinanalyzer.app/report/123">Full Report →</a>
</div>
```

## Score Overlay — Search Results (/s?)

**How it works:**

1. `content-search.js` runs on `https://www.amazon.com/s?*`
2. Finds all product cards via `[data-asin]` attribute
3. Collects all ASINs on the page (typically 16-48)
4. Sends batch request to `background.js`: `{ action: "getBatchScores", asins: [...] }`
5. `background.js` calls `POST https://asinanalyzer.app/api/extension/batch-scores` (new endpoint — returns cached scores for multiple ASINs)
6. For each product card with a cached score, inject a small badge:
   - Small colored circle with grade letter
   - Appears next to the product title or price

**New backend endpoints needed:**
- `GET /api/extension/score/:asin` — lightweight score lookup (cache only, no scrape)
- `POST /api/extension/batch-scores` — accepts array of ASINs, returns cached scores
- `POST /api/extension/analyze/:asin` — trigger full analysis from extension (counts against quota)

## Estimated Complexity

**Medium-High**

| Component | Effort | Notes |
|-----------|--------|-------|
| manifest.json + structure | Low | Standard Manifest V3 boilerplate |
| Popup (login + settings) | Low | Simple form, token storage |
| Product page overlay | Medium | DOM injection, positioning, Amazon layout varies |
| Search results overlay | Medium-High | Multiple products, batch API, various Amazon layouts |
| Background service worker | Medium | API client, token management, caching |
| New backend endpoints | Low | 3 new lightweight endpoints |
| Chrome Web Store submission | Low | Screenshots, description, review process (~2-5 days) |
| **Total** | **~3-4 days of dev work** | Plus 2-5 days for Chrome Web Store review |

## Key Considerations

1. **Amazon DOM changes frequently** — Content scripts need resilient selectors. Use `data-asin` attribute (stable) rather than class names (change often).

2. **Rate limiting** — Batch endpoint is critical. Without it, a search page with 48 results would fire 48 individual API calls. The batch endpoint should return only cached results (no scraping) for performance.

3. **Manifest V3 restrictions** — No persistent background pages. Must use service workers. `chrome.storage.local` for persistence. No inline scripts in popup.

4. **Amazon CSP** — Amazon has strict Content Security Policy. Injected styles must be inline or in the extension's own CSS file loaded via `chrome.runtime.getURL()`. Cannot load external resources from content scripts.

5. **Internationalization** — Amazon has different domains (.co.uk, .de, .co.jp, etc.). Start with .com only, expand later via manifest `matches` patterns.

6. **Free vs paid overlay** — Free users see grade only. Paid users see grade + score + direct link to report + scan button. This drives conversions.
