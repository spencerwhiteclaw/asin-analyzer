// ═══════════════════════════════════════════════════════════════
// ASIN Analyzer v3.0 — Server (Sprint 1 + Sprint 2: Complete)
// Express backend: scraping, 12-point scoring w/ content split,
// implementation plan via Claude API, Stripe payments, GHL webhook,
// Supabase auth, user dashboard, quota enforcement, billing management
// © 2026 ASIN Analyzer · A Gonipless Product
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const fetch = require('node-fetch');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══ MIDDLEWARE ═══
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

// Stripe webhook needs raw body — must be BEFORE express.json for that route
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.static(path.join(__dirname, 'public')));

// ═══ DATABASE ═══
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ═══ ANTHROPIC CLIENT ═══
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ═══ STRIPE ═══
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// ═══ SUPABASE (Auth) ═══
const { createClient } = require('@supabase/supabase-js');
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// ═══ TIER CONFIGURATION ═══
const TIER_LIMITS = {
  free: 1,         // 1 report ever (not per month)
  seller: 10,      // per month
  agency_power: 100,
  agency: 50,
  enterprise: 300,
};
const TIER_NAMES = {
  free: 'Free', seller: 'Seller', agency_power: 'Agency Power',
  agency: 'Agency', enterprise: 'Enterprise',
};

