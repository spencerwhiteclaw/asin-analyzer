// ============================================================
// lib/plan-generator.js — Implementation Plan Generator (v4.4)
// Claude API — the $7 product
// Deep, listing-specific, references actual title/bullets/images
// Score keys: title, images, video, bullets, aPlus, rating,
//   reviews, qa, bsr, brand, completeness, contentDepth
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function generateImplementationPlan(product, scores, grade, overall, actions) {
  if (!anthropic) {
    console.warn('ANTHROPIC_API_KEY not set — returning fallback implementation plan');
    return { sections: actions.map(a => ({ category: a.category, priority: a.priority, problem: a.problem, solution: a.solution })) };
  }

  const scoreDisplayNames = {
    title: 'Title Optimization', images: 'Image Gallery', video: 'Video Content',
    bullets: 'Bullet Points', aPlus: 'A+ / Enhanced Content', rating: 'Star Rating',
    reviews: 'Review Volume', qa: 'Q&A Engagement', bsr: 'Sales Rank (BSR)',
    brand: 'Brand Presence', completeness: 'Listing Completeness', contentDepth: 'Content Depth'
  };

  const titleLen = (product.title || '').length;
  const avgBulletLen = product.bulletLengths?.length > 0
    ? Math.round(product.bulletLengths.reduce((a, b) => a + b, 0) / product.bulletLengths.length)
    : 0;

  const prompt = `You are the world's leading Amazon listing optimization consultant. A seller just ran a 12-point diagnostic on their listing and you need to create their personalized Implementation Plan — a step-by-step action plan to fix every issue found.

THIS IS A PAID PRODUCT ($7). It must deliver AT LEAST $200 worth of value. Be brutally specific, actionable, and reference their actual listing data throughout. No generic advice — every recommendation must directly reference their ASIN, their title, their images, their actual numbers. The seller should feel like a $2,000 consultant reviewed their listing personally.

LISTING DATA:
- ASIN: ${product.asin}
- Title: "${product.title}"
- Title Length: ${titleLen} characters
- Brand: ${product.brand || 'Not detected'}
- Price: $${(product.price || 0).toFixed(2)}
- Rating: ${product.rating || 'N/A'}/5 (${(product.reviewCount || 0).toLocaleString()} reviews)
- BSR: #${(product.bsr || 0).toLocaleString()} in ${product.category || 'Unknown'}
- Images: ${product.imageCount || 0} hi-res images ${product.hasVideo ? '(has video)' : '(NO video)'}
- Bullets: ${product.bulletCount || 0}/5 (avg length: ${avgBulletLen} chars)
- A+ Content: ${product.hasAPlus ? 'Active' : 'Missing'}
- Description Length: ${product.descriptionLength || 0} characters
- Q&A: ${product.qaCount || 0} answered questions
- Overall Grade: ${grade} (${overall}/100)

SCORES BY CATEGORY (all scored 0-100):
${Object.entries(scores).map(([k, v]) => `- ${scoreDisplayNames[k] || k}: ${v}/100`).join('\n')}

ISSUES FOUND (${actions.length} total):
${actions.map(a => `[${a.priority.toUpperCase()}] ${a.category}: ${a.problem}`).join('\n')}

Create a comprehensive Implementation Plan with these sections:

1. EXECUTIVE SUMMARY — 3-4 sentences. Name their grade, their biggest strengths (scores above 80), and their most urgent problems (scores below 50). Be direct and honest.

2. QUICK WINS — 5 things they can do TODAY in under 30 minutes each. Reference their actual listing.

3. 30-DAY ACTION CALENDAR — Week-by-week plan:
   - Week 1: Quick wins + image fixes
   - Week 2: Copy optimization (title, bullets, description/A+)
   - Week 3: Review strategy + Q&A seeding
   - Week 4: Advanced optimization + measurement

4. CATEGORY-BY-CATEGORY FIX PLANS — For EACH issue found:
   - The specific problem (1 sentence referencing their data)
   - Step-by-step fix (3-7 numbered steps, each actionable and specific to THEIR listing)
   - Expected score impact
   - Time estimate for the fix

5. KEYWORD SUGGESTIONS — 15-20 specific keywords. Group into: (a) Primary (top 5), (b) Long-tail (10+), (c) Competitor keywords.

6. TITLE REWRITE — Write a complete optimized title. Show current vs rewritten, explain each change.

7. BULLET POINT REWRITES — Write all 5 optimized bullet points. Each 200-300 characters using ALL-CAPS BENEFIT formula.

8. A/B TESTING GAME PLAN — Step-by-step instructions for Manage Your Experiments. Test title as Version B, run 2 weeks, check results, re-score at asinanalyzer.app. If B wins lock it in. If A wins analyze and tweak. Then test bullets. Emphasize continuous testing cycle.

Respond in JSON format:
{
  "executiveSummary": "...",
  "quickWins": [{"action": "...", "timeMinutes": 10, "impact": "...", "howTo": "step-by-step instructions"}],
  "weeklyCalendar": {"week1": ["..."], "week2": ["..."], "week3": ["..."], "week4": ["..."]},
  "categoryPlans": [{"category": "...", "currentScore": 65, "targetScore": 85, "priority": "high|medium|low", "problem": "...", "steps": ["..."], "expectedImpact": "...", "timeEstimate": "2 hours"}],
  "keywordSuggestions": {"primary": ["..."], "longTail": ["..."], "competitor": ["..."]},
  "titleRewrite": {"current": "...", "optimized": "...", "changes": "..."},
  "bulletRewrites": [{"bullet": 1, "text": "...", "focus": "primary benefit"}],
  "abTestingPlan": {"titleTest": {"setup": "...", "duration": "2 weeks", "whatToMeasure": "...", "nextSteps": "..."}, "bulletTest": {"setup": "...", "duration": "2 weeks", "whatToMeasure": "...", "nextSteps": "..."}, "ongoingStrategy": "Keep testing every 2 weeks. Re-score at asinanalyzer.app after each test cycle. Top sellers never stop optimizing."}
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { raw: text };
  } catch (err) {
    console.error('Claude API error:', err.message);
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

module.exports = { generateImplementationPlan };
