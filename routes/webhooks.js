const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const crypto = require('crypto');

/**
 * POST /rewardful
 * Handle Rewardful webhook events for affiliate referrals and commissions
 */
router.post('/rewardful', async (req, res) => {
  try {
    const signature = req.headers['x-rewardful-signature'];
    const body = req.body;

    // Verify webhook signature if secret is configured
    if (process.env.REWARDFUL_WEBHOOK_SECRET) {
      if (!signature) {
        console.warn('[REWARDFUL_WEBHOOK] Missing signature header');
        return res.status(400).json({ error: 'Missing signature' });
      }

      const payload = JSON.stringify(body);
      const expectedSignature = crypto
        .createHmac('sha256', process.env.REWARDFUL_WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');

      if (signature !== expectedSignature) {
        console.warn('[REWARDFUL_WEBHOOK] Invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = body.event;
    const data = body.data || {};

    console.log(`[REWARDFUL_WEBHOOK] Processing event: ${event}`);

    switch (event) {
      case 'referral.created':
        await handleReferralCreated(data);
        break;

      case 'referral.converted':
        await handleReferralConverted(data);
        break;

      case 'commission.created':
        await handleCommissionCreated(data);
        break;

      case 'commission.paid':
        await handleCommissionPaid(data);
        break;

      default:
        console.log(`[REWARDFUL_WEBHOOK] Unknown event type: ${event}`);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[REWARDFUL_WEBHOOK_ERROR]', err.message);
    res.status(200).json({ success: true }); // Always return 200 to prevent retries
  }
});

/**
 * Handle referral.created event
 * Inserts new referral into affiliate_referrals table
 */
async function handleReferralCreated(data) {
  const affiliate = data.affiliate || {};
  const referral = data.referral || {};

  try {
    await db.query(
      `INSERT INTO affiliate_referrals
       (affiliate_id, affiliate_email, referral_email, referral_status, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (affiliate_id, referral_email) DO NOTHING`,
      [
        affiliate.id,
        affiliate.email,
        referral.email,
        'pending'
      ]
    );

    console.log(`[REFERRAL_CREATED] Affiliate: ${affiliate.id}, Referral: ${referral.email}`);
  } catch (err) {
    console.error('[REFERRAL_CREATED_ERROR]', err.message);
  }
}

/**
 * Handle referral.converted event
 * Updates referral status and affiliate aggregate counts
 */
async function handleReferralConverted(data) {
  const affiliate = data.affiliate || {};
  const referral = data.referral || {};

  try {
    // Update referral status to converted
    await db.query(
      `UPDATE affiliate_referrals
       SET referral_status = $1, converted_at = NOW()
       WHERE affiliate_id = $2 AND referral_email = $3`,
      ['converted', affiliate.id, referral.email]
    );

    // Update affiliates aggregate counts
    await db.query(
      `UPDATE affiliates
       SET total_referrals = total_referrals + 1,
           converted_referrals = converted_referrals + 1,
           updated_at = NOW()
       WHERE affiliate_id = $1`,
      [affiliate.id]
    );

    console.log(`[REFERRAL_CONVERTED] Affiliate: ${affiliate.id}, Referral: ${referral.email}`);
  } catch (err) {
    console.error('[REFERRAL_CONVERTED_ERROR]', err.message);
  }
}

/**
 * Handle commission.created event
 * Updates affiliate_referrals with commission info and updates affiliate totals
 */
async function handleCommissionCreated(data) {
  const affiliate = data.affiliate || {};
  const referral = data.referral || {};
  const commission = data.commission || {};

  try {
    // Update referral with commission earned
    await db.query(
      `UPDATE affiliate_referrals
       SET commission_earned = $1,
           commission_currency = $2,
           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{commission_id}', to_jsonb($3))
       WHERE affiliate_id = $4 AND referral_email = $5`,
      [
        commission.amount || 0,
        commission.currency || 'USD',
        commission.id,
        affiliate.id,
        referral.email
      ]
    );

    // Update affiliates total commissions
    await db.query(
      `UPDATE affiliates
       SET total_commissions = total_commissions + $1,
           updated_at = NOW()
       WHERE affiliate_id = $2`,
      [commission.amount || 0, affiliate.id]
    );

    console.log(`[COMMISSION_CREATED] Affiliate: ${affiliate.id}, Amount: ${commission.amount} ${commission.currency}`);
  } catch (err) {
    console.error('[COMMISSION_CREATED_ERROR]', err.message);
  }
}

/**
 * Handle commission.paid event
 * Updates commission metadata with payment status
 */
async function handleCommissionPaid(data) {
  const affiliate = data.affiliate || {};
  const commission = data.commission || {};

  try {
    await db.query(
      `UPDATE affiliate_referrals
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
           '{commission_paid}', to_jsonb(true)),
           metadata = jsonb_set(metadata, '{paid_at}', to_jsonb($1))
       WHERE affiliate_id = $2 AND metadata->>'commission_id' = $3`,
      [new Date().toISOString(), affiliate.id, commission.id]
    );

    console.log(`[COMMISSION_PAID] Affiliate: ${affiliate.id}, Commission: ${commission.id}`);
  } catch (err) {
    console.error('[COMMISSION_PAID_ERROR]', err.message);
  }
}

module.exports = router;
