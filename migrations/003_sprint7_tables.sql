-- ============================================================
-- Migration 003: Sprint 7 — Back Office Tables
-- 8 new tables + user_profiles column additions + indexes
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- ============================================================

-- ═══ TABLE 1: admin_users ═══
CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  role VARCHAR(50) NOT NULL DEFAULT 'admin',          -- owner, manager, viewer
  permissions JSONB DEFAULT '{}',                      -- {can_export, can_edit_customers, can_manage_billing, can_view_financials}
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID
);

-- ═══ TABLE 2: admin_activity_log ═══
CREATE TABLE IF NOT EXISTS admin_activity_log (
  id SERIAL PRIMARY KEY,
  admin_user_id UUID NOT NULL,
  action VARCHAR(100) NOT NULL,                        -- grant_credit, extend_billing, change_tier, add_note, export_data, login
  target_user_id UUID,
  details JSONB DEFAULT '{}',                          -- {old_value, new_value, reason, ip_address}
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ TABLE 3: customer_credits ═══
CREATE TABLE IF NOT EXISTS customer_credits (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  credit_type VARCHAR(50) NOT NULL,                    -- bonus_reports, free_month, billing_extension
  amount INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  granted_by UUID NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ TABLE 4: subscription_events ═══
CREATE TABLE IF NOT EXISTS subscription_events (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,                     -- subscription_created, subscription_upgraded, subscription_downgraded,
                                                       -- subscription_cancelled, subscription_reactivated, subscription_expired,
                                                       -- payment_failed, payment_recovered, billing_interval_changed,
                                                       -- trial_started, trial_converted
  stripe_subscription_id VARCHAR(255),
  stripe_event_id VARCHAR(255) UNIQUE,                 -- Deduplication key
  previous_tier VARCHAR(50),
  new_tier VARCHAR(50),
  previous_mrr DECIMAL(10,2) DEFAULT 0,
  new_mrr DECIMAL(10,2) DEFAULT 0,
  mrr_delta DECIMAL(10,2) DEFAULT 0,
  billing_interval VARCHAR(20),                        -- monthly or yearly
  failure_reason TEXT,
  recovery_method VARCHAR(50),                         -- auto_retry, card_update, admin_action
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ TABLE 5: affiliates ═══
CREATE TABLE IF NOT EXISTS affiliates (
  id SERIAL PRIMARY KEY,
  rewardful_id VARCHAR(255) UNIQUE,
  user_id UUID,
  name VARCHAR(255),
  email VARCHAR(255),
  referral_code VARCHAR(50) UNIQUE,
  commission_rate DECIMAL(5,2) DEFAULT 40.00,          -- 40% flat recurring
  total_referrals INTEGER DEFAULT 0,
  active_subscribers INTEGER DEFAULT 0,
  total_revenue DECIMAL(10,2) DEFAULT 0,
  total_commissions DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',                 -- active, paused, suspended
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ
);

-- ═══ TABLE 6: affiliate_referrals ═══
CREATE TABLE IF NOT EXISTS affiliate_referrals (
  id SERIAL PRIMARY KEY,
  affiliate_id INTEGER REFERENCES affiliates(id),
  referred_user_id UUID,
  referred_email VARCHAR(255),
  subscription_tier VARCHAR(50),
  mrr_value DECIMAL(10,2) DEFAULT 0,
  commission_earned DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',                 -- active, churned, refunded
  rewardful_referral_id VARCHAR(255),
  converted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ TABLE 7: business_metrics_daily ═══
CREATE TABLE IF NOT EXISTS business_metrics_daily (
  id SERIAL PRIMARY KEY,
  date DATE UNIQUE NOT NULL,
  total_users INTEGER DEFAULT 0,
  total_email_captures INTEGER DEFAULT 0,
  new_email_captures INTEGER DEFAULT 0,
  free_users INTEGER DEFAULT 0,
  seller_monthly INTEGER DEFAULT 0,
  seller_annual INTEGER DEFAULT 0,
  agency_monthly INTEGER DEFAULT 0,
  agency_annual INTEGER DEFAULT 0,
  enterprise_monthly INTEGER DEFAULT 0,
  enterprise_annual INTEGER DEFAULT 0,
  mrr DECIMAL(10,2) DEFAULT 0,
  arr DECIMAL(10,2) DEFAULT 0,
  new_mrr DECIMAL(10,2) DEFAULT 0,
  expansion_mrr DECIMAL(10,2) DEFAULT 0,
  contraction_mrr DECIMAL(10,2) DEFAULT 0,
  churned_mrr DECIMAL(10,2) DEFAULT 0,
  net_new_mrr DECIMAL(10,2) DEFAULT 0,
  daily_revenue DECIMAL(10,2) DEFAULT 0,
  tripwire_purchases INTEGER DEFAULT 0,
  downsell_purchases INTEGER DEFAULT 0,
  reports_generated INTEGER DEFAULT 0,
  new_subscriptions INTEGER DEFAULT 0,
  cancellations INTEGER DEFAULT 0,
  failed_payments INTEGER DEFAULT 0,
  recovered_payments INTEGER DEFAULT 0,
  churn_rate DECIMAL(5,4) DEFAULT 0,
  affiliate_referrals INTEGER DEFAULT 0,
  affiliate_revenue DECIMAL(10,2) DEFAULT 0,
  organic_revenue DECIMAL(10,2) DEFAULT 0
);

-- ═══ TABLE 8: financial_summaries_monthly ═══
CREATE TABLE IF NOT EXISTS financial_summaries_monthly (
  id SERIAL PRIMARY KEY,
  month DATE UNIQUE NOT NULL,                          -- First day of month (e.g. 2026-03-01)
  gross_revenue DECIMAL(10,2) DEFAULT 0,
  refunds DECIMAL(10,2) DEFAULT 0,
  net_revenue DECIMAL(10,2) DEFAULT 0,
  stripe_fees DECIMAL(10,2) DEFAULT 0,
  affiliate_commissions DECIMAL(10,2) DEFAULT 0,
  rewardful_cost DECIMAL(10,2) DEFAULT 49.00,
  infrastructure_cost DECIMAL(10,2) DEFAULT 0,
  estimated_margin DECIMAL(10,2) DEFAULT 0,
  margin_percentage DECIMAL(5,2) DEFAULT 0,
  starting_mrr DECIMAL(10,2) DEFAULT 0,
  ending_mrr DECIMAL(10,2) DEFAULT 0,
  mrr_growth_rate DECIMAL(5,2) DEFAULT 0,
  total_subscribers_start INTEGER DEFAULT 0,
  total_subscribers_end INTEGER DEFAULT 0,
  new_subscribers INTEGER DEFAULT 0,
  churned_subscribers INTEGER DEFAULT 0,
  net_subscriber_growth INTEGER DEFAULT 0,
  arpu DECIMAL(10,2) DEFAULT 0,
  ltv_estimate DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ USER_PROFILES MIGRATIONS ═══
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bonus_reports INTEGER DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS billing_extended_until TIMESTAMPTZ;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referred_by VARCHAR(50);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50) UNIQUE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS lifetime_reports INTEGER DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS first_paid_at TIMESTAMPTZ;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS acquisition_channel VARCHAR(50) DEFAULT 'organic';

-- ═══ INDEXES ═══
CREATE INDEX IF NOT EXISTS idx_user_profiles_tier ON user_profiles(subscription_tier);
CREATE INDEX IF NOT EXISTS idx_user_profiles_status ON user_profiles(subscription_status);
CREATE INDEX IF NOT EXISTS idx_user_profiles_channel ON user_profiles(acquisition_channel);
CREATE INDEX IF NOT EXISTS idx_subscription_events_user ON subscription_events(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_type ON subscription_events(event_type);
CREATE INDEX IF NOT EXISTS idx_subscription_events_created ON subscription_events(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_activity_created ON admin_activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_business_metrics_date ON business_metrics_daily(date);
CREATE INDEX IF NOT EXISTS idx_financial_summaries_month ON financial_summaries_monthly(month);
CREATE INDEX IF NOT EXISTS idx_affiliates_email ON affiliates(email);
CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_affiliate ON affiliate_referrals(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_customer_credits_user ON customer_credits(user_id);