// Auto-create tables on startup
async function initDB() {
  try {
    await pool.query(`
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

    // Sprint 3: saved_asins table for multi-ASIN dashboard
    await pool.query(`
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

    // Keyword rank tracking table (Sprint 5.1)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS keyword_rankings (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL,
        asin VARCHAR(10) NOT NULL,
        keyword VARCHAR(500) NOT NULL,
        rank INTEGER,
        page INTEGER,
        checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kw_user_asin ON keyword_rankings(user_id, asin);
      CREATE INDEX IF NOT EXISTS idx_kw_checked ON keyword_rankings(checked_at DESC);
    `).catch(() => {});

    // Add implementation_plan column if missing (migration for existing DBs)
    await pool.query(`
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS implementation_plan JSONB;
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS user_id UUID;
    `).catch(() => {});

    // Add extension_api_key column to user_profiles (Sprint 6.1)
    await pool.query(`
      ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS extension_api_key VARCHAR(64);
    `).catch(() => {});

    console.log('✅ Database tables ready');
  } catch (err) {
    console.error('⚠️  Database init failed (will retry on first request):', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMITING — 1 free report per email, ever
// ═══════════════════════════════════════════════════════════════

async function checkEmailLimit(email) {
  if (!email) return { allowed: false, reason: 'Email is required to run a free report.' };

  const cleanEmail = email.trim().toLowerCase();

  // Check if this email has EVER run a free analysis
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM analyses WHERE LOWER(email) = $1',
    [cleanEmail]
  );
  const count = parseInt(result.rows[0].count, 10);

  if (count > 0) {
    return {
      allowed: false,
      reason: 'You\'ve already used your free report. Upgrade to the Seller Plan for 10 reports per month.',
      upgradeRequired: true,
    };
  }

  return { allowed: true };
}

// ═══════════════════════════════════════════════════════════════
// SCRAPING — Scrapingdog (single HTML fetch)
// ═══════════════════════════════════════════════════════════════

async function scrapeAmazon(asin) {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) throw new Error('SCRAPINGDOG_API_KEY not configured');

  const amazonUrl = `https://www.amazon.com/dp/${asin}`;
  const scraperUrl = `https://api.scrapingdog.com/scrape?api_key=${apiKey}&url=${encodeURIComponent(amazonUrl)}&dynamic=true`;

  console.log(`🔍 Scraping ${asin} via Scrapingdog...`);
  const resp = await fetch(scraperUrl, { timeout: 60000 });

  if (!resp.ok) {
    throw new Error(`Scrapingdog returned ${resp.status}: ${resp.statusText}`);
  }

  const html = await resp.text();
  if (html.length < 1000) {
    throw new Error('Amazon returned empty or blocked page. Try again.');
  }

  return parseAmazonHTML(html, asin);
}

// ═══════════════════════════════════════════════════════════════
// HTML PARSING — Extract product data from raw Amazon HTML
// ═══════════════════════════════════════════════════════════════

function parseAmazonHTML(html, asin) {
  const product = {
    asin,
    title: '',
    brand: '',
    price: 0,
    currency: 'USD',
    rating: 0,
    reviewCount: 0,
    bsr: 0,
    category: '',
    imageCount: 0,
    bulletCount: 0,
    bulletLengths: [],
    hasAPlus: false,
    hasVideo: false,
    qaCount: 0,
    descriptionLength: 0,
  };

  // Title
  const titleMatch = html.match(/<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i);
  if (titleMatch) product.title = titleMatch[1].trim();

  // Brand
  const brandMatch = html.match(/id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/i)
    || html.match(/Brand[:\s]*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
    || html.match(/"brand"\s*:\s*"([^"]+)"/i);
  if (brandMatch) {
    product.brand = brandMatch[1].replace(/<[^>]+>/g, '').replace(/Visit the |Brand: |Store/gi, '').trim();
  }

  // Price
  const priceMatch = html.match(/class="a-price-whole"[^>]*>(\d+[\d,]*)/i)
    || html.match(/priceAmount["\s:]+(\d+\.?\d*)/i)
    || html.match(/\$(\d+\.?\d{0,2})/);
  if (priceMatch) {
    const fractionMatch = html.match(/class="a-price-fraction"[^>]*>(\d+)/i);
    const whole = priceMatch[1].replace(/,/g, '');
    const fraction = fractionMatch ? fractionMatch[1] : '00';
    product.price = parseFloat(`${whole}.${fraction}`);
  }

  // Rating
  const ratingMatch = html.match(/(\d+\.?\d*)\s*out of\s*5\s*stars?/i)
    || html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)/i)
    || html.match(/class="a-icon-alt"[^>]*>(\d+\.?\d*) out of 5/i);
  if (ratingMatch) product.rating = parseFloat(ratingMatch[1]);

  // Review Count
  const reviewMatch = html.match(/id="acrCustomerReviewText"[^>]*>([\d,]+)/i)
    || html.match(/([\d,]+)\s*(?:global\s*)?ratings?/i)
    || html.match(/"reviewCount"\s*:\s*"?([\d,]+)/i);
  if (reviewMatch) product.reviewCount = parseInt(reviewMatch[1].replace(/,/g, ''), 10);

  // BSR
  const bsrMatch = html.match(/#([\d,]+)\s*in\s+([^\(<\n]+)/i)
    || html.match(/Best Sellers Rank[^#]*#([\d,]+)\s*in\s+([^\(<\n]+)/i);
  if (bsrMatch) {
    product.bsr = parseInt(bsrMatch[1].replace(/,/g, ''), 10);
    product.category = bsrMatch[2].replace(/<[^>]+>/g, '').trim().substring(0, 100);
  }

  // Images
  const imageMatches = html.match(/hiRes":"https?:\/\/[^"]+/gi) || [];
  const uniqueImages = new Set(imageMatches.map(m => m.replace('hiRes":"', '')));
  product.imageCount = Math.max(uniqueImages.size, 1);

  // Video
  product.hasVideo = /class="[^"]*video[^"]*"/i.test(html)
    || /data-video/i.test(html)
    || /"videoUrl"/i.test(html)
    || /immersive-view/i.test(html);

  // Bullet Points
  const bulletSection = html.match(/<div[^>]*id="feature-bullets"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<ul[^>]*class="[^"]*a-unordered-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (bulletSection) {
    const bullets = bulletSection[1].match(/<span[^>]*class="[^"]*a-list-item[^"]*"[^>]*>([\s\S]*?)<\/span>/gi) || [];
    product.bulletCount = bullets.length;
    product.bulletLengths = bullets.map(b => b.replace(/<[^>]+>/g, '').trim().length);
  }

  // A+ Content
  product.hasAPlus = /id="aplus"/i.test(html)
    || /class="[^"]*aplus[^"]*"/i.test(html)
    || /a-plus-content/i.test(html)
    || /brand-story/i.test(html)
    || /celwidget[^"]*aplus/i.test(html);

  // Description length
  const descMatch = html.match(/<div[^>]*id="productDescription"[^>]*>([\s\S]*?)<\/div>/i);
  if (descMatch) {
    product.descriptionLength = descMatch[1].replace(/<[^>]+>/g, '').trim().length;
  }

  // Q&A Count
  const qaMatch = html.match(/([\d,]+)\s*answered\s*questions?/i)
    || html.match(/(\d+)\+?\s*answered/i);
  if (qaMatch) product.qaCount = parseInt(qaMatch[1].replace(/,/g, ''), 10);

  return product;
}

// ═══════════════════════════════════════════════════════════════
// 12-POINT SCORING ALGORITHM v2 — Honest 0-100 scale per category
// All scores based on what we can ACTUALLY measure from a page scrape
// ═══════════════════════════════════════════════════════════════

// KEYWORD RANK DETECTION — Check where an ASIN ranks for a keyword
// ═══════════════════════════════════════════════════════════════

async function checkKeywordRank(asin, keyword) {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) throw new Error('Scraping API not configured');

  let position = 0;

  for (let page = 1; page <= 3; page++) {
    const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&page=${page}`;
    const scraperUrl = `https://api.scrapingdog.com/scrape?api_key=${apiKey}&url=${encodeURIComponent(searchUrl)}&dynamic=false`;

    const resp = await fetch(scraperUrl, { timeout: 30000 });
    if (!resp.ok) throw new Error(`Scraper returned ${resp.status}`);
    const html = await resp.text();

    // Find all ASINs in search results (data-asin attribute)
    const matches = [...html.matchAll(/data-asin="([A-Z0-9]{10})"/g)];
    const pageAsins = matches.map(m => m[1]).filter(a => a && a !== 'undefined');

    for (let i = 0; i < pageAsins.length; i++) {
      position++;
      if (pageAsins[i].toUpperCase() === asin.toUpperCase()) {
        return { rank: position, page };
      }
    }

    if (pageAsins.length === 0) break; // No more results
  }

  return { rank: null, page: null }; // Not found in top ~150
}

// ═══════════════════════════════════════════════════════════════
// SCORING ENGINE — 12-point listing diagnosis with content split
// Each action item has:
//   problem: what's wrong (FREE users see this)
//   solution: how to fix it (PAID users see this)
// ═══════════════════════════════════════════════════════════════

function scoreProduct(product) {
  const scores = {};
  const actions = [];

  // ═══════════════════════════════════════════════════════════
  // ALL SCORES ARE 0-100 SCALE — directly maps to grade display
  // ═══════════════════════════════════════════════════════════

  // ── 1. TITLE OPTIMIZATION ──
  // Sweet spot: 120-200 chars. Has brand. Not keyword-stuffed.
  const titleLen = (product.title || '').length;
  const titleHasBrand = product.brand && (product.title || '').toLowerCase().includes(product.brand.toLowerCase());

  if (titleLen >= 120 && titleLen <= 200) {
    scores.title = titleHasBrand ? 95 : 85;
  } else if (titleLen >= 100 && titleLen <= 220) {
    scores.title = titleHasBrand ? 80 : 72;
  } else if (titleLen >= 80 && titleLen <= 250) {
    scores.title = 60;
  } else if (titleLen >= 50) {
    scores.title = 40;
  } else if (titleLen > 0) {
    scores.title = 20;
  } else {
    scores.title = 0;
  }

  if (scores.title < 75) {
    actions.push({
      category: 'Title Optimization',
      problem: titleLen < 120
        ? `Your title is only ${titleLen} characters — below the 120-200 character sweet spot where top listings perform. Shorter titles mean fewer keywords indexed and less information for buyers to click.`
        : titleLen > 200
        ? `Your title is ${titleLen} characters — past the optimal range. On mobile, buyers only see the first 80 characters. Key selling points are getting cut off.`
        : `Your title length is ${titleLen} characters which is in range, but ${!titleHasBrand ? 'your brand name is missing from the title — this hurts trust and Brand Analytics tracking.' : 'could be structured better for maximum keyword visibility.'}`,
      solution: titleLen < 120
        ? `Expand to 120-200 characters. Structure: [Brand] + [Primary Keyword] + [Key Feature 1] + [Key Feature 2] + [Size/Variant]. Front-load your highest-volume keyword in the first 80 characters for mobile. Your current title "${(product.title || '').substring(0, 60)}..." needs more keyword-rich benefit language.`
        : `Trim to 120-200 characters. Remove filler words like "premium quality," "best," "amazing." Keep the first 80 characters focused on your #1 keyword + primary benefit. Current title starts with "${(product.title || '').substring(0, 60)}..."`,
      priority: scores.title < 50 ? 'high' : 'medium',
    });
  }

  // ── 2. IMAGE GALLERY ──
  // Target: 7+ high-res images. Measured by count of hi-res images detected.
  const imgCount = product.imageCount || 0;

  if (imgCount >= 9) scores.images = 98;
  else if (imgCount >= 7) scores.images = 90;
  else if (imgCount >= 6) scores.images = 78;
  else if (imgCount >= 5) scores.images = 68;
  else if (imgCount >= 4) scores.images = 55;
  else if (imgCount >= 3) scores.images = 42;
  else if (imgCount >= 2) scores.images = 28;
  else if (imgCount >= 1) scores.images = 18;
  else scores.images = 0;

  if (scores.images < 75) {
    actions.push({
      category: 'Image Gallery',
      problem: `You have ${imgCount} image${imgCount !== 1 ? 's' : ''}. Top-converting listings use 7-9 images. Every missing image slot is a missed chance to address buyer objections and showcase value. Images are the #1 conversion driver on Amazon.`,
      solution: `Upload 7+ images in this order: (1) Main image — white background, product fills 85% of frame. (2) Infographic — 3-4 key features with text overlays. (3) Lifestyle shot — product in use. (4) Size/scale comparison. (5) What's in the box. (6) Close-up detail — texture, craftsmanship. (7) Benefit-driven graphic — "Before vs After" or "Problem → Solution." Use 2000x2000px minimum for zoom.`,
      priority: scores.images < 50 ? 'high' : 'medium',
    });
  }

  // ── 3. VIDEO CONTENT ──
  // Binary but critical — video increases conversion significantly
  const hasVideo = product.hasVideo || false;

  if (hasVideo) {
    scores.video = 95;
  } else {
    scores.video = 25;
  }

  if (!hasVideo) {
    actions.push({
      category: 'Video Content',
      problem: `No product video detected. Listings with video see significantly higher conversion rates. Video lets buyers see the product in action, understand scale, and build confidence — things static images can't fully deliver.`,
      solution: `Add a 30-60 second product video covering: (1) Quick unboxing — show packaging quality. (2) Product in hand — establishes real size/scale. (3) Key feature demo — show it working. (4) Close-up quality shots. Keep it professional but authentic. Upload via Seller Central > Manage Videos. You can also use Amazon's video ad placements to drive traffic.`,
      priority: 'medium',
    });
  }

  // ── 4. BULLET POINTS ──
  // Target: 5 bullets, 150-300 chars each (detailed but readable)
  const bulletCount = product.bulletCount || 0;
  const avgBulletLen = product.bulletLengths?.length > 0
    ? product.bulletLengths.reduce((a, b) => a + b, 0) / product.bulletLengths.length
    : 0;

  if (bulletCount >= 5 && avgBulletLen >= 200) scores.bullets = 95;
  else if (bulletCount >= 5 && avgBulletLen >= 150) scores.bullets = 88;
  else if (bulletCount >= 5 && avgBulletLen >= 100) scores.bullets = 78;
  else if (bulletCount >= 5) scores.bullets = 68;
  else if (bulletCount >= 4) scores.bullets = 55;
  else if (bulletCount >= 3) scores.bullets = 40;
  else if (bulletCount >= 1) scores.bullets = 22;
  else scores.bullets = 0;

  if (scores.bullets < 75) {
    actions.push({
      category: 'Bullet Points',
      problem: `You have ${bulletCount}/5 bullet points${avgBulletLen > 0 ? ` averaging ${Math.round(avgBulletLen)} characters each` : ''}. Amazon gives you 5 slots with up to 500 characters each — ${bulletCount < 5 ? "you're not using all your slots" : "your bullets are too short to be persuasive"}.`,
      solution: `Write 5 bullets at 150-300 characters each. Formula: ALL-CAPS BENEFIT → then explain with specifics. Example: "NEVER WORRY ABOUT SPILLS — Triple-sealed medical-grade silicone gaskets keep every drop inside..." Each bullet answers one objection: Bullet 1 = primary benefit, 2 = quality/materials, 3 = ease of use, 4 = what's included, 5 = guarantee/social proof.`,
      priority: scores.bullets < 50 ? 'high' : 'medium',
    });
  }

  // ── 5. A+ / ENHANCED CONTENT ──
  // A+ Content presence. If no A+, fall back to description length.
  if (product.hasAPlus) {
    scores.aPlus = 88;
  } else if (product.descriptionLength >= 2000) {
    scores.aPlus = 65;
  } else if (product.descriptionLength >= 1000) {
    scores.aPlus = 50;
  } else if (product.descriptionLength >= 300) {
    scores.aPlus = 32;
  } else {
    scores.aPlus = 10;
  }

  if (scores.aPlus < 75) {
    actions.push({
      category: 'A+ / Enhanced Content',
      problem: product.hasAPlus
        ? 'A+ Content is present but may benefit from optimization. Strong A+ Content with comparison charts and lifestyle imagery typically drives 3-10% higher conversion.'
        : `No A+ Content detected. This is the most powerful visual real estate Amazon gives brand-registered sellers. Without it, you're leaving significant conversion potential on the table.`,
      solution: !product.hasAPlus
        ? 'Apply for Brand Registry at amazon.com/brandregistry. Then build A+ with: (1) Hero banner with primary benefit headline. (2) Comparison chart — your product vs 3 alternatives across 5 features. (3) "What\'s in the box" module. (4) Brand Story carousel. (5) Use every text field for keyword-rich descriptions — A+ text is indexed.'
        : 'Optimize your A+ with: (1) Brand Story banner. (2) Comparison chart — you vs 3 competitors, you win every row. (3) "How It Works" 3-step visual. (4) Lifestyle imagery with benefit callouts. (5) Use alt-text on every image for SEO indexing.',
      priority: !product.hasAPlus ? 'high' : 'low',
    });
  }

  // ── 6. STAR RATING ──
  const rating = product.rating || 0;

  if (rating >= 4.7) scores.rating = 98;
  else if (rating >= 4.5) scores.rating = 92;
  else if (rating >= 4.3) scores.rating = 84;
  else if (rating >= 4.0) scores.rating = 74;
  else if (rating >= 3.7) scores.rating = 60;
  else if (rating >= 3.5) scores.rating = 50;
  else if (rating >= 3.0) scores.rating = 35;
  else if (rating > 0) scores.rating = 18;
  else scores.rating = 0;

  if (scores.rating < 75) {
    actions.push({
      category: 'Star Rating',
      problem: rating > 0
        ? `Your ${rating}/5 star rating is hurting conversions. Shoppers filter and compare by stars — every 0.1 below 4.5 measurably reduces click-through rate. At ${rating} stars, some buyers filter you out entirely.`
        : 'No rating data detected. This may indicate a new listing or a data issue.',
      solution: `Improving your rating: (1) Read every 1-2 star review — categorize complaints: product quality? Shipping? Misleading listing? (2) Fix product issues, then update listing to set correct expectations. (3) Use "Request a Review" in Seller Central on every order (7-30 days post-delivery). (4) Enroll in Amazon Vine for honest verified reviews. (5) Add product inserts with QR code to a support page — catch unhappy customers before they leave negative reviews.`,
      priority: scores.rating < 50 ? 'high' : 'medium',
    });
  }

  // ── 7. REVIEW VOLUME ──
  const reviewCount = product.reviewCount || 0;

  if (reviewCount >= 1000) scores.reviews = 95;
  else if (reviewCount >= 500) scores.reviews = 88;
  else if (reviewCount >= 200) scores.reviews = 78;
  else if (reviewCount >= 100) scores.reviews = 68;
  else if (reviewCount >= 50) scores.reviews = 55;
  else if (reviewCount >= 20) scores.reviews = 42;
  else if (reviewCount >= 5) scores.reviews = 28;
  else if (reviewCount > 0) scores.reviews = 15;
  else scores.reviews = 0;

  if (scores.reviews < 75) {
    actions.push({
      category: 'Review Volume',
      problem: `${reviewCount.toLocaleString()} review${reviewCount !== 1 ? 's' : ''}. Competitors with 200+ reviews appear more trustworthy by default. Low review count compounds — fewer reviews → lower conversion → fewer sales → fewer reviews.`,
      solution: `Build review velocity: (1) Amazon Vine — up to 30 reviews ($200/parent ASIN). (2) "Request a Review" on every order via Seller Central. (3) Product insert card with support contact + gentle review ask. (4) Run Lightning Deals to spike sales = more organic reviews. (5) Target 10 new reviews/month — you should reach ${Math.max(100, reviewCount + 60)}+ within 6 months.`,
      priority: scores.reviews < 50 ? 'high' : 'medium',
    });
  }

  // ── 8. Q&A ENGAGEMENT ──
  const qaCount = product.qaCount || 0;

  if (qaCount >= 30) scores.qa = 95;
  else if (qaCount >= 20) scores.qa = 88;
  else if (qaCount >= 10) scores.qa = 75;
  else if (qaCount >= 5) scores.qa = 60;
  else if (qaCount >= 2) scores.qa = 42;
  else if (qaCount >= 1) scores.qa = 30;
  else scores.qa = 15;

  if (scores.qa < 75) {
    actions.push({
      category: 'Q&A Engagement',
      problem: `Only ${qaCount} answered question${qaCount !== 1 ? 's' : ''}. Q&A is indexed by Amazon search, builds buyer confidence, and addresses objections before they become abandoned carts.`,
      solution: `Seed 10-15 questions about real buyer concerns: sizing, compatibility, materials, use cases, warranty. Answer every question within 24 hours. Use your negative reviews as a source — if people complain about durability, have someone ask about it and answer thoroughly. Include keywords naturally in answers.`,
      priority: 'low',
    });
  }

  // ── 9. SALES RANK (BSR) ──
  // Note: BSR varies by category, so this is a rough indicator
  const bsr = product.bsr || 0;

  if (bsr > 0 && bsr <= 500) scores.bsr = 98;
  else if (bsr <= 2000) scores.bsr = 92;
  else if (bsr <= 5000) scores.bsr = 85;
  else if (bsr <= 10000) scores.bsr = 78;
  else if (bsr <= 25000) scores.bsr = 68;
  else if (bsr <= 50000) scores.bsr = 58;
  else if (bsr <= 100000) scores.bsr = 45;
  else if (bsr <= 250000) scores.bsr = 30;
  else if (bsr > 0) scores.bsr = 18;
  else scores.bsr = 0;

  if (scores.bsr < 75) {
    actions.push({
      category: 'Sales Rank (BSR)',
      problem: bsr > 0
        ? `BSR #${bsr.toLocaleString()}${product.category ? ` in ${product.category}` : ''}. BSR reflects overall sales velocity — it's the output of every other factor on this report. Note: BSR varies by category size, so this score is a general indicator.`
        : 'No BSR detected. This may indicate a very new listing or a data extraction issue.',
      solution: `BSR improves when sales velocity increases. Priority: (1) Fix your highest-impact issues from this report first — usually images, bullets, and reviews. (2) Run a 7-day Lightning Deal or coupon to spike sales. (3) Optimize PPC — focus on exact-match keywords where your conversion rate > 10%. (4) A/B test your main image to improve click-through rate. (5) Target BSR under ${bsr > 0 ? Math.max(1000, Math.floor(bsr / 2)).toLocaleString() : '50,000'} within 60 days.`,
      priority: scores.bsr < 50 ? 'medium' : 'low',
    });
  }

  // ── 10. BRAND PRESENCE ──
  // Checks for brand name detection + indicators of Brand Registry (A+, brand story)
  const hasBrand = !!(product.brand && product.brand.length > 0);
  const hasBrandRegistry = hasBrand && product.hasAPlus; // A+ implies Brand Registry

  if (hasBrandRegistry) scores.brand = 95;
  else if (hasBrand && product.descriptionLength > 500) scores.brand = 72;
  else if (hasBrand) scores.brand = 60;
  else scores.brand = 25;

  if (scores.brand < 75) {
    actions.push({
      category: 'Brand Presence',
      problem: !hasBrand
        ? 'No brand detected on your listing. Unbranded listings miss out on Brand Registry benefits: A+ Content, Brand Analytics, Sponsored Brands ads, and the brand trust badge.'
        : !hasBrandRegistry
        ? `Brand "${product.brand}" detected, but no A+ Content found — which suggests you may not have Brand Registry active. Brand Registry unlocks critical tools for conversion and protection.`
        : `Brand "${product.brand}" is registered. Ensure your Brand Store and Brand Story are optimized.`,
      solution: !hasBrand
        ? 'Register your brand at amazon.com/brandregistry. You need a registered trademark (can be pending). Brand Registry unlocks: A+ Content, Sponsored Brands, Brand Analytics, brand protection tools, and the trusted "Visit the [Brand] Store" link.'
        : 'Ensure Brand Registry is active and build out: (1) A+ Content with comparison charts and lifestyle modules. (2) Brand Store with at least 3 sub-pages. (3) Brand Story section on your listing. (4) Sponsored Brands campaigns for branded keyword defense.',
      priority: !hasBrand ? 'medium' : 'low',
    });
  }

  // ── 11. LISTING COMPLETENESS ──
  // Composite: how many listing fields are properly filled
  let completeness = 100;
  if (imgCount < 7) completeness -= Math.min(20, (7 - imgCount) * 4);
  if (bulletCount < 5) completeness -= Math.min(18, (5 - bulletCount) * 5);
  if (!product.hasAPlus && product.descriptionLength < 500) completeness -= 15;
  if (!hasVideo) completeness -= 10;
  if (qaCount < 5) completeness -= 8;
  if (reviewCount < 5) completeness -= 8;
  if (!hasBrand) completeness -= 8;
  if (titleLen < 80) completeness -= 8;
  scores.completeness = Math.max(0, completeness);

  if (scores.completeness < 75) {
    const missing = [];
    if (imgCount < 7) missing.push(`images (${imgCount}/7)`);
    if (bulletCount < 5) missing.push(`bullets (${bulletCount}/5)`);
    if (!product.hasAPlus) missing.push('A+ Content');
    if (!hasVideo) missing.push('product video');
    if (qaCount < 5) missing.push(`Q&A (${qaCount})`);
    if (!hasBrand) missing.push('brand registration');
    actions.push({
      category: 'Listing Completeness',
      problem: `Your listing is incomplete — gaps: ${missing.join(', ')}. Amazon's algorithm rewards complete listings with higher organic placement. Every missing element signals to Amazon that your listing isn't worth promoting.`,
      solution: `Fill every field, priority order: (1) ${imgCount < 7 ? `Add ${7 - imgCount} more images.` : 'Images ✓.'} (2) ${bulletCount < 5 ? `Write ${5 - bulletCount} more bullets.` : 'Bullets ✓.'} (3) ${!product.hasAPlus ? 'Build A+ Content.' : 'A+ ✓.'} (4) ${!hasVideo ? 'Add a product video.' : 'Video ✓.'} (5) ${qaCount < 5 ? `Seed ${5 - qaCount} more Q&As.` : 'Q&A ✓.'} (6) Check backend: Search Terms (249 bytes), Subject Matter, Target Audience, Intended Use.`,
      priority: scores.completeness < 50 ? 'high' : 'medium',
    });
  }

  // ── 12. CONTENT DEPTH ──
  // Total indexable text across title + bullets + description/A+
  // Measures how much keyword-rich content Amazon can index
  const totalBulletChars = product.bulletLengths?.length > 0
    ? product.bulletLengths.reduce((a, b) => a + b, 0) : 0;
  const totalContent = titleLen + totalBulletChars + (product.descriptionLength || 0);

  if (totalContent >= 4000) scores.contentDepth = 95;
  else if (totalContent >= 3000) scores.contentDepth = 88;
  else if (totalContent >= 2000) scores.contentDepth = 78;
  else if (totalContent >= 1500) scores.contentDepth = 68;
  else if (totalContent >= 1000) scores.contentDepth = 55;
  else if (totalContent >= 500) scores.contentDepth = 38;
  else if (totalContent > 0) scores.contentDepth = 20;
  else scores.contentDepth = 0;

  if (scores.contentDepth < 75) {
    actions.push({
      category: 'Content Depth',
      problem: `Your listing has approximately ${totalContent.toLocaleString()} characters of indexable text across title, bullets, and description. Top-performing listings typically have 3,000+ characters. More content means more keywords indexed and better search visibility.`,
      solution: `Increase your indexable content: (1) Expand bullets to 200+ characters each (currently averaging ${avgBulletLen > 0 ? Math.round(avgBulletLen) : 0}). (2) ${product.descriptionLength < 1000 ? 'Write a detailed product description (1,000+ characters).' : 'Description length is good.'} (3) ${!product.hasAPlus ? 'Add A+ Content — its text fields are indexed by Amazon search.' : 'Optimize A+ Content alt-text on all images.'} (4) Use natural keyword-rich language throughout — don't keyword-stuff, but weave in relevant search terms.`,
      priority: scores.contentDepth < 50 ? 'medium' : 'low',
    });
  }

  // ═══ OVERALL SCORE & GRADE ═══
  // All scores are 0-100, so overall is simply the average
  const scoreValues = Object.values(scores);
  const overall = Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length);

  let grade;
  if (overall >= 93) grade = 'A+';
  else if (overall >= 86) grade = 'A';
  else if (overall >= 80) grade = 'B+';
  else if (overall >= 73) grade = 'B';
  else if (overall >= 66) grade = 'C+';
  else if (overall >= 58) grade = 'C';
  else if (overall >= 45) grade = 'D';
  else grade = 'F';

  // Sort actions by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

  return { scores, overall, grade, actions };
}

// ═══════════════════════════════════════════════════════════════
// IMPLEMENTATION PLAN GENERATOR — Claude API (the $7 product)
// Deep, listing-specific, references actual title/bullets/images
// ═══════════════════════════════════════════════════════════════

async function generateImplementationPlan(product, scores, grade, overall, actions) {
  if (!anthropic) {
    console.warn('⚠️ ANTHROPIC_API_KEY not set — returning fallback implementation plan');
    return { sections: actions.map(a => ({ category: a.category, priority: a.priority, problem: a.problem, solution: a.solution })) };
  }

  // Build human-readable score names for the prompt
  const scoreDisplayNames = {
    title: 'Title Optimization', images: 'Image Gallery', video: 'Video Content',
    bullets: 'Bullet Points', aPlus: 'A+ / Enhanced Content', rating: 'Star Rating',
    reviews: 'Review Volume', qa: 'Q&A Engagement', bsr: 'Sales Rank (BSR)',
    brand: 'Brand Presence', completeness: 'Listing Completeness', contentDepth: 'Content Depth'
  };

  const prompt = `You are the world's leading Amazon listing optimization consultant. A seller just ran a 12-point diagnostic on their listing and you need to create their personalized Implementation Plan — a step-by-step action plan to fix every issue found.

THIS IS A PAID PRODUCT ($7). It must deliver AT LEAST $200 worth of value. Be brutally specific, actionable, and reference their actual listing data throughout. No generic advice — every recommendation must directly reference their ASIN, their title, their images, their actual numbers. The seller should feel like a $2,000 consultant reviewed their listing personally.

LISTING DATA:
- ASIN: ${product.asin}
- Title: "${product.title}"
- Title Length: ${(product.title || '').length} characters
- Brand: ${product.brand || 'Not detected'}
- Price: $${(product.price || 0).toFixed(2)}
- Rating: ${product.rating || 'N/A'}/5 (${(product.reviewCount || 0).toLocaleString()} reviews)
- BSR: #${(product.bsr || 0).toLocaleString()} in ${product.category || 'Unknown'}
- Images: ${product.imageCount || 0} hi-res images ${product.hasVideo ? '(has video)' : '(NO video)'}
- Bullets: ${product.bulletCount || 0}/5 (avg length: ${product.bulletLengths?.length > 0 ? Math.round(product.bulletLengths.reduce((a,b) => a+b, 0) / product.bulletLengths.length) : 0} chars)
- A+ Content: ${product.hasAPlus ? 'Active' : 'Missing'}
- Description Length: ${product.descriptionLength || 0} characters
- Q&A: ${product.qaCount || 0} answered questions
- Overall Grade: ${grade} (${overall}/100)

SCORES BY CATEGORY (all scored 0-100):
${Object.entries(scores).map(([k,v]) => `- ${scoreDisplayNames[k] || k}: ${v}/100`).join('\n')}

ISSUES FOUND (${actions.length} total):
${actions.map(a => `[${a.priority.toUpperCase()}] ${a.category}: ${a.problem}`).join('\n')}

Create a comprehensive Implementation Plan with these sections:

1. EXECUTIVE SUMMARY — 3-4 sentences. Name their grade, their biggest strengths (scores above 80), and their most urgent problems (scores below 50). Be direct and honest.

2. QUICK WINS — 5 things they can do TODAY in under 30 minutes each. Reference their actual listing. Example: "Your title is ${(product.title || '').length} characters — ${(product.title || '').length < 120 ? 'add these keywords to extend it: [suggest 3-4 specific keywords based on their category]' : (product.title || '').length > 200 ? 'cut these filler words: [identify specific words to remove from their title]' : 'rearrange to front-load your primary keyword'}"

3. 30-DAY ACTION CALENDAR — Week-by-week plan:
   - Week 1: Quick wins + image fixes
   - Week 2: Copy optimization (title, bullets, description/A+)
   - Week 3: Review strategy + Q&A seeding
   - Week 4: Advanced optimization + measurement

4. CATEGORY-BY-CATEGORY FIX PLANS — For EACH issue found:
   - The specific problem (1 sentence referencing their data)
   - Step-by-step fix (3-7 numbered steps, each actionable and specific to THEIR listing)
   - Expected score impact ("This should improve your ${category} score from ${current} to approximately ${target}")
   - Time estimate for the fix

5. KEYWORD SUGGESTIONS — Based on their title, category, and brand, suggest 15-20 specific keywords they should target. Group into: (a) Primary (top 5 by estimated volume), (b) Long-tail (10+), (c) Competitor keywords to target.

6. TITLE REWRITE — Write a complete optimized title for their product. Show the current title, then your rewritten version, and explain each change.

7. BULLET POINT REWRITES — Write all 5 optimized bullet points for their product. Each 200-300 characters using the ALL-CAPS BENEFIT → detail formula.

Respond in JSON format:
{
  "executiveSummary": "...",
  "quickWins": [{"action": "...", "timeMinutes": 10, "impact": "...", "howTo": "step-by-step instructions"}],
  "weeklyCalendar": {"week1": ["..."], "week2": ["..."], "week3": ["..."], "week4": ["..."]},
  "categoryPlans": [{"category": "...", "currentScore": 65, "targetScore": 85, "priority": "high|medium|low", "problem": "...", "steps": ["..."], "expectedImpact": "...", "timeEstimate": "2 hours"}],
  "keywordSuggestions": {"primary": ["..."], "longTail": ["..."], "competitor": ["..."]},
  "titleRewrite": {"current": "...", "optimized": "...", "changes": "..."},
  "bulletRewrites": [{"bullet": 1, "text": "...", "focus": "primary benefit"}]
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { raw: text };
  } catch (err) {
    console.error('Claude API error:', err.message);
    // Fallback: return the solution fields as the plan
    return {
      executiveSummary: `Your listing scored ${grade} (${overall}/100) with ${actions.length} areas for improvement.`,
      categoryPlans: actions.map(a => ({
        category: a.category,
        priority: a.priority,
        problem: a.problem,
        steps: [a.solution],
        expectedImpact: 'Score improvement expected after implementation.',
      })),
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// EMAIL — Send report via Resend
// ═══════════════════════════════════════════════════════════════

async function sendReportEmail(email, report) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !email) return;

  const sender = process.env.SENDER_EMAIL || 'reports@asinanalyzer.app';
  const p = report.product;
  const gradeEmoji = report.overall >= 80 ? '🟢' : report.overall >= 60 ? '🔵' : report.overall >= 40 ? '🟡' : '🔴';

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `ASIN Analyzer <${sender}>`,
        to: [email],
        subject: `${gradeEmoji} Your ASIN Report: ${report.asin} scored ${report.grade} (${report.overall}/100)`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h1 style="color:#0F172A;font-size:24px;">Your Listing Diagnosis is Ready</h1>
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:24px;margin:16px 0;text-align:center;">
              <div style="font-size:48px;font-weight:800;color:${report.overall >= 80 ? '#10B981' : report.overall >= 60 ? '#3B82F6' : report.overall >= 40 ? '#F59E0B' : '#EF4444'};">${report.grade}</div>
              <div style="font-size:28px;font-weight:700;color:#0F172A;">${report.overall} / 100</div>
              <div style="font-size:14px;color:#64748B;margin-top:4px;">${p.title ? p.title.substring(0, 80) + '...' : report.asin}</div>
            </div>
            <p style="color:#475569;line-height:1.7;">We found <strong>${report.actions.length} areas for improvement</strong> across your listing's ${Object.keys(report.scores).length} scoring categories.</p>
            <a href="https://www.asinanalyzer.app/report/${report.id}" style="display:inline-block;padding:14px 32px;background:#3B82F6;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;margin:16px 0;">View Full Report →</a>
            <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;" />
            <p style="font-size:13px;color:#94A3B8;">© 2026 ASIN Analyzer · <a href="https://www.asinanalyzer.app" style="color:#3B82F6;">asinanalyzer.app</a></p>
          </div>
        `,
      }),
    });
    console.log(`📧 Report email sent to ${email}`);
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// GHL WEBHOOK — Fire contact data after every analysis
// ═══════════════════════════════════════════════════════════════

// ─── GHL Field + Tag IDs (created by Blake 2026-03-07) ─────────────────────
const GHL_FIELDS = {
  asin:          'AjmEDWXPaIE8pE7YKLFC',
  score:         '2Hva7xVzZdQDLn3zuCAo',
  grade:         'o7fvQyzxKKYTupyMfAHt',
  report_url:    'ICJ1witGoPrqNEMFjhLy',
  product_title: 'G4rxjtGllrZrIgMGwQQa',
  analysis_id:   'c6vGNgJDKDRPEp1L0cmD',
  brand:         'nMO0qC7W1JqvUJoS76oL',
  category:      '5Wo6zwcNaNxsNSkbMESE',
  analyses_used: 'nkSbcVipoTpaFPEly32y',
  analyses_limit:'BhpWsIuULzkZc2RgiGtt',
};
const GHL_TAGS = {
  free_report_user:            'Tnk36y0baCz7M8W5moIL',
  tripwire_buyer:              '5WMzW822x5329OPx6JMP',
  downsell_buyer:              'UjzCQDxEkfJkREHlBLuR',
  active_subscriber:           'L0Gx5rMsDyFlEJ1Fc4jY',
  payment_failed:              '43r4h83B0voPhnXuqCjc',
  subscription_cancelled:      'LfStuU9ScIHQ1MYda2CF',
  nurture_complete_no_purchase:'vEKV2lnnTYcr8w7yVwpv',
  grade_a: 'gjaSq86xHRSNRty88q4C',
  grade_b: 'FT1dYACltpPEi8hkllO7',
  grade_c: 'wP5SgugTqwh5iyxXyL9X',
  grade_d: 's2eRB3RTPJjM3DHZdNmt',
  grade_f: '7NI8SDRLxhcPMYic5qDs',
};
const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_HDR = () => ({
  'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
  'Content-Type': 'application/json',
  'Version': '2021-07-28',
});

async function ghlUpsertContact(email, customField = {}) {
  if (!process.env.GHL_API_KEY) return null;
  try {
    const res = await fetch(`${GHL_API}/contacts/upsert`, {
      method: 'POST',
      headers: GHL_HDR(),
      body: JSON.stringify({ locationId: process.env.GHL_LOCATION_ID, email, customField }),
    });
    const data = await res.json();
    return data?.contact?.id || data?.id || null;
  } catch (err) {
    console.error('GHL upsert failed:', err.message);
    return null;
  }
}

async function ghlAddTags(contactId, tagNames = []) {
  if (!process.env.GHL_API_KEY || !contactId) return;
  const tags = tagNames.map(t => GHL_TAGS[t]).filter(Boolean);
  if (!tags.length) return;
  try {
    await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
      method: 'POST', headers: GHL_HDR(), body: JSON.stringify({ tags }),
    });
  } catch (err) {
    console.error('GHL add tags failed:', err.message);
  }
}

async function triggerGHL(email, asin, score, grade, reportId, product, event = 'analysis') {
  if (!process.env.GHL_API_KEY) return;
  try {
    const customField = {
      [GHL_FIELDS.asin]:          asin || '',
      [GHL_FIELDS.score]:         score || 0,
      [GHL_FIELDS.grade]:         grade || '',
      [GHL_FIELDS.report_url]:    `https://www.asinanalyzer.app/report/${reportId}`,
      [GHL_FIELDS.product_title]: product?.title || '',
      [GHL_FIELDS.brand]:         product?.brand || '',
      [GHL_FIELDS.category]:      product?.category || '',
      [GHL_FIELDS.analysis_id]:   reportId || '',
    };
    const contactId = await ghlUpsertContact(email, customField);
    const tagsToAdd = [];
    if (event === 'analysis') {
      tagsToAdd.push('free_report_user');
      const gradeKey = `grade_${(grade || '').toLowerCase().replace(/[^a-f]/g, '')}`;
      if (GHL_TAGS[gradeKey]) tagsToAdd.push(gradeKey);
    } else if (event === 'purchase')               tagsToAdd.push('tripwire_buyer');
    else if (event === 'downsell_purchase')         tagsToAdd.push('downsell_buyer');
    else if (event === 'subscription_active')       tagsToAdd.push('active_subscriber');
    else if (event === 'payment_failed')            tagsToAdd.push('payment_failed');
    else if (event === 'subscription_cancelled')    tagsToAdd.push('subscription_cancelled');
    await ghlAddTags(contactId, tagsToAdd);

    // Determine grade tag
    const gradeTag = (grade || '').startsWith('A') ? 'grade_a' :
                     (grade || '').startsWith('B') ? 'grade_b' :
                     (grade || '').startsWith('C') ? 'grade_c' :
                     (grade || '').startsWith('D') ? 'grade_d' : 'grade_f';

    // Apply grade tag via GHL Contacts API
    try {
      const gradeTagRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer pit-0ec4239a-cc6e-4275-baad-95d27ed39808',
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        },
        body: JSON.stringify({
          email: email,
          tags: [gradeTag],
          locationId: 'FkRY7SKAXibyjuH3c7Ew'
        })
      });
      console.log(`🏷️ GHL grade tag applied: ${gradeTag} for ${email}`);
    } catch (err) {
      console.error('GHL grade tag failed:', err.message);
    }

    console.log(`✅ GHL: ${email} → upserted, tags: [${tagsToAdd.join(', ')}]`);
  } catch (err) {
    console.error('GHL triggerGHL failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// ── POST /api/analyze ──
// Supports two modes:
// 1. Free/unauthenticated: requires email, 1 report per email ever
// 2. Authenticated subscriber: uses tier quota, includes solutions if paid tier
app.post('/api/analyze', optionalAuth, async (req, res) => {
  try {
    const { asin, email } = req.body;

    // Validate ASIN
    const cleanASIN = (asin || '').trim().toUpperCase();
    if (!cleanASIN || !/^B0[A-Z0-9]{8}$/i.test(cleanASIN)) {
      return res.status(400).json({ error: 'Invalid ASIN. Must be 10 characters starting with B0.' });
    }

    let cleanEmail = (email || '').trim().toLowerCase();
    let isPaidUser = false;
    let userTier = 'free';
    let userId = null;

    // ── AUTHENTICATED USER PATH ──
    if (req.user) {
      userId = req.user.id;
      cleanEmail = (req.user.email || cleanEmail).toLowerCase();

      // Get user profile & check quota
      const profileResult = await pool.query('SELECT * FROM user_profiles WHERE id = $1', [userId]);
      if (profileResult.rows.length > 0) {
        const profile = profileResult.rows[0];
        userTier = profile.subscription_tier || 'free';
        isPaidUser = userTier !== 'free' && profile.subscription_status === 'active';

        if (isPaidUser) {
          // Check monthly quota for paid users
          const limit = TIER_LIMITS[userTier] || 10;
          const used = profile.analyses_this_month || 0;

          // Check if quota needs monthly reset
          if (profile.analyses_month_reset && new Date(profile.analyses_month_reset) <= new Date()) {
            await pool.query(
              `UPDATE user_profiles SET analyses_this_month = 0,
               analyses_month_reset = date_trunc('month', NOW()) + interval '1 month'
               WHERE id = $1`,
              [userId]
            );
          } else if (used >= limit) {
            return res.status(402).json({
              error: `You've used all ${limit} reports this month. Upgrade for more.`,
              upgradeRequired: true,
              used, limit, tier: userTier,
            });
          }
        }
      }
    }

    // ── FREE USER PATH ──
    if (!isPaidUser) {
      // If email provided, check free-tier limit; if no email (preview gate), allow analysis
      if (cleanEmail && cleanEmail.includes('@')) {
        const limit = await checkEmailLimit(cleanEmail);
        if (!limit.allowed) {
          return res.status(429).json({
            error: limit.reason,
            upgradeRequired: limit.upgradeRequired || false,
          });
        }
      }
    }

    // Scrape Amazon
    const product = await scrapeAmazon(cleanASIN);

    // Score the listing (with content split)
    const { scores, overall, grade, actions } = scoreProduct(product);

    // Save to database
    let reportId = null;
    try {
      const result = await pool.query(
        `INSERT INTO analyses (asin, email, user_id, product_title, brand, price, currency, rating, review_count, bsr, category, image_count, bullet_count, has_aplus, has_video, qa_count, overall_score, overall_grade, scores, raw_data, action_items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id`,
        [
          cleanASIN, cleanEmail, userId,
          product.title, product.brand, product.price, product.currency,
          product.rating, product.reviewCount, product.bsr, product.category,
          product.imageCount, product.bulletCount, product.hasAPlus, product.hasVideo, product.qaCount,
          overall, grade, JSON.stringify(scores), JSON.stringify(product), JSON.stringify(actions),
        ]
      );
      reportId = result.rows[0].id;
    } catch (dbErr) {
      console.error('DB save failed (returning report anyway):', dbErr.message);
    }

    // Increment quota for paid users
    if (isPaidUser && userId) {
      await pool.query(
        'UPDATE user_profiles SET analyses_this_month = analyses_this_month + 1 WHERE id = $1',
        [userId]
      ).catch(e => console.error('Quota increment failed:', e.message));
    }

    // Subscribe email (free users)
    if (cleanEmail && !isPaidUser) {
      try {
        await pool.query(
          `INSERT INTO subscribers (email, source) VALUES ($1, 'report') ON CONFLICT (email) DO NOTHING`,
          [cleanEmail]
        );
      } catch (e) { /* ignore dupe */ }
    }

    // Build response
    // Paid subscribers get BOTH problem and solution
    // Free users get problem ONLY
    const responseActions = actions.map(a => {
      const item = { category: a.category, problem: a.problem, priority: a.priority };
      if (isPaidUser) item.solution = a.solution; // Include solutions for paid users
      return item;
    });

    const report = {
      id: reportId,
      asin: cleanASIN,
      product: {
        title: product.title, brand: product.brand, price: product.price,
        rating: product.rating, reviewCount: product.reviewCount,
        bsr: product.bsr, category: product.category,
        imageCount: product.imageCount, bulletCount: product.bulletCount,
        hasAPlus: product.hasAPlus, hasVideo: product.hasVideo, qaCount: product.qaCount,
      },
      scores, overall, grade,
      actions: responseActions,
      actionCount: actions.length,
      isPaidReport: isPaidUser,
    };

    // Fire GHL webhook (async, don't block response)
    if (cleanEmail) triggerGHL(cleanEmail, cleanASIN, overall, grade, reportId, product);

    // Send email report (async, don't block response)
    if (cleanEmail) sendReportEmail(cleanEmail, report);

    console.log(`✅ ${cleanASIN} → ${grade} (${overall}/100) — ${actions.length} actions [${isPaidUser ? userTier : 'free'}]`);
    res.json({ report });

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// ── POST /api/generate-plan — Generate implementation plan (after $7 purchase) ──
app.post('/api/generate-plan', async (req, res) => {
  try {
    const { analysisId, email } = req.body;

    // Verify purchase
    const purchase = await pool.query(
      'SELECT * FROM purchases WHERE email = $1 AND analysis_id = $2',
      [(email || '').trim().toLowerCase(), parseInt(analysisId, 10)]
    );

    // Also allow if they have an active subscription
    // TODO: Check subscription tier when auth is built

    if (purchase.rows.length === 0) {
      return res.status(403).json({ error: 'Purchase required. Get your Implementation Plan for $7.' });
    }

    // Load the analysis
    const analysis = await pool.query('SELECT * FROM analyses WHERE id = $1', [parseInt(analysisId, 10)]);
    if (analysis.rows.length === 0) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }

    const row = analysis.rows[0];

    // Check if plan already generated
    if (row.implementation_plan) {
      return res.json({ plan: row.implementation_plan });
    }

    // Reconstruct product + scores for the generator
    const product = row.raw_data || {};
    product.asin = row.asin;
    const scores = row.scores || {};
    const actions = row.action_items || [];

    const plan = await generateImplementationPlan(product, scores, row.overall_grade, row.overall_score, actions);

    // Save plan to DB
    await pool.query('UPDATE analyses SET implementation_plan = $1 WHERE id = $2', [JSON.stringify(plan), row.id]);

    res.json({ plan });
  } catch (err) {
    console.error('Plan generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate implementation plan.' });
  }
});

// ── GET /api/report/:id ──
app.get('/api/report/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM analyses WHERE id = $1', [parseInt(id, 10)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });

    const r = result.rows[0];

    // Strip solutions from action items for free access
    const actions = (r.action_items || []).map(a => ({
      category: a.category,
      problem: a.problem || a.text, // backwards compat with old format
      priority: a.priority,
    }));

    res.json({
      report: {
        ...r,
        action_items: actions, // Problems only
        implementation_plan: null, // Never expose plan via public report endpoint
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load report' });
  }
});

// ── GET /api/report/:id/pdf — Generate PDF export of report ──
app.get('/api/report/:id/pdf', async (req, res) => {
  let browser;
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM analyses WHERE id = $1', [parseInt(id, 10)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });

    const r = result.rows[0];
    const puppeteer = require('puppeteer');

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    // Build self-contained HTML for the PDF
    const getColor = (s) => s >= 80 ? '#10B981' : s >= 60 ? '#3B82F6' : s >= 40 ? '#F59E0B' : '#EF4444';
    const scores = r.scores || {};
    const scoreKeys = [
      { key: 'title', label: 'Title Optimization' },
      { key: 'images', label: 'Image Gallery' },
      { key: 'video', label: 'Video Content' },
      { key: 'bullets', label: 'Bullet Points' },
      { key: 'aPlus', label: 'A+ / Enhanced Content' },
      { key: 'rating', label: 'Star Rating' },
      { key: 'reviews', label: 'Review Volume' },
      { key: 'qa', label: 'Q&A Engagement' },
      { key: 'bsr', label: 'Sales Rank (BSR)' },
      { key: 'brand', label: 'Brand Presence' },
      { key: 'completeness', label: 'Listing Completeness' },
      { key: 'contentDepth', label: 'Content Depth' },
    ];

    const actionItems = r.action_items || [];
    const problems = actionItems.map(a => ({
      category: a.category,
      problem: a.problem || a.text,
      priority: a.priority,
    }));

    const scoreRows = scoreKeys.map(sk => {
      const val = scores[sk.key];
      if (val == null) return '';
      const pct = Math.min(100, val); // scores are already 0-100
      const color = getColor(pct);
      return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #f1f5f9;">
          <div style="width:180px;font-size:13px;font-weight:600;color:#475569;">${sk.label}</div>
          <div style="flex:1;height:8px;background:#f1f5f9;border-radius:100px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${color};border-radius:100px;"></div>
          </div>
          <div style="width:50px;text-align:right;font-size:14px;font-weight:700;color:${color};">${val}/100</div>
        </div>
      `;
    }).join('');

    const actionRows = problems.slice(0, 12).map((a, i) => {
      const prioColor = a.priority === 'High' ? '#EF4444' : a.priority === 'Medium' ? '#F59E0B' : '#94A3B8';
      return `
        <div style="padding:12px 0;border-bottom:1px solid #f1f5f9;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;color:${prioColor};text-transform:uppercase;">${a.priority || 'Medium'}</span>
            <span style="font-size:11px;color:#94a3b8;">·</span>
            <span style="font-size:11px;color:#94a3b8;">${a.category}</span>
          </div>
          <div style="font-size:13px;color:#0f172a;line-height:1.5;">${a.problem}</div>
        </div>
      `;
    }).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; color: #0f172a; background: #fff; padding: 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #f1f5f9; }
    .logo { font-size: 20px; font-weight: 800; }
    .logo span { color: #3B82F6; }
    .grade-box { text-align: center; }
    .grade { font-size: 56px; font-weight: 800; line-height: 1; }
    .score { font-size: 14px; color: #475569; margin-top: 4px; }
    .product-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; max-width: 600px; }
    .product-meta { font-size: 13px; color: #475569; }
    .section { margin-bottom: 28px; }
    .section-title { font-size: 16px; font-weight: 800; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 2px solid #3B82F6; display: inline-block; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 2px solid #f1f5f9; font-size: 11px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">ASIN <span>Analyzer</span></div>
      <div style="margin-top:12px;">
        <div class="product-title">${r.product_title || r.asin}</div>
        <div class="product-meta">ASIN: ${r.asin}${r.brand ? ' · ' + r.brand : ''}${r.category ? ' · ' + r.category : ''}</div>
        <div class="product-meta" style="margin-top:4px;">Generated: ${new Date(r.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
      </div>
    </div>
    <div class="grade-box">
      <div class="grade" style="color:${getColor(r.overall_score)}">${r.overall_grade}</div>
      <div class="score">${r.overall_score} / 100</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Score Breakdown</div>
    ${scoreRows}
  </div>

  <div class="section">
    <div class="section-title">Issues Found (${problems.length})</div>
    ${actionRows || '<div style="font-size:13px;color:#94a3b8;">No issues detected.</div>'}
  </div>

  <div class="footer">
    ASIN Analyzer Report · asinanalyzer.app · Report #${r.id} · Confidential
  </div>
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });

    await browser.close();
    browser = null;

    const filename = `ASIN-Report-${r.asin}-${r.id}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);

  } catch (err) {
    console.error('PDF export error:', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ── POST /api/subscribe ──
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email, asin, source, reportId, grade, overall } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    const cleanEmail = email.trim().toLowerCase();
    await pool.query(
      `INSERT INTO subscribers (email, source) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET active = true`,
      [cleanEmail, source || 'newsletter']
    );
    // Fire GHL for preview-gate captures so email workflows trigger
    if (source === 'preview-gate' && asin) {
      triggerGHL(cleanEmail, asin, overall || 0, grade || '', reportId || '', null, 'analysis');
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Subscription failed' });
  }
});

// ── GET /api/score-history/:asin — Score tracking over time ──
app.get('/api/score-history/:asin', async (req, res) => {
  try {
    const asin = (req.params.asin || '').trim().toUpperCase();
    if (!asin || !/^B0[A-Z0-9]{8}$/i.test(asin)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    const result = await pool.query(
      `SELECT id, overall_score, overall_grade, scores, created_at
       FROM analyses WHERE UPPER(asin) = $1
       ORDER BY created_at ASC LIMIT 50`,
      [asin]
    );

    // Build per-category trend data
    const history = result.rows.map(r => ({
      id: r.id,
      score: r.overall_score,
      grade: r.overall_grade,
      scores: r.scores || {},
      date: r.created_at,
    }));

    // Calculate delta if 2+ data points
    let delta = null;
    if (history.length >= 2) {
      const first = history[0].score;
      const last = history[history.length - 1].score;
      delta = { from: first, to: last, change: last - first };
    }

    res.json({ asin, history, delta, totalScans: history.length });
  } catch (err) {
    console.error('Score history error:', err.message);
    res.status(500).json({ error: 'Failed to load score history.' });
  }
});

// ── GET /api/stats ──
// ── POST /api/compare — Competitor Comparison (2-5 ASINs) ──
app.post('/api/compare', optionalAuth, async (req, res) => {
  try {
    const { asins } = req.body;
    if (!Array.isArray(asins) || asins.length < 2 || asins.length > 5) {
      return res.status(400).json({ error: 'Provide 2 to 5 ASINs for comparison.' });
    }

    // Validate all ASINs
    const cleanAsins = asins.map(a => (a || '').trim().toUpperCase());
    for (const a of cleanAsins) {
      if (!/^B0[A-Z0-9]{8}$/i.test(a)) {
        return res.status(400).json({ error: `Invalid ASIN: ${a}` });
      }
    }

    // De-duplicate
    const uniqueAsins = [...new Set(cleanAsins)];
    if (uniqueAsins.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 different ASINs.' });
    }

    // For each ASIN, check if we have a recent analysis (last 7 days), otherwise scrape fresh
    const results = [];
    for (const asin of uniqueAsins) {
      // Check for recent analysis
      const existing = await pool.query(
        `SELECT * FROM analyses WHERE UPPER(asin) = $1 AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC LIMIT 1`,
        [asin]
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        results.push({
          asin,
          product: {
            title: row.product_title, brand: row.brand, price: row.price,
            rating: row.rating, reviewCount: row.review_count, bsr: row.bsr,
            category: row.category, imageCount: row.image_count,
            bulletCount: row.bullet_count, hasAPlus: row.has_aplus,
            hasVideo: row.has_video, qaCount: row.qa_count,
          },
          scores: row.scores || {},
          overall: row.overall_score,
          grade: row.overall_grade,
          reportId: row.id,
          cached: true,
        });
      } else {
        // Scrape and score fresh
        try {
          const product = await scrapeAmazon(asin);
          const { scores, overall, grade } = scoreProduct(product);
          results.push({
            asin,
            product: {
              title: product.title, brand: product.brand, price: product.price,
              rating: product.rating, reviewCount: product.reviewCount, bsr: product.bsr,
              category: product.category, imageCount: product.imageCount,
              bulletCount: product.bulletCount, hasAPlus: product.hasAPlus,
              hasVideo: product.hasVideo, qaCount: product.qaCount,
            },
            scores, overall, grade,
            reportId: null,
            cached: false,
          });
        } catch (scrapeErr) {
          results.push({
            asin,
            error: `Failed to analyze ${asin}: ${scrapeErr.message}`,
          });
        }
      }
    }

    // Build comparison summary
    const valid = results.filter(r => !r.error);
    let winner = null;
    if (valid.length >= 2) {
      winner = valid.reduce((best, r) => r.overall > best.overall ? r : best, valid[0]);
    }

    // Score categories for comparison
    const categories = [
      'title', 'images', 'bullet_points', 'a_plus', 'reviews',
      'price_competitiveness', 'keyword_optimization', 'brand_story',
      'inventory_status', 'listing_completeness', 'competitive_position', 'conversion_elements',
    ];

    // Find who wins each category
    const categoryWinners = {};
    categories.forEach(cat => {
      let best = null;
      let bestScore = -1;
      valid.forEach(r => {
        const val = r.scores?.[cat] || 0;
        if (val > bestScore) { bestScore = val; best = r.asin; }
      });
      categoryWinners[cat] = best;
    });

    res.json({
      comparison: results,
      winner: winner ? { asin: winner.asin, score: winner.overall, grade: winner.grade } : null,
      categoryWinners,
    });

  } catch (err) {
    console.error('Compare error:', err.message);
    res.status(500).json({ error: 'Comparison failed. Please try again.' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const analyses = await pool.query('SELECT COUNT(*) as count FROM analyses');
    const subscribers = await pool.query('SELECT COUNT(*) as count FROM subscribers WHERE active = true');
    res.json({
      totalAnalyses: parseInt(analyses.rows[0].count, 10),
      totalSubscribers: parseInt(subscribers.rows[0].count, 10),
    });
  } catch (err) {
    res.json({ totalAnalyses: 0, totalSubscribers: 0 });
  }
});

// ── GET /api/health ──
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', db: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'disconnected', error: err.message });
  }
});

// ── GET /api/check-oto — Check if $39/mo OTO should be shown ──
app.get('/api/check-oto', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.json({ showOTO: false });

    const result = await pool.query('SELECT id FROM oto_shown WHERE LOWER(email) = $1', [email.trim().toLowerCase()]);
    res.json({ showOTO: result.rows.length === 0 });
  } catch (err) {
    res.json({ showOTO: false });
  }
});

// ── POST /api/mark-oto-shown — Mark OTO as shown (never show again) ──
app.post('/api/mark-oto-shown', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ success: false });

    await pool.query(
      'INSERT INTO oto_shown (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email.trim().toLowerCase()]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE — Validates Supabase JWT tokens
// ═══════════════════════════════════════════════════════════════

async function requireAuth(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Optional auth — attaches user if token present, continues regardless
async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token && supabase) {
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) req.user = user;
    } catch (e) { /* continue without auth */ }
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES — Signup, Login, Password Reset, OAuth
// ═══════════════════════════════════════════════════════════════

// ── POST /api/auth/signup ──
app.post('/api/auth/signup', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    // Create Supabase auth user
    const { data, error } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true, // Auto-confirm since they already verified email during analysis
    });

    if (error) {
      if (error.message.includes('already registered')) {
        return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
      }
      return res.status(400).json({ error: error.message });
    }

    // Create user_profiles row
    await pool.query(
      `INSERT INTO user_profiles (id, email, name, subscription_tier, subscription_status)
       VALUES ($1, $2, $3, 'free', 'inactive')
       ON CONFLICT (id) DO UPDATE SET name = $3`,
      [data.user.id, email.trim().toLowerCase(), name || null]
    );

    // Link any existing analyses to this user
    await pool.query(
      'UPDATE analyses SET user_id = $1 WHERE LOWER(email) = $2 AND user_id IS NULL',
      [data.user.id, email.trim().toLowerCase()]
    );

    // Sign them in to get a session
    const { data: signIn, error: signInErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: email.trim().toLowerCase(),
    });

    // Direct sign-in with password for immediate session
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: session, error: sessErr } = await supabaseClient.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (sessErr) {
      return res.json({ success: true, error: 'Account created but auto-login failed. Please log in manually.' });
    }

    console.log(`👤 New account: ${email}`);
    res.json({ session: session.session, user: data.user });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// ── POST /api/auth/login ──
