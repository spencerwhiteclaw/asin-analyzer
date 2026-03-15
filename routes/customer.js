const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/middleware');

const router = express.Router();

// Tier limits configuration
const TIER_LIMITS = {
  free: { reports: 3, saved_asins: 0, price_monthly: 0 },
  seller: { reports: 15, saved_asins: 5, price_monthly: 19 },
  agency: { reports: 50, saved_asins: 25, price_monthly: 49 },
  agency_power: { reports: 50, saved_asins: 25, price_monthly: 39 },
  enterprise: { reports: 999, saved_asins: 999, price_monthly: 199 },
};

// Initialize Stripe if secret key exists
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// ============================================================================
// EXISTING ENDPOINTS (Sprint 6 and earlier)
// ============================================================================

/**
 * GET /dashboard
 * User profile + recent reports
 */
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user profile
    const userResult = await db.query(
      'SELECT id, email, name, tier, created_at FROM user_profiles WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Get recent reports (last 10)
    const reportsResult = await db.query(
      `SELECT id, asin, product_title, overall_score, overall_grade, created_at
       FROM reports
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    res.json({
      profile: user,
      recent_reports: reportsResult.rows,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

/**
 * GET /history
 * Paginated report history
 */
router.get('/history', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await db.query(
      'SELECT COUNT(*) as total FROM reports WHERE user_id = $1',
      [userId]
    );
    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / limit);

    // Get paginated reports
    const reportsResult = await db.query(
      `SELECT id, asin, product_title, overall_score, overall_grade, created_at
       FROM reports
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json({
      reports: reportsResult.rows,
      pagination: {
        page,
        limit,
        total_count: totalCount,
        total_pages: totalPages,
      },
    });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/**
 * GET /saved-asins
 * List saved ASINs with latest scores
 */
router.get('/saved-asins', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT sa.asin, sa.nickname, r.overall_score, r.overall_grade, r.created_at as last_analyzed_at
       FROM saved_asins sa
       LEFT JOIN LATERAL (
         SELECT overall_score, overall_grade, created_at
         FROM reports
         WHERE user_id = sa.user_id AND asin = sa.asin
         ORDER BY created_at DESC
         LIMIT 1
       ) r ON TRUE
       WHERE sa.user_id = $1
       ORDER BY sa.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Saved ASINs error:', error);
    res.status(500).json({ error: 'Failed to fetch saved ASINs' });
  }
});

/**
 * POST /saved-asins
 * Save an ASIN
 */
router.post('/saved-asins', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { asin, nickname } = req.body;

    if (!asin) {
      return res.status(400).json({ error: 'ASIN is required' });
    }

    const result = await db.query(
      `INSERT INTO saved_asins (user_id, asin, nickname, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING asin, nickname, created_at`,
      [userId, asin, nickname || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      // Unique constraint violation
      return res.status(409).json({ error: 'ASIN already saved' });
    }
    console.error('Save ASIN error:', error);
    res.status(500).json({ error: 'Failed to save ASIN' });
  }
});

/**
 * DELETE /saved-asins/:asin
 * Remove saved ASIN
 */
router.delete('/saved-asins/:asin', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { asin } = req.params;

    const result = await db.query(
      'DELETE FROM saved_asins WHERE user_id = $1 AND asin = $2 RETURNING asin',
      [userId, asin]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saved ASIN not found' });
    }

    res.json({ message: 'ASIN removed from saved list' });
  } catch (error) {
    console.error('Delete ASIN error:', error);
    res.status(500).json({ error: 'Failed to delete ASIN' });
  }
});

/**
 * PATCH /saved-asins/:asin
 * Update nickname
 */
router.patch('/saved-asins/:asin', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { asin } = req.params;
    const { nickname } = req.body;

    const result = await db.query(
      `UPDATE saved_asins
       SET nickname = $1
       WHERE user_id = $2 AND asin = $3
       RETURNING asin, nickname`,
      [nickname || null, userId, asin]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saved ASIN not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update ASIN error:', error);
    res.status(500).json({ error: 'Failed to update ASIN' });
  }
});

/**
 * POST /account/update
 * Update user profile
 */
