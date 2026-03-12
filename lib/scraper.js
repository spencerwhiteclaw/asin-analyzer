// ============================================================
// lib/scraper.js — Amazon Scraping via Scrapingdog
// Extracted from server.js (lines 200-331)
// ============================================================

const fetch = require('node-fetch');

/**
 * Scrape an Amazon product page via Scrapingdog.
 * @param {string} asin - Amazon ASIN (e.g., B0XXXXXXXX)
 * @returns {Promise<Object>} Parsed product data
 */
async function scrapeAmazon(asin) {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) throw new Error('SCRAPINGDOG_API_KEY not configured');

  const amazonUrl = `https://www.amazon.com/dp/${asin}`;
  const scraperUrl = `https://api.scrapingdog.com/scrape?api_key=${apiKey}&url=${encodeURIComponent(amazonUrl)}&dynamic=true`;

  console.log(`[SCRAPE] Scraping ${asin} via Scrapingdog...`);
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

/**
 * Parse raw Amazon HTML into structured product data.
 * @param {string} html - Raw HTML from Amazon product page
 * @param {string} asin - The ASIN being parsed
 * @returns {Object} Structured product data
 */
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

module.exports = { scrapeAmazon, parseAmazonHTML };
