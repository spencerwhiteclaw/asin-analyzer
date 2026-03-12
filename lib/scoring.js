// ============================================================
// lib/scoring.js — 12-Point Scoring Algorithm (v4.4 Rebuild)
// ALL scores are 0-100 scale — directly maps to grade display
// Score keys: title, images, video, bullets, aPlus, rating,
//   reviews, qa, bsr, brand, completeness, contentDepth
// DO NOT CHANGE SCORING LOGIC — this is the product IP.
// ============================================================

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

module.exports = { scoreProduct };
