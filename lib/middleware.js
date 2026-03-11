// ============================================================
// lib/middleware.js — Auth & Access Control Middleware
// Sprint 0.1: Server Modularization
// ============================================================
// Extract these from the current server.js and place them here.
// DO NOT change any logic — just move them into this file.
//
// Usage:
//   const { requireAuth, optionalAuth, requireAdmin } = require('./lib/middleware');
//   router.get('/api/my-account', requireAuth, handler);
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const db = require('./db');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * requireAuth — Request MUST have a valid Supabase token.
 * Sets req.user with the full user_profiles row.
 * Returns 401 if no token or invalid token.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get full user profile
    const profile = await db.query(
      'SELECT * FROM user_profiles WHERE id = $1',
      [user.id]
    );

    req.user = profile.rows[0] || { id: user.id, email: user.email };
    next();
  } catch (err) {
    console.error('[AUTH_ERROR] requireAuth:', err.message);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * optionalAuth — If a token is present, validate it and set req.user.
 * If no token or invalid token, continue without req.user (req.user = null).
 * Never returns 401.
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      req.user = null;
      return next();
    }

    const profile = await db.query(
      'SELECT * FROM user_profiles WHERE id = $1',
      [user.id]
    );

    req.user = profile.rows[0] || { id: user.id, email: user.email };
    next();
  } catch (err) {
    req.user = null;
    next();
  }
}

/**
 * requireAdmin — Requires authentication AND admin role.
 * For Sprint 7B admin dashboard endpoints.
 * Returns 403 if user is not an admin.
 */
async function requireAdmin(req, res, next) {
  // First run requireAuth
  await requireAuth(req, res, () => {
    if (!req.user) return; // requireAuth already sent 401

    // Check admin role (owner email or admin_users table)
    // For now, check against ADMIN_EMAILS env var (comma-separated)
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());

    if (!adminEmails.includes(req.user.email?.toLowerCase())) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  });
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  supabase,
};
