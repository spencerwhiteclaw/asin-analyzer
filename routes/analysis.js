// ============================================================
// routes/analysis.js — Analysis, Reports, Comparison Routes
// Extracted from server.js with Sprint 0 fixes:
//   - GHL push via lib/ghl.js (Task 0.4)
//   - Atomic quota UPDATE (Task 0.6)
//   - Retry logic via lib/errors.js (Task 0.7)
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { optionalAuth } = require('../lib/middleware');
const { scrapeAmazon } = require('../lib/scraper');
const { scoreProduct } = require('../lib/scoring');
const { generateImplementationPlan } = require('../lib/plan-generator');
const { sendReportEmail } = require('../lib/email');
const { triggerGHL } = require('../lib/ghl');
const { scrapeWithRetry, callClaudeWithFallback } = require('../lib/errors');

// ═══ TIER CONFIGURATION ═══
const TIER_LIMITS = {
  free: 1,           // 1 report ever (not per month)
  seller: 10,        // per month
  agency_power: 100, // OTO $39/mo tier
  agency: 50,
  enterprise: 300,
};

// ── Rate limiting — 1 free report per email, ever ──
async function checkEmailLimit(email) {
  if (!email) return { allowed: false, reason: 'Email is required to run a free report.' };

  const cleanEmail = email.trim().toLowerCase();
  const result = await db.query(
    'SELECT COUNT(*) as count FROM analyses WHERE LOWER(email) = $1',
    [cleanEmail]
  );
  const count = parseInt(result.rows[0].count, 10);

  if (count > 0) {
    return {
      allowed: false,
      reason: 'You\'ve already used your free report. Upgrade to the Seller Plan for 10 reports per month.',
      upgradeRequired: true,
    };
  }

  return { allowed: true };
}

