// ============================================================
// lib/email.js — Email sending via Resend
// Extracted from server.js (lines 700-738)
// ============================================================

const fetch = require('node-fetch');

/**
 * Send the report email after analysis completes.
 * Fire-and-forget — never blocks the user experience.
 *
 * @param {string} email - Recipient email
 * @param {Object} report - The full report object from /api/analyze response
 */
async function sendReportEmail(email, report) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !email) return;

  const sender = process.env.SENDER_EMAIL || 'reports@asinanalyzer.app';
  const p = report.product;
  const gradeEmoji = report.overall >= 80 ? '\u{1F7E2}' : report.overall >= 60 ? '\u{1F535}' : report.overall >= 40 ? '\u{1F7E1}' : '\u{1F534}';

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `ASIN Analyzer <${sender}>`,
        to: [email],
        subject: `${gradeEmoji} Your ASIN Report: ${report.asin} scored ${report.grade} (${report.overall}/100)`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h1 style="color:#0F172A;font-size:24px;">Your Listing Diagnosis is Ready</h1>
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:24px;margin:16px 0;text-align:center;">
              <div style="font-size:48px;font-weight:800;color:${report.overall >= 80 ? '#10B981' : report.overall >= 60 ? '#3B82F6' : report.overall >= 40 ? '#F59E0B' : '#EF4444'};">${report.grade}</div>
              <div style="font-size:28px;font-weight:700;color:#0F172A;">${report.overall} / 100</div>
              <div style="font-size:14px;color:#64748B;margin-top:4px;">${p.title ? p.title.substring(0, 80) + '...' : report.asin}</div>
            </div>
            <p style="color:#475569;line-height:1.7;">We found <strong>${report.actions.length} areas for improvement</strong> across your listing's ${Object.keys(report.scores).length} scoring categories.</p>
            <a href="https://asinanalyzer.app/report/${report.id}" style="display:inline-block;padding:14px 32px;background:#3B82F6;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;margin:16px 0;">View Full Report &rarr;</a>
            <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;" />
            <p style="font-size:13px;color:#94A3B8;">&copy; 2026 ASIN Analyzer &middot; <a href="https://asinanalyzer.app" style="color:#3B82F6;">asinanalyzer.app</a></p>
          </div>
        `,
      }),
    });
    console.log(`[EMAIL] Report email sent to ${email}`);
  } catch (err) {
    console.error('[EMAIL_ERROR]', err.message);
  }
}

module.exports = { sendReportEmail };
