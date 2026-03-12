// ============================================================
// lib/errors.js — Error Handling & Retry Logic
// Sprint 0.7: Resilient External API Calls
// ============================================================
// Fixed to work with the actual route code:
//   - scrapeWithRetry(asin) calls scrapeAmazon with retries
//   - callClaudeWithFallback(product, scores, grade, overall, actions) calls Claude with retries
//   - checkStripeIdempotency(eventId) checks/inserts using shared db
// ============================================================

const db = require('./db');

/**
 * Retry wrapper with exponential backoff.
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
 * Scrape Amazon with 3x retry and exponential backoff.
 * Wraps lib/scraper.js scrapeAmazon().
 *
 * @param {string} asin - ASIN to scrape
 * @returns {Promise<Object>} Parsed product data
 */
async function scrapeWithRetry(asin) {
  // Lazy-load to avoid circular dependency
  const { scrapeAmazon } = require('./scraper');
  return withRetry(() => scrapeAmazon(asin), {
    attempts: 3,
    baseDelay: 1000,
    label: 'SCRAPINGDOG',
  });
}

/**
 * Claude API call with retry + fallback template.
 * Wraps lib/plan-generator.js generateImplementationPlan().
 *
 * @param {Object} product - Parsed Amazon product data
 * @param {Object} scores - Category scores
 * @param {string} grade - Overall grade
 * @param {number} overall - Overall score
 * @param {Array} actions - Action items
 * @returns {Promise<Object>} Plan result (real or fallback)
 */
async function callClaudeWithFallback(product, scores, grade, overall, actions) {
  const { generateImplementationPlan } = require('./plan-generator');
  try {
    return await withRetry(() => generateImplementationPlan(product, scores, grade, overall, actions), {
      attempts: 2,
      baseDelay: 5000,
      label: 'CLAUDE_API',
    });
  } catch (err) {
    console.error('[CLAUDE_API_FALLBACK] All retries failed, returning template plan:', err.message);
    return {
      executiveSummary: `Your listing scored ${grade} (${overall}/100) with ${actions.length} areas for improvement.`,
      categoryPlans: actions.map(a => ({
        category: a.category,
        priority: a.priority,
        problem: a.problem,
        steps: [a.solution],
        expectedImpact: 'Score improvement expected after implementation.',
      })),
      quickWins: [
        { action: 'Review your listing title for keyword coverage', timeMinutes: 5, impact: 'Improved search visibility' },
        { action: 'Check all product images meet Amazon requirements', timeMinutes: 10, impact: 'Better click-through rate' },
        { action: 'Verify bullet points highlight key benefits', timeMinutes: 10, impact: 'Higher conversion rate' },
      ],
      _fallback: true,
    };
  }
}

/**
 * Check Stripe webhook event idempotency.
 * Returns true if this event is a DUPLICATE (skip it).
 * Returns false if this event is NEW (process it).
 *
 * @param {string} stripeEventId - The Stripe event ID
 * @returns {Promise<boolean>} true = duplicate (skip), false = new (process)
 */
async function checkStripeIdempotency(stripeEventId) {
  try {
    const result = await db.query(
      'INSERT INTO processed_stripe_events (stripe_event_id) VALUES ($1) ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id',
      [stripeEventId]
    );
    // If a row was returned, the INSERT succeeded — this is a new event
    // If no row returned, the ON CONFLICT fired — this is a duplicate
    return result.rowCount === 0; // true = duplicate
  } catch (err) {
    console.error('[STRIPE_IDEMPOTENCY_ERROR]', err.message);
    return false; // On error, allow processing (don't block payments)
  }
}

module.exports = {
  withRetry,
  scrapeWithRetry,
  callClaudeWithFallback,
  checkStripeIdempotency,
};