app.post('/api/auth/login', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    console.log(`🔑 Login: ${email}`);
    res.json({ session: data.session, user: data.user });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// ── GET /api/auth/google — Return Google OAuth URL ──
app.get('/api/auth/google', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'https://www.asinanalyzer.app/dashboard' },
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.url });
  } catch (err) {
    res.status(500).json({ error: 'Google auth unavailable.' });
  }
});

// ── POST /api/auth/magic-link ──
app.post('/api/auth/magic-link', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error } = await supabaseClient.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: 'https://www.asinanalyzer.app/dashboard' },
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send magic link.' });
  }
});

// ── POST /api/auth/forgot-password ──
app.post('/api/auth/forgot-password', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Auth not configured.' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error } = await supabaseClient.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo: 'https://www.asinanalyzer.app/reset-password' }
    );

    // Always return success to prevent email enumeration
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true });
  }
});

// ── POST /api/auth/reset-password ──
app.post('/api/auth/reset-password', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required.' });

  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters.' });

    const { error } = await supabase.auth.admin.updateUserById(
      // Decode token to get user ID
      (await supabase.auth.getUser(token)).data.user.id,
      { password }
    );

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ── POST /api/auth/change-password (authenticated) ──
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters.' });

    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD & ACCOUNT ROUTES (authenticated)
// ═══════════════════════════════════════════════════════════════

// ── GET /api/dashboard — User profile + recent reports ──
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    // Get or create user profile
    let profile = await pool.query('SELECT * FROM user_profiles WHERE id = $1', [req.user.id]);

    if (profile.rows.length === 0) {
      // Auto-create profile for OAuth/magic-link users
      await pool.query(
        `INSERT INTO user_profiles (id, email, subscription_tier, subscription_status)
         VALUES ($1, $2, 'free', 'inactive') ON CONFLICT (id) DO NOTHING`,
        [req.user.id, req.user.email]
      );
      profile = await pool.query('SELECT * FROM user_profiles WHERE id = $1', [req.user.id]);
    }

    const user = profile.rows[0];

    // Check if monthly quota needs reset
    if (user.analyses_month_reset && new Date(user.analyses_month_reset) <= new Date()) {
      await pool.query(
        `UPDATE user_profiles SET analyses_this_month = 0,
         analyses_month_reset = date_trunc('month', NOW()) + interval '1 month'
         WHERE id = $1`,
        [req.user.id]
      );
      user.analyses_this_month = 0;
    }

    // Get recent reports for this user
    const reports = await pool.query(
      `SELECT id, asin, product_title, brand, price, overall_score, overall_grade, action_items, created_at
       FROM analyses WHERE user_id = $1 OR LOWER(email) = $2
       ORDER BY created_at DESC LIMIT 10`,
      [req.user.id, (req.user.email || '').toLowerCase()]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email || req.user.email,
        name: user.name,
        subscription_tier: user.subscription_tier || 'free',
        subscription_status: user.subscription_status || 'inactive',
        analyses_this_month: user.analyses_this_month || 0,
        analyses_month_reset: user.analyses_month_reset,
      },
      reports: reports.rows,
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

// ── GET /api/history — Paginated report history ──
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const totalResult = await pool.query(
      'SELECT COUNT(*) as count FROM analyses WHERE user_id = $1 OR LOWER(email) = $2',
      [req.user.id, (req.user.email || '').toLowerCase()]
    );
    const total = parseInt(totalResult.rows[0].count, 10);

    const reports = await pool.query(
      `SELECT id, asin, product_title, brand, price, rating, review_count, bsr, category,
              overall_score, overall_grade, action_items, created_at
       FROM analyses WHERE user_id = $1 OR LOWER(email) = $2
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, (req.user.email || '').toLowerCase(), limit, offset]
    );

    res.json({ reports: reports.rows, total, page, limit });
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: 'Failed to load history.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SAVED ASINS — Multi-ASIN dashboard (Sprint 3)
// ═══════════════════════════════════════════════════════════════

// ── GET /api/saved-asins — List saved ASINs with latest scores ──
app.get('/api/saved-asins', requireAuth, async (req, res) => {
  try {
    // Get all saved ASINs for this user
    const saved = await pool.query(
      'SELECT id, asin, nickname, created_at FROM saved_asins WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.id]
    );

    if (saved.rows.length === 0) {
      return res.json({ asins: [] });
    }

    // For each saved ASIN, get the latest analysis + score history
    const asins = await Promise.all(saved.rows.map(async (sa) => {
      // Latest analysis
      const latest = await pool.query(
        `SELECT id, overall_score, overall_grade, scores, product_title, brand, price, rating, review_count, bsr, category, created_at
         FROM analyses WHERE UPPER(asin) = $1 ORDER BY created_at DESC LIMIT 1`,
        [sa.asin.toUpperCase()]
      );

      // Score history (last 10 for sparkline)
      const history = await pool.query(
        `SELECT overall_score, created_at FROM analyses WHERE UPPER(asin) = $1 ORDER BY created_at DESC LIMIT 10`,
        [sa.asin.toUpperCase()]
      );

      const latestRow = latest.rows[0] || null;
      const sparkline = history.rows.reverse().map(h => h.overall_score);

      // Calculate delta (latest vs previous)
      let delta = null;
      if (sparkline.length >= 2) {
        delta = sparkline[sparkline.length - 1] - sparkline[sparkline.length - 2];
      }

      return {
        id: sa.id,
        asin: sa.asin,
        nickname: sa.nickname,
        savedAt: sa.created_at,
        latest: latestRow ? {
          reportId: latestRow.id,
          score: latestRow.overall_score,
          grade: latestRow.overall_grade,
          scores: latestRow.scores,
          title: latestRow.product_title,
          brand: latestRow.brand,
          price: parseFloat(latestRow.price || 0),
          rating: parseFloat(latestRow.rating || 0),
          reviewCount: latestRow.review_count,
          bsr: latestRow.bsr,
          category: latestRow.category,
          date: latestRow.created_at,
        } : null,
        sparkline,
        delta,
        totalScans: sparkline.length,
      };
    }));

    res.json({ asins });
  } catch (err) {
    console.error('Saved ASINs error:', err.message);
    res.status(500).json({ error: 'Failed to load saved ASINs.' });
  }
});

// ── POST /api/saved-asins — Save an ASIN to track ──
app.post('/api/saved-asins', requireAuth, async (req, res) => {
  try {
    const { asin, nickname } = req.body;
    const cleanASIN = (asin || '').trim().toUpperCase();

    if (!cleanASIN || !/^B0[A-Z0-9]{8}$/i.test(cleanASIN)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    // Check limit (max 20 saved ASINs per user)
    const countResult = await pool.query('SELECT COUNT(*) as count FROM saved_asins WHERE user_id = $1', [req.user.id]);
    if (parseInt(countResult.rows[0].count, 10) >= 20) {
      return res.status(400).json({ error: 'Maximum 20 saved ASINs. Remove one to add another.' });
    }

    const result = await pool.query(
      `INSERT INTO saved_asins (user_id, asin, nickname) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, asin) DO UPDATE SET nickname = COALESCE($3, saved_asins.nickname)
       RETURNING *`,
      [req.user.id, cleanASIN, nickname || null]
    );

    res.json({ saved: result.rows[0] });
  } catch (err) {
    console.error('Save ASIN error:', err.message);
    res.status(500).json({ error: 'Failed to save ASIN.' });
  }
});

// ── DELETE /api/saved-asins/:asin — Remove a saved ASIN ──
app.delete('/api/saved-asins/:asin', requireAuth, async (req, res) => {
  try {
    const asin = (req.params.asin || '').trim().toUpperCase();
    await pool.query('DELETE FROM saved_asins WHERE user_id = $1 AND UPPER(asin) = $2', [req.user.id, asin]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete saved ASIN error:', err.message);
    res.status(500).json({ error: 'Failed to remove ASIN.' });
  }
});

// ── PATCH /api/saved-asins/:asin — Update nickname ──
app.patch('/api/saved-asins/:asin', requireAuth, async (req, res) => {
  try {
    const asin = (req.params.asin || '').trim().toUpperCase();
    const { nickname } = req.body;
    await pool.query(
      'UPDATE saved_asins SET nickname = $1 WHERE user_id = $2 AND UPPER(asin) = $3',
      [nickname || null, req.user.id, asin]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ASIN.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// KEYWORD RANK TRACKING (Sprint 5.1 — Enterprise feature)
// ═══════════════════════════════════════════════════════════════

// ── POST /api/keywords/track — Track a keyword for an ASIN ──
app.post('/api/keywords/track', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { asin, keyword } = req.body;

    // Validate ASIN
    const cleanAsin = (asin || '').trim().toUpperCase();
    if (!cleanAsin || !/^B0[A-Z0-9]{8}$/i.test(cleanAsin)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    // Validate keyword
    const cleanKeyword = (keyword || '').trim().toLowerCase();
    if (!cleanKeyword || cleanKeyword.length > 500) {
      return res.status(400).json({ error: 'Keyword is required (max 500 chars).' });
    }

    // Check tier — Seller gets 20 keywords/ASIN, Enterprise gets 100
    const profile = await pool.query('SELECT subscription_tier, subscription_status FROM user_profiles WHERE id = $1', [userId]);
    const tier = profile.rows[0]?.subscription_tier || 'free';
    const isActive = profile.rows[0]?.subscription_status === 'active';

    if (tier === 'free' || !isActive) {
      return res.status(403).json({ error: 'Keyword tracking requires a paid plan.' });
    }

    const maxKeywords = (tier === 'enterprise') ? 100 : 20;

    // Count existing unique keywords for this ASIN
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT keyword) as cnt FROM keyword_rankings WHERE user_id = $1 AND UPPER(asin) = $2`,
      [userId, cleanAsin]
    );
    const currentCount = parseInt(countResult.rows[0].cnt, 10);

    // Check if this keyword already exists for this ASIN
    const existsResult = await pool.query(
      `SELECT id FROM keyword_rankings WHERE user_id = $1 AND UPPER(asin) = $2 AND LOWER(keyword) = $3 LIMIT 1`,
      [userId, cleanAsin, cleanKeyword]
    );
    const isNewKeyword = existsResult.rows.length === 0;

    if (isNewKeyword && currentCount >= maxKeywords) {
      return res.status(400).json({ error: `Maximum ${maxKeywords} keywords per ASIN on your plan.` });
    }

    // Check keyword rank via Scrapingdog
    const rankData = await checkKeywordRank(cleanAsin, cleanKeyword);

    // Save to database
    await pool.query(
      `INSERT INTO keyword_rankings (user_id, asin, keyword, rank, page) VALUES ($1, $2, $3, $4, $5)`,
      [userId, cleanAsin, cleanKeyword, rankData.rank, rankData.page]
    );

    console.log(`🔍 Keyword tracked: "${cleanKeyword}" for ${cleanAsin} → Rank ${rankData.rank || 'not found'}`);

    res.json({
      asin: cleanAsin,
      keyword: cleanKeyword,
      rank: rankData.rank,
      page: rankData.page,
      checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Keyword track error:', err.message);
    res.status(500).json({ error: 'Failed to check keyword rank.' });
  }
});

