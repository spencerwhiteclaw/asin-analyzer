const { createClient } = require('@supabase/supabase-js');
const db = require('./db');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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
    const profile = await db.query('SELECT * FROM user_profiles WHERE id = $1', [user.id]);
    req.user = profile.rows[0] || { id: user.id, email: user.email };

    // Update last_active_at on user_profiles
    await db.query(
      'UPDATE user_profiles SET last_active_at = NOW() WHERE id = $1',
      [user.id]
    );

    next();
  } catch (err) {
    console.error('[AUTH_ERROR] requireAuth:', err.message);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

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
    const profile = await db.query('SELECT * FROM user_profiles WHERE id = $1', [user.id]);
    req.user = profile.rows[0] || { id: user.id, email: user.email };
    next();
  } catch (err) {
    req.user = null;
    next();
  }
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const adminRecord = await db.query(
      'SELECT * FROM admin_users WHERE user_id = $1',
      [req.user.id]
    );

    if (!adminRecord.rows || adminRecord.rows.length === 0) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const admin = adminRecord.rows[0];
    req.adminRole = admin.role;
    req.adminPermissions = admin.permissions;

    next();
  } catch (err) {
    console.error('[AUTH_ERROR] requireAdmin:', err.message);
    return res.status(500).json({ error: 'Admin verification error' });
  }
}

async function ownerOnly(req, res, next) {
  try {
    if (req.adminRole !== 'owner') {
      return res.status(403).json({ error: 'Owner access required' });
    }
    next();
  } catch (err) {
    console.error('[AUTH_ERROR] ownerOnly:', err.message);
    return res.status(500).json({ error: 'Authorization error' });
  }
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  ownerOnly
};
