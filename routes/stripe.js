// ============================================================
// routes/stripe.js — Stripe Checkout + Webhook Routes
// v4.8 Sprint 7: Enhanced with subscription lifecycle event logging
// Sprint 0 base + Sprint 7D subscription_events table
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { requireAuth } = require('../lib/middleware');
const { triggerGHL } = require('../lib/ghl');
const { checkStripeIdempotency } = require('../lib/errors');
const { getMrrForPrice, getTierForPrice, getIntervalForPrice } = require('../lib/mrr');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// ── Price-to-Tier mapping (matches v4.8 exactly) ──
const PRICE_TO_TIER = {
  [process.env.STRIPE_PRICE_ID_SELLER_MONTHLY || '']:     'seller',
  [process.env.STRIPE_PRICE_ID_SELLER_ANNUAL || '']:      'seller',
  [process.env.STRIPE_PRICE_ID_AGENCY_OTO || '']:         'agency_power',
  [process.env.STRIPE_PRICE_ID_AGENCY_MONTHLY || '']:     'agency',
  [process.env.STRIPE_PRICE_ID_AGENCY_ANNUAL || '']:      'agency',
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
// Sprint 7C: Added client_reference_id for Rewardful affiliate tracking
// ══════════════════════════════════════════════════════════════
router.post('/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured yet.' });

  try {
    const { priceId, email, analysisId, mode, rewardful_referral } = req.body;

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

    // Sprint 7C: Rewardful affiliate attribution
    if (rewardful_referral) {
      sessionParams.client_reference_id = rewardful_referral;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[STRIPE_ERROR] Checkout:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/stripe/webhook — Handle Stripe events
// v4.8 Sprint 7D: Full subscription lifecycle event logging
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

  // ── Idempotency check (Sprint 0 — processed_stripe_events table) ──
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
    // ── CHECKOUT COMPLETED ──
    case 'checkout.session.completed': {
      const session = event.data.object;
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

    // ── SUBSCRIPTION CREATED ──
    case 'customer.subscription.created': {
      const sub = event.data.object;
      const customerId = sub.customer;
      const priceId = sub.items?.data?.[0]?.price?.id || '';
      const subStatus = sub.status;

      let tier = PRICE_TO_TIER[priceId] || 'seller';
      const newMrr = getMrrForPrice(priceId);
      const billingInterval = getIntervalForPrice(priceId);

      try {
        // Find user by stripe_customer_id or email
        const customerEmail = sub.customer_email || '';
        const result = await db.query(
          `UPDATE user_profiles SET
            subscription_tier = $1,
            subscription_status = $2,
            stripe_subscription_id = $3,
            stripe_customer_id = $4,
            first_paid_at = COALESCE(first_paid_at, NOW())
           WHERE stripe_customer_id = $4 OR LOWER(email) = LOWER($5)
           RETURNING id, subscription_tier AS previous_tier`,
          [
            subStatus === 'active' ? tier : 'free',
            subStatus,
            sub.id,
            customerId,
            customerEmail,
          ]
        );

        const userId = result.rows[0]?.id;

        // Sprint 7D: Log subscription_created event
        if (userId) {
          await logSubscriptionEvent(userId, 'subscription_created', {
            stripeSubId: sub.id,
            stripeEventId: event.id,
            newTier: tier,
            newMrr: newMrr,
            mrrDelta: newMrr,
            billingInterval,
          });
        }

        console.log(`[STRIPE] Subscription created: ${sub.id} -> ${tier} (${subStatus}), MRR: $${newMrr}`);
      } catch (dbErr) {
        console.error('[STRIPE_ERROR] Subscription create failed:', dbErr.message);
      }

      // Fire GHL webhook
      const customerEmail = sub.customer_email || '';
      if (customerEmail) triggerGHL(customerEmail, '', 0, '', '', null, 'subscription_active').catch(e => {});
      break;
    }

    // ── SUBSCRIPTION UPDATED (upgrade/downgrade/interval change) ──
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const previousAttributes = event.data.previous_attributes || {};
      const customerId = sub.customer;
      const priceId = sub.items?.data?.[0]?.price?.id || '';
      const subStatus = sub.status;

      let tier = PRICE_TO_TIER[priceId] || 'seller';
      const newMrr = getMrrForPrice(priceId);
      const billingInterval = getIntervalForPrice(priceId);

      try {
        // Get current user data before update
        const currentUser = await db.query(
          'SELECT id, subscription_tier, subscription_status FROM user_profiles WHERE stripe_customer_id = $1',
          [customerId]
        );
        const userId = currentUser.rows[0]?.id;
        const previousTier = currentUser.rows[0]?.subscription_tier;

        // Update user profile
        await db.query(
          `UPDATE user_profiles SET
            subscription_tier = $1,
            subscription_status = $2,
            stripe_subscription_id = $3,
            stripe_customer_id = $4
           WHERE stripe_customer_id = $4 OR LOWER(email) = LOWER($5)`,
          [
            subStatus === 'active' ? tier : (subStatus === 'canceled' ? 'free' : tier),
            subStatus,
            sub.id,
            customerId,
            sub.customer_email || '',
          ]
        );

        // Sprint 7D: Determine event type and log
        if (userId) {
          // Figure out the old price to calculate MRR delta
          const oldPriceId = previousAttributes.items?.data?.[0]?.price?.id;
          const previousMrr = oldPriceId ? getMrrForPrice(oldPriceId) : getMrrForPrice(priceId);

          let eventType = 'subscription_updated';
          let mrrDelta = 0;

          // Check if cancel_at_period_end was toggled (cancellation request)
          if (sub.cancel_at_period_end && !previousAttributes.cancel_at_period_end) {
            eventType = 'subscription_cancelled';
            mrrDelta = -(previousMrr || 0);
          }
          // Check if cancel_at_period_end was untoggled (reactivation)
          else if (!sub.cancel_at_period_end && previousAttributes.cancel_at_period_end === true) {
            eventType = 'subscription_reactivated';
            mrrDelta = newMrr;
          }
          // Check for tier/price change
          else if (oldPriceId && oldPriceId !== priceId) {
            mrrDelta = newMrr - previousMrr;
            if (mrrDelta > 0) {
              eventType = 'subscription_upgraded';
            } else if (mrrDelta < 0) {
              eventType = 'subscription_downgraded';
            } else {
              eventType = 'billing_interval_changed';
            }
          }

          if (eventType !== 'subscription_updated') {
            await logSubscriptionEvent(userId, eventType, {
              stripeSubId: sub.id,
              stripeEventId: event.id,
              previousTier: previousTier,
              newTier: tier,
              previousMrr: previousMrr,
              newMrr: newMrr,
              mrrDelta: mrrDelta,
              billingInterval,
            });
          }
        }

        console.log(`[STRIPE] Subscription ${event.type}: ${sub.id} -> ${tier} (${subStatus})`);
      } catch (dbErr) {
        console.error('[STRIPE_ERROR] Subscription update failed:', dbErr.message);
      }

      // Fire GHL webhook
      const customerEmail = sub.customer_email || '';
      if (customerEmail) triggerGHL(customerEmail, '', 0, '', '', null, 'subscription_' + subStatus).catch(e => {});
      break;
    }

    // ── SUBSCRIPTION DELETED (expired) ──
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const customerId = sub.customer;

      try {
        // Get current user data before downgrade
        const currentUser = await db.query(
          'SELECT id, subscription_tier FROM user_profiles WHERE stripe_customer_id = $1',
          [customerId]
        );
        const userId = currentUser.rows[0]?.id;
        const previousTier = currentUser.rows[0]?.subscription_tier;
        const previousMrr = previousTier ? getMrrForPrice(
          Object.keys(PRICE_TO_TIER).find(id => PRICE_TO_TIER[id] === previousTier) || ''
        ) : 0;

        // Downgrade to free
        await db.query(
          `UPDATE user_profiles SET subscription_tier = 'free', subscription_status = 'cancelled',
           stripe_subscription_id = NULL WHERE stripe_customer_id = $1`,
          [customerId]
        );

        // Sprint 7D: Log subscription_expired event
        if (userId) {
          await logSubscriptionEvent(userId, 'subscription_expired', {
            stripeSubId: sub.id,
            stripeEventId: event.id,
            previousTier: previousTier,
            newTier: 'free',
            previousMrr: previousMrr,
            newMrr: 0,
            mrrDelta: -(previousMrr || 0),
          });
        }

        console.log(`[STRIPE] Subscription expired -> free: ${sub.id}`);
      } catch (dbErr) {
        console.error('[STRIPE_ERROR] Cancellation update failed:', dbErr.message);
      }

      // Fire GHL webhook
      if (sub.customer_email) triggerGHL(sub.customer_email, '', 0, '', '', null, 'subscription_cancelled').catch(e => {});
      break;
    }

    // ── PAYMENT SUCCEEDED ──
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

      // Sprint 7D: Check if this was a recovery from payment_failed
      try {
        const userResult = await db.query(
          'SELECT id FROM user_profiles WHERE stripe_customer_id = $1',
          [customerId]
        );
        const userId = userResult.rows[0]?.id;

        if (userId) {
          const recentFailure = await db.query(
            `SELECT id FROM subscription_events
             WHERE user_id = $1 AND event_type = 'payment_failed'
             AND created_at > NOW() - INTERVAL '30 days'
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
          );

          if (recentFailure.rows.length > 0) {
            await logSubscriptionEvent(userId, 'payment_recovered', {
              stripeSubId: invoice.subscription,
              stripeEventId: event.id,
              recoveryMethod: 'auto_retry',
              metadata: { invoice_id: invoice.id, amount: invoice.amount_paid / 100 },
            });
            console.log(`[STRIPE] Payment recovered for user: ${userId}`);
          }
        }
      } catch (recoveryErr) {
        console.error('[STRIPE_WARN] Recovery check failed:', recoveryErr.message);
      }
      break;
    }

    // ── PAYMENT FAILED ──
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      console.log(`[STRIPE] Payment failed: ${invoice.customer_email}`);

      // Sprint 7D: Log payment_failed event
      try {
        const userResult = await db.query(
          'SELECT id FROM user_profiles WHERE stripe_customer_id = $1',
          [invoice.customer]
        );
        const userId = userResult.rows[0]?.id;

        if (userId) {
          await logSubscriptionEvent(userId, 'payment_failed', {
            stripeSubId: invoice.subscription,
            stripeEventId: event.id,
            failureReason: invoice.last_finalization_error?.message || 'Payment method declined',
            metadata: { invoice_id: invoice.id, amount_due: invoice.amount_due / 100 },
          });
        }
      } catch (failErr) {
        console.error('[STRIPE_WARN] Payment failed logging error:', failErr.message);
      }

      // Fire GHL webhook for dunning sequence
      if (invoice.customer_email) triggerGHL(invoice.customer_email, '', 0, '', '', null, 'payment_failed').catch(e => {});
      break;
    }
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════
// Sprint 7D: Log subscription lifecycle event to subscription_events table
// ══════════════════════════════════════════════════════════════
async function logSubscriptionEvent(userId, eventType, data = {}) {
  try {
    await db.query(
      `INSERT INTO subscription_events
       (user_id, event_type, stripe_subscription_id, stripe_event_id,
        previous_tier, new_tier, previous_mrr, new_mrr, mrr_delta,
        billing_interval, failure_reason, recovery_method, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [
        userId,
        eventType,
        data.stripeSubId || null,
        data.stripeEventId || null,
        data.previousTier || null,
        data.newTier || null,
        data.previousMrr || 0,
        data.newMrr || 0,
        data.mrrDelta || 0,
        data.billingInterval || null,
        data.failureReason || null,
        data.recoveryMethod || null,
        JSON.stringify(data.metadata || {}),
      ]
    );
  } catch (err) {
    console.error('[STRIPE_ERROR] logSubscriptionEvent:', err.message);
  }
}

module.exports = router;