// ── GET /api/keywords/:asin — Get all tracked keywords for an ASIN ──
app.get('/api/keywords/:asin', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const asin = (req.params.asin || '').trim().toUpperCase();
    if (!asin || !/^B0[A-Z0-9]{8}$/i.test(asin)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    // Get all keyword entries for this user + ASIN, ordered by keyword then date
    const result = await pool.query(
      `SELECT keyword, rank, page, checked_at
       FROM keyword_rankings
       WHERE user_id = $1 AND UPPER(asin) = $2
       ORDER BY keyword ASC, checked_at DESC`,
      [userId, asin]
    );

    // Group by keyword and build history
    const keywordMap = {};
    result.rows.forEach(row => {
      const kw = row.keyword.toLowerCase();
      if (!keywordMap[kw]) {
        keywordMap[kw] = { keyword: row.keyword, history: [] };
      }
      keywordMap[kw].history.push({
        rank: row.rank,
        page: row.page,
        checkedAt: row.checked_at,
      });
    });

    // Build response with current rank, previous rank, delta, sparkline
    const keywords = Object.values(keywordMap).map(kw => {
      const hist = kw.history.slice(0, 10); // Last 10 checks
      const current = hist[0]?.rank || null;
      const previous = hist[1]?.rank || null;
      let delta = null;
      if (current != null && previous != null) {
        delta = previous - current; // Positive = improved (lower rank number = better)
      }

      return {
        keyword: kw.keyword,
        currentRank: current,
        previousRank: previous,
        delta,
        history: hist.map(h => h.rank),
        lastChecked: hist[0]?.checkedAt || null,
      };
    });

    res.json({ asin, keywords });

  } catch (err) {
    console.error('Keywords fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load keywords.' });
  }
});

