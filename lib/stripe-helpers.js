// ============================================================
// lib/stripe-helpers.js — Stripe Price ID Mapping & Utilities
// Sprint 0.1 / 0.10: Centralize Price IDs for easy test→live cutover
// ============================================================
// Instead of hardcoding Price IDs in 6+ HTML files, reference them here.
// When switching from TEST to LIVE mode, only this file changes.
//
// Usage:
//   const stripe = require('./lib/stripe-helpers');
//   const priceId = stripe.PRICES.SELLER_MONTHLY;
// ============================================================

// ═══ PRICE ID CONFIGURATION ═══
// Currently TEST mode. For Sprint 10 go-live, replace these with LIVE Price IDs.
const PRICES = {
  // One-time products
  IMPLEMENTATION_PLAN:   process.env.STRIPE_PRICE_IMPL_PLAN    || 'price_1T8YvgLhOMEKeqYhtWctJRfE',  // $7
  DOWNSELL_PLAN:         process.env.STRIPE_PRICE_DOWNSELL     || 'price_1T8YvgLhOMEKeqYhASOpwLxu',  // $4.97

  // Seller tier
  SELLER_MONTHLY:        process.env.STRIPE_PRICE_SELLER_MO    || 'price_1T8YvhLhOMEKeqYhIln1TduM',  // $19/mo
  SELLER_ANNUAL:         process.env.STRIPE_PRICE_SELLER_YR    || 'price_1T8YvhLhOMEKeqYhyqxhGszT',  // $149/yr

  // OTO (One-Time Offer) — special funnel price
  OTO_MONTHLY:           process.env.STRIPE_PRICE_OTO_MO       || 'price_1T8YviLhOMEKeqYhja9HXiIt',  // $39/mo

  // Agency tier
  AGENCY_MONTHLY:        process.env.STRIPE_PRICE_AGENCY_MO    || 'price_1T8YviLhOMEKeqYhNj6UVKgk',  // $49/mo
  AGENCY_ANNUAL:         process.env.STRIPE_PRICE_AGENCY_YR    || 'price_1T8YvjLhOMEKeqYhFY1anKa4',  // $449/yr

  // Enterprise tier
  ENTERPRISE_MONTHLY:    process.env.STRIPE_PRICE_ENT_MO       || 'price_1T8YvjLhOMEKeqYh3kcVBOZc',  // $199/mo
  ENTERPRISE_ANNUAL:     process.env.STRIPE_PRICE_ENT_YR       || 'price_1T8YvkLhOMEKeqYheyjYf5S4',  // $1899/yr
};

// ═══ PRICE → TIER MAPPING ═══
// Used by webhook handlers to determine what tier a subscriber should get.
const PRICE_TO_TIER = {
  [PRICES.SELLER_MONTHLY]:     'seller',
  [PRICES.SELLER_ANNUAL]:      'seller',
  [PRICES.OTO_MONTHLY]:        'oto',
  [PRICES.AGENCY_MONTHLY]:     'agency',
  [PRICES.AGENCY_ANNUAL]:      'agency',
  [PRICES.ENTERPRISE_MONTHLY]: 'enterprise',
  [PRICES.ENTERPRISE_ANNUAL]:  'enterprise',
};

// ═══ PRICE → MRR MAPPING (in cents) ═══
// Used for subscription_events MRR calculations.
const PRICE_TO_MRR = {
  [PRICES.SELLER_MONTHLY]:     1900,    // $19.00
  [PRICES.SELLER_ANNUAL]:      1242,    // $149/12 = $12.42/mo
  [PRICES.OTO_MONTHLY]:        3900,    // $39.00
  [PRICES.AGENCY_MONTHLY]:     4900,    // $49.00
  [PRICES.AGENCY_ANNUAL]:      3742,    // $449/12 = $37.42/mo
  [PRICES.ENTERPRISE_MONTHLY]: 19900,   // $199.00
  [PRICES.ENTERPRISE_ANNUAL]:  15825,   // $1899/12 = $158.25/mo
};

/**
 * Get the subscription tier for a given Stripe Price ID.
 * @param {string} priceId
 * @returns {string} Tier name (seller, agency, enterprise, oto) or 'free'
 */
function getTierForPrice(priceId) {
  return PRICE_TO_TIER[priceId] || 'free';
}

/**
 * Get the monthly MRR in cents for a given Stripe Price ID.
 * @param {string} priceId
 * @returns {number} MRR in cents
 */
function getMRRForPrice(priceId) {
  return PRICE_TO_MRR[priceId] || 0;
}

module.exports = {
  PRICES,
  PRICE_TO_TIER,
  PRICE_TO_MRR,
  getTierForPrice,
  getMRRForPrice,
};
