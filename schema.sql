-- ASIN Analyzer v3.0 Database Schema
-- Tables auto-create on server startup, this file is for reference

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
