// MRR calculation utilities for ASIN Analyzer

// Build price ID to MRR mapping from environment variables
const PRICE_TO_MRR = {
  [process.env.STRIPE_PRICE_ID_SELLER_MONTHLY]: 19.00,
  [process.env.STRIPE_PRICE_ID_SELLER_ANNUAL]: 12.42,
  [process.env.STRIPE_PRICE_ID_AGENCY_OTO]: 39.00,
  [process.env.STRIPE_PRICE_ID_AGENCY_MONTHLY]: 49.00,
  [process.env.STRIPE_PRICE_ID_AGENCY_ANNUAL]: 37.42,
  [process.env.STRIPE_PRICE_ID_ENTERPRISE_MONTHLY]: 199.00,
  [process.env.STRIPE_PRICE_ID_ENTERPRISE_ANNUAL]: 158.25
};

// Map price IDs to subscription tiers
const PRICE_TO_TIER = {
  [process.env.STRIPE_PRICE_ID_SELLER_MONTHLY]: 'seller',
  [process.env.STRIPE_PRICE_ID_SELLER_ANNUAL]: 'seller',
  [process.env.STRIPE_PRICE_ID_AGENCY_OTO]: 'agency_power',
  [process.env.STRIPE_PRICE_ID_AGENCY_MONTHLY]: 'agency',
  [process.env.STRIPE_PRICE_ID_AGENCY_ANNUAL]: 'agency',
  [process.env.STRIPE_PRICE_ID_ENTERPRISE_MONTHLY]: 'enterprise',
  [process.env.STRIPE_PRICE_ID_ENTERPRISE_ANNUAL]: 'enterprise'
};

// Map price IDs to billing intervals
const PRICE_TO_INTERVAL = {
  [process.env.STRIPE_PRICE_ID_SELLER_MONTHLY]: 'monthly',
  [process.env.STRIPE_PRICE_ID_SELLER_ANNUAL]: 'yearly',
  [process.env.STRIPE_PRICE_ID_AGENCY_OTO]: 'one-time',
  [process.env.STRIPE_PRICE_ID_AGENCY_MONTHLY]: 'monthly',
  [process.env.STRIPE_PRICE_ID_AGENCY_ANNUAL]: 'yearly',
  [process.env.STRIPE_PRICE_ID_ENTERPRISE_MONTHLY]: 'monthly',
  [process.env.STRIPE_PRICE_ID_ENTERPRISE_ANNUAL]: 'yearly'
};

/**
 * Get MRR value for a given Stripe price ID
 * @param {string} priceId - Stripe price ID
 * @returns {number} MRR value in dollars
 */
function getMrrForPrice(priceId) {
  if (!priceId) return 0;
  return PRICE_TO_MRR[priceId] || 0;
}

/**
 * Get subscription tier for a given Stripe price ID
 * @param {string} priceId - Stripe price ID
 * @returns {string} Subscription tier (seller, agency, agency_power, enterprise)
 */
function getTierForPrice(priceId) {
  if (!priceId) return null;
  return PRICE_TO_TIER[priceId] || null;
}

/**
 * Get billing interval for a given Stripe price ID
 * @param {string} priceId - Stripe price ID
 * @returns {string} Billing interval (monthly, yearly, one-time)
 */
function getIntervalForPrice(priceId) {
  if (!priceId) return null;
  return PRICE_TO_INTERVAL[priceId] || null;
}

/**
 * Calculate the MRR delta when upgrading/downgrading between price IDs
 * @param {string} oldPriceId - Previous Stripe price ID
 * @param {string} newPriceId - New Stripe price ID
 * @returns {number} MRR delta (positive = increase, negative = decrease)
 */
function calculateMrrDelta(oldPriceId, newPriceId) {
  const oldMrr = getMrrForPrice(oldPriceId);
  const newMrr = getMrrForPrice(newPriceId);
  return newMrr - oldMrr;
}

module.exports = {
  PRICE_TO_MRR,
  PRICE_TO_TIER,
  PRICE_TO_INTERVAL,
  getMrrForPrice,
  getTierForPrice,
  getIntervalForPrice,
  calculateMrrDelta
};
