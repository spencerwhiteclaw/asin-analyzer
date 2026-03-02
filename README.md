# ASIN Analyzer v2.0

**Diagnose Your Listing. Dominate Your Category.**

## What It Does
- Paste any Amazon ASIN → get a full 12-point listing audit
- Scores: Title, Images, Bullets, A+ Content, Pricing, Reviews, Q&A, BSR, and more
- Generates prioritized action plans
- Sends email reports via Resend
- Stores all analyses in PostgreSQL

## Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS (v13 design)
- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Scraping**: Scrapingdog
- **Email**: Resend
- **Hosting**: Railway

## API Endpoints
- `POST /api/analyze` — Analyze an ASIN `{ asin, email }`
- `GET /api/report/:id` — Get saved report
- `POST /api/subscribe` — Newsletter signup `{ email }`
- `GET /api/stats` — Total analyses & subscribers
- `GET /api/health` — Health check

---
© 2026 ASIN Analyzer · A Gonipless Product
