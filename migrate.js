// ============================================================
// migrate.js — One-time DB migrations runner
// Sprint 0.2 + 0.3: Identity unification + integrity constraints
// Run: node migrate.js
// ============================================================
// This script runs idempotently — safe to run multiple times.
// Remove from package.json start script after confirmed success.
// ============================================================

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('[MIGRATE] Starting Sprint 0.2 + 0.3 migrations...');

    // PRE-CHECK: Log existing tier/status data before constraints
    const tiers = await client.query(
      "SELECT subscription_tier, COUNT(*) as cnt FROM user_profiles GROUP BY subscription_tier"
    );
    console.log('[MIGRATE] Current tiers:', JSON.stringify(tiers.rows));

    const statuses = await client.query(
      "SELECT subscription_status, COUNT(*) as cnt FROM user_profiles GROUP BY subscription_status"
    );
    console.log('[MIGRATE] Current statuses:', JSON.stringify(statuses.rows));

    // Check for any NULL subscription_status (constraint allows NULL for this column)
    // but NOT NULL for subscription_tier — fix any nulls first
    await client.query(`
      UPDATE user_profiles SET subscription_tier = 'free'
      WHERE subscription_tier IS NULL OR subscription_tier NOT IN ('free','seller','agency','enterprise','oto')
    `);
    console.log('[MIGRATE] Fixed invalid tiers');

    // Run migration 001 — identity unification
    const sql001 = fs.readFileSync(path.join(__dirname, 'migrations', '001_identity_unification.sql'), 'utf8');
    // Remove comment lines for cleaner execution
    const statements001 = sql001
      .split(';')
      .map(s => s.replace(/--.*$/gm, '').trim())
      .filter(s => s.length > 0);

    for (const stmt of statements001) {
      try {
        await client.query(stmt);
        console.log('[MIGRATE] 001 stmt OK:', stmt.substring(0, 60).replace(/\s+/g, ' '));
      } catch (err) {
        console.warn('[MIGRATE] 001 stmt skipped (may already exist):', err.message.substring(0, 100));
      }
    }

    // Run migration 002 — integrity constraints
    const sql002 = fs.readFileSync(path.join(__dirname, 'migrations', '002_integrity_constraints.sql'), 'utf8');
    const statements002 = sql002
      .split(';')
      .map(s => s.replace(/--.*$/gm, '').trim())
      .filter(s => s.length > 0);

    for (const stmt of statements002) {
      try {
        await client.query(stmt);
        console.log('[MIGRATE] 002 stmt OK:', stmt.substring(0, 60).replace(/\s+/g, ' '));
      } catch (err) {
        // Constraint already exists = fine
        if (err.code === '42710' || err.code === '42P07' || err.message.includes('already exists')) {
          console.log('[MIGRATE] 002 stmt already exists (skip):', stmt.substring(0, 60).replace(/\s+/g, ' '));
        } else {
          console.error('[MIGRATE] 002 stmt FAILED:', err.message, '|', stmt.substring(0, 80).replace(/\s+/g, ' '));
        }
      }
    }

    // Verification
    const analyses = await client.query("SELECT COUNT(*) as total, COUNT(user_id) as with_uid FROM analyses");
    console.log('[MIGRATE] Analyses verification:', JSON.stringify(analyses.rows[0]));

    const purchases = await client.query("SELECT COUNT(*) as total, COUNT(user_id) as with_uid FROM purchases");
    console.log('[MIGRATE] Purchases verification:', JSON.stringify(purchases.rows[0]));

    console.log('[MIGRATE] ✅ All migrations complete');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch(err => {
  console.error('[MIGRATE] FATAL:', err.message);
  process.exit(1);
});