router.post('/account/update', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const result = await db.query(
      'UPDATE user_profiles SET name = $1 WHERE id = $2 RETURNING id, email, name, tier, created_at',
      [name, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Account update error:', error);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

// ============================================================================
// NEW SPRINT 7A ENDPOINTS
// ============================================================================

/**
 * GET /my-account
 * Complete account info with quota and subscription details
 */
router.get('/my-account', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user profile
    const userResult = await db.query(
      `SELECT id, email, name, tier, subscription_status, stripe_subscription_id, created_at
       FROM user_profiles
       WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const tier = user.tier || 'free';
    const tierConfig = TIER_LIMITS[tier] || TIER_LIMITS.free;

    // Get analyses this month count
    const analysesResult = await db.query(
      `SELECT COUNT(*) as count FROM reports
       WHERE user_id = $1
       AND created_at >= DATE_TRUNC('month', NOW())`,
      [userId]
    );
    const analysesThisMonth = parseInt(analysesResult.rows[0].count);

    // Get bonus reports (if applicable)
    const bonusResult = await db.query(
      'SELECT COALESCE(SUM(bonus_reports), 0) as total_bonus FROM user_bonuses WHERE user_id = $1 AND expires_at > NOW()',
      [userId]
    );
    const bonusReports = parseInt(bonusResult.rows[0].total_bonus) || 0;

    // Get saved ASIN count
    const savedAsinsResult = await db.query(
      'SELECT COUNT(*) as count FROM saved_asins WHERE user_id = $1',
      [userId]
    );
    const savedAsinCount = parseInt(savedAsinsResult.rows[0].count);

    // Get lifetime reports count
    const lifetimeResult = await db.query(
      'SELECT COUNT(*) as count FROM reports WHERE user_id = $1',
      [userId]
    );
    const lifetimeReports = parseInt(lifetimeResult.rows[0].count);

    const reportsLimit = tierConfig.reports;
    const reportsRemaining = (reportsLimit + bonusReports) - analysesThisMonth;
    const analyseMonthReset = new Date();
    analyseMonthReset.setMonth(analyseMonthReset.getMonth() + 1);
    analyseMonthReset.setDate(1);
    analyseMonthReset.setHours(0, 0, 0, 0);

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      tier,
      subscription_status: user.subscription_status,
      stripe_subscription_id: user.stripe_subscription_id,
      reports_used: analysesThisMonth,
      reports_limit: reportsLimit,
      bonus_reports: bonusReports,
      reports_remaining: Math.max(0, reportsRemaining),
      billing_cycle_end: analyseMonthReset.toISOString(),
      member_since: user.created_at,
      lifetime_reports: lifetimeReports,
      saved_asin_count: savedAsinCount,
      next_billing_amount: tierConfig.price_monthly,
    });
  } catch (error) {
    console.error('My account error:', error);
    res.status(500).json({ error: 'Failed to fetch account information' });
  }
});

/**
 * GET /my-reports
 * Paginated, searchable report archive
 */
router.get('/my-reports', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const sort = req.query.sort || 'date_desc';
    const search = req.query.search || '';

    const offset = (page - 1) * limit;

    // Build sort clause
    let sortClause = 'r.created_at DESC';
    switch (sort) {
      case 'date_asc':
        sortClause = 'r.created_at ASC';
        break;
      case 'score_desc':
        sortClause = 'r.overall_score DESC';
        break;
      case 'score_asc':
        sortClause = 'r.overall_score ASC';
        break;
      case 'date_desc':
      default:
        sortClause = 'r.created_at DESC';
    }

    // Build search condition
    let searchCondition = '';
    let searchParams = [userId];
    if (search) {
      searchCondition = 'AND (r.asin ILIKE $2 OR r.product_title ILIKE $2)';
      searchParams.push(`%${search}%`);
    }

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total FROM reports r
      WHERE r.user_id = $1 ${searchCondition}
    `;
    const countResult = await db.query(countQuery, searchParams);
    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / limit);

    // Get paginated reports with scores JSONB
    const offsetParam = search ? 3 : 2;
    const reportsQuery = `
      SELECT
        r.id,
        r.asin,
        r.product_title,
        r.overall_score,
        r.overall_grade,
        jsonb_object_agg(
          s.category,
          jsonb_build_object('score', s.score, 'grade', s.grade)
        ) as scores,
        (r.implementation_plan IS NOT NULL) as has_plan,
        r.created_at
      FROM reports r
      LEFT JOIN scores s ON r.id = s.report_id
      WHERE r.user_id = $1 ${searchCondition}
      GROUP BY r.id, r.asin, r.product_title, r.overall_score, r.overall_grade, r.implementation_plan, r.created_at
      ORDER BY ${sortClause}
      LIMIT $${offsetParam} OFFSET ${offsetParam === 3 ? '$4' : '$3'}
    `;

    const queryParams = [...searchParams];
    queryParams.push(limit);
    if (search) {
      queryParams.push(offset);
    } else {
      queryParams.push(offset);
    }

    const reportsResult = await db.query(reportsQuery, queryParams);

    res.json({
      reports: reportsResult.rows,
      pagination: {
        page,
        limit,
        total_count: totalCount,
        total_pages: totalPages,
      },
    });
  } catch (error) {
    console.error('My reports error:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

/**
 * GET /my-reports/:id/compare/:compareId
 * Compare two reports
 */
router.get('/my-reports/:id/compare/:compareId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id: reportIdA, compareId: reportIdB } = req.params;

    // Get first report and verify ownership
    const reportAResult = await db.query(
      'SELECT * FROM reports WHERE id = $1 AND user_id = $2',
      [reportIdA, userId]
    );

    if (reportAResult.rows.length === 0) {
      return res.status(404).json({ error: 'Report A not found or access denied' });
    }

    const reportA = reportAResult.rows[0];

    // Get second report and verify ownership
    const reportBResult = await db.query(
      'SELECT * FROM reports WHERE id = $1 AND user_id = $2',
      [reportIdB, userId]
    );

    if (reportBResult.rows.length === 0) {
      return res.status(404).json({ error: 'Report B not found or access denied' });
    }

    const reportB = reportBResult.rows[0];

    // Get scores for both reports
    const scoresAResult = await db.query(
      'SELECT category, score FROM scores WHERE report_id = $1',
      [reportIdA]
    );

    const scoresBResult = await db.query(
      'SELECT category, score FROM scores WHERE report_id = $1',
      [reportIdB]
    );

    // Build score maps
    const scoresA = {};
    const scoresB = {};

    scoresAResult.rows.forEach(row => {
      scoresA[row.category] = row.score;
    });

    scoresBResult.rows.forEach(row => {
      scoresB[row.category] = row.score;
    });

    // Calculate deltas
    const deltas = {};
    const allCategories = new Set([...Object.keys(scoresA), ...Object.keys(scoresB)]);

    allCategories.forEach(category => {
      const scoreAVal = scoresA[category] || 0;
      const scoreBVal = scoresB[category] || 0;
      deltas[category] = scoreBVal - scoreAVal;
    });

    const overallDelta = (reportB.overall_score || 0) - (reportA.overall_score || 0);

    res.json({
      report_a: reportA,
      report_b: reportB,
      deltas,
      overall_delta: overallDelta,
    });
  } catch (error) {
    console.error('Compare reports error:', error);
    res.status(500).json({ error: 'Failed to compare reports' });
  }
});

/**
 * GET /my-quota
 * Quick quota check
 */
router.get('/my-quota', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user tier
    const userResult = await db.query(
      'SELECT tier FROM user_profiles WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const tier = userResult.rows[0].tier || 'free';
    const tierConfig = TIER_LIMITS[tier] || TIER_LIMITS.free;

    // Get analyses this month count
    const analysesResult = await db.query(
      `SELECT COUNT(*) as count FROM reports
       WHERE user_id = $1
       AND created_at >= DATE_TRUNC('month', NOW())`,
      [userId]
    );
    const used = parseInt(analysesResult.rows[0].count);

    // Get bonus reports
    const bonusResult = await db.query(
      'SELECT COALESCE(SUM(bonus_reports), 0) as total_bonus FROM user_bonuses WHERE user_id = $1 AND expires_at > NOW()',
      [userId]
    );
    const bonus = parseInt(bonusResult.rows[0].total_bonus) || 0;

    const limit = tierConfig.reports;
    const remaining = (limit + bonus) - used;
    const percentageUsed = limit + bonus > 0 ? (used / (limit + bonus)) * 100 : 0;

    // Calculate reset date
    const resetsAt = new Date();
    resetsAt.setMonth(resetsAt.getMonth() + 1);
    resetsAt.setDate(1);
    resetsAt.setHours(0, 0, 0, 0);

    res.json({
      used,
      limit,
      bonus,
      remaining: Math.max(0, remaining),
      resets_at: resetsAt.toISOString(),
      percentage_used: Math.round(percentageUsed * 100) / 100,
    });
  } catch (error) {
    console.error('My quota error:', error);
    res.status(500).json({ error: 'Failed to fetch quota information' });
  }
});

/**
 * GET /my-saved-asins
 * Enhanced saved ASINs list
 */
router.get('/my-saved-asins', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT
        sa.asin,
        sa.nickname,
        r.overall_score as latest_score,
        r.overall_grade as latest_grade,
        r.created_at as last_analyzed_at,
        COUNT(rr.id) as total_analyses,
        0 as keyword_count
       FROM saved_asins sa
       LEFT JOIN LATERAL (
         SELECT overall_score, overall_grade, created_at
         FROM reports
         WHERE user_id = sa.user_id AND asin = sa.asin
         ORDER BY created_at DESC
         LIMIT 1
       ) r ON TRUE
       LEFT JOIN LATERAL (
         SELECT id FROM reports rr
         WHERE user_id = sa.user_id AND asin = sa.asin
       ) rr ON TRUE
       WHERE sa.user_id = $1
       GROUP BY sa.asin, sa.nickname, r.overall_score, r.overall_grade, r.created_at
       ORDER BY sa.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('My saved ASINs error:', error);
    res.status(500).json({ error: 'Failed to fetch saved ASINs' });
  }
});

/**
 * POST /create-portal-session
 * Create Stripe Customer Portal session
 */
router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe is not configured' });
    }

    const userId = req.user.id;

    // Get user's Stripe customer ID
    const userResult = await db.query(
      'SELECT stripe_customer_id FROM user_profiles WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const stripeCustomerId = userResult.rows[0].stripe_customer_id;

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe customer ID found for this account' });
    }

    // Create Stripe billing portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: 'https://asinanalyzer.app/dashboard',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Create portal session error:', error);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

module.exports = router;
