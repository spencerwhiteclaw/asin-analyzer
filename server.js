// ═══════════════════════════════════════════════════════════════
// ASIN Analyzer v2.0 — Server
// Express backend: scraping via Scrapingdog, 12-point scoring, PostgreSQL, Resend
// © 2026 ASIN Analyzer · A Gonipless Product
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══ MIDDLEWARE ═══
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══ DATABASE ═══
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

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
    `);
    console.log('✅ Database tables ready');
  } catch (err) {
    console.error('⚠️  Database init failed (will retry on first request):', err.message);
  }
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

  // Images — count unique hi-res images from image block
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

  // Description length (for non-A+ scoring)
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
// 12-POINT SCORING ALGORITHM
// ═══════════════════════════════════════════════════════════════

function scoreProduct(product) {
  const scores = {};
  const actions = [];

  // ── 1. Title Quality (sweet spot 120-180 chars) ──
  const titleLen = (product.title || '').length;
  if (titleLen >= 120 && titleLen <= 180) scores.title = 10;
  else if (titleLen >= 100 && titleLen <= 200) scores.title = 8;
  else if (titleLen >= 80 && titleLen <= 220) scores.title = 6;
  else if (titleLen >= 50) scores.title = 4;
  else if (titleLen > 0) scores.title = 2;
  else scores.title = 1;

  if (scores.title < 7) {
    actions.push({
      category: 'Title Optimization',
      text: titleLen < 120
        ? `Your title is only ${titleLen} characters. Amazon allows up to 200. Add keywords, key features, and differentiators to reach the 120-180 character sweet spot.`
        : `Your title is ${titleLen} characters — too long. Trim filler words and keep the most important keywords in the first 80 characters for mobile visibility.`,
      priority: scores.title < 4 ? 'high' : 'medium',
    });
  }

  // ── 2. Image Score (7+ = 10, video = +1 bonus) ──
  const imgCount = product.imageCount || 0;
  if (imgCount >= 7) scores.images = 9;
  else if (imgCount >= 5) scores.images = 7;
  else if (imgCount >= 3) scores.images = 5;
  else if (imgCount >= 1) scores.images = 3;
  else scores.images = 1;
  if (product.hasVideo) scores.images = Math.min(10, scores.images + 1);

  if (scores.images < 7) {
    actions.push({
      category: 'Image Optimization',
      text: `You have ${imgCount} images${product.hasVideo ? ' with video' : ' and no video'}. Top-performing listings use 7+ high-quality images including infographics, lifestyle shots, and size comparisons. ${!product.hasVideo ? 'Adding a product video can boost conversion by 9.7%.' : ''}`,
      priority: scores.images < 4 ? 'high' : 'medium',
    });
  }

  // ── 3. Bullet Points (5 bullets at 200+ chars each) ──
  const bulletCount = product.bulletCount || 0;
  const avgBulletLen = product.bulletLengths?.length > 0
    ? product.bulletLengths.reduce((a, b) => a + b, 0) / product.bulletLengths.length
    : 0;

  if (bulletCount >= 5 && avgBulletLen >= 200) scores.bullets = 10;
  else if (bulletCount >= 5 && avgBulletLen >= 100) scores.bullets = 8;
  else if (bulletCount >= 4) scores.bullets = 6;
  else if (bulletCount >= 3) scores.bullets = 4;
  else if (bulletCount >= 1) scores.bullets = 2;
  else scores.bullets = 1;

  if (scores.bullets < 7) {
    actions.push({
      category: 'Bullet Point Enhancement',
      text: `You have ${bulletCount}/5 bullet points${avgBulletLen > 0 ? ` averaging ${Math.round(avgBulletLen)} chars` : ''}. Write 5 keyword-rich bullets at 200+ characters each. Lead each bullet with a CAPITALIZED benefit and follow with specific details.`,
      priority: scores.bullets < 4 ? 'high' : 'medium',
    });
  }

  // ── 4. A+ / Description ──
  if (product.hasAPlus) {
    scores.description = 9;
  } else if (product.descriptionLength >= 2000) {
    scores.description = 7;
  } else if (product.descriptionLength >= 1000) {
    scores.description = 5;
  } else if (product.descriptionLength >= 300) {
    scores.description = 3;
  } else {
    scores.description = 1;
  }

  if (scores.description < 7) {
    actions.push({
      category: 'A+ Content / Description',
      text: product.hasAPlus
        ? 'Your A+ Content is active — review it for SEO keywords, comparison charts, and brand story modules to maximize conversion.'
        : 'No A+ Content detected. Brand-registered sellers with A+ Content see 3-10% higher conversion rates. Add comparison charts, enhanced images, and brand storytelling.',
      priority: !product.hasAPlus ? 'high' : 'low',
    });
  }

  // ── 5. Pricing Position ──
  const price = product.price || 0;
  if (price > 0 && price <= 25) scores.pricing = 8;
  else if (price <= 50) scores.pricing = 9;
  else if (price <= 100) scores.pricing = 8;
  else if (price <= 200) scores.pricing = 7;
  else if (price <= 500) scores.pricing = 6;
  else if (price > 500) scores.pricing = 5;
  else scores.pricing = 5;

  // ── 6. Review Quality (star rating) ──
  const rating = product.rating || 0;
  if (rating >= 4.5) scores.reviewQuality = 10;
  else if (rating >= 4.0) scores.reviewQuality = 8;
  else if (rating >= 3.5) scores.reviewQuality = 6;
  else if (rating >= 3.0) scores.reviewQuality = 4;
  else if (rating > 0) scores.reviewQuality = 2;
  else scores.reviewQuality = 1;

  if (scores.reviewQuality < 7) {
    actions.push({
      category: 'Review Quality',
      text: `Your ${rating}/5 star rating is dragging down your conversion rate. Identify recurring complaints in 1-2 star reviews and address them — product improvements, updated listing photos, or insert cards asking satisfied buyers to leave reviews.`,
      priority: scores.reviewQuality < 4 ? 'high' : 'medium',
    });
  }

  // ── 7. Review Quantity ──
  const reviewCount = product.reviewCount || 0;
  if (reviewCount >= 1000) scores.reviewQuantity = 10;
  else if (reviewCount >= 500) scores.reviewQuantity = 9;
  else if (reviewCount >= 200) scores.reviewQuantity = 8;
  else if (reviewCount >= 100) scores.reviewQuantity = 7;
  else if (reviewCount >= 50) scores.reviewQuantity = 5;
  else if (reviewCount >= 10) scores.reviewQuantity = 3;
  else scores.reviewQuantity = 1;

  if (scores.reviewQuantity < 7) {
    actions.push({
      category: 'Review Volume',
      text: `Only ${reviewCount.toLocaleString()} reviews puts you at a disadvantage. Use Amazon Vine, "Request a Review" button, and follow-up sequences to build social proof. Listings with 100+ reviews see significantly higher click-through rates.`,
      priority: scores.reviewQuantity < 4 ? 'high' : 'medium',
    });
  }

  // ── 8. Q&A Presence ──
  const qaCount = product.qaCount || 0;
  if (qaCount >= 20) scores.qa = 10;
  else if (qaCount >= 10) scores.qa = 8;
  else if (qaCount >= 5) scores.qa = 6;
  else if (qaCount >= 1) scores.qa = 4;
  else scores.qa = 2;

  if (scores.qa < 7) {
    actions.push({
      category: 'Q&A Section',
      text: `Only ${qaCount} Q&As answered. Proactively seed questions about key features, sizing, compatibility, and use cases. Answer every question within 24 hours. Listings with 10+ Q&As build buyer confidence.`,
      priority: 'low',
    });
  }

  // ── 9. BSR / Sales Rank ──
  const bsr = product.bsr || 0;
  if (bsr > 0 && bsr <= 1000) scores.bsr = 10;
  else if (bsr <= 5000) scores.bsr = 9;
  else if (bsr <= 10000) scores.bsr = 8;
  else if (bsr <= 25000) scores.bsr = 7;
  else if (bsr <= 50000) scores.bsr = 6;
  else if (bsr <= 100000) scores.bsr = 5;
  else if (bsr <= 250000) scores.bsr = 3;
  else if (bsr > 0) scores.bsr = 2;
  else scores.bsr = 1;

  // ── 10. Category Rank (bonus for top 100) ──
  if (bsr > 0 && bsr <= 100) scores.categoryRank = 10;
  else if (bsr <= 500) scores.categoryRank = 8;
  else if (bsr <= 2000) scores.categoryRank = 7;
  else if (bsr <= 10000) scores.categoryRank = 6;
  else if (bsr <= 50000) scores.categoryRank = 5;
  else if (bsr <= 100000) scores.categoryRank = 4;
  else scores.categoryRank = 3;

  // ── 11. Keyword Visibility (title keywords in bullets/desc) ──
  const titleWords = (product.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const bulletText = (product.bulletLengths || []).length > 0 ? 'bullets present' : '';
  const descText = (product.descriptionLength || 0) > 0 ? 'desc present' : '';
  const combinedText = `${bulletText} ${descText}`.toLowerCase();

  if (product.bulletCount >= 5 && (product.hasAPlus || product.descriptionLength > 1000)) {
    scores.keywords = 8;
  } else if (product.bulletCount >= 3 && product.descriptionLength > 300) {
    scores.keywords = 6;
  } else if (product.bulletCount >= 1) {
    scores.keywords = 4;
  } else {
    scores.keywords = 2;
  }

  if (scores.keywords < 7) {
    actions.push({
      category: 'Keyword Optimization',
      text: 'Ensure your top search keywords appear naturally across your title, bullet points, A+ Content, and backend search terms. Use tools like Helium 10 or Brand Analytics to identify high-volume, low-competition keywords in your niche.',
      priority: 'medium',
    });
  }

  // ── 12. Completeness (penalizes missing elements) ──
  let completenessScore = 10;
  if (imgCount < 5) completenessScore -= 2;
  if (bulletCount < 5) completenessScore -= 2;
  if (!product.hasAPlus && product.descriptionLength < 500) completenessScore -= 2;
  if (!product.hasVideo) completenessScore -= 1;
  if (qaCount < 5) completenessScore -= 1;
  if (reviewCount < 10) completenessScore -= 1;
  if (!product.brand) completenessScore -= 1;
  scores.completeness = Math.max(1, completenessScore);

  if (scores.completeness < 7) {
    const missing = [];
    if (imgCount < 5) missing.push(`images (${imgCount}/7)`);
    if (bulletCount < 5) missing.push(`bullets (${bulletCount}/5)`);
    if (!product.hasAPlus) missing.push('A+ Content');
    if (!product.hasVideo) missing.push('product video');
    if (qaCount < 5) missing.push(`Q&A (${qaCount})`);
    actions.push({
      category: 'Listing Completeness',
      text: `Your listing is missing key elements: ${missing.join(', ')}. Complete listings rank higher and convert better. Fill every field Amazon gives you.`,
      priority: scores.completeness < 4 ? 'high' : 'medium',
    });
  }

  // ── OVERALL SCORE & GRADE ──
  const scoreValues = Object.values(scores);
  const rawTotal = scoreValues.reduce((a, b) => a + b, 0);
  const maxPossible = scoreValues.length * 10;
  const overall = Math.round((rawTotal / maxPossible) * 100);

  let grade;
  if (overall >= 90) grade = 'A+';
  else if (overall >= 85) grade = 'A';
  else if (overall >= 80) grade = 'B+';
  else if (overall >= 75) grade = 'B';
  else if (overall >= 70) grade = 'C+';
  else if (overall >= 65) grade = 'C';
  else if (overall >= 55) grade = 'D';
  else grade = 'F';

  // Sort actions by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

  return { scores, overall, grade, actions };
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
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// ── POST /api/analyze ──
app.post('/api/analyze', async (req, res) => {
  try {
    const { asin, email } = req.body;

    // Validate ASIN
    const cleanASIN = (asin || '').trim().toUpperCase();
    if (!cleanASIN || !/^B0[A-Z0-9]{8}$/i.test(cleanASIN)) {
      return res.status(400).json({ error: 'Invalid ASIN. Must be 10 characters starting with B0.' });
    }

    // Scrape Amazon
    const product = await scrapeAmazon(cleanASIN);

    // Score the listing
    const { scores, overall, grade, actions } = scoreProduct(product);

    // Save to database
    let reportId = null;
    try {
      const result = await pool.query(
        `INSERT INTO analyses (asin, email, product_title, brand, price, currency, rating, review_count, bsr, category, image_count, bullet_count, has_aplus, has_video, qa_count, overall_score, overall_grade, scores, raw_data, action_items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING id`,
        [
          cleanASIN, email || null, product.title, product.brand, product.price, product.currency,
          product.rating, product.reviewCount, product.bsr, product.category,
          product.imageCount, product.bulletCount, product.hasAPlus, product.hasVideo, product.qaCount,
          overall, grade, JSON.stringify(scores), JSON.stringify(product), JSON.stringify(actions),
        ]
      );
      reportId = result.rows[0].id;
    } catch (dbErr) {
      console.error('DB save failed (returning report anyway):', dbErr.message);
    }

    // Subscribe email if provided
    if (email) {
      try {
        await pool.query(
          `INSERT INTO subscribers (email, source) VALUES ($1, 'report') ON CONFLICT (email) DO NOTHING`,
          [email]
        );
      } catch (e) { /* ignore dupe */ }
    }

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
      scores, overall, grade, actions,
    };

    // Send email report (async, don't block response)
    if (email) sendReportEmail(email, report);

    console.log(`✅ ${cleanASIN} → ${grade} (${overall}/100) — ${actions.length} actions`);
    res.json({ report });

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// ── GET /api/report/:id ──
app.get('/api/report/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM analyses WHERE id = $1', [parseInt(id, 10)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    res.json({ report: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load report' });
  }
});

// ── POST /api/subscribe ──
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    await pool.query(
      `INSERT INTO subscribers (email, source) VALUES ($1, 'newsletter') ON CONFLICT (email) DO UPDATE SET active = true`,
      [email.trim().toLowerCase()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Subscription failed' });
  }
});

// ── GET /api/stats ──
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

// ═══ PAGE ROUTES ═══
app.get('/report/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

// Catch-all → landing page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══ START ═══
app.listen(PORT, async () => {
  console.log(`🚀 ASIN Analyzer v2.0 running on port ${PORT}`);
  await initDB();
});
