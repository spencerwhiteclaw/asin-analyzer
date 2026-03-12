const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { requireAuth, requireAdmin, ownerOnly } = require('../lib/middleware');
const { getMrrForPrice, calculateMrrDelta } = require('../lib/mrr');
const { syncRewardful } = require('../lib/cron');

// Initialize Stripe if API key is available
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// Price ID to tier mapping for plan changes
const TIER_PRICE_MAP = {
  seller_monthly: process.env.STRIPE_PRICE_ID_SELLER_MONTHLY,
  seller_annual: process.env.STRIPE_PRICE_ID_SELLER_ANNUAL,
  agency_monthly: process.env.STRIPE_PRICE_ID_AGENCY_MONTHLY,
  agency_annual: process.env.STRIPE_PRICE_ID_AGENCY_ANNUAL,
  enterprise_monthly: process.env.STRIPE_PRICE_ID_ENTERPRISE_MONTHLY,
  enterprise_annual: process.env.STRIPE_PRICE_ID_ENTERPRISE_ANNUAL,
};

// Tier to MRR mapping for dashboard
const TIER_MRR_MAP = {
  seller_monthly: 19.00,
  seller_annual: 12.42,
  agency_monthly: 49.00,
  agency_annual: 37.42,
  enterprise_monthly: 199.00,
  enterprise_annual: 158.25,
};

// ============================================================================
// 1. GET /health - Simple health check
// ============================================================================
router.get('/health', (req, res) => {
  return res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================

// GET /check-access - Simple auth check for sub-pages
router.get('/check-access', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, role: req.adminRole });
});

// GET /user - Return current admin user info
router.get('/user', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.adminRole,
      permissions: req.adminPermissions,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get user info' });
  }
});

