// ============================================================
// routes/admin.js — Admin Dashboard API Routes
// Sprint 0.1: Create empty, Sprint 7B fills it
// ============================================================
// This file is EMPTY for now. Sprint 7B will add 14 endpoints:
//   GET  /dashboard-stats
//   GET  /mrr-waterfall
//   GET  /customers
//   GET  /customers/:id
//   GET  /cohorts
//   GET  /financials
//   GET  /affiliates
//   POST /customers/:id/gift-credit
//   POST /customers/:id/adjust-tier
//   GET  /export/:type (CSV export)
//   GET  /daily-metrics
//   GET  /revenue-transactions
//   GET  /subscription-events
//   GET  /system-health
// ============================================================

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../lib/middleware');

// Placeholder — confirms admin routes are mounted
router.get('/health', requireAdmin, (req, res) => {
  res.json({ status: 'ok', admin: true, timestamp: new Date().toISOString() });
});

module.exports = router;