// ── DELETE /api/keywords/:asin/:keyword — Remove a tracked keyword ──
app.delete('/api/keywords/:asin/:keyword', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const asin = (req.params.asin || '').trim().toUpperCase();
    const keyword = decodeURIComponent(req.params.keyword || '').trim().toLowerCase();

    if (!asin || !keyword) return res.status(400).json({ error: 'ASIN and keyword required.' });

    await pool.query(
      `DELETE FROM keyword_rankings WHERE user_id = $1 AND UPPER(asin) = $2 AND LOWER(keyword) = $3`,
      [userId, asin, keyword]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Keyword delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete keyword.' });
  }
});

// ── POST /api/keywords/refresh/:asin — Re-check all keywords for an ASIN ──
app.post('/api/keywords/refresh/:asin', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const asin = (req.params.asin || '').trim().toUpperCase();
    if (!asin || !/^B0[A-Z0-9]{8}$/i.test(asin)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    // Check tier
    const profile = await pool.query('SELECT subscription_tier, subscription_status FROM user_profiles WHERE id = $1', [userId]);
    const tier = profile.rows[0]?.subscription_tier || 'free';
    if (tier === 'free' || profile.rows[0]?.subscription_status !== 'active') {
      return res.status(403).json({ error: 'Keyword tracking requires a paid plan.' });
    }

    // Get unique keywords for this ASIN
    const kwResult = await pool.query(
      `SELECT DISTINCT keyword FROM keyword_rankings WHERE user_id = $1 AND UPPER(asin) = $2`,
      [userId, asin]
    );

    if (kwResult.rows.length === 0) {
      return res.json({ asin, refreshed: 0, keywords: [] });
    }

    const results = [];
    for (const row of kwResult.rows) {
      try {
        const rankData = await checkKeywordRank(asin, row.keyword);
        await pool.query(
          `INSERT INTO keyword_rankings (user_id, asin, keyword, rank, page) VALUES ($1, $2, $3, $4, $5)`,
          [userId, asin, row.keyword, rankData.rank, rankData.page]
        );
        results.push({
          keyword: row.keyword,
          rank: rankData.rank,
          page: rankData.page,
          checkedAt: new Date().toISOString(),
        });
      } catch (kwErr) {
        console.error(`Keyword refresh failed for "${row.keyword}":`, kwErr.message);
        results.push({ keyword: row.keyword, error: kwErr.message });
      }
    }

    console.log(`🔄 Refreshed ${results.length} keywords for ${asin}`);
    res.json({ asin, refreshed: results.length, keywords: results });

  } catch (err) {
    console.error('Keyword refresh error:', err.message);
    res.status(500).json({ error: 'Failed to refresh keywords.' });
  }
});

