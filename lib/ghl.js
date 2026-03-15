// ============================================================
// lib/ghl.js — GoHighLevel Integration Module
// Extracted from server.js (lines 740-863)
// Uses v2 API (services.leadconnectorhq.com)
// ============================================================
// Usage (fire-and-forget after analysis):
//   const ghl = require('./lib/ghl');
//   ghl.triggerGHL(email, asin, score, grade, reportId, product).catch(() => {});
// ============================================================

const fetch = require('node-fetch');

// ─── GHL Field + Tag IDs (created by Blake 2026-03-07) ─────────────────────
const GHL_FIELDS = {
  asin:           'AjmEDWXPaIE8pE7YKLFC',
  score:          '2Hva7xVzZdQDLn3zuCAo',
  grade:          'o7fvQyzxKKYTupyMfAHt',
  report_url:     'ICJ1witGoPrqNEMFjhLy',
  product_title:  'G4rxjtGllrZrIgMGwQQa',
  analysis_id:    'c6vGNgJDKDRPEp1L0cmD',
  brand:          'nMO0qC7W1JqvUJoS76oL',
  category:       '5Wo6zwcNaNxsNSkbMESE',
  analyses_used:  'nkSbcVipoTpaFPEly32y',
  analyses_limit: 'BhpWsIuULzkZc2RgiGtt',
};

const GHL_TAGS = {
  free_report_user:             'Tnk36y0baCz7M8W5moIL',
  tripwire_buyer:               '5WMzW822x5329OPx6JMP',
  downsell_buyer:               'UjzCQDxEkfJkREHlBLuR',
  active_subscriber:            'L0Gx5rMsDyFlEJ1Fc4jY',
  payment_failed:               '43r4h83B0voPhnXuqCjc',
  subscription_cancelled:       'LfStuU9ScIHQ1MYda2CF',
  nurture_complete_no_purchase: 'vEKV2lnnTYcr8w7yVwpv',
  grade_a: 'gjaSq86xHRSNRty88q4C',
  grade_b: 'FT1dYACltpPEi8hkllO7',
  grade_c: 'wP5SgugTqwh5iyxXyL9X',
  grade_d: 's2eRB3RTPJjM3DHZdNmt',
  grade_f: '7NI8SDRLxhcPMYic5qDs',
};

const GHL_API = 'https://services.leadconnectorhq.com';

function GHL_HDR() {
  return {
    'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
    'Content-Type': 'application/json',
    'Version': '2021-07-28',
  };
}

/**
 * Upsert a contact in GHL with custom fields.
 * Uses v2 API: POST /contacts/upsert
 * @param {string} email
 * @param {Object} customField - key-value pairs where keys are GHL field IDs
 * @returns {Promise<string|null>} contact ID or null
 */
async function ghlUpsertContact(email, customField = {}) {
  if (!process.env.GHL_API_KEY) return null;
  try {
    const res = await fetch(`${GHL_API}/contacts/upsert`, {
      method: 'POST',
      headers: GHL_HDR(),
      body: JSON.stringify({ locationId: process.env.GHL_LOCATION_ID, email, customField }),
    });
    const data = await res.json();
    return data?.contact?.id || data?.id || null;
  } catch (err) {
    console.error('[GHL_ERROR]', new Date().toISOString(), 'ghlUpsertContact', err.message, email);
    return null;
  }
}

/**
 * Add tags to a GHL contact.
 * @param {string} contactId
 * @param {string[]} tagNames - keys from GHL_TAGS (e.g., 'free_report_user')
 */
async function ghlAddTags(contactId, tagNames = []) {
  if (!process.env.GHL_API_KEY || !contactId) return;
  const tags = tagNames.map(t => GHL_TAGS[t]).filter(Boolean);
  if (!tags.length) return;
  try {
    await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
      method: 'POST', headers: GHL_HDR(), body: JSON.stringify({ tags }),
    });
  } catch (err) {
    console.error('[GHL_ERROR]', new Date().toISOString(), 'ghlAddTags', err.message, contactId);
  }
}

/**
 * Main entry point — fire after every analysis or Stripe event.
 *
 * @param {string} email
 * @param {string} asin
 * @param {number} score - overall score (0-100)
 * @param {string} grade - e.g., 'A+', 'B', 'C+', 'F'
 * @param {string|number} reportId - analysis ID
 * @param {Object} product - parsed product data (title, brand, category)
 * @param {string} [event='analysis'] - event type: analysis|purchase|downsell_purchase|subscription_active|payment_failed|subscription_cancelled
 */
async function triggerGHL(email, asin, score, grade, reportId, product, event = 'analysis') {
  if (!process.env.GHL_API_KEY) return;
  try {
    const customField = {
      [GHL_FIELDS.asin]:          asin || '',
      [GHL_FIELDS.score]:         score || 0,
      [GHL_FIELDS.grade]:         grade || '',
      [GHL_FIELDS.report_url]:    `https://asinanalyzer.app/report/${reportId}`,
      [GHL_FIELDS.product_title]: product?.title || '',
      [GHL_FIELDS.brand]:         product?.brand || '',
      [GHL_FIELDS.category]:      product?.category || '',
      [GHL_FIELDS.analysis_id]:   reportId || '',
    };

    const contactId = await ghlUpsertContact(email, customField);

    // Determine tags based on event type
    const tagsToAdd = [];
    if (event === 'analysis') {
      tagsToAdd.push('free_report_user');
      // Add grade tag (e.g., grade_a, grade_b, etc.)
      const gradeKey = `grade_${(grade || '').toLowerCase().replace(/[^a-f]/g, '')}`;
      if (GHL_TAGS[gradeKey]) tagsToAdd.push(gradeKey);
    } else if (event === 'purchase')               tagsToAdd.push('tripwire_buyer');
    else if (event === 'downsell_purchase')         tagsToAdd.push('downsell_buyer');
    else if (event === 'subscription_active')       tagsToAdd.push('active_subscriber');
    else if (event === 'payment_failed')            tagsToAdd.push('payment_failed');
    else if (event === 'subscription_cancelled')    tagsToAdd.push('subscription_cancelled');

    await ghlAddTags(contactId, tagsToAdd);

    console.log(`[GHL] ${email} → upserted, tags: [${tagsToAdd.join(', ')}]`);
  } catch (err) {
    console.error('[GHL_ERROR]', new Date().toISOString(), 'triggerGHL', err.message, email);
  }
}

module.exports = {
  GHL_FIELDS,
  GHL_TAGS,
  ghlUpsertContact,
  ghlAddTags,
  triggerGHL,
};