// ══════════════════════════════════════════════════════════════
// POST /api/analyze
// Supports two modes:
// 1. Free/unauthenticated: requires email, 1 report per email ever
// 2. Authenticated subscriber: uses tier quota, includes solutions if paid tier
// ══════════════════════════════════════════════════════════════
router.post('/analyze', optionalAuth, async (req, res) => {
  try {
    const { asin, email } = req.body;

    // Validate ASIN
    const cleanASIN = (asin || '').trim().toUpperCase();
    if (!cleanASIN || !/^B0[A-Z0-9]{8}$/i.test(cleanASIN)) {
      return res.status(400).json({ error: 'Invalid ASIN. Must be 10 characters starting with B0.' });
    }

    let cleanEmail = (email || '').trim().toLowerCase();
    let isPaidUser = false;
    let userTier = 'free';
    let userId = null;

    // ── AUTHENTICATED USER PATH ──
    if (req.user) {
      userId = req.user.id;
      cleanEmail = (req.user.email || cleanEmail).toLowerCase();

      // Get user profile & check quota
      const profileResult = await db.query('SELECT * FROM user_profiles WHERE id = $1', [userId]);
      if (profileResult.rows.length > 0) {
        const profile = profileResult.rows[0];
        userTier = profile.subscription_tier || 'free';
        isPaidUser = userTier !== 'free' && profile.subscription_status === 'active';

        if (isPaidUser) {
          const limit = TIER_LIMITS[userTier] || 10;

          // ── SPRINT 0 FIX (Task 0.6): Atomic quota check + increment ──
          // Prevents race condition where two concurrent requests both pass the check
          const quotaResult = await db.query(
            `UPDATE user_profiles
             SET analyses_this_month = CASE
               WHEN analyses_month_reset IS NOT NULL AND analyses_month_reset <= NOW()
               THEN 1
               ELSE analyses_this_month + 1
             END,
             analyses_month_reset = CASE
               WHEN analyses_month_reset IS NOT NULL AND analyses_month_reset <= NOW()
               THEN date_trunc('month', NOW()) + interval '1 month'
               ELSE analyses_month_reset
             END
             WHERE id = $1
               AND (
                 (analyses_month_reset IS NOT NULL AND analyses_month_reset <= NOW())
                 OR analyses_this_month < $2
               )
             RETURNING analyses_this_month`,
            [userId, limit]
          );

          if (quotaResult.rows.length === 0) {
            return res.status(402).json({
              error: `You've used all ${limit} reports this month. Upgrade for more.`,
              upgradeRequired: true,
              used: limit, limit, tier: userTier,
            });
          }
        }
      }
    }

    // ── FREE USER PATH ──
    // Only enforce email limit if email was actually provided.
    // The preview gate allows running analysis WITHOUT email first
    // (user sees their grade, THEN we ask for email to unlock full report).
    if (!isPaidUser && cleanEmail && cleanEmail.includes('@')) {
      const limitCheck = await checkEmailLimit(cleanEmail);
      if (!limitCheck.allowed) {
        return res.status(429).json({
          error: limitCheck.reason,
          upgradeRequired: limitCheck.upgradeRequired || false,
        });
      }
    }

    // ── SPRINT 0 FIX (Task 0.7): Scrape with retry ──
    const product = await scrapeWithRetry(cleanASIN);

    // Score the listing (with content split)
    const { scores, overall, grade, actions } = scoreProduct(product);

    // Save to database
    let reportId = null;
    try {
      const result = await db.query(
        `INSERT INTO analyses (asin, email, user_id, product_title, brand, price, currency, rating, review_count, bsr, category, image_count, bullet_count, has_aplus, has_video, qa_count, overall_score, overall_grade, scores, raw_data, action_items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id`,
        [
          cleanASIN, cleanEmail || null, userId,
          product.title, product.brand, product.price, product.currency,
          product.rating, product.reviewCount, product.bsr, product.category,
          product.imageCount, product.bulletCount, product.hasAPlus, product.hasVideo, product.qaCount,
          overall, grade, JSON.stringify(scores), JSON.stringify(product), JSON.stringify(actions),
        ]
      );
      reportId = result.rows[0].id;
    } catch (dbErr) {
      console.error('[DB_ERROR] Save failed (returning report anyway):', dbErr.message);
    }

    // NOTE: Quota increment for paid users is now handled atomically above (Task 0.6)
    // No separate UPDATE needed here.

    // Subscribe email (free users)
    if (cleanEmail && !isPaidUser) {
      try {
        await db.query(
          `INSERT INTO subscribers (email, source) VALUES ($1, 'report') ON CONFLICT (email) DO NOTHING`,
          [cleanEmail]
        );
      } catch (e) { /* ignore dupe */ }
    }

    // Build response — paid subscribers get BOTH problem and solution
    const responseActions = actions.map(a => {
      const item = { category: a.category, problem: a.problem, priority: a.priority };
      if (isPaidUser) item.solution = a.solution;
      return item;
    });

    const report = {
      id: reportId,
      asin: cleanASIN,
      product: {
        title: product.title, brand: product.brand, price: product.price,
        rating: product.rating, reviewCount: product.reviewCount,
        bsr: product.bsr, category: product.category,
        imageCount: product.imageCount, bulletCount: product.bulletCount,
        hasAPlus: product.hasAPlus, hasVideo: product.hasVideo, qaCount: product.qaCount,
      },
      scores, overall, grade,
      actions: responseActions,
      actionCount: actions.length,
      isPaidReport: isPaidUser,
    };

    // ── SPRINT 0 FIX (Task 0.4): Fire GHL webhook (async, don't block response) ──
    if (cleanEmail) triggerGHL(cleanEmail, cleanASIN, overall, grade, reportId, product).catch(() => {});

    // Send email report (async, don't block response)
    if (cleanEmail) sendReportEmail(cleanEmail, report).catch(() => {});

    console.log(`[ANALYZE] ${cleanASIN} -> ${grade} (${overall}/100) — ${actions.length} actions [${isPaidUser ? userTier : 'free'}]`);
    res.json({ report });

  } catch (err) {
    console.error('[ANALYZE_ERROR]', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/generate-plan — Generate implementation plan (after $7 purchase)
// ══════════════════════════════════════════════════════════════
router.post('/generate-plan', async (req, res) => {
  try {
    const { analysisId, email } = req.body;

    // Verify purchase
    const purchase = await db.query(
      'SELECT * FROM purchases WHERE email = $1 AND analysis_id = $2',
      [(email || '').trim().toLowerCase(), parseInt(analysisId, 10)]
    );

    if (purchase.rows.length === 0) {
      return res.status(403).json({ error: 'Purchase required. Get your Implementation Plan for $7.' });
    }

    // Load the analysis
    const analysis = await db.query('SELECT * FROM analyses WHERE id = $1', [parseInt(analysisId, 10)]);
    if (analysis.rows.length === 0) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }

    const row = analysis.rows[0];

    // Check if plan already generated
    if (row.implementation_plan) {
      return res.json({ plan: row.implementation_plan });
    }

    // Reconstruct product + scores for the generator
    const product = row.raw_data || {};
    product.asin = row.asin;
    const scores = row.scores || {};
    const actions = row.action_items || [];

    // ── SPRINT 0 FIX (Task 0.7): Claude API with fallback ──
    const plan = await callClaudeWithFallback(product, scores, row.overall_grade, row.overall_score, actions);

    // Save plan to DB
    await db.query('UPDATE analyses SET implementation_plan = $1 WHERE id = $2', [JSON.stringify(plan), row.id]);

    res.json({ plan });
  } catch (err) {
    console.error('[PLAN_ERROR]', err.message);
    res.status(500).json({ error: 'Failed to generate implementation plan.' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/report/:id — Public report endpoint (problems only, no plan)
// ══════════════════════════════════════════════════════════════
router.get('/report/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM analyses WHERE id = $1', [parseInt(id, 10)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });

    const r = result.rows[0];

    // Strip solutions from action items for free/public access
    const actions = (r.action_items || []).map(a => ({
      category: a.category,
      problem: a.problem || a.text,
      priority: a.priority,
    }));

    res.json({
      report: {
        ...r,
        action_items: actions,
        implementation_plan: null, // Never expose plan via public report endpoint
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load report' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/report/:id/pdf — Generate PDF export of report
// ══════════════════════════════════════════════════════════════
router.get('/report/:id/pdf', async (req, res) => {
  let browser;
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM analyses WHERE id = $1', [parseInt(id, 10)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });

    const r = result.rows[0];
    const puppeteer = require('puppeteer');

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    // Build self-contained HTML for the PDF
    const getColor = (s) => s >= 80 ? '#10B981' : s >= 60 ? '#3B82F6' : s >= 40 ? '#F59E0B' : '#EF4444';
    const scores = r.scores || {};
    const scoreKeys = [
      { key: 'title', label: 'Title Quality' },
      { key: 'images', label: 'Image Quality' },
      { key: 'bullet_points', label: 'Bullet Points' },
      { key: 'a_plus', label: 'A+ Content' },
      { key: 'reviews', label: 'Review Profile' },
      { key: 'price_competitiveness', label: 'Price Position' },
      { key: 'keyword_optimization', label: 'Keyword Optimization' },
      { key: 'brand_story', label: 'Brand Story' },
      { key: 'inventory_status', label: 'Inventory Status' },
      { key: 'listing_completeness', label: 'Listing Completeness' },
      { key: 'competitive_position', label: 'Competitive Position' },
      { key: 'conversion_elements', label: 'Conversion Elements' },
    ];

    const actionItems = r.action_items || [];
    const problems = actionItems.map(a => ({
      category: a.category,
      problem: a.problem || a.text,
      priority: a.priority,
    }));

    const scoreRows = scoreKeys.map(sk => {
      const val = scores[sk.key];
      if (val == null) return '';
      const pct = val * 10;
      const color = getColor(pct);
      return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #f1f5f9;">
          <div style="width:180px;font-size:13px;font-weight:600;color:#475569;">${sk.label}</div>
          <div style="flex:1;height:8px;background:#f1f5f9;border-radius:100px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${color};border-radius:100px;"></div>
          </div>
          <div style="width:50px;text-align:right;font-size:14px;font-weight:700;color:${color};">${val}/10</div>
        </div>
      `;
    }).join('');

    const actionRows = problems.slice(0, 12).map((a, i) => {
      const prioColor = a.priority === 'High' ? '#EF4444' : a.priority === 'Medium' ? '#F59E0B' : '#94A3B8';
      return `
        <div style="padding:12px 0;border-bottom:1px solid #f1f5f9;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;color:${prioColor};text-transform:uppercase;">${a.priority || 'Medium'}</span>
            <span style="font-size:11px;color:#94a3b8;">·</span>
            <span style="font-size:11px;color:#94a3b8;">${a.category}</span>
          </div>
          <div style="font-size:13px;color:#0f172a;line-height:1.5;">${a.problem}</div>
        </div>
      `;
    }).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; color: #0f172a; background: #fff; padding: 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #f1f5f9; }
    .logo { font-size: 20px; font-weight: 800; }
    .logo span { color: #3B82F6; }
    .grade-box { text-align: center; }
    .grade { font-size: 56px; font-weight: 800; line-height: 1; }
    .score { font-size: 14px; color: #475569; margin-top: 4px; }
    .product-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; max-width: 600px; }
    .product-meta { font-size: 13px; color: #475569; }
    .section { margin-bottom: 28px; }
    .section-title { font-size: 16px; font-weight: 800; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 2px solid #3B82F6; display: inline-block; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 2px solid #f1f5f9; font-size: 11px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">ASIN <span>Analyzer</span></div>
      <div style="margin-top:12px;">
        <div class="product-title">${r.product_title || r.asin}</div>
        <div class="product-meta">ASIN: ${r.asin}${r.brand ? ' · ' + r.brand : ''}${r.category ? ' · ' + r.category : ''}</div>
        <div class="product-meta" style="margin-top:4px;">Generated: ${new Date(r.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
      </div>
    </div>
    <div class="grade-box">
      <div class="grade" style="color:${getColor(r.overall_score)}">${r.overall_grade}</div>
      <div class="score">${r.overall_score} / 100</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Score Breakdown</div>
    ${scoreRows}
  </div>

  <div class="section">
    <div class="section-title">Issues Found (${problems.length})</div>
    ${actionRows || '<div style="font-size:13px;color:#94a3b8;">No issues detected.</div>'}
  </div>

  <div class="footer">
    ASIN Analyzer Report · asinanalyzer.app · Report #${r.id} · Confidential
  </div>
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });

    await browser.close();
    browser = null;

    const filename = `ASIN-Report-${r.asin}-${r.id}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);

  } catch (err) {
    console.error('[PDF_ERROR]', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/compare — Competitor Comparison (2-5 ASINs)
// ══════════════════════════════════════════════════════════════
router.post('/compare', optionalAuth, async (req, res) => {
  try {
    const { asins } = req.body;
    if (!Array.isArray(asins) || asins.length < 2 || asins.length > 5) {
      return res.status(400).json({ error: 'Provide 2 to 5 ASINs for comparison.' });
    }

    const cleanAsins = asins.map(a => (a || '').trim().toUpperCase());
    for (const a of cleanAsins) {
      if (!/^B0[A-Z0-9]{8}$/i.test(a)) {
        return res.status(400).json({ error: `Invalid ASIN: ${a}` });
      }
    }

    const uniqueAsins = [...new Set(cleanAsins)];
    if (uniqueAsins.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 different ASINs.' });
    }

    const results = [];
    for (const asinItem of uniqueAsins) {
      // Check for recent analysis (last 7 days)
      const existing = await db.query(
        `SELECT * FROM analyses WHERE UPPER(asin) = $1 AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC LIMIT 1`,
        [asinItem]
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        results.push({
          asin: asinItem,
          product: {
            title: row.product_title, brand: row.brand, price: row.price,
            rating: row.rating, reviewCount: row.review_count, bsr: row.bsr,
            category: row.category, imageCount: row.image_count,
            bulletCount: row.bullet_count, hasAPlus: row.has_aplus,
            hasVideo: row.has_video, qaCount: row.qa_count,
          },
          scores: row.scores || {},
          overall: row.overall_score,
          grade: row.overall_grade,
          reportId: row.id,
          cached: true,
        });
      } else {
        try {
          const product = await scrapeAmazon(asinItem);
          const { scores, overall, grade } = scoreProduct(product);
          results.push({
            asin: asinItem,
            product: {
              title: product.title, brand: product.brand, price: product.price,
              rating: product.rating, reviewCount: product.reviewCount, bsr: product.bsr,
              category: product.category, imageCount: product.imageCount,
              bulletCount: product.bulletCount, hasAPlus: product.hasAPlus,
              hasVideo: product.hasVideo, qaCount: product.qaCount,
            },
            scores, overall, grade,
            reportId: null,
            cached: false,
          });
        } catch (scrapeErr) {
          results.push({ asin: asinItem, error: `Failed to analyze ${asinItem}: ${scrapeErr.message}` });
        }
      }
    }

    const valid = results.filter(r => !r.error);
    let winner = null;
    if (valid.length >= 2) {
      winner = valid.reduce((best, r) => r.overall > best.overall ? r : best, valid[0]);
    }

    const categories = [
      'title', 'images', 'bullet_points', 'a_plus', 'reviews',
      'price_competitiveness', 'keyword_optimization', 'brand_story',
      'inventory_status', 'listing_completeness', 'competitive_position', 'conversion_elements',
    ];

    const categoryWinners = {};
    categories.forEach(cat => {
      let best = null;
      let bestScore = -1;
      valid.forEach(r => {
        const val = r.scores?.[cat] || 0;
        if (val > bestScore) { bestScore = val; best = r.asin; }
      });
      categoryWinners[cat] = best;
    });

    res.json({
      comparison: results,
      winner: winner ? { asin: winner.asin, score: winner.overall, grade: winner.grade } : null,
      categoryWinners,
    });

  } catch (err) {
    console.error('[COMPARE_ERROR]', err.message);
    res.status(500).json({ error: 'Comparison failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/score-history/:asin — Score tracking over time
// ══════════════════════════════════════════════════════════════
router.get('/score-history/:asin', async (req, res) => {
  try {
    const asin = (req.params.asin || '').trim().toUpperCase();
    if (!asin || !/^B0[A-Z0-9]{8}$/i.test(asin)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    const result = await db.query(
      `SELECT id, overall_score, overall_grade, scores, created_at
       FROM analyses WHERE UPPER(asin) = $1
       ORDER BY created_at ASC LIMIT 50`,
      [asin]
    );

    const history = result.rows.map(r => ({
      id: r.id,
      score: r.overall_score,
      grade: r.overall_grade,
      scores: r.scores || {},
      date: r.created_at,
    }));

    let delta = null;
    if (history.length >= 2) {
      const first = history[0].score;
      const last = history[history.length - 1].score;
      delta = { from: first, to: last, change: last - first };
    }

    res.json({ asin, history, delta, totalScans: history.length });
  } catch (err) {
    console.error('[HISTORY_ERROR]', err.message);
    res.status(500).json({ error: 'Failed to load score history.' });
  }
});

// ══════════════════════════════════════════════════════════════
// Utility routes
// ══════════════════════════════════════════════════════════════

// POST /api/subscribe
router.post('/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    await db.query(
      `INSERT INTO subscribers (email, source) VALUES ($1, 'newsletter') ON CONFLICT (email) DO UPDATE SET active = true`,
      [email.trim().toLowerCase()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Subscription failed' });
  }
});

// GET /api/stats
router.get('/stats', async (req, res) => {
  try {
    const analyses = await db.query('SELECT COUNT(*) as count FROM analyses');
    const subscribers = await db.query('SELECT COUNT(*) as count FROM subscribers WHERE active = true');
    res.json({
      totalAnalyses: parseInt(analyses.rows[0].count, 10),
      totalSubscribers: parseInt(subscribers.rows[0].count, 10),
    });
  } catch (err) {
    res.json({ totalAnalyses: 0, totalSubscribers: 0 });
  }
});

// GET /api/health
router.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'healthy', db: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'disconnected', error: err.message });
  }
});

// GET /api/check-oto
router.get('/check-oto', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.json({ showOTO: false });
    const result = await db.query('SELECT id FROM oto_shown WHERE LOWER(email) = $1', [email.trim().toLowerCase()]);
    res.json({ showOTO: result.rows.length === 0 });
  } catch (err) {
    res.json({ showOTO: false });
  }
});

// POST /api/mark-oto-shown
router.post('/mark-oto-shown', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ success: false });
    await db.query(
      'INSERT INTO oto_shown (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email.trim().toLowerCase()]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

module.exports = router;
