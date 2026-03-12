-- ============================================================
-- SPRINT 0.2: DATABASE IDENTITY UNIFICATION
-- ============================================================
-- Run this migration BEFORE 002_integrity_constraints.sql
-- Run against: Railway PostgreSQL (Supabase)
-- Purpose: Add user_id (UUID) to email-based tables so ALL tables
--          can be joined by user_id for the customer portal and admin.
-- ============================================================

-- Step 1: Add user_id column to analyses
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS user_id UUID;

-- Step 2: Backfill user_id from user_profiles matching by email
UPDATE analyses a SET user_id = up.id
FROM user_profiles up WHERE LOWER(a.email) = LOWER(up.email)
AND a.user_id IS NULL;

-- Step 3: Add user_id column to purchases
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS user_id UUID;

-- Step 4: Backfill user_id in purchases
UPDATE purchases p SET user_id = up.id
FROM user_profiles up WHERE LOWER(p.email) = LOWER(up.email)
AND p.user_id IS NULL;

-- Step 5: Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_analyses_user_id ON analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_user_id ON purchases(user_id);

-- Step 6: Add user_profiles columns needed for future sprints
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bonus_reports INTEGER DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS brand_color VARCHAR(7);

-- ============================================================
-- VERIFICATION QUERIES (run after migration to confirm success)
-- ============================================================
-- SELECT COUNT(*) AS total, COUNT(user_id) AS with_user_id FROM analyses;
-- SELECT COUNT(*) AS total, COUNT(user_id) AS with_user_id FROM purchases;
-- SELECT DISTINCT column_name FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name IN ('referral_code','bonus_reports','brand_name','brand_logo_url','brand_color');