// 2. GET /dashboard - Main dashboard metrics
// ============================================================================
router.get('/dashboard', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Total users
    const totalUsersResult = await db.query('SELECT COUNT(*) as count FROM user_profiles');
    const totalUsers = parseInt(totalUsersResult.rows[0]?.count) || 0;

    // Total subscribers (email captures)
    const totalSubscribersResult = await db.query('SELECT COUNT(*) as count FROM subscribers');
    const totalSubscribers = parseInt(totalSubscribersResult.rows[0]?.count) || 0;

    // Get today's date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    // Daily revenue today
    const dailyRevenueResult = await db.query(
      'SELECT COALESCE(SUM(daily_revenue), 0) as total FROM business_metrics_daily WHERE date = $1',
      [todayStr]
    );
    const dailyRevenueToday = parseFloat(dailyRevenueResult.rows[0]?.total) || 0;

    // Reports generated today
    const reportsResult = await db.query(
      'SELECT COUNT(*) as count FROM analyses WHERE DATE(created_at) = $1',
      [todayStr]
    );
    const reportsToday = parseInt(reportsResult.rows[0]?.count) || 0;

    // MRR from all subscription_events with active status (sum of MRR for each user)
    const mrrResult = await db.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN subscription_tier = 'seller_monthly' THEN 19.00
           WHEN subscription_tier = 'seller_annual' THEN 12.42
           WHEN subscription_tier = 'agency_monthly' THEN 49.00
           WHEN subscription_tier = 'agency_annual' THEN 37.42
           WHEN subscription_tier = 'enterprise_monthly' THEN 199.00
           WHEN subscription_tier = 'enterprise_annual' THEN 158.25
           ELSE 0
         END
       ), 0) as mrr
       FROM user_profiles
       WHERE subscription_status = 'active'`
    );
    const mrr = parseFloat(mrrResult.rows[0]?.mrr) || 0;

    // Calculate ARR
    const arr = mrr * 12;

    // Subscribers by tier (count from user_profiles)
    const tierCounts = await db.query(
      `SELECT subscription_tier, COUNT(*) as count
       FROM user_profiles
       WHERE subscription_status = 'active'
       GROUP BY subscription_tier`
    );
    const subscribersByTier = {
      seller_monthly: 0,
      seller_annual: 0,
      agency_monthly: 0,
      agency_annual: 0,
      enterprise_monthly: 0,
      enterprise_annual: 0,
    };
    tierCounts.rows.forEach(row => {
      if (row.subscription_tier && subscribersByTier.hasOwnProperty(row.subscription_tier)) {
        subscribersByTier[row.subscription_tier] = parseInt(row.count) || 0;
      }
    });

    // MRR components from today's subscription_events
    const mrrComponentsResult = await db.query(
      `SELECT
        COALESCE(SUM(CASE WHEN event_type = 'new_subscription' THEN mrr_delta ELSE 0 END), 0) as new_mrr,
        COALESCE(SUM(CASE WHEN event_type = 'upgrade' THEN mrr_delta ELSE 0 END), 0) as expansion_mrr,
        COALESCE(SUM(CASE WHEN event_type = 'downgrade' THEN mrr_delta ELSE 0 END), 0) as contraction_mrr,
        COALESCE(SUM(CASE WHEN event_type = 'cancellation' THEN mrr_delta ELSE 0 END), 0) as churned_mrr
       FROM subscription_events
       WHERE DATE(created_at) = $1`,
      [todayStr]
    );
    const mrrComponents = {
      new_mrr: parseFloat(mrrComponentsResult.rows[0]?.new_mrr) || 0,
      expansion_mrr: parseFloat(mrrComponentsResult.rows[0]?.expansion_mrr) || 0,
      contraction_mrr: parseFloat(mrrComponentsResult.rows[0]?.contraction_mrr) || 0,
      churned_mrr: parseFloat(mrrComponentsResult.rows[0]?.churned_mrr) || 0,
    };

    // Funnel today
    const emailCapturesResult = await db.query(
      'SELECT COUNT(*) as count FROM subscribers WHERE DATE(subscribed_at) = $1',
      [todayStr]
    );
    const emailCaptures = parseInt(emailCapturesResult.rows[0]?.count) || 0;

    const purchasesResult = await db.query(
      'SELECT COUNT(*) as count FROM purchases WHERE DATE(created_at) = $1',
      [todayStr]
    );
    const purchasesToday = parseInt(purchasesResult.rows[0]?.count) || 0;

    const newSubsResult = await db.query(
      `SELECT COUNT(*) as count FROM subscription_events
       WHERE event_type = 'new_subscription' AND DATE(created_at) = $1`,
      [todayStr]
    );
    const newSubscriptions = parseInt(newSubsResult.rows[0]?.count) || 0;

    const funnel = {
      email_captures: emailCaptures,
      tripwire_downsell: purchasesToday,
      new_subscriptions: newSubscriptions,
    };

    // Trend data - last 90 days from business_metrics_daily
    const trendStart = new Date();
    trendStart.setDate(trendStart.getDate() - 89);
    trendStart.setHours(0, 0, 0, 0);
    const trendStartStr = trendStart.toISOString().split('T')[0];

    const trendResult = await db.query(
      `SELECT date, mrr, daily_revenue, new_subscriptions, cancellations
       FROM business_metrics_daily
       WHERE date >= $1 AND date <= $2
       ORDER BY date ASC`,
      [trendStartStr, todayStr]
    );
    const trendData = trendResult.rows.map(row => ({
      date: row.date,
      mrr: parseFloat(row.mrr) || 0,
      revenue: parseFloat(row.daily_revenue) || 0,
      new_subs: parseInt(row.new_subscriptions) || 0,
      churn: parseInt(row.cancellations) || 0,
    }));

    // Recent activity - last 25 subscription_events with user email
    const activityResult = await db.query(
      `SELECT se.*, up.email
       FROM subscription_events se
       LEFT JOIN user_profiles up ON se.user_id = up.id
       ORDER BY se.created_at DESC
       LIMIT 25`
    );
    const recentActivity = activityResult.rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      email: row.email,
      event_type: row.event_type,
      subscription_tier: row.subscription_tier,
      mrr_delta: parseFloat(row.mrr_delta) || 0,
      created_at: row.created_at,
    }));

    const overview = {
      total_users: totalUsers,
      total_subscribers: totalSubscribers,
      mrr,
      arr,
      daily_revenue_today: dailyRevenueToday,
      reports_today: reportsToday,
      active_trials: 0, // TODO: calculate from user_profiles if trial_ends_at exists
    };

    return res.json({
      overview,
      subscribers_by_tier: subscribersByTier,
      mrr_components: mrrComponents,
      funnel_today: funnel,
      trend_data: trendData,
      recent_activity: recentActivity,
    });
  } catch (err) {
    console.error('[Admin] dashboard error:', err.message);
    return res.status(500).json({ error: 'Dashboard fetch failed' });
  }
});

// ============================================================================
// 3. GET /mrr-waterfall - MRR waterfall data
// ============================================================================
router.get('/mrr-waterfall', requireAuth, requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '12m';
    let monthsBack = 12;

    if (period === '30d') monthsBack = 1;
    else if (period === '90d') monthsBack = 3;
    else if (period === '6m') monthsBack = 6;
    else if (period === 'all') monthsBack = 120; // 10 years

    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - monthsBack);
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);
    const startStr = startDate.toISOString().split('T')[0];

    // Get all subscription events for the period, ordered by month
    const eventsResult = await db.query(
      `SELECT
        DATE_TRUNC('month', created_at)::DATE as month,
        event_type,
        SUM(mrr_delta) as total_mrr_delta
       FROM subscription_events
       WHERE created_at >= $1
       GROUP BY DATE_TRUNC('month', created_at), event_type
       ORDER BY month ASC`,
      [startStr]
    );

    // Build waterfall data by month
    const waterfallMap = {};
    eventsResult.rows.forEach(row => {
      const monthStr = row.month.toISOString().split('T')[0];
      if (!waterfallMap[monthStr]) {
        waterfallMap[monthStr] = {
          month: monthStr,
          new_mrr: 0,
          expansion_mrr: 0,
          contraction_mrr: 0,
          churned_mrr: 0,
        };
      }
      const change = parseFloat(row.total_mrr_delta) || 0;
      if (row.event_type === 'new_subscription') waterfallMap[monthStr].new_mrr += change;
      else if (row.event_type === 'upgrade') waterfallMap[monthStr].expansion_mrr += change;
      else if (row.event_type === 'downgrade') waterfallMap[monthStr].contraction_mrr += change;
      else if (row.event_type === 'cancellation') waterfallMap[monthStr].churned_mrr += change;
    });

    // Calculate starting and ending MRR for each month
    const monthlyData = Object.keys(waterfallMap).sort().map((monthStr, idx, allMonths) => {
      const monthData = waterfallMap[monthStr];
      let startingMrr = 0;

      // Calculate starting MRR from previous month's ending MRR
      if (idx > 0) {
        const prevMonthStr = allMonths[idx - 1];
        const prevData = waterfallMap[prevMonthStr];
        startingMrr = prevData.starting_mrr + prevData.new_mrr + prevData.expansion_mrr +
                     prevData.contraction_mrr + prevData.churned_mrr;
      } else {
        // For first month, calculate from all subscription_events up to that month
        // (This is a simplified approach)
        startingMrr = 0;
      }

      const netNewMrr = monthData.new_mrr + monthData.expansion_mrr + monthData.contraction_mrr + monthData.churned_mrr;
      const endingMrr = startingMrr + netNewMrr;

      return {
        month: monthStr,
        starting_mrr: startingMrr,
        new_mrr: monthData.new_mrr,
        expansion_mrr: monthData.expansion_mrr,
        contraction_mrr: monthData.contraction_mrr,
        churned_mrr: monthData.churned_mrr,
        net_new_mrr: netNewMrr,
        ending_mrr: endingMrr,
      };
    });

    return res.json({ period, waterfall: monthlyData });
  } catch (err) {
    console.error('[Admin] mrr-waterfall error:', err.message);
    return res.status(500).json({ error: 'MRR waterfall fetch failed' });
  }
});

// ============================================================================
// 4. GET /cohort-retention - Monthly cohort retention grid
// ============================================================================
router.get('/cohort-retention', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Get all users with their first_paid_at cohort
    const cohortsResult = await db.query(
      `SELECT
        DATE_TRUNC('month', first_paid_at)::DATE as cohort_month,
        id,
        first_paid_at
       FROM user_profiles
       WHERE first_paid_at IS NOT NULL
       ORDER BY cohort_month ASC`
    );

    // Group users by cohort month
    const cohortMap = {};
    cohortsResult.rows.forEach(row => {
      const cohortStr = row.cohort_month.toISOString().split('T')[0];
      if (!cohortMap[cohortStr]) {
        cohortMap[cohortStr] = [];
      }
      cohortMap[cohortStr].push(row.id);
    });

    // For each cohort, calculate retention at each month milestone
    const cohortRetention = {};

    for (const [cohortStr, userIds] of Object.entries(cohortMap)) {
      if (userIds.length === 0) continue;

      const cohortDate = new Date(cohortStr);
      const totalUsersInCohort = userIds.length;
      cohortRetention[cohortStr] = {};

      // Check retention at each month (0, 1, 2, 3, etc.)
      for (let monthsAgo = 0; monthsAgo <= 12; monthsAgo++) {
        const checkDate = new Date(cohortDate);
        checkDate.setMonth(checkDate.getMonth() + monthsAgo);
        const checkStr = checkDate.toISOString().split('T')[0];

        // Count how many users from this cohort are still active at this date
        const retentionResult = await db.query(
          `SELECT COUNT(*) as count FROM user_profiles
           WHERE id = ANY($1) AND subscription_status = 'active'
           AND first_paid_at <= $2`,
          [userIds, checkStr]
        );

        const retainedCount = parseInt(retentionResult.rows[0]?.count) || 0;
        const retentionRate = totalUsersInCohort > 0 ? (retainedCount / totalUsersInCohort) * 100 : 0;
        cohortRetention[cohortStr][monthsAgo] = Math.round(retentionRate);
      }
    }

    // Convert to 2D array format
    const cohorts = Object.keys(cohortRetention).sort();
    const maxMonths = 13;
    const retentionGrid = cohorts.map(cohortStr => {
      const row = [cohortStr];
      for (let m = 0; m < maxMonths; m++) {
        row.push(cohortRetention[cohortStr][m] || 0);
      }
      return row;
    });

    return res.json({
      cohorts,
      monthLabels: Array.from({ length: maxMonths }, (_, i) => `M${i}`),
      grid: retentionGrid,
    });
  } catch (err) {
    console.error('[Admin] cohort-retention error:', err.message);
    return res.status(500).json({ error: 'Cohort retention fetch failed' });
  }
});

// ============================================================================
// 5. GET /financial-summary - Monthly P&L
// ============================================================================
router.get('/financial-summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Only manager and owner can view financials
    if (req.adminRole === 'viewer') {
      return res.status(403).json({ error: 'Insufficient permissions to view financial data' });
    }

    const months = parseInt(req.query.months) || 12;

    const result = await db.query(
      `SELECT *
       FROM financial_summaries_monthly
       ORDER BY month DESC
       LIMIT $1`,
      [months]
    );

    const summaries = result.rows.map(row => ({
      month: row.month,
      gross_revenue: parseFloat(row.gross_revenue) || 0,
      refunds: parseFloat(row.refunds) || 0,
      net_revenue: parseFloat(row.net_revenue) || 0,
      cost_of_goods: parseFloat(row.cost_of_goods) || 0,
      operating_expenses: parseFloat(row.operating_expenses) || 0,
      net_profit: parseFloat(row.net_profit) || 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return res.json({ months, summaries });
  } catch (err) {
    console.error('[Admin] financial-summary error:', err.message);
    return res.status(500).json({ error: 'Financial summary fetch failed' });
  }
});

// ============================================================================
// 6. GET /customers - Paginated, searchable customer list
// ============================================================================
router.get('/customers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;
    const tier = req.query.tier || null;
    const status = req.query.status || null;
    const channel = req.query.channel || null;
    const sort = req.query.sort || 'last_active_at';

    // Build query dynamically
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (search) {
      whereClause += ` AND (email ILIKE $${params.length + 1} OR name ILIKE $${params.length + 1})`;
      params.push(search);
    }
    if (tier) {
      whereClause += ` AND subscription_tier = $${params.length + 1}`;
      params.push(tier);
    }
    if (status) {
      whereClause += ` AND subscription_status = $${params.length + 1}`;
      params.push(status);
    }
    if (channel) {
      whereClause += ` AND acquisition_channel = $${params.length + 1}`;
      params.push(channel);
    }

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) as count FROM user_profiles ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0]?.count) || 0;
    const totalPages = Math.ceil(totalCount / limit);

    // Get paginated customers
    const sortColumn = ['email', 'first_paid_at', 'last_active_at'].includes(sort) ? sort : 'last_active_at';
    const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';

    const result = await db.query(
      `SELECT
        id as user_id,
        email,
        name,
        subscription_tier,
        subscription_status,
        acquisition_channel,
        referred_by,
        first_paid_at,
        last_active_at,
        bonus_reports
       FROM user_profiles
       ${whereClause}
       ORDER BY ${sortColumn} ${sortDir}
       LIMIT $${params.length + 1}
       OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    // Enrich with calculated fields
    const customers = await Promise.all(result.rows.map(async (row) => {
      // Get analyses count (reports this month)
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);
      const thisMonthStr = thisMonth.toISOString().split('T')[0];

      const analysesResult = await db.query(
        'SELECT COUNT(*) as count FROM analyses WHERE user_id = $1 AND created_at >= $2',
        [row.user_id, thisMonthStr]
      );
      const reportsThisMonth = parseInt(analysesResult.rows[0]?.count) || 0;

      // Get lifetime analyses count
      const lifetimeResult = await db.query(
        'SELECT COUNT(*) as count FROM analyses WHERE user_id = $1',
        [row.user_id]
      );
      const lifetimeReports = parseInt(lifetimeResult.rows[0]?.count) || 0;

      // Calculate MRR from tier
      const tierMrr = TIER_MRR_MAP[row.subscription_tier] || 0;
      const mrr = row.subscription_status === 'active' ? tierMrr : 0;

      return {
        user_id: row.user_id,
        email: row.email,
        name: row.name,
        tier: row.subscription_tier,
        status: row.subscription_status,
        reports_this_month: reportsThisMonth,
        lifetime_reports: lifetimeReports,
        mrr,
        first_paid_at: row.first_paid_at,
        last_active_at: row.last_active_at,
        acquisition_channel: row.acquisition_channel,
        referred_by: row.referred_by,
      };
    }));

    return res.json({
      page,
      limit,
      total_count: totalCount,
      total_pages: totalPages,
      customers,
    });
  } catch (err) {
    console.error('[Admin] customers list error:', err.message);
    return res.status(500).json({ error: 'Customer list fetch failed' });
  }
});

