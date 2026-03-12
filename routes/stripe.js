// ============================================================
// routes/stripe.js — Stripe Checkout + Webhook Routes
// Extracted from server.js (lines 1926-2158)
// Sprint 0 fixes:
//   - Idempotency check via processed_stripe_events (Task 0.7)
//   - customer_email fallback (customer_details.email)
//   - Centralized price-to-tier mapping via lib/stripe-helpers.js
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { requireAuth } = require('../lib/middleware');
const { triggerGHL } = require('../lib/ghl');
const { checkStripeIdempotency } = require('../lib/errors');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// ── Price-to-Tier mapping (matches existing server.js) ──
// Uses environment variables for easy test→live cutover
const PRICE_TO_TIER = {
  [process.env.STRIPE_PRICE_ID_SELLER_MONTHLY || '']:    'seller',
  [process.env.STRIPE_PRICE_ID_SELLER_ANNUAL || '']:     'seller',
  [process.env.STRIPE_PRICE_ID_AGENCY_OTO || '']:        'agency_power',
  [process.env.STRIPE_PRICE_ID_AGENCY_MONTHLY || '']:    'agency',
  [process.env.STRIPE_PRICE_ID_AGENCY_ANNUAL || '']:     'agency',
  [process.env.STRIPE_PRICE_ID_ENTERPRISE_MONTHLY || '']: 'enterprise',
  [process.env.STRIPE_PRICE_ID_ENTERPRISE_ANNUAL || '']:  'enterprise',
};