// ── POST /api/account/update — Update user profile ──
app.post('/api/account/update', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    await pool.query('UPDATE user_profiles SET name = $1 WHERE id = $2', [name || null, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// BILLING ROUTES (authenticated)
// ═══════════════════════════════════════════════════════════════

// ── GET /api/stripe/portal — Open Stripe Customer Portal ──
app.get('/api/stripe/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

  try {
    const profile = await pool.query('SELECT stripe_customer_id FROM user_profiles WHERE id = $1', [req.user.id]);
    const customerId = profile.rows[0]?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'https://www.asinanalyzer.app/dashboard/account',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal.' });
  }
});

// ── POST /api/stripe/cancel — Cancel subscription ──
app.post('/api/stripe/cancel', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

  try {
    const profile = await pool.query('SELECT stripe_subscription_id FROM user_profiles WHERE id = $1', [req.user.id]);
    const subId = profile.rows[0]?.stripe_subscription_id;

    if (!subId) {
      return res.status(400).json({ error: 'No active subscription found.' });
    }

    // Cancel at end of billing period (not immediately)
    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });

    await pool.query(
      "UPDATE user_profiles SET subscription_status = 'cancelling' WHERE id = $1",
      [req.user.id]
    );

    // Fire GHL webhook for cancellation
    triggerGHL(req.user.email, '', 0, '', '', null, 'subscription_cancelled').catch(e => console.error('GHL cancel failed:', e.message));

    console.log(`❌ Subscription cancel requested: ${req.user.email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Cancel error:', err.message);
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// STRIPE ROUTES (activate when Stripe account is ready)
// ═══════════════════════════════════════════════════════════════

// ── POST /api/stripe/create-checkout — Create Stripe Checkout session ──
app.post('/api/stripe/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured yet.' });

  try {
    const { priceId, email, analysisId, mode } = req.body;

    const sessionParams = {
      ...(email && email.includes('@') ? { customer_email: email } : {}),
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: mode || 'payment', // 'payment' for one-time, 'subscription' for recurring
      success_url: `https://www.asinanalyzer.app/thank-you?session_id={CHECKOUT_SESSION_ID}&analysis_id=${analysisId || ''}`,
      cancel_url: `https://www.asinanalyzer.app/report/${analysisId || ''}`,
      metadata: {
        analysisId: String(analysisId || ''),
        product: priceId,
      },
    };

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// ── POST /api/stripe/webhook — Handle Stripe events ──
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.status(503).send('Payments not configured');

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const analysisId = session.metadata?.analysisId;

      // Record purchase
      try {
        await pool.query(
          'INSERT INTO purchases (email, stripe_session_id, stripe_payment_intent_id, product, amount_cents, analysis_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [
            email?.toLowerCase(),
            session.id,
            session.payment_intent,
            session.metadata?.product || 'unknown',
            session.amount_total,
            analysisId ? parseInt(analysisId, 10) : null,
          ]
        );
        console.log(`💰 Purchase recorded: ${email} — $${(session.amount_total / 100).toFixed(2)}`);
      } catch (dbErr) {
        console.error('Purchase record failed:', dbErr.message);
      }

      // Fire GHL webhook for purchase event
      if (email) triggerGHL(email, '', 0, '', analysisId || '', null, 'purchase').catch(e => console.error('GHL purchase failed:', e.message));
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const customerId = sub.customer;
      const subStatus = sub.status; // active, past_due, canceled, etc.
      const priceId = sub.items?.data?.[0]?.price?.id || '';

      // Map Stripe price to tier — Rex: replace these with actual price IDs
      let tier = 'seller';
      const priceToTier = {
        [process.env.STRIPE_PRICE_ID_SELLER_MONTHLY || '']: 'seller',
        [process.env.STRIPE_PRICE_ID_SELLER_ANNUAL || '']: 'seller',
        [process.env.STRIPE_PRICE_ID_AGENCY_OTO || '']: 'agency_power',
        [process.env.STRIPE_PRICE_ID_AGENCY_MONTHLY || '']: 'agency',
        [process.env.STRIPE_PRICE_ID_AGENCY_ANNUAL || '']: 'agency',
        [process.env.STRIPE_PRICE_ID_ENTERPRISE_MONTHLY || '']: 'enterprise',
        [process.env.STRIPE_PRICE_ID_ENTERPRISE_ANNUAL || '']: 'enterprise',
      };
      if (priceToTier[priceId]) tier = priceToTier[priceId];

      // Update user profile
      try {
        await pool.query(
          `UPDATE user_profiles SET
            subscription_tier = $1,
            subscription_status = $2,
            stripe_subscription_id = $3,
            stripe_customer_id = $4
           WHERE stripe_customer_id = $4 OR LOWER(email) = LOWER($5)`,
          [
            subStatus === 'active' ? tier : 'free',
            subStatus,
            sub.id,
            customerId,
            sub.customer_email || '',
          ]
        );
        console.log(`📋 Subscription ${event.type}: ${sub.id} → ${tier} (${subStatus})`);
      } catch (dbErr) {
        console.error('Subscription update failed:', dbErr.message);
      }

      // Fire GHL webhook
      { const customerEmail = sub.customer_email || '';
      if (customerEmail) triggerGHL(customerEmail, '', 0, '', '', null, 'subscription_' + subStatus).catch(e => {}); }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const customerId = sub.customer;

      // Downgrade to free
      try {
        await pool.query(
          `UPDATE user_profiles SET subscription_tier = 'free', subscription_status = 'cancelled',
           stripe_subscription_id = NULL WHERE stripe_customer_id = $1`,
          [customerId]
        );
        console.log(`❌ Subscription cancelled → free: ${sub.id}`);
      } catch (dbErr) {
        console.error('Cancellation update failed:', dbErr.message);
      }

      // Fire GHL webhook
      if (sub.customer_email) triggerGHL(sub.customer_email, '', 0, '', '', null, 'subscription_cancelled').catch(e => {});
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      // Reset monthly quota on successful subscription payment
      if (invoice.subscription) {
        try {
          await pool.query(
            `UPDATE user_profiles SET analyses_this_month = 0,
             analyses_month_reset = date_trunc('month', NOW()) + interval '1 month'
             WHERE stripe_customer_id = $1`,
            [customerId]
          );
          console.log(`🔄 Quota reset for customer: ${customerId}`);
        } catch (dbErr) {
          console.error('Quota reset failed:', dbErr.message);
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      console.log(`⚠️ Payment failed: ${invoice.customer_email}`);

      // Fire GHL webhook for dunning sequence
      if (invoice.customer_email) triggerGHL(invoice.customer_email, '', 0, '', '', null, 'payment_failed').catch(e => {});
      break;
    }
  }

  res.json({ received: true });
});

