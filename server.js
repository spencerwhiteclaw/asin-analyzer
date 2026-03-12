const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const db = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Version label
const VERSION = 'ASIN Analyzer v4.8 — Sprint 7';

// MIDDLEWARE
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());

// Stripe webhook needs raw body — must be BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Rewardful webhook also needs raw body
app.use('/api/webhooks/rewardful', express.raw({ type: 'application/json' }));

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// ROUTE IMPORTS
const analysisRoutes = require('./routes/analysis');
const authRoutes = require('./routes/auth');
const stripeRoutes = require('./routes/stripe');
const customerRoutes = require('./routes/customer');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');

// MOUNT ROUTES
app.use('/api', analysisRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api', customerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);

// ============================================================================
// PAGE ROUTES
// ============================================================================

// FUNNEL & LANDING PAGES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/features', (req, res) => res.sendFile(path.join(__dirname, 'public', 'features.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));

// AUTH PAGES
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));

// DASHBOARD PAGES
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/analysis/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analysis.html')));

// Dynamic report page with social meta tags
app.get('/report/:id', (req, res) => {
  const reportId = req.params.id;
  const baseUrl = process.env.BASE_URL || 'https://asinanalyzer.com';
  const reportUrl = `${baseUrl}/report/${reportId}`;

  // Fetch report metadata from DB for social meta tags
  db.get('SELECT title, summary FROM reports WHERE id = ?', [reportId], (err, row) => {
    const title = row?.title || 'ASIN Analysis Report';
    const description = row?.summary || 'Detailed ASIN analysis on ASIN Analyzer';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${reportUrl}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <link rel="stylesheet" href="/css/main.css">
</head>
<body>
  <div id="app"></div>
  <script src="/js/report.js"></script>
</body>
</html>`;
    res.send(html);
  });
});

// ============================================================================
// SPRINT 7A: CUSTOMER PORTAL PAGES
// ============================================================================
app.get('/archive', (req, res) => res.sendFile(path.join(__dirname, 'public', 'archive.html')));
app.get('/saved-asins', (req, res) => res.sendFile(path.join(__dirname, 'public', 'saved-asins.html')));

// ============================================================================
// SPRINT 7B: ADMIN PAGES
// ============================================================================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/customers', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/customer/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-customer.html')));
app.get('/admin/cohorts', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-cohorts.html')));
app.get('/admin/financials', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-financials.html')));
app.get('/admin/affiliates', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-affiliates.html')));

// ============================================================================
// SPRINT 7C: AFFILIATE PAGE
// ============================================================================
app.get('/affiliates', (req, res) => res.sendFile(path.join(__dirname, 'public', 'affiliates.html')));

// ============================================================================
// CATCH-ALL (return 404)
// ============================================================================
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

function initDB() {
  return new Promise((resolve, reject) => {
    // Users table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) return reject(err);

      // Customers table
      db.run(`
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          user_id TEXT UNIQUE NOT NULL,
          subscription_status TEXT,
          subscription_plan TEXT,
          stripe_customer_id TEXT UNIQUE,
          subscription_id TEXT,
          credits_used INTEGER DEFAULT 0,
          credits_remaining INTEGER DEFAULT 100,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `, (err) => {
        if (err) return reject(err);

        // Reports table
        db.run(`
          CREATE TABLE IF NOT EXISTS reports (
            id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            asin TEXT NOT NULL,
            title TEXT,
            summary TEXT,
            data JSON,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers(id)
          )
        `, (err) => {
          if (err) return reject(err);

          // Saved ASINs table
          db.run(`
            CREATE TABLE IF NOT EXISTS saved_asins (
              id TEXT PRIMARY KEY,
              customer_id TEXT NOT NULL,
              asin TEXT NOT NULL,
              title TEXT,
              category TEXT,
              tags TEXT,
              notes TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (customer_id) REFERENCES customers(id)
            )
          `, (err) => {
            if (err) return reject(err);

            // Audit log table
            db.run(`
              CREATE TABLE IF NOT EXISTS audit_log (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                action TEXT,
                resource_type TEXT,
                resource_id TEXT,
                details JSON,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
              )
            `, (err) => {
              if (err) return reject(err);

              // Session tokens table
              db.run(`
                CREATE TABLE IF NOT EXISTS session_tokens (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL,
                  token TEXT UNIQUE NOT NULL,
                  expires_at DATETIME NOT NULL,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (user_id) REFERENCES users(id)
                )
              `, (err) => {
                if (err) return reject(err);
                resolve();
              });
            });
          });
        });
      });
    });
  });
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

initDB()
  .then(() => {
    console.log(`[${VERSION}] Database initialized`);

    app.listen(PORT, () => {
      console.log(`[${VERSION}] Server running on port ${PORT}`);

      // ========================================================================
      // CRON JOB SCHEDULING
      // ========================================================================

      const { snapshotDailyMetrics, generateMonthlyFinancialSummary, syncRewardful } = require('./lib/cron');

      setInterval(async () => {
        const now = new Date();

        // Daily metrics snapshot at 11:59 PM (check every 5 minutes, run if approaching midnight)
        if (now.getHours() === 23 && now.getMinutes() >= 55) {
          console.log('[CRON] Running daily metrics snapshot...');
          await snapshotDailyMetrics().catch(e => console.error('[CRON_ERROR] Daily metrics:', e.message));
        }

        // Monthly financial summary on the 1st at 1 AM
        if (now.getDate() === 1 && now.getHours() === 1 && now.getMinutes() < 5) {
          const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          console.log('[CRON] Running monthly financial summary...');
          await generateMonthlyFinancialSummary(lastMonth).catch(e => console.error('[CRON_ERROR] Monthly summary:', e.message));
        }

        // Rewardful sync at 2 AM
        if (now.getHours() === 2 && now.getMinutes() < 5) {
          console.log('[CRON] Running Rewardful sync...');
          await syncRewardful().catch(e => console.error('[CRON_ERROR] Rewardful sync:', e.message));
        }
      }, 5 * 60 * 1000); // Check every 5 minutes
    });
  })
  .catch((err) => {
    console.error(`[${VERSION}] Database initialization failed:`, err.message);
    process.exit(1);
  });

module.exports = app;
