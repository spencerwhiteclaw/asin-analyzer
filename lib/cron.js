const db = require('./db');
const fetch = require('node-fetch');

/**
 * snapshotDailyMetrics()
 * Runs at end of day. Populates business_metrics_daily for today's date.
 */
async function snapshotDailyMetrics() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    // Total users
    const totalUsersResult = await db.query(
      'SELECT COUNT(*) as count FROM user_profiles'
    );
    const totalUsers = parseInt(totalUsersResult.rows[0]?.count) || 0;

    // Total email captures
    const totalEmailResult = await db.query(
      'SELECT COUNT(*) as count FROM subscribers'
    );
    const totalEmailCaptures = parseInt(totalEmailResult.rows[0]?.count) || 0;

    // New email captures today
    const newEmailResult = await db.query(
      `SELECT COUNT(*) as count FROM subscribers
       WHERE DATE(subscribed_at) = $1`,
      [todayStr]
    );
    const newEmailCaptures = parseInt(newEmailResult.rows[0]?.count) || 0;

    // Free users
    const freeUsersResult = await db.query(
      `SELECT COUNT(*) as count FROM user_profiles
       WHERE subscription_tier = 'free'`
    );
    const freeUsers = parseInt(freeUsersResult.rows[0]?.count) || 0;

    // Users by subscription tier
    const tierCounts = await db.query(
      `SELECT subscription_tier, COUNT(*) as count
       FROM user_profiles
       WHERE subscription_tier IS NOT NULL
       GROUP BY subscription_tier`
    );
    const tierMap = {};
    tierCounts.rows.forEach(row => {
      tierMap[row.subscription_tier] = parseInt(row.count) || 0;
    });

    const sellerTotal = tierMap.seller || 0;
    const agencyTotal = tierMap.agency || 0;
    const enterpriseTotal = tierMap.enterprise || 0;

    // MRR from latest subscription events per user
    const mrrResult = await db.query(
      `SELECT COALESCE(SUM(new_mrr), 0) as total_mrr
       FROM (
         SELECT DISTINCT ON (user_id) user_id, new_mrr
         FROM subscription_events
         WHERE event_type IN ('subscription_created', 'subscription_updated')
         ORDER BY user_id, created_at DESC
       ) sub`
    );
    const mrr = parseFloat(mrrResult.rows[0]?.total_mrr) || 0;

    // MRR breakdown by event type today
    const mrrBreakdown = await db.query(
      `SELECT event_type, COALESCE(SUM(new_mrr), 0) as mrr_total
       FROM subscription_events
       WHERE DATE(created_at) = $1
       GROUP BY event_type`,
      [todayStr]
    );
    const mrrByEvent = {};
    mrrBreakdown.rows.forEach(row => {
      mrrByEvent[row.event_type] = parseFloat(row.mrr_total) || 0;
    });

    const newMrr = mrrByEvent.subscription_created || 0;
    const expansionMrr = mrrByEvent.subscription_upgraded || 0;
    const contractionMrr = mrrByEvent.subscription_downgraded || 0;
    const churnedMrr = mrrByEvent.subscription_cancelled || 0;
    const netNewMrr = newMrr + expansionMrr - contractionMrr - churnedMrr;

    // Daily revenue from purchases
    const revenueResult = await db.query(
      `SELECT COALESCE(SUM(amount_cents), 0) as total
       FROM purchases
       WHERE DATE(created_at) = $1`,
      [todayStr]
    );
    const dailyRevenue = (parseFloat(revenueResult.rows[0]?.total) || 0) / 100;

    // Tripwire purchases ($7)
    const tripwireResult = await db.query(
      `SELECT COUNT(*) as count FROM purchases
       WHERE product_id = 'price_7' AND DATE(created_at) = $1`,
      [todayStr]
    );
    const tripwirePurchases = parseInt(tripwireResult.rows[0]?.count) || 0;

    // Downsell purchases ($4.97)
    const downsellResult = await db.query(
      `SELECT COUNT(*) as count FROM purchases
       WHERE product_id = 'price_4_97' AND DATE(created_at) = $1`,
      [todayStr]
    );
    const downsellPurchases = parseInt(downsellResult.rows[0]?.count) || 0;

    // Reports generated
    const reportsResult = await db.query(
      `SELECT COUNT(*) as count FROM analyses
       WHERE DATE(created_at) = $1`,
      [todayStr]
    );
    const reportsGenerated = parseInt(reportsResult.rows[0]?.count) || 0;

    // New subscriptions
    const newSubsResult = await db.query(
      `SELECT COUNT(*) as count FROM subscription_events
       WHERE event_type = 'subscription_created' AND DATE(created_at) = $1`,
      [todayStr]
    );
    const newSubscriptions = parseInt(newSubsResult.rows[0]?.count) || 0;

    // Cancellations
    const cancelResult = await db.query(
      `SELECT COUNT(*) as count FROM subscription_events
       WHERE event_type IN ('subscription_cancelled', 'subscription_expired')
       AND DATE(created_at) = $1`,
      [todayStr]
    );
    const cancellations = parseInt(cancelResult.rows[0]?.count) || 0;

    // Failed payments
    const failedResult = await db.query(
      `SELECT COUNT(*) as count FROM subscription_events
       WHERE event_type = 'payment_failed' AND DATE(created_at) = $1`,
      [todayStr]
    );
    const failedPayments = parseInt(failedResult.rows[0]?.count) || 0;

    // Recovered payments
    const recoveredResult = await db.query(
      `SELECT COUNT(*) as count FROM subscription_events
       WHERE event_type = 'payment_recovered' AND DATE(created_at) = $1`,
      [todayStr]
    );
    const recoveredPayments = parseInt(recoveredResult.rows[0]?.count) || 0;

    // Total active subscribers (count users with at least one active subscription event)
    const activeSubsResult = await db.query(
      `SELECT COUNT(DISTINCT user_id) as count
       FROM subscription_events
       WHERE event_type IN ('subscription_created', 'subscription_updated')
       AND created_at = (
         SELECT MAX(created_at) FROM subscription_events se2
         WHERE se2.user_id = subscription_events.user_id
       )`
    );
    const totalActiveSubscribers = parseInt(activeSubsResult.rows[0]?.count) || 1;

    // Churn rate
    const churnRate = cancellations / totalActiveSubscribers;

    // Affiliate metrics
    const affiliateResult = await db.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(payout_amount_cents), 0) as total_payout
       FROM affiliate_referrals
       WHERE DATE(created_at) = $1`,
      [todayStr]
    );
    const affiliateReferrals = parseInt(affiliateResult.rows[0]?.count) || 0;
    const affiliateRevenue = (parseFloat(affiliateResult.rows[0]?.total_payout) || 0) / 100;

    // UPSERT into business_metrics_daily
    await db.query(
      `INSERT INTO business_metrics_daily (
        date,
        total_users,
        total_email_captures,
        new_email_captures,
        free_users,
        seller_total,
        agency_total,
        enterprise_total,
        mrr,
        new_mrr,
        expansion_mrr,
        contraction_mrr,
        churned_mrr,
        net_new_mrr,
        daily_revenue,
        tripwire_purchases,
        downsell_purchases,
        reports_generated,
        new_subscriptions,
        cancellations,
        failed_payments,
        recovered_payments,
        churn_rate,
        affiliate_referrals,
        affiliate_revenue,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW(), NOW())
      ON CONFLICT(date) DO UPDATE SET
        total_users = $2,
        total_email_captures = $3,
        new_email_captures = $4,
        free_users = $5,
        seller_total = $6,
        agency_total = $7,
        enterprise_total = $8,
        mrr = $9,
        new_mrr = $10,
        expansion_mrr = $11,
        contraction_mrr = $12,
        churned_mrr = $13,
        net_new_mrr = $14,
        daily_revenue = $15,
        tripwire_purchases = $16,
        downsell_purchases = $17,
        reports_generated = $18,
        new_subscriptions = $19,
        cancellations = $20,
        failed_payments = $21,
        recovered_payments = $22,
        churn_rate = $23,
        affiliate_referrals = $24,
        affiliate_revenue = $25,
        updated_at = NOW()`,
      [
        todayStr,
        totalUsers,
        totalEmailCaptures,
        newEmailCaptures,
        freeUsers,
        sellerTotal,
        agencyTotal,
        enterpriseTotal,
        mrr,
        newMrr,
        expansionMrr,
        contractionMrr,
        churnedMrr,
        netNewMrr,
        dailyRevenue,
        tripwirePurchases,
        downsellPurchases,
        reportsGenerated,
        newSubscriptions,
        cancellations,
        failedPayments,
        recoveredPayments,
        churnRate,
        affiliateReferrals,
        affiliateRevenue
      ]
    );

    console.log(`[Cron] snapshotDailyMetrics completed for ${todayStr}`);
  } catch (error) {
    console.error('[Cron] snapshotDailyMetrics error:', error);
  }
}

/**
 * generateMonthlyFinancialSummary(targetMonth)
 * Runs on 1st of each month for previous month.
 * @param {Date} targetMonth - First day of the month to summarize
 */
async function generateMonthlyFinancialSummary(targetMonth) {
  try {
    const monthStart = new Date(targetMonth);
    monthStart.setHours(0, 0, 0, 0);
    const monthStr = monthStart.toISOString().split('T')[0];
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth() + 1;

    // Get last day of month
    const monthEnd = new Date(year, monthStart.getMonth() + 1, 0);
    monthEnd.setHours(23, 59, 59, 999);
    const monthEndStr = monthEnd.toISOString().split('T')[0];

    // Gross revenue: sum of daily_revenue for the month
    const grossResult = await db.query(
      `SELECT COALESCE(SUM(daily_revenue), 0) as total
       FROM business_metrics_daily
       WHERE date >= $1 AND date <= $2`,
      [monthStr, monthEndStr]
    );
    const grossRevenue = parseFloat(grossResult.rows[0]?.total) || 0;

    // Refunds: 0 for now
    const refunds = 0;
    const netRevenue = grossRevenue - refunds;

    // Stripe fees: 2.9% + $0.30 per transaction
    const txnResult = await db.query(
      `SELECT COUNT(*) as count FROM purchases
       WHERE created_at >= $1 AND created_at <= $2`,
      [monthStart, monthEnd]
    );
    const transactionCount = parseInt(txnResult.rows[0]?.count) || 0;
    const stripeFees = (grossRevenue * 0.029) + (transactionCount * 0.30);

    // Affiliate commissions: sum from affiliate_referrals for the month
    const affiliateResult = await db.query(
      `SELECT COALESCE(SUM(payout_amount_cents), 0) as total
       FROM affiliate_referrals
       WHERE created_at >= $1 AND created_at <= $2`,
      [monthStart, monthEnd]
    );
    const affiliateCommissions = (parseFloat(affiliateResult.rows[0]?.total) || 0) / 100;

    // Infrastructure cost: $70 default
    const infrastructureCost = 70;

    // Estimated margin
    const estimatedMargin = netRevenue - stripeFees - affiliateCommissions - infrastructureCost;
    const marginPercentage = grossRevenue > 0 ? (estimatedMargin / grossRevenue) * 100 : 0;

    // Starting MRR: from first day of month
    const startingMrrResult = await db.query(
      `SELECT COALESCE(mrr, 0) as mrr FROM business_metrics_daily
       WHERE date = $1`,
      [monthStr]
    );
    const startingMrr = parseFloat(startingMrrResult.rows[0]?.mrr) || 0;

    // Ending MRR: from last day of month
    const endingMrrResult = await db.query(
      `SELECT COALESCE(mrr, 0) as mrr FROM business_metrics_daily
       WHERE date = $1`,
      [monthEndStr]
    );
    const endingMrr = parseFloat(endingMrrResult.rows[0]?.mrr) || 0;

    // MRR growth rate
    const mrrGrowthRate = startingMrr > 0 ? ((endingMrr - startingMrr) / startingMrr) * 100 : 0;

    // Subscriber counts from business_metrics_daily
    const startingSubsResult = await db.query(
      `SELECT total_users as count FROM business_metrics_daily
       WHERE date = $1`,
      [monthStr]
    );
    const startingSubscribers = parseInt(startingSubsResult.rows[0]?.count) || 0;

    const endingSubsResult = await db.query(
      `SELECT total_users as count FROM business_metrics_daily
       WHERE date = $1`,
      [monthEndStr]
    );
    const endingSubscribers = parseInt(endingSubsResult.rows[0]?.count) || 0;

    // ARPU: ending MRR / ending subscribers
    const arpu = endingSubscribers > 0 ? endingMrr / endingSubscribers : 0;

    // Average churn rate for the month
    const churnResult = await db.query(
      `SELECT AVG(churn_rate) as avg_churn FROM business_metrics_daily
       WHERE date >= $1 AND date <= $2`,
      [monthStr, monthEndStr]
    );
    const avgChurnRate = parseFloat(churnResult.rows[0]?.avg_churn) || 0.05;

    // LTV estimate: ARPU / monthly churn rate (avoid divide by zero)
    const ltvEstimate = avgChurnRate > 0 ? arpu / avgChurnRate : 0;

    // UPSERT into business_metrics_monthly
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    await db.query(
      `INSERT INTO business_metrics_monthly (
        month,
        gross_revenue,
        refunds,
        net_revenue,
        stripe_fees,
        affiliate_commissions,
        infrastructure_cost,
        estimated_margin,
        margin_percentage,
        starting_mrr,
        ending_mrr,
        mrr_growth_rate,
        starting_subscribers,
        ending_subscribers,
        arpu,
        ltv_estimate,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
      ON CONFLICT(month) DO UPDATE SET
        gross_revenue = $2,
        refunds = $3,
        net_revenue = $4,
        stripe_fees = $5,
        affiliate_commissions = $6,
        infrastructure_cost = $7,
        estimated_margin = $8,
        margin_percentage = $9,
        starting_mrr = $10,
        ending_mrr = $11,
        mrr_growth_rate = $12,
        starting_subscribers = $13,
        ending_subscribers = $14,
        arpu = $15,
        ltv_estimate = $16,
        updated_at = NOW()`,
      [
        monthKey,
        grossRevenue,
        refunds,
        netRevenue,
        stripeFees,
        affiliateCommissions,
        infrastructureCost,
        estimatedMargin,
        marginPercentage,
        startingMrr,
        endingMrr,
        mrrGrowthRate,
        startingSubscribers,
        endingSubscribers,
        arpu,
        ltvEstimate
      ]
    );

    console.log(`[Cron] generateMonthlyFinancialSummary completed for ${monthKey}`);
  } catch (error) {
    console.error('[Cron] generateMonthlyFinancialSummary error:', error);
  }
}

/**
 * syncRewardful()
 * Syncs affiliate data from Rewardful API
 */
async function syncRewardful() {
  try {
    const apiKey = process.env.REWARDFUL_API_KEY;
    if (!apiKey) {
      console.log('[Cron] syncRewardful skipped: no REWARDFUL_API_KEY');
      return;
    }

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    // Fetch affiliates
    const affiliatesResponse = await fetch('https://api.getrewardful.com/v1/affiliates', {
      method: 'GET',
      headers
    });

    if (!affiliatesResponse.ok) {
      console.error('[Cron] syncRewardful: affiliates fetch failed', affiliatesResponse.status);
      return;
    }

    const affiliatesData = await affiliatesResponse.json();
    const affiliates = affiliatesData.affiliates || [];

    // UPSERT each affiliate
    for (const affiliate of affiliates) {
      await db.query(
        `INSERT INTO affiliates (
          rewardful_id,
          email,
          status,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, NOW(), NOW())
        ON CONFLICT(rewardful_id) DO UPDATE SET
          email = $2,
          status = $3,
          updated_at = NOW()`,
        [affiliate.id, affiliate.email, affiliate.status]
      );
    }

    // Fetch referrals
    const referralsResponse = await fetch('https://api.getrewardful.com/v1/referrals', {
      method: 'GET',
      headers
    });

    if (!referralsResponse.ok) {
      console.error('[Cron] syncRewardful: referrals fetch failed', referralsResponse.status);
      return;
    }

    const referralsData = await referralsResponse.json();
    const referrals = referralsData.referrals || [];

    // UPSERT each referral
    for (const referral of referrals) {
      const payoutAmountCents = Math.round((referral.payout_amount || 0) * 100);
      await db.query(
        `INSERT INTO affiliate_referrals (
          rewardful_id,
          affiliate_id,
          customer_email,
          payout_amount_cents,
          status,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT(rewardful_id) DO UPDATE SET
          affiliate_id = $2,
          customer_email = $3,
          payout_amount_cents = $4,
          status = $5,
          updated_at = NOW()`,
        [referral.id, referral.affiliate_id, referral.customer_email, payoutAmountCents, referral.status]
      );
    }

    // Update aggregate counts on affiliates table
    const affiliateStats = await db.query(
      `SELECT affiliate_id, COUNT(*) as referral_count, COALESCE(SUM(payout_amount_cents), 0) as total_payouts
       FROM affiliate_referrals
       GROUP BY affiliate_id`
    );

    for (const stat of affiliateStats.rows) {
      await db.query(
        `UPDATE affiliates
         SET referral_count = $1, total_payouts_cents = $2, updated_at = NOW()
         WHERE rewardful_id = $3`,
        [stat.referral_count, stat.total_payouts, stat.affiliate_id]
      );
    }

    console.log(`[Cron] syncRewardful completed: ${affiliates.length} affiliates, ${referrals.length} referrals`);
  } catch (error) {
    console.error('[Cron] syncRewardful error:', error);
  }
}

module.exports = {
  snapshotDailyMetrics,
  generateMonthlyFinancialSummary,
  syncRewardful
};
