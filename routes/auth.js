// ============================================================
// routes/auth.js — Authentication Routes (Supabase)
// Extracted from server.js (lines 1509-1692)
// ============================================================

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const db = require('../lib/db');
const { requireAuth } = require('../lib/middleware');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// ── POST /api/auth/signup ──
router.post('/signup', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    // Create Supabase auth user
    const { data, error } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true, // Auto-confirm since they already verified email during analysis
    });

    if (error) {
      if (error.message.includes('already registered')) {
        return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
      }
      return res.status(400).json({ error: error.message });
    }

    // Create user_profiles row
    await db.query(
      `INSERT INTO user_profiles (id, email, name, subscription_tier, subscription_status)
       VALUES ($1, $2, $3, 'free', 'inactive')
       ON CONFLICT (id) DO UPDATE SET name = $3`,
      [data.user.id, email.trim().toLowerCase(), name || null]
    );

    // Link any existing analyses to this user
    await db.query(
      'UPDATE analyses SET user_id = $1 WHERE LOWER(email) = $2 AND user_id IS NULL',
      [data.user.id, email.trim().toLowerCase()]
    );

    // Direct sign-in with password for immediate session
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: session, error: sessErr } = await supabaseClient.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (sessErr) {
      return res.json({ success: true, error: 'Account created but auto-login failed. Please log in manually.' });
    }

    console.log(`[AUTH] New account: ${email}`);
    res.json({ session: session.session, user: data.user });
  } catch (err) {
    console.error('[AUTH_ERROR] Signup:', err.message);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// ── POST /api/auth/login ──
router.post('/login', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    console.log(`[AUTH] Login: ${email}`);
    res.json({ session: data.session, user: data.user });
  } catch (err) {
    console.error('[AUTH_ERROR] Login:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// ── GET /api/auth/google — Return Google OAuth URL ──
router.get('/google', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'https://www.asinanalyzer.app/dashboard' },
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.url });
  } catch (err) {
    res.status(500).json({ error: 'Google auth unavailable.' });
  }
});

// ── POST /api/auth/magic-link ──
router.post('/magic-link', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error } = await supabaseClient.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: 'https://www.asinanalyzer.app/dashboard' },
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send magic link.' });
  }
});

// ── POST /api/auth/forgot-password ──
router.post('/forgot-password', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error } = await supabaseClient.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo: 'https://www.asinanalyzer.app/reset-password' }
    );

    // Always return success to prevent email enumeration
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true });
  }
});

// ── POST /api/auth/reset-password ──
router.post('/reset-password', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required.' });

  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters.' });

    const { error } = await supabase.auth.admin.updateUserById(
      (await supabase.auth.getUser(token)).data.user.id,
      { password }
    );

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ── POST /api/auth/change-password (authenticated) ──
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters.' });

    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

module.exports = router;
