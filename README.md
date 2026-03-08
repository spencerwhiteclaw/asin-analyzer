# ASIN Analyzer v3.0 — Sprint 1: First Dollar

**Diagnose Your Listing. Dominate Your Category.**

## What's New in v3.0
- **Content Split**: Action items have `problem` (free) and `solution` (paid) fields
- **Rate Limiting**: 1 free report per email address, ever
- **Implementation Plan Generator**: Claude API generates listing-specific $7 paid product
- **Reveal & Gate Report**: Grade + 3 worst scores visible, email unlocks full report
- **Complete Funnel**: $7 tripwire → $19/mo upsell → $39/mo disappearing OTO → $4.97 downsell
- **Stripe Integration**: Checkout sessions + webhook handler (activate when Stripe account ready)
- **GHL Webhook**: Fires contact data after every analysis for CRM automation

## File Structure
```
asin-analyzer/
├── server.js          ← Express backend (v3.0 — content split, Stripe, Claude API, GHL)
├── package.json       ← Node.js dependencies (+ @anthropic-ai/sdk, stripe)
├── Procfile           ← Railway deployment config
├── .gitignore
├── schema.sql         ← Database schema reference (4 tables)
└── public/
    ├── index.html     ← v13 landing page (email required, rate limit handling)
    ├── report.html    ← Reveal & gate report (3 worst visible, email unlocks rest, $7 CTA)
    ├── offer.html     ← $7 tripwire page (value stack, Stripe checkout)
    ├── downsell.html  ← $4.97 downsell (same plan, no bonuses)
    ├── upgrade.html   ← $19/mo Seller Plan upsell (monthly/annual toggle)
    ├── oto.html       ← $39/mo disappearing Agency Power OTO (database-tracked)
    └── thank-you.html ← Delivery page (plan display, referral, next steps)
```

## Environment Variables (Railway)
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
SCRAPINGDOG_API_KEY=69a3d4e92394935e4334bdb3
SENDER_EMAIL=reports@asinanalyzer.app
NODE_ENV=production

# Add these when ready:
ANTHROPIC_API_KEY=sk-ant-xxx          # For implementation plan generation
STRIPE_SECRET_KEY=sk_live_xxx         # Stripe secret key
STRIPE_WEBHOOK_SECRET=whsec_xxx       # Stripe webhook signing secret
GHL_WEBHOOK_URL=https://xxx           # GoHighLevel inbound webhook URL
RESEND_API_KEY=re_xxx                 # Optional — for email delivery
```

## Stripe Setup (When Account Created)
Create these products/prices in Stripe Dashboard:
- Implementation Plan + Bonuses: $7.00 one-time
- Implementation Plan Only: $4.97 one-time
- Seller Plan Monthly: $19.00/mo recurring
- Seller Plan Annual: $149.00/yr recurring
- Agency Power OTO: $39.00/mo recurring
- Agency Plan Monthly: $49.00/mo recurring
- Agency Plan Annual: $449.00/yr recurring
- Enterprise Monthly: $299.00/mo recurring

Then replace `STRIPE_PRICE_ID_*` placeholders in the HTML files with actual price IDs.

## Funnel Flow
```
Free Report → $7 Tripwire → $19/mo Upsell → $39/mo OTO → Thank You
                  ↓ NO
              $4.97 Downsell → $19/mo Upsell → Thank You
                  ↓ NO
              Email Nurture (GHL)
```

---
© 2026 ASIN Analyzer · A Gonipless Product
