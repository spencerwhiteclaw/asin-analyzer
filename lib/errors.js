// ============================================================
// lib/errors.js — Error Handling & Retry Logic
// Sprint 0.7: Resilient External API Calls
// ============================================================
// Usage:
//   const { scrapeWithRetry, callClaudeWithFallback, checkStripeIdempotency } = require('./lib/errors');
// ============================================================

/**
 * Retry wrapper with exponential backoff.
 * Used for Scrapingdog and any other flaky external API.
 *
 * @param {Function} fn - Async function to call
 * @param {Object} [opts]
 * @param {number} [opts.attempts=3] - Max attempts
 * @param {number} [opts.baseDelay=1000] - Base delay in ms (doubles each retry)
 * @param {string} [opts.label='API'] - Label for error logging
 * @returns {Promise<*>} Result of fn()
 */
async function withRetry(fn, opts = {}) {
  const { attempts = 3, baseDelay = 1000, label = 'API' } = opts;
  let lastError;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(`[${label}_RETRY] Attempt ${i + 1}/${attempts} failed:`, err.message);
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
      }
    }
  }

  throw lastError;
}

/**
 * Scrapingdog scrape with 3x retry and exponential backoff.
 *
 * @param {Function} scrapeFn - The actual scrape function (e.g., () => scrapingdog.scrape(url))
 * @returns {Promise<*>} Scrape result
 */
async function scrapeWithRetry(scrapeFn) {
  return withRetry(scrapeFn, {
    attempts: 3,
    baseDelay: 1000,
    label: 'SCRAPINGDOG',
  });
}

/**
 * Claude API call with 1x retry and fallback template.
 * If all retries fail, returns a basic template plan instead of erroring.
 *
 * @param {Function} claudeFn - The actual Claude API call
 * @param {Object} fallbackContext - Data for the fallback template
 * @param {string} fallbackContext.asin - The ASIN being analyzed
 * @param {string} fallbackContext.grade - Overall grade
 * @param {number} fallbackContext.score - Overall score
 * @returns {Promise<Object>} Plan result (real or fallback)
 */
async function callClaudeWithFallback(claudeFn, fallbackContext) {
  try {
    return await withRetry(claudeFn, {
      attempts: 2,
      baseDelay: 5000,
      label: 'CLAUDE_API',
    });
  } catch (err) {
    console.error('[CLAUDE_API_FALLBACK] All retries failed, returning template plan:', err.message);

    // Return a generic but useful fallback plan
    return {
      titleRewrite: {
        before: 'Your current title',
        after: `[AI plan generation temporarily unavailable — please regenerate from your report page]`,
      },
      bulletRewrites: [],
      executiveSummary: `Your listing scored ${fallbackContext.score}/100 (${fallbackContext.grade}). Our AI plan generator is temporarily processing a high volume of requests. Please return to your report and click "Generate Plan" again in a few minutes for your full personalized implementation plan.`,
      quickWins: [
        { action: 'Review your listing title for keyword coverage', timeMinutes: 5, impact: 'Improved search visibility' },
        { action: 'Check all product images meet Amazon requirements', timeMinutes: 10, impact: 'Better click-through rate' },
        { action: 'Verify bullet points highlight key benefits', timeMinutes: 10, impact: 'Higher conversion rate' },
      ],
      _fallback: true,
      _retryMessage: 'Your implementation plan is being prepared. Check back in a few minutes for your full personalized plan.',
    };
  }
}

/**
 * Check Stripe webhook event idempotency.
 * Prevents duplicate processing of the same webhook event.
 *
 * @param {Object} db - Database pool/client with .query()
 * @param {string} stripeEventId - The Stripe event ID (e.g., 'evt_1234567890')
 * @returns {Promise<boolean>} true if this is a NEW event (process it), false if duplicate (skip it)
 */
async function checkStripeIdempotency(db, stripeEventId) {
  try {
    const existing = await db.query(
      'SELECT id FROM processed_stripe_events WHERE stripe_event_id = $1',
      [stripeEventId]
    );

    if (existing.rowCount > 0) {
      console.log('[STRIPE_WEBHOOK] Duplicate event skipped:', stripeEventId);
      return false; // Already processed
    }

    // Mark as processed
    await db.query(
      'INSERT INTO processed_stripe_events (stripe_event_id) VALUES ($1)',
      [stripeEventId]
    );

    return true; // New event — process it
  } catch (err) {
    // If the insert fails due to unique constraint (race condition), treat as duplicate
    if (err.code === '23505') {
      console.log('[STRIPE_WEBHOOK] Duplicate event (race):', stripeEventId);
      return false;
    }
    // For other errors, log but allow processing (better to double-process than miss)
    console.error('[STRIPE_WEBHOOK] Idempotency check error:', err.message);
    return true;
  }
}

module.exports = {
  withRetry,
  scrapeWithRetry,
  callClaudeWithFallback,
  checkStripeIdempotency,
};
