// ============================================================
// routes/customer.js — Customer-Facing Dashboard & Account Routes
// Extracted from server.js (lines 1698-1920)
// Includes: dashboard, history, saved ASINs, account update
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { requireAuth } = require('../lib/middleware');

// ══════════════════════════════════════════════════════════════
// GET /api/dashboard — User profile + recent reports
// ══════════════════════════════════════════════════════════════
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    // Get or create user profile
    let profile = await db.query('SELECT * FROM user_profiles WHERE id = $1', [req.user.id]);

    if (profile.rows.length === 0) {
      // Auto-create profile for OAuth/magic-link users
      await db.query(
        `INSERT INTO user_profiles (id, email, subscription_tier, subscription_status)
         VALUES ($1, $2, 'free', 'inactive') ON CONFLICT (id) DO NOTHING`,
        [req.user.id, req.user.email]
      );
      profile = await db.query('SELECT * FROM user_profiles WHERE id = $1', [req.user.id]);
    }

    const user = profile.rows[0];

    // Check if monthly quota needs reset
    if (user.analyses_month_reset && new Date(user.analyses_month_reset) <= new Date()) {
      await db.query(
        `UPDATE user_profiles SET analyses_this_month = 0,
         analyses_month_reset = date_trunc('month', NOW()) + interval '1 month'
         WHERE id = $1`,
        [req.user.id]
      );
      user.analyses_this_month = 0;
    }

    // Get recent reports for this user
    const reports = await db.query(
      `SELECT id, asin, product_title, brand, price, overall_score, overall_grade, action_items, created_at
       FROM analyses WHERE user_id = $1 OR LOWER(email) = $2
       ORDER BY created_at DESC LIMIT 10`,
      [req.user.id, (req.user.email || '').toLowerCase()]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email || req.user.email,
        name: user.name,
        subscription_tier: user.subscription_tier || 'free',
        subscription_status: user.subscription_status || 'inactive',
        analyses_this_month: user.analyses_this_month || 0,
        analyses_month_reset: user.analyses_month_reset,
      },
      reports: reports.rows,
    });
  } catch (err) {
    console.error('[CUSTOMER_ERROR] Dashboard:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/history — Paginated report history
// ══════════════════════════════════════════════════════════════
router.get('/history', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const totalResult = await db.query(
      'SELECT COUNT(*) as count FROM analyses WHERE user_id = $1 OR LOWER(email) = $2',
      [req.user.id, (req.user.email || '').toLowerCase()]
    );
    const total = parseInt(totalResult.rows[0].count, 10);

    const reports = await db.query(
      `SELECT id, asin, product_title, brand, price, rating, review_count, bsr, category,
              overall_score, overall_grade, action_items, created_at
       FROM analyses WHERE user_id = $1 OR LOWER(email) = $2
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, (req.user.email || '').toLowerCase(), limit, offset]
    );

    res.json({ reports: reports.rows, total, page, limit });
  } catch (err) {
    console.error('[CUSTOMER_ERROR] History:', err.message);
    res.status(500).json({ error: 'Failed to load history.' });
  }
});

// ══════════════════════════════════════════════════════════════
// SAVED ASINS — Multi-ASIN dashboard (Sprint 3)
// ══════════════════════════════════════════════════════════════

// GET /api/saved-asins — List saved ASINs with latest scores
router.get('/saved-asins', requireAuth, async (req, res) => {
  try {
    const saved = await db.query(
      'SELECT id, asin, nickname, created_at FROM saved_asins WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.id]
    );

    if (saved.rows.length === 0) {
      return res.json({ asins: [] });
    }

    const asins = await Promise.all(saved.rows.map(async (sa) => {
      // Latest analysis
      const latest = await db.query(
        `SELECT id, overall_score, overall_grade, scores, product_title, brand, price, rating, review_count, bsr, category, created_at
         FROM analyses WHERE UPPER(asin) = $1 ORDER BY created_at DESC LIMIT 1`,
        [sa.asin.toUpperCase()]
      );

      // Score history (last 10 for sparkline)
      const history = await db.query(
        `SELECT overall_score, created_at FROM analyses WHERE UPPER(asin) = $1 ORDER BY created_at DESC LIMIT 10`,
        [sa.asin.toUpperCase()]
      );

      const latestRow = latest.rows[0] || null;
      const sparkline = history.rows.reverse().map(h => h.overall_score);

      let delta = null;
      if (sparkline.length >= 2) {
        delta = sparkline[sparkline.length - 1] - sparkline[sparkline.length - 2];
      }

      return {
        id: sa.id,
        asin: sa.asin,
        nickname: sa.nickname,
        savedAt: sa.created_at,
        latest: latestRow ? {
          reportId: latestRow.id,
          score: latestRow.overall_score,
          grade: latestRow.overall_grade,
          scores: latestRow.scores,
          title: latestRow.product_title,
          brand: latestRow.brand,
          price: parseFloat(latestRow.price || 0),
          rating: parseFloat(latestRow.rating || 0),
          reviewCount: latestRow.review_count,
          bsr: latestRow.bsr,
          category: latestRow.category,
          date: latestRow.created_at,
        } : null,
        sparkline,
        delta,
        totalScans: sparkline.length,
      };
    }));

    res.json({ asins });
  } catch (err) {
    console.error('[CUSTOMER_ERROR] Saved ASINs:', err.message);
    res.status(500).json({ error: 'Failed to load saved ASINs.' });
  }
});

// POST /api/saved-asins — Save an ASIN to track
router.post('/saved-asins', requireAuth, async (req, res) => {
  try {
    const { asin, nickname } = req.body;
    const cleanASIN = (asin || '').trim().toUpperCase();

    if (!cleanASIN || !/^B0[A-Z0-9]{8}$/i.test(cleanASIN)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    // Check limit (max 20 saved ASINs per user)
    const countResult = await db.query('SELECT COUNT(*) as count FROM saved_asins WHERE user_id = $1', [req.user.id]);
    if (parseInt(countResult.rows[0].count, 10) >= 20) {
      return res.status(400).json({ error: 'Maximum 20 saved ASINs. Remove one to add another.' });
    }

    const result = await db.query(
      `INSERT INTO saved_asins (user_id, asin, nickname) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, asin) DO UPDATE SET nickname = COALESCE($3, saved_asins.nickname)
       RETURNING *`,
      [req.user.id, cleanASIN, nickname || null]
    );

    res.json({ saved: result.rows[0] });
  } catch (err) {
    console.error('[CUSTOMER_ERROR] Save ASIN:', err.message);
    res.status(500).json({ error: 'Failed to save ASIN.' });
  }
});

// DELETE /api/saved-asins/:asin — Remove a saved ASIN
router.delete('/saved-asins/:asin', requireAuth, async (req, res) => {
  try {
    const asin = (req.params.asin || '').trim().toUpperCase();
    await db.query('DELETE FROM saved_asins WHERE user_id = $1 AND UPPER(asin) = $2', [req.user.id, asin]);
    res.json({ success: true });
  } catch (err) {
    console.error('[CUSTOMER_ERROR] Delete ASIN:', err.message);
    res.status(500).json({ error: 'Failed to remove ASIN.' });
  }
});

// PATCH /api/saved-asins/:asin — Update nickname
router.patch('/saved-asins/:asin', requireAuth, async (req, res) => {
  try {
    const asin = (req.params.asin || '').trim().toUpperCase();
    const { nickname } = req.body;
    await db.query(
      'UPDATE saved_asins SET nickname = $1 WHERE user_id = $2 AND UPPER(asin) = $3',
      [nickname || null, req.user.id, asin]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ASIN.' });
  }
});

// POST /api/account/update — Update user profile
router.post('/account/update', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    await db.query('UPDATE user_profiles SET name = $1 WHERE id = $2', [name || null, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

module.exports = router;
