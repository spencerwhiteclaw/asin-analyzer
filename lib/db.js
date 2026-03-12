// ============================================================
// lib/db.js — Database Pool Configuration
// Sprint 0.1: Server Modularization
// ============================================================
// Centralizes the database connection pool.
// All route files import from here instead of creating their own pools.
//
// Usage:
//   const db = require('./lib/db');
//   const result = await db.query('SELECT * FROM analyses WHERE id = $1', [id]);
// ============================================================

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log pool errors (don't crash the server)
pool.on('error', (err) => {
  console.error('[DB_POOL_ERROR] Unexpected error on idle client:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
