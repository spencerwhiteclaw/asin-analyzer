-- ASIN Analyzer Database Schema
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_analyses_asin ON analyses(asin);
CREATE INDEX idx_analyses_email ON analyses(email);
CREATE INDEX idx_analyses_created ON analyses(created_at DESC);

CREATE TABLE IF NOT EXISTS subscribers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  source VARCHAR(50) DEFAULT 'report',
  subscribed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_subscribers_email ON subscribers(email);