// ============================================================================
// 7. GET /customer/:userId - Full customer detail
// ============================================================================
router.get('/customer/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;

    // Get user profile
    const userResult = await db.query('SELECT * FROM user_profiles WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // Get all analyses (reports)
    const analysesResult = await db.query(
      'SELECT * FROM analyses WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const reports = analysesResult.rows || [];

    // Get saved ASINs
    const asinsResult = await db.query(
      'SELECT * FROM saved_asins WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const savedAsins = asinsResult.rows || [];

    // Get purchases
    const purchasesResult = await db.query(
      'SELECT * FROM purchases WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const purchases = purchasesResult.rows || [];

    // Get credits
    const creditsResult = await db.query(
      'SELECT * FROM customer_credits WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const credits = creditsResult.rows || [];

    // Get subscription events
    const eventsResult = await db.query(
      'SELECT * FROM subscription_events WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const subscriptionEvents = eventsResult.rows || [];

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        subscription_tier: user.subscription_tier,
        subscription_status: user.subscription_status,
        first_paid_at: user.first_paid_at,
        last_active_at: user.last_active_at,
        acquisition_channel: user.acquisition_channel,
        referred_by: user.referred_by,
        bonus_reports: user.bonus_reports,
        notes: user.notes,
        stripe_customer_id: user.stripe_customer_id,
        stripe_subscription_id: user.stripe_subscription_id,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
      reports: reports.slice(0, 50),
      saved_asins: savedAsins,
      purchases: purchases,
      credits: credits,
      subscription_events: subscriptionEvents,
    });
  } catch (err) {
    console.error('[Admin] customer detail error:', err.message);
    return res.status(500).json({ error: 'Customer detail fetch failed' });
  }
});

// ============================================================================
// 8. POST /customer/:userId/credit - Grant credit
// ============================================================================
router.post('/customer/:userId/credit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { credit_type, amount, reason } = req.body;

    if (!credit_type || !amount || !reason) {
      return res.status(400).json({ error: 'Missing required fields: credit_type, amount, reason' });
    }

    // Validate credit_type
    const validTypes = ['bonus_reports', 'free_month', 'billing_extension'];
    if (!validTypes.includes(credit_type)) {
      return res.status(400).json({ error: `Invalid credit_type. Must be one of: ${validTypes.join(', ')}` });
    }

    // If bonus_reports, update user_profiles
    if (credit_type === 'bonus_reports') {
      await db.query(
        'UPDATE user_profiles SET bonus_reports = bonus_reports + $1 WHERE id = $2',
        [parseInt(amount), userId]
      );
    }

    // Insert into customer_credits
    await db.query(
      `INSERT INTO customer_credits (user_id, credit_type, amount, reason, granted_by, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, credit_type, parseInt(amount), reason, req.user.id]
    );

    // Log to admin_activity_log
    await db.query(
      `INSERT INTO admin_activity_log (admin_user_id, target_user_id, action, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [req.user.id, userId, 'granted_credit', JSON.stringify({ credit_type, amount, reason })]
    );

    return res.json({ success: true, message: `${amount} ${credit_type} credited to user` });
  } catch (err) {
    console.error('[Admin] credit error:', err.message);
    return res.status(500).json({ error: 'Failed to grant credit' });
  }
});

// ============================================================================
// 9. POST /customer/:userId/change-tier - Change subscription tier
// ============================================================================
router.post('/customer/:userId/change-tier', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { new_tier, prorate } = req.body;

    if (!new_tier) {
      return res.status(400).json({ error: 'Missing required field: new_tier' });
    }

    // Validate tier
    if (!TIER_PRICE_MAP[new_tier]) {
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }

    // Get user
    const userResult = await db.query('SELECT * FROM user_profiles WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // If user has a Stripe subscription and Stripe is available, update it
    if (stripe && user.stripe_subscription_id) {
      try {
        const newPriceId = TIER_PRICE_MAP[new_tier];
        await stripe.subscriptions.update(user.stripe_subscription_id, {
          items: [{
            id: (await stripe.subscriptions.retrieve(user.stripe_subscription_id)).items.data[0].id,
            price: newPriceId,
          }],
          proration_behavior: prorate ? 'create_prorations' : 'none',
        });
      } catch (stripeErr) {
        console.error('[Admin] Stripe update error:', stripeErr.message);
        // Continue with database update even if Stripe fails
      }
    }

    // Update user_profiles
    await db.query(
      'UPDATE user_profiles SET subscription_tier = $1 WHERE id = $2',
      [new_tier, userId]
    );

    // Log to admin_activity_log
    await db.query(
      `INSERT INTO admin_activity_log (admin_user_id, target_user_id, action, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [req.user.id, userId, 'tier_change', JSON.stringify({ old_tier: user.subscription_tier, new_tier, prorate })]
    );

    return res.json({ success: true, message: `User tier changed to ${new_tier}` });
  } catch (err) {
    console.error('[Admin] tier change error:', err.message);
    return res.status(500).json({ error: 'Failed to change tier' });
  }
});

// ============================================================================
// 10. POST /customer/:userId/note - Add admin note
// ============================================================================
router.post('/customer/:userId/note', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { note } = req.body;

    if (!note) {
      return res.status(400).json({ error: 'Missing required field: note' });
    }

    // Get current notes
    const userResult = await db.query('SELECT notes FROM user_profiles WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentNotes = userResult.rows[0].notes || '';
    const timestamp = new Date().toISOString();
    const adminEmail = req.user.email || 'admin';
    const newNote = `\n[${timestamp}] ${adminEmail}: ${note}`;
    const updatedNotes = currentNotes + newNote;

    // Update user notes
    await db.query(
      'UPDATE user_profiles SET notes = $1 WHERE id = $2',
      [updatedNotes, userId]
    );

    // Log to admin_activity_log
    await db.query(
      `INSERT INTO admin_activity_log (admin_user_id, target_user_id, action, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [req.user.id, userId, 'added_note', JSON.stringify({ note })]
    );

    return res.json({ success: true, message: 'Note added to customer' });
  } catch (err) {
    console.error('[Admin] note error:', err.message);
    return res.status(500).json({ error: 'Failed to add note' });
  }
});

// ============================================================================
// 11. GET /revenue - Revenue analytics
// ============================================================================
router.get('/revenue', requireAuth, requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    let daysBack = 30;

    if (period === '7d') daysBack = 7;
    else if (period === '90d') daysBack = 90;
    else if (period === '12m') daysBack = 365;
    else if (period === 'all') daysBack = 3650;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    startDate.setHours(0, 0, 0, 0);
    const startStr = startDate.toISOString().split('T')[0];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    // Daily revenue from business_metrics_daily
    const dailyRevenueResult = await db.query(
      `SELECT date, daily_revenue, mrr, new_subscriptions, cancellations
       FROM business_metrics_daily
       WHERE date >= $1 AND date <= $2
       ORDER BY date ASC`,
      [startStr, todayStr]
    );

    const dailyRevenue = dailyRevenueResult.rows.map(row => ({
      date: row.date,
      revenue: parseFloat(row.daily_revenue) || 0,
      mrr: parseFloat(row.mrr) || 0,
      new_subs: parseInt(row.new_subscriptions) || 0,
      churn: parseInt(row.cancellations) || 0,
    }));

    // MRR trend
    const mrrTrend = dailyRevenue.map(row => ({
      date: row.date,
      mrr: row.mrr,
    }));

    // Subscriber growth
    const subscriberGrowth = dailyRevenue.map(row => ({
      date: row.date,
      new: row.new_subs,
      churn: row.churn,
      net: row.new_subs - row.churn,
    }));

    // Calculate totals
    const totalRevenue = dailyRevenue.reduce((sum, row) => sum + row.revenue, 0);
    const avgDaily = dailyRevenue.length > 0 ? totalRevenue / dailyRevenue.length : 0;

    return res.json({
      period,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      avg_daily_revenue: Math.round(avgDaily * 100) / 100,
      daily_revenue: dailyRevenue,
      mrr_trend: mrrTrend,
      subscriber_growth: subscriberGrowth,
    });
  } catch (err) {
    console.error('[Admin] revenue error:', err.message);
    return res.status(500).json({ error: 'Revenue fetch failed' });
  }
});