// ═══ PAGE ROUTES ═══
app.get('/report/:id', async (req, res) => {
  // Check if this is a social media crawler requesting OG meta tags
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isCrawler = /facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|whatsapp|telegrambot/i.test(ua);

  if (isCrawler) {
    // Serve dynamic OG meta tags for social preview cards
    try {
      const result = await pool.query('SELECT asin, product_title, overall_score, overall_grade, scores FROM analyses WHERE id = $1', [parseInt(req.params.id, 10)]);
      if (result.rows.length > 0) {
        const r = result.rows[0];
        const scoreCount = r.scores ? Object.keys(r.scores).length : 12;
        const gradeEmoji = r.overall_score >= 80 ? '🟢' : r.overall_score >= 60 ? '🔵' : r.overall_score >= 40 ? '🟡' : '🔴';
        return res.send(`<!DOCTYPE html><html><head>
          <meta property="og:title" content="${gradeEmoji} ${r.asin} scored ${r.overall_grade} (${r.overall_score}/100) — ASIN Analyzer">
          <meta property="og:description" content="${r.product_title ? r.product_title.substring(0, 120) + '...' : r.asin} — Scored across ${scoreCount} categories. Free listing audit at asinanalyzer.app">
          <meta property="og:url" content="https://www.asinanalyzer.app/report/${req.params.id}">
          <meta property="og:type" content="website">
          <meta property="og:site_name" content="ASIN Analyzer">
          <meta name="twitter:card" content="summary">
          <meta name="twitter:title" content="${gradeEmoji} ${r.asin}: ${r.overall_grade} (${r.overall_score}/100)">
          <meta name="twitter:description" content="12-point Amazon listing audit. Free at asinanalyzer.app">
          <title>${r.asin} — ${r.overall_grade} (${r.overall_score}/100) — ASIN Analyzer</title>
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

// Dashboard pages (require auth — enforced client-side, API endpoints verify token)
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/dashboard/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get('/dashboard/account', (req, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
app.get('/compare', (req, res) => res.sendFile(path.join(__dirname, 'public', 'compare.html')));
app.get('/keywords', (req, res) => res.sendFile(path.join(__dirname, 'public', 'keywords.html')));

// ═══════════════════════════════════════════════════════════════
// CHROME EXTENSION API (Sprint 6.1)
// ═══════════════════════════════════════════════════════════════

// Extension API key auth middleware
async function requireExtensionAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey) return res.status(401).json({ error: 'API key required. Get yours at asinanalyzer.app/dashboard/account' });

  try {
    const result = await pool.query(
      'SELECT id, email, subscription_tier, subscription_status FROM user_profiles WHERE extension_api_key = $1',
      [apiKey]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid API key.' });

    req.extUser = result.rows[0];
    req.extUser.isPaid = result.rows[0].subscription_status === 'active' && result.rows[0].subscription_tier !== 'free';
    next();
  } catch (err) {
    console.error('Extension auth error:', err.message);
    res.status(500).json({ error: 'Auth failed.' });
  }
}

// Simple in-memory rate limiter for batch endpoint (1 req per 10s per key)
const batchRateLimit = {};
function checkBatchRate(apiKey) {
  const now = Date.now();
  const last = batchRateLimit[apiKey] || 0;
  if (now - last < 10000) return false;
  batchRateLimit[apiKey] = now;
  return true;
}

// ── GET /api/auth/extension-key — Get or generate extension API key ──
app.get('/api/auth/extension-key', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query('SELECT extension_api_key FROM user_profiles WHERE id = $1', [userId]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Profile not found.' });

    let apiKey = result.rows[0].extension_api_key;

    if (!apiKey) {
      // Generate new key: aa_ prefix + 48 random hex chars
      const crypto = require('crypto');
      apiKey = 'aa_' + crypto.randomBytes(24).toString('hex');
      await pool.query('UPDATE user_profiles SET extension_api_key = $1 WHERE id = $2', [apiKey, userId]);
    }

    res.json({ apiKey });
  } catch (err) {
    console.error('Extension key error:', err.message);
    res.status(500).json({ error: 'Failed to get API key.' });
  }
});

// ── GET /api/extension/score/:asin — Cached score lookup (no scrape) ──
app.get('/api/extension/score/:asin', requireExtensionAuth, async (req, res) => {
  try {
    const asin = (req.params.asin || '').trim().toUpperCase();
    if (!asin || !/^B0[A-Z0-9]{8}$/i.test(asin)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    const result = await pool.query(
      `SELECT id, overall_score, overall_grade, product_title, brand, created_at
       FROM analyses WHERE UPPER(asin) = $1
       ORDER BY created_at DESC LIMIT 1`,
      [asin]
    );

    if (result.rows.length === 0) {
      return res.json({ asin, found: false, message: 'No analysis found. Scan this ASIN first.' });
    }

    const row = result.rows[0];
    const response = {
      asin,
      found: true,
      grade: row.overall_grade,
      title: row.product_title,
      brand: row.brand,
      analyzedAt: row.created_at,
      reportUrl: `https://www.asinanalyzer.app/report/${row.id}`,
    };

    // Paid users get full score; free users get grade only
    if (req.extUser.isPaid) {
      response.score = row.overall_score;
      response.reportId = row.id;
    }

    res.json(response);
  } catch (err) {
    console.error('Extension score error:', err.message);
    res.status(500).json({ error: 'Failed to get score.' });
  }
});

// ── POST /api/extension/batch-scores — Batch cached scores (max 48 ASINs) ──
app.post('/api/extension/batch-scores', requireExtensionAuth, async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (!checkBatchRate(apiKey)) {
      return res.status(429).json({ error: 'Rate limited. 1 request per 10 seconds.' });
    }

    const { asins } = req.body;
    if (!Array.isArray(asins) || asins.length === 0 || asins.length > 48) {
      return res.status(400).json({ error: 'Provide 1-48 ASINs.' });
    }

    const cleanAsins = asins.map(a => (a || '').trim().toUpperCase()).filter(a => /^B0[A-Z0-9]{8}$/i.test(a));
    if (cleanAsins.length === 0) return res.json({ scores: {} });

    // Get latest score for each ASIN using DISTINCT ON
    const placeholders = cleanAsins.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `SELECT DISTINCT ON (UPPER(asin)) asin, id, overall_score, overall_grade, product_title, created_at
       FROM analyses WHERE UPPER(asin) IN (${placeholders})
       ORDER BY UPPER(asin), created_at DESC`,
      cleanAsins
    );

    const scores = {};
    result.rows.forEach(row => {
      const key = row.asin.toUpperCase();
      scores[key] = {
        grade: row.overall_grade,
        title: row.product_title,
        reportUrl: `https://www.asinanalyzer.app/report/${row.id}`,
      };
      if (req.extUser.isPaid) {
        scores[key].score = row.overall_score;
        scores[key].reportId = row.id;
      }
    });

    res.json({ scores, found: Object.keys(scores).length, total: cleanAsins.length });
  } catch (err) {
    console.error('Extension batch error:', err.message);
    res.status(500).json({ error: 'Failed to get batch scores.' });
  }
});