// ══════════════════════════════════════════════════════════════
// GET /api/stripe/portal — Open Stripe Customer Portal
// ══════════════════════════════════════════════════════════════
router.get('/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

  try {
    const profile = await db.query('SELECT stripe_customer_id FROM user_profiles WHERE id = $1', [req.user.id]);
    const customerId = profile.rows[0]?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'https://www.asinanalyzer.app/dashboard/account',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[STRIPE_ERROR] Portal:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal.' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/stripe/cancel — Cancel subscription
// ══════════════════════════════════════════════════════════════
router.post('/cancel', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

  try {
    const profile = await db.query('SELECT stripe_subscription_id FROM user_profiles WHERE id = $1', [req.user.id]);
    const subId = profile.rows[0]?.stripe_subscription_id;

    if (!subId) {
      return res.status(400).json({ error: 'No active subscription found.' });
    }

    // Cancel at end of billing period (not immediately)
    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });

    await db.query(
      "UPDATE user_profiles SET subscription_status = 'cancelling' WHERE id = $1",
      [req.user.id]
    );

    // Fire GHL webhook for cancellation
    triggerGHL(req.user.email, '', 0, '', '', null, 'subscription_cancelled').catch(e => console.error('[GHL_ERROR] Cancel:', e.message));

    console.log(`[STRIPE] Subscription cancel requested: ${req.user.email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[STRIPE_ERROR] Cancel:', err.message);
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/stripe/create-checkout — Create Stripe Checkout session
// ══════════════════════════════════════════════════════════════
router.post('/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured yet.' });

  try {
    const { priceId, email, analysisId, mode } = req.body;

    const sessionParams = {
      // Only pass customer_email if it's a valid email — otherwise Stripe
      // throws resource_missing for unrecognized/empty email strings
      ...(email && email.includes('@') ? { customer_email: email } : {}),
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: mode || 'payment',
      success_url: `https://www.asinanalyzer.app/thank-you?session_id={CHECKOUT_SESSION_ID}&analysis_id=${analysisId || ''}`,
      cancel_url: `https://www.asinanalyzer.app/report/${analysisId || ''}`,
      metadata: {
        analysisId: String(analysisId || ''),
        product: priceId,
      },
    };

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[STRIPE_ERROR] Checkout:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/stripe/webhook — Handle Stripe events
// Sprint 0 fix: idempotency check prevents double-processing
// ══════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
  if (!stripe) return res.status(503).send('Payments not configured');

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[STRIPE_ERROR] Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── SPRINT 0 FIX (Task 0.7): Idempotency check ──
  try {
    const isDuplicate = await checkStripeIdempotency(event.id);
    if (isDuplicate) {
      console.log(`[STRIPE] Skipping duplicate event: ${event.id}`);
      return res.json({ received: true, duplicate: true });
    }
  } catch (idempErr) {
    // If idempotency check fails, proceed anyway (don't block payments)
    console.error('[STRIPE_WARN] Idempotency check failed, proceeding:', idempErr.message);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // ── SPRINT 0 FIX: customer_email fallback ──
      const email = session.customer_email || session.customer_details?.email;
      const analysisId = session.metadata?.analysisId;

      // Record purchase
      try {
        await db.query(
          'INSERT INTO purchases (email, stripe_session_id, stripe_payment_intent_id, product, amount_cents, analysis_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [
            email?.toLowerCase(),
            session.id,
            session.payment_intent,
            session.metadata?.product || 'unknown',
            session.amount_total,
            analysisId ? parseInt(analysisId, 10) : null,
          ]
        );
        console.log(`[STRIPE] Purchase recorded: ${email} — $${(session.amount_total / 100).toFixed(2)}`);
      } catch (dbErr) {
        console.error('[STRIPE_ERROR] Purchase record failed:', dbErr.message);
      }

      // Fire GHL webhook for purchase event
      if (email) triggerGHL(email, '', 0, '', analysisId || '', null, 'purchase').catch(e => console.error('[GHL_ERROR] Purchase:', e.message));
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const customerId = sub.customer;
      const subStatus = sub.status;
      const priceId = sub.items?.data?.[0]?.price?.id || '';

      // Map Stripe price to tier
      let tier = 'seller';
      if (PRICE_TO_TIER[priceId]) tier = PRICE_TO_TIER[priceId];

      // Update user profile
      try {
        await db.query(
          `UPDATE user_profiles SET
            subscription_tier = $1,
            subscription_status = $2,
            stripe_subscription_id = $3,
            stripe_customer_id = $4
           WHERE stripe_customer_id = $4 OR LOWER(email) = LOWER($5)`,
          [
            subStatus === 'active' ? tier : 'free',
            subStatus,
            sub.id,
            customerId,
            sub.customer_email || '',
          ]
        );
        console.log(`[STRIPE] Subscription ${event.type}: ${sub.id} -> ${tier} (${subStatus})`);
      } catch (dbErr) {
        console.error('[STRIPE_ERROR] Subscription update failed:', dbErr.message);
      }

      // Fire GHL webhook
      const customerEmail = sub.customer_email || '';
      if (customerEmail) triggerGHL(customerEmail, '', 0, '', '', null, 'subscription_' + subStatus).catch(e => {});
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const customerId = sub.customer;

      // Downgrade to free
      try {
        await db.query(
          `UPDATE user_profiles SET subscription_tier = 'free', subscription_status = 'cancelled',
           stripe_subscription_id = NULL WHERE stripe_customer_id = $1`,
          [customerId]
        );
        console.log(`[STRIPE] Subscription cancelled -> free: ${sub.id}`);
      } catch (dbErr) {
        console.error('[STRIPE_ERROR] Cancellation update failed:', dbErr.message);
      }

      // Fire GHL webhook
      if (sub.customer_email) triggerGHL(sub.customer_email, '', 0, '', '', null, 'subscription_cancelled').catch(e => {});
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      // Reset monthly quota on successful subscription payment
      if (invoice.subscription) {
        try {
          await db.query(
            `UPDATE user_profiles SET analyses_this_month = 0,
             analyses_month_reset = date_trunc('month', NOW()) + interval '1 month'
             WHERE stripe_customer_id = $1`,
            [customerId]
          );
          console.log(`[STRIPE] Quota reset for customer: ${customerId}`);
        } catch (dbErr) {
          console.error('[STRIPE_ERROR] Quota reset failed:', dbErr.message);
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      console.log(`[STRIPE] Payment failed: ${invoice.customer_email}`);

      // Fire GHL webhook for dunning sequence
      if (invoice.customer_email) triggerGHL(invoice.customer_email, '', 0, '', '', null, 'payment_failed').catch(e => {});
      break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
