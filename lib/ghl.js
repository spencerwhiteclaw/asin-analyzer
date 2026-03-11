// ============================================================
// lib/ghl.js — GoHighLevel Contact Upsert Module
// Sprint 0.4: GHL Integration
// ============================================================
// This module pushes analysis data to GHL so email workflows
// have real merge fields (asin, score, grade, report URL, etc.)
// WITHOUT THIS, ALL PERSONALIZED EMAIL FIELDS ARE BLANK.
//
// Usage:
//   const ghl = require('./lib/ghl');
//   // After analysis completes (fire-and-forget):
//   ghl.upsertContact({ email, customFields, tags }).catch(() => {});
// ============================================================

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

if (!GHL_API_KEY) console.warn('[GHL] WARNING: GHL_API_KEY not set — contact upserts will fail silently');
if (!GHL_LOCATION_ID) console.warn('[GHL] WARNING: GHL_LOCATION_ID not set — contact upserts will fail silently');

/**
 * Upsert a contact in GHL with custom fields and tags.
 * GHL's POST /contacts endpoint creates OR updates based on email match.
 *
 * @param {Object} opts
 * @param {string} opts.email - Contact email (required)
 * @param {string} [opts.firstName] - First name (optional)
 * @param {Object} [opts.customFields] - Key-value custom field data
 * @param {string[]} [opts.tags] - Tags to apply (triggers workflows)
 * @returns {Promise<Response|undefined>}
 */
async function upsertContact({ email, firstName, customFields, tags }) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.error('[GHL_ERROR]', new Date().toISOString(), 'upsertContact', 'MISSING_CONFIG', email);
    return;
  }

  try {
    const response = await fetch('https://rest.gohighlevel.com/v1/contacts/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        firstName: firstName || undefined,
        locationId: GHL_LOCATION_ID,
        customField: customFields,
        tags,
      }),
    });

    if (!response.ok) {
      console.error('[GHL_ERROR]', new Date().toISOString(), 'upsertContact', response.status, email);
    }

    return response;
  } catch (err) {
    // GHL failures NEVER block the user experience
    console.error('[GHL_ERROR]', new Date().toISOString(), 'upsertContact', err.message, email);
  }
}

/**
 * Determine which GHL tag to apply based on user state.
 * The tag determines which GHL workflow fires.
 *
 * @param {Object} user - User profile from DB (or null for unauthenticated)
 * @param {boolean} hasPriorAnalysis - Whether the email has prior analyses
 * @param {boolean} hasPurchase - Whether the email has a $7/$4.97 purchase
 * @returns {string} GHL tag name
 */
function determineTag(user, hasPriorAnalysis, hasPurchase) {
  if (user && ['enterprise'].includes(user.subscription_tier)) {
    return 'enterprise-report-run';
  }
  if (user && ['seller', 'agency', 'oto'].includes(user.subscription_tier)) {
    return 'subscriber-report-run';
  }
  if (hasPurchase) {
    return 'buyer-not-subscribed';
  }
  if (hasPriorAnalysis) {
    return 'repeat-analyzer';
  }
  return 'free-report-nurture';
}

/**
 * Push analysis results to GHL after a successful analysis.
 * Call this FIRE-AND-FORGET in routes/analysis.js:
 *
 *   ghl.pushAnalysisToGHL({ ... }).catch(() => {});
 *
 * @param {Object} opts - Analysis result data
 */
async function pushAnalysisToGHL({
  email,
  asin,
  overallScore,
  overallGrade,
  analysisId,
  productTitle,
  weakestCategory,
  strongestCategory,
  totalReportsForUser,
  user,
  hasPriorAnalysis,
  hasPurchase,
}) {
  return upsertContact({
    email,
    customFields: {
      asin,
      last_score: overallScore,
      last_grade: overallGrade,
      report_url: `https://asinanalyzer.app/report?id=${analysisId}`,
      product_title: (productTitle || '').substring(0, 200),
      weakest_category: weakestCategory,
      strongest_category: strongestCategory,
      total_reports: totalReportsForUser,
      subscription_tier: user?.subscription_tier || 'free',
    },
    tags: [determineTag(user, hasPriorAnalysis, hasPurchase)],
  });
}

module.exports = {
  upsertContact,
  determineTag,
  pushAnalysisToGHL,
};