// ── POST /api/extension/analyze/:asin — Trigger full analysis from extension ──
app.post('/api/extension/analyze/:asin', requireExtensionAuth, async (req, res) => {
  try {
    if (!req.extUser.isPaid) {
      return res.status(403).json({ error: 'Full analysis requires a paid plan.' });
    }

    const asin = (req.params.asin || '').trim().toUpperCase();
    if (!asin || !/^B0[A-Z0-9]{8}$/i.test(asin)) {
      return res.status(400).json({ error: 'Invalid ASIN.' });
    }

    const userId = req.extUser.id;

    // Check quota
    const profile = await pool.query('SELECT * FROM user_profiles WHERE id = $1', [userId]);
    if (profile.rows.length > 0) {
      const p = profile.rows[0];
      const tier = p.subscription_tier || 'free';
      const limit = TIER_LIMITS[tier] || 1;
      const used = p.analyses_this_month || 0;

      if (used >= limit) {
        return res.status(402).json({ error: `Quota exceeded (${used}/${limit}). Upgrade for more.` });
      }
    }

    // Scrape and score
    const product = await scrapeAmazon(asin);
    const { scores, overall, grade, actions } = scoreProduct(product);

    // Save to database
    let reportId = null;
    try {
      const result = await pool.query(
        `INSERT INTO analyses (asin, email, user_id, product_title, brand, price, currency, rating, review_count, bsr, category, image_count, bullet_count, has_aplus, has_video, qa_count, overall_score, overall_grade, scores, raw_data, action_items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id`,
        [
          asin, req.extUser.email, userId,
          product.title, product.brand, product.price, product.currency,
          product.rating, product.reviewCount, product.bsr, product.category,
          product.imageCount, product.bulletCount, product.hasAPlus, product.hasVideo, product.qaCount,
          overall, grade, JSON.stringify(scores), JSON.stringify(product), JSON.stringify(actions),
        ]
      );
      reportId = result.rows[0].id;
    } catch (dbErr) {
      console.error('DB save from extension failed:', dbErr.message);
    }

    // Increment quota
    await pool.query(
      'UPDATE user_profiles SET analyses_this_month = analyses_this_month + 1 WHERE id = $1',
      [userId]
    ).catch(e => console.error('Quota increment failed:', e.message));

    // GHL webhook
    if (req.extUser.email) triggerGHL(req.extUser.email, asin, overall, grade, reportId, product);

    console.log(`🔌 Extension scan: ${asin} → ${grade} (${overall}/100)`);

    res.json({
      asin, grade, score: overall,
      reportId,
      reportUrl: reportId ? `https://www.asinanalyzer.app/report/${reportId}` : null,
      title: product.title,
    });
  } catch (err) {
    console.error('Extension analyze error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// Catch-all → landing page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══ START ═══
app.listen(PORT, async () => {
  console.log(`🚀 ASIN Analyzer v3.0 running on port ${PORT}`);
  await initDB();
});