// ============================================================================
// 12. GET /export/:type - CSV export
// ============================================================================
router.get('/export/:type', requireAuth, requireAdmin, ownerOnly, async (req, res) => {
  try {
    const exportType = req.params.type;
    const startDate = req.query.start_date ? new Date(req.query.start_date) : null;
    const endDate = req.query.end_date ? new Date(req.query.end_date) : null;

    let csv = '';
    const validTypes = ['customers', 'revenue', 'metrics', 'subscriptions', 'affiliates', 'financial_summaries'];

    if (!validTypes.includes(exportType)) {
      return res.status(400).json({ error: `Invalid export type. Must be one of: ${validTypes.join(', ')}` });
    }

    if (exportType === 'customers') {
      csv = await exportCustomersCSV(startDate, endDate);
    } else if (exportType === 'revenue') {
      csv = await exportRevenueCSV(startDate, endDate);
    } else if (exportType === 'metrics') {
      csv = await exportMetricsCSV(startDate, endDate);
    } else if (exportType === 'subscriptions') {
      csv = await exportSubscriptionsCSV(startDate, endDate);
    } else if (exportType === 'affiliates') {
      csv = await exportAffiliatesCSV();
    } else if (exportType === 'financial_summaries') {
      csv = await exportFinancialSummariesCSV();
    }

    // Log export
    await db.query(
      `INSERT INTO admin_activity_log (admin_user_id, action, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [req.user.id, 'export', JSON.stringify({ type: exportType, start_date: startDate, end_date: endDate })]
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="export_${exportType}_${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('[Admin] export error:', err.message);
    return res.status(500).json({ error: 'Export failed' });
  }
});

async function exportCustomersCSV(startDate, endDate) {
  const result = await db.query(
    `SELECT id, email, name, subscription_tier, subscription_status, acquisition_channel, first_paid_at, last_active_at
     FROM user_profiles
     ORDER BY created_at DESC`
  );

  let csv = 'User ID,Email,Name,Tier,Status,Channel,First Paid,Last Active\n';
  result.rows.forEach(row => {
    csv += `"${row.id}","${row.email}","${row.name || ''}","${row.subscription_tier}","${row.subscription_status}","${row.acquisition_channel || ''}","${row.first_paid_at || ''}","${row.last_active_at || ''}"\n`;
  });
  return csv;
}

async function exportRevenueCSV(startDate, endDate) {
  const result = await db.query(
    `SELECT date, daily_revenue, mrr, new_subscriptions, cancellations
     FROM business_metrics_daily
     ORDER BY date DESC`
  );

  let csv = 'Date,Daily Revenue,MRR,New Subscriptions,Cancellations\n';
  result.rows.forEach(row => {
    csv += `"${row.date}","${row.daily_revenue}","${row.mrr}","${row.new_subscriptions}","${row.cancellations}"\n`;
  });
  return csv;
}

async function exportMetricsCSV(startDate, endDate) {
  const result = await db.query(
    `SELECT * FROM business_metrics_daily ORDER BY date DESC`
  );

  if (result.rows.length === 0) return 'No data\n';

  const headers = Object.keys(result.rows[0]);
  let csv = headers.join(',') + '\n';
  result.rows.forEach(row => {
    const values = headers.map(h => {
      const val = row[h];
      return typeof val === 'string' && val.includes(',') ? `"${val}"` : val;
    });
    csv += values.join(',') + '\n';
  });
  return csv;
}

async function exportSubscriptionsCSV(startDate, endDate) {
  const result = await db.query(
    `SELECT user_id, event_type, new_tier as subscription_tier, mrr_delta, created_at
     FROM subscription_events
     ORDER BY created_at DESC`
  );

  let csv = 'User ID,Event Type,Tier,MRR Change,Date\n';
  result.rows.forEach(row => {
    csv += `"${row.user_id}","${row.event_type}","${row.subscription_tier}","${row.mrr_delta}","${row.created_at}"\n`;
  });
  return csv;
}

async function exportAffiliatesCSV() {
  const result = await db.query(
    `SELECT * FROM affiliates ORDER BY created_at DESC`
  );

  if (result.rows.length === 0) return 'No data\n';

  const headers = Object.keys(result.rows[0]);
  let csv = headers.join(',') + '\n';
  result.rows.forEach(row => {
    const values = headers.map(h => {
      const val = row[h];
      return typeof val === 'string' && val.includes(',') ? `"${val}"` : val;
    });
    csv += values.join(',') + '\n';
  });
  return csv;
}

async function exportFinancialSummariesCSV() {
  const result = await db.query(
    `SELECT * FROM financial_summaries_monthly ORDER BY month DESC`
  );

  if (result.rows.length === 0) return 'No data\n';

  const headers = Object.keys(result.rows[0]);
  let csv = headers.join(',') + '\n';
  result.rows.forEach(row => {
    const values = headers.map(h => {
      const val = row[h];
      return typeof val === 'string' && val.includes(',') ? `"${val}"` : val;
    });
    csv += values.join(',') + '\n';
  });
  return csv;
}

// ============================================================================
// 13. GET /affiliates - Affiliate overview
// ============================================================================
router.get('/affiliates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM affiliates ORDER BY created_at DESC`
    );

    const affiliates = result.rows || [];

    // Calculate summary totals
    let totalAffiliates = affiliates.length;
    let totalReferrals = 0;
    let totalRevenue = 0;

    affiliates.forEach(aff => {
      totalReferrals += parseInt(aff.referral_count) || 0;
      totalRevenue += parseFloat(aff.total_revenue) || 0;
    });

    return res.json({
      summary: {
        total_affiliates: totalAffiliates,
        total_referrals: totalReferrals,
        total_revenue: Math.round(totalRevenue * 100) / 100,
      },
      affiliates,
    });
  } catch (err) {
    console.error('[Admin] affiliates error:', err.message);
    return res.status(500).json({ error: 'Affiliates fetch failed' });
  }
});

