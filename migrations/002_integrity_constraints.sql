-- ============================================================
-- SPRINT 0.3: DATABASE INTEGRITY CONSTRAINTS
-- ============================================================
-- Run this AFTER 001_identity_unification.sql
-- Run against: Railway PostgreSQL (Supabase)
-- Purpose: Add CHECK constraints to prevent garbage data.
-- ============================================================

-- IMPORTANT: Before running, check for bad data that would violate constraints:
-- SELECT DISTINCT subscription_tier FROM user_profiles;
-- SELECT DISTINCT subscription_status FROM user_profiles;
-- Fix any values not in the allowed lists below BEFORE running this script.

-- Enforce valid subscription tiers (prevent garbage data)
ALTER TABLE user_profiles ADD CONSTRAINT chk_tier
  CHECK (subscription_tier IN ('free','seller','agency','enterprise','oto'));

-- Enforce valid subscription statuses
ALTER TABLE user_profiles ADD CONSTRAINT chk_status
  CHECK (subscription_status IN ('active','past_due','cancelled','expired','trialing'));

-- Email must never be null on user profiles
ALTER TABLE user_profiles ALTER COLUMN email SET NOT NULL;

-- Fix oto_shown: currently per-email-forever, should be per-analysis
ALTER TABLE oto_shown DROP CONSTRAINT IF EXISTS oto_shown_email_key;
ALTER TABLE oto_shown ADD COLUMN IF NOT EXISTS analysis_id INTEGER;
ALTER TABLE oto_shown ADD CONSTRAINT oto_shown_email_analysis UNIQUE(email, analysis_id);

-- ============================================================
-- SPRINT 0.7: Stripe webhook idempotency table
-- ============================================================
CREATE TABLE IF NOT EXISTS processed_stripe_events (
  id SERIAL PRIMARY KEY,
  stripe_event_id TEXT UNIQUE NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
-- INSERT INTO user_profiles (id, email, subscription_tier) VALUES (gen_random_uuid(), 'test@test.com', 'invalid_tier');
-- ^ This should FAIL with constraint violation — that's correct behavior.
