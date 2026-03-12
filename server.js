// ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
// ASIN Analyzer v4.7 ΓÇö Server (Sprint 0: Modularized)
// Express backend: all logic extracted into lib/ and routes/
// ┬⌐ 2026 ASIN Analyzer ┬╖ A Gonipless Product
// ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const db = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

// ΓòÉΓòÉΓòÉ MIDDLEWARE ΓòÉΓòÉΓòÉ
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());

// Stripe webhook needs raw body ΓÇö must be BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/api/webhooks/rewardful', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// ΓòÉΓòÉΓòÉ DATABASE INIT ΓòÉΓòÉΓòÉ
async function initDB() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS analyses (
        id SERIAL PRIMARY KEY,
        asin VARCHAR(10) NOT NULL,
        email VARCHAR(255),
        product_title TEXT,
        brand VARCHAR(255),
        price DECIMAL(10,2),
        currency VARCHAR(5) DEFAULT 'USD',
        rating DECIMAL(3,2),
        review_count INTEGER DEFAULT 0,
        bsr INTEGER,
        category VARCHAR(255),
        image_count INTEGER DEFAULT 0,
        bullet_count INTEGER DEFAULT 0,
        has_aplus BOOLEAN DEFAULT FALSE,
        has_video BOOLEAN DEFAULT FALSE,
        qa_count INTEGER DEFAULT 0,
        overall_score INTEGER DEFAULT 0,
        overall_grade VARCHAR(2),
        scores JSONB DEFAULT '{}',
        raw_data JSONB DEFAULT '{}',
        action_items JSONB DEFAULT '[]',
        implementation_plan JSONB,
        user_id UUID,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_asin ON analyses(asin);
      CREATE INDEX IF NOT EXISTS idx_analyses_email ON analyses(email);
      CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at DESC);

      CREATE TABLE IF NOT EXISTS subscribers (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        source VARCHAR(50) DEFAULT 'report',
        subscribed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        active BOOLEAN DEFAULT TRUE
      );
      CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);

      CREATE TABLE IF NOT EXISTS purchases (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        stripe_payment_intent_id VARCHAR(255),
        stripe_session_id VARCHAR(255),
        product VARCHAR(100) NOT NULL,
        amount_cents INTEGER NOT NULL,
        analysis_id INTEGER REFERENCES analyses(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_purchases_email ON purchases(email);

      CREATE TABLE IF NOT EXISTS oto_shown (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        shown_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_oto_shown_email ON oto_shown(email);

      CREATE TABLE IF NOT EXISTS user_profiles (
        id UUID PRIMARY KEY,
        email VARCHAR(255),
        name VARCHAR(255),
        stripe_customer_id VARCHAR(255),
        subscription_tier VARCHAR(50) DEFAULT 'free',
        subscription_status VARCHAR(50) DEFAULT 'inactive',
        stripe_subscription_id VARCHAR(255),
        analyses_this_month INTEGER DEFAULT 0,
        analyses_month_reset TIMESTAMP WITH TIME ZONE DEFAULT (date_trunc('month', NOW()) + interval '1 month'),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
      CREATE INDEX IF NOT EXISTS idx_user_profiles_stripe ON user_profiles(stripe_customer_id);
    `);

    // Sprint 3: saved_asins table
    await db.query(`
      CREATE TABLE IF NOT EXISTS saved_asins (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL,
        asin VARCHAR(10) NOT NULL,
        nickname VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(user_id, asin)
      );
      CREATE INDEX IF NOT EXISTS idx_saved_asins_user ON saved_asins(user_id);
    `).catch(() => {});

    // Sprint 0.7: Stripe webhook idempotency table
    await db.query(`
      CREATE TABLE IF NOT EXISTS processed_stripe_events (
        id SERIAL PRIMARY KEY,
        stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
        processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `).catch(() => {});

    // Migration: add columns if missing
    await db.query(`
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS implementation_plan JSONB;
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS user_id UUID;
    `).catch(() => {});

    console.log('[DB] Tables ready');
  } catch (err) {
    console.error('[DB_ERROR] Init failed (will retry on first request):', err.message);
  }
}

// ΓòÉΓòÉΓòÉ MOUNT ROUTES ΓòÉΓòÉΓòÉ
const analysisRoutes = require('./routes/analysis');
const authRoutes     = require('./routes/auth');
const stripeRoutes   = require('./routes/stripe');
const customerRoutes = require('./routes/customer');
const adminRoutes     = require('./routes/admin');
const webhookRoutes   = require('./routes/webhooks');

app.use('/api',        analysisRoutes);   // /api/analyze, /api/report/:id, /api/compare, etc.
app.use('/api/auth',   authRoutes);       // /api/auth/signup, /api/auth/login, etc.
app.use('/api/stripe', stripeRoutes);     // /api/stripe/webhook, /api/stripe/create-checkout, etc.
app.use('/api',        customerRoutes);   // /api/dashboard, /api/history, /api/saved-asins, etc.
app.use('/api/admin',  adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', webhookRoutes);      // /api/admin/health (Sprint 7B fills the rest)

// ΓòÉΓòÉΓòÉ PAGE ROUTES ΓÇö Social meta tags for reports ΓòÉΓòÉΓòÉ
app.get('/report/:id', async (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isCrawler = /facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|whatsapp|telegrambot/i.test(ua);

  if (isCrawler) {
    try {
      const result = await db.query('SELECT asin, product_title, overall_score, overall_grade, scores FROM analyses WHERE id = $1', [parseInt(req.params.id, 10)]);
      if (result.rows.length > 0) {
        const r = result.rows[0];
        const scoreCount = r.scores ? Object.keys(r.scores).length : 12;
        const gradeEmoji = r.overall_score >= 80 ? '\u{1F7E2}' : r.overall_score >= 60 ? '\u{1F535}' : r.overall_score >= 40 ? '\u{1F7E1}' : '\u{1F534}';
        return res.send(`<!DOCTYPE html><html><head>
          <meta property="og:title" content="${gradeEmoji} ${r.asin} scored ${r.overall_grade} (${r.overall_score}/100) ΓÇö ASIN Analyzer">
          <meta property="og:description" content="${r.product_title ? r.product_title.substring(0, 120) + '...' : r.asin} ΓÇö Scored across ${scoreCount} categories. Free listing audit at asinanalyzer.app">
          <meta property="og:url" content="https://www.asinanalyzer.app/report/${req.params.id}">
          <meta property="og:type" content="website">
          <meta property="og:site_name" content="ASIN Analyzer">
          <meta name="twitter:card" content="summary">
          <meta name="twitter:title" content="${gradeEmoji} ${r.asin}: ${r.overall_grade} (${r.overall_score}/100)">
          <meta name="twitter:description" content="12-point Amazon listing audit. Free at asinanalyzer.app">
          <title>${r.asin} ΓÇö ${r.overall_grade} (${r.overall_score}/100) ΓÇö ASIN Analyzer</title>
        </head><body></body></html>`);
      }
    } catch (e) { /* fall through to normal page */ }
  }

  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

// Funnel pages
app.get('/offer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'offer.html')));
app.get('/downsell', (req, res) => res.sendFile(path.join(__dirname, 'public', 'downsell.html')));
app.get('/upgrade', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upgrade.html')));
app.get('/oto', (req, res) => res.sendFile(path.join(__dirname, 'public', 'oto.html')));
app.get('/thank-you', (req, res) => res.sendFile(path.join(__dirname, 'public', 'thank-you.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// Auth pages
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-password.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));

// Dashboard pages
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/dashboard/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get('/dashboard/account', (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/affiliates', (req, res) => res.sendFile(path.join(__dirname, 'public', 'affiliates.html')));
app.get('/archive', (req, res) => res.sendFile(path.join(__dirname, 'public', 'archive.html')));
app.get('/saved-asins', (req, res) => res.sendFile(path.join(__dirname, 'public', 'saved-asins.html')));
app.get('/compare', (req, res) => res.sendFile(path.join(__dirname, 'public', 'compare.html')));

// Catch-all ΓåÆ landing page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ΓòÉΓòÉΓòÉ START ΓòÉΓòÉΓòÉ
app.listen(PORT, async () => {
  console.log(`[SERVER] ASIN Analyzer v4.7 running on port ${PORT}`);
  await initDB();

  // CRON SCHEDULING
  const { snapshotDailyMetrics, generateMonthlyFinancialSummary, syncRewardful } = require('./lib/cron');
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() >= 55) {
      await snapshotDailyMetrics().catch(e => console.error('[CRON]', e.message));
    }
    if (now.getDate() === 1 && now.getHours() === 1 && now.getMinutes() < 5) {
      await generateMonthlyFinancialSummary(new Date(now.getFullYear(), now.getMonth()-1, 1)).catch(e => console.error('[CRON]', e.message));
    }
    if (now.getHours() === 2 && now.getMinutes() < 5) {
      await syncRewardful().catch(e => console.error('[CRON]', e.message));
    }
  }, 5 * 60 * 1000);
});