// ============================================================================
// 14. GET /affiliate/:id - Affiliate detail with referrals
// ============================================================================
router.get('/affiliate/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const affiliateId = req.params.id;

    // Get affiliate
    const affResult = await db.query('SELECT * FROM affiliates WHERE id = $1', [affiliateId]);
    if (affResult.rows.length === 0) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }
    const affiliate = affResult.rows[0];

    // Get referrals for this affiliate
    const referralsResult = await db.query(
      'SELECT * FROM affiliate_referrals WHERE affiliate_id = $1 ORDER BY created_at DESC',
      [affiliateId]
    );
    const referrals = referralsResult.rows || [];

    return res.json({
      affiliate,
      referrals,
    });
  } catch (err) {
    console.error('[Admin] affiliate detail error:', err.message);
    return res.status(500).json({ error: 'Affiliate detail fetch failed' });
  }
});

// ============================================================================
// 15. POST /sync-rewardful - Manual Rewardful sync trigger
// ============================================================================
router.post('/sync-rewardful', requireAuth, requireAdmin, ownerOnly, async (req, res) => {
  try {
    // Trigger Rewardful sync
    await syncRewardful();

    // Log action
    await db.query(
      `INSERT INTO admin_activity_log (admin_user_id, action, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [req.user.id, 'sync_rewardful', JSON.stringify({ manual: true })]
    );

    return res.json({ success: true, message: 'Rewardful sync triggered' });
  } catch (err) {
    console.error('[Admin] sync-rewardful error:', err.message);
    return res.status(500).json({ error: 'Rewardful sync failed' });
  }
});

// ============================================================================
// 16. POST /admin-users - Manage admin accounts (owner only)
// ============================================================================
router.post('/admin-users', requireAuth, requireAdmin, ownerOnly, async (req, res) => {
  try {
    const { user_id, role } = req.body;

    if (!user_id || !role) {
      return res.status(400).json({ error: 'Missing required fields: user_id, role' });
    }

    if (!['manager', 'viewer', 'owner'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be manager, viewer, or owner' });
    }

    // Check if user exists
    const userResult = await db.query('SELECT * FROM user_profiles WHERE id = $1', [user_id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if already an admin
    const existingResult = await db.query('SELECT * FROM admin_users WHERE user_id = $1', [user_id]);

    if (existingResult.rows.length > 0) {
      // Update existing
      await db.query(
        'UPDATE admin_users SET role = $1 WHERE user_id = $2',
        [role, user_id]
      );
    } else {
      // Insert new
      await db.query(
        'INSERT INTO admin_users (user_id, role, created_at) VALUES ($1, $2, NOW())',
        [user_id, role]
      );
    }

    // Log action
    await db.query(
      `INSERT INTO admin_activity_log (admin_user_id, target_user_id, action, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [req.user.id, user_id, 'admin_role_change', JSON.stringify({ role })]
    );

    return res.json({ success: true, message: `User role set to ${role}` });
  } catch (err) {
    console.error('[Admin] admin-users create error:', err.message);
    return res.status(500).json({ error: 'Failed to manage admin user' });
  }
});

// ============================================================================
// 17. GET /admin-users - List admin users (owner only)
// ============================================================================
router.get('/admin-users', requireAuth, requireAdmin, ownerOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT au.*, up.email, up.name
       FROM admin_users au
       LEFT JOIN user_profiles up ON au.user_id = up.id
       ORDER BY au.created_at DESC`
    );

    const admins = result.rows.map(row => ({
      user_id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })) || [];

    return res.json({ admins });
  } catch (err) {
    console.error('[Admin] admin-users list error:', err.message);
    return res.status(500).json({ error: 'Admin users fetch failed' });
  }
});

module.exports = router;
