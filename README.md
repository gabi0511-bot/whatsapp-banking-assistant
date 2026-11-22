# WhatsApp Banking Assistant

**WhatsApp Banking Assistant** is an AI-powered personal finance, bill-auditing, and payment-tracking assistant built for Romania. It connects **WhatsApp (Baileys)**, **Gmail**, **PostgreSQL**, and **Google Gemini** to turn your WhatsApp chat into a secure, conversational Financial AI Twin — with zero rigid commands and deterministic `BIGINT` financial precision.

---

## Core Capabilities

### 1. Invoice X-Ray (Automated Bill Audit & Dispute Drafts)
- Automatically polls Gmail for Romanian utility (electricity, natural gas, water) and telecom invoices (**e-Factura UBL 2.1 XML-first** + **PDF extraction** via Gemini structured output).
- **Zero-LLM Arithmetic:** All totals, VAT, unit prices, and deltas are validated deterministically in integer subunits (`BIGINT` bani) + `decimal.js`.
- **3-Pillar Audit Engine:**
  - *Meter Reading:* detects estimated bills, meter regressions, and schedules `Europe/Bucharest` self-reading reminders (`autocitire`).
  - *Pricing & Anomalies:* detects unit price hikes vs. contract/history, expired promotional discounts, and late-payment penalties.
  - *Dispute Builder:* generates formal Romanian dispute emails and saves them strictly to **Gmail Drafts** (never auto-sent).

### 2. Strictly-Scoped Financial AI Twin (WhatsApp)
- **Natural Conversation (Zero Fixed Commands):** Ask freely in Romanian (or English) — e.g., *"La ce mai am de plată?"*, *"Plătește factura de la ENGIE"*, *"Am vreun trial activ?"*, *"Compară-mi plățile de luna asta cu luna trecută și fă-mi un rating"*.
- **3-Layer Defense-in-Depth Guardrail:** Deterministic pre-filter → strict JSON intent gatekeeper → live PostgreSQL tool-grounded generator. Off-topic requests and prompt injections are reliably blocked
- **Multi-Model Gemini Flash Rotation:** Automatically rotates across healthy Gemini Flash models with per-model cooldown on `429`/`503` spikes, keeping responses fast and genuinely AI-generated.

### 3. Tracked Payment QR & Brushed-Metal Checkout Page (`/pay/:token`)
- Generates signed PNG QR codes and tracked `/pay/:token` payment links for invoices and manual WhatsApp payments.
- Filters out WhatsApp/Facebook link-preview bots so only real human scans record `QR_ACCESSED`.
- Serves a bespoke split-screen brushed-metal fintech checkout page with one-tap copyable amount/IBAN/reference and instant WhatsApp confirmation sync (`POST /pay/:token/confirm`).
- Smart anti-spam reminder engine (`REMINDER_QR_UNACCESSED`, `REMINDER_QR_ABANDONED`, `REMINDER_OVERDUE`) that never nags for disputed/held bills.

### 4. Subscription "Zombie" Radar, Silent Price-Hike Detector & 48h Free-Trial Alerts
- Groups ~30-day recurring charges, computes exact monthly and cumulative annual cost (`sumă × 12`), and flags unused micro-subscriptions.
- Sends immediate AI-composed WhatsApp alerts whenever a subscription price increases silently compared to the prior month.
- Watches Gmail for **free-trial activation & cancellation emails** (`free trial`, `perioadă de probă`, `reînnoire automată`), schedules automatic WhatsApp reminders **48 hours before expiration**, and displays **Sold curent (Demo)** + 30-day **Safe-to-Spend**.

### 5. End-of-Month Payment Efficiency Rating & Savings Advisor
- Compares current month vs. previous month payment discipline (on-time rate, late payments, penalties) and calculates an exact rating (`0–100`, `A+` to `D`).
- When you spend less than last month, recommends moving the exact saved difference into a savings account or investments (`cont de economii / depozit / titluri de stat / ETF`) with annualized savings potential.

---

## Tech Stack

- **Runtime & Language:** Node.js 20+, TypeScript (`strict: true`, ESM)
- **Database:** PostgreSQL 16 (`pg`, raw SQL idempotent migrations `001`–`005`)
- **AI:** `@google/genai` (Gemini Flash multi-model fallback chain + structured JSON + function calling)
- **Messaging & Email:** `@whiskeysockets/baileys` (WhatsApp Multi-Device), `googleapis` (Gmail API)
- **Web Server & Scheduling:** Express 5 (`/pay/:token`), `qrcode`, `node-cron`
- **Precision & Validation:** `BIGINT` bani, `decimal.js`, `zod`, `pino`, `vitest`

---

## Security & Privacy Notice

Sensitive credentials and session keys are **excluded via `.gitignore` and MUST NEVER be committed**:
- `.env` (API keys, Gmail OAuth secrets/refresh token, personal WhatsApp JID)
- `.baileys_auth/` (WhatsApp Multi-Device cryptographic session keys)

Always configure secrets locally by copying `.env.example` to `.env`.

---

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd invoice-xray
npm install
cp .env.example .env
```

Fill in `.env` with your local `DATABASE_URL`, `GEMINI_API_KEY`, Gmail OAuth2 credentials, `USER_FULL_NAME`, and `OWNER_WHATSAPP_JID`.

### 2. Start PostgreSQL 16 & Run Migrations

```bash
docker compose up -d
npm run migrate
```

Applies all idempotent migrations:
- `001_init.sql` — Invoice X-Ray schema + Romanian provider defaults
- `002_ai_twin_and_payment_tracking.sql` — WhatsApp payments, tracked QR links/events, AI Twin memory & chat history
- `004_subscription_radar.sql` — Demo Balance, recurring subscriptions, charge history, price hikes, and free trials
- `005_monthly_reviews.sql` — End-of-month efficiency comparison & review history

*(Optional)* Seed sample paid utility bills (water, gas, electricity, telecom) for the previous 2 months:

```bash
npm run seed:history
```

### 3. Run Typecheck, Build & Tests

```bash
npm run typecheck
npm run build
npm test
```

### 4. Offline Simulators (No Live Gmail / WhatsApp Needed)

```bash
npm run simulate        # Invoice X-Ray 3-pillar audit demo
npm run simulate:twin   # AI Twin + local /pay/:token QR server + abandonment reminders
npm run simulate:radar  # Subscription Zombie Radar + silent price hikes + 48h free-trial alerts
```

### 5. Live Mode (Gmail + WhatsApp)

1. Generate your Gmail OAuth2 refresh token once:
   ```bash
   npm run gmail:auth
   ```
2. Start the assistant and scan the terminal QR code from **WhatsApp → Linked Devices**:
   ```bash
   npm run dev
   ```
3. *(Optional)* Expose port `3080` over HTTPS so phone QR scans hit `/pay/:token`:
   ```bash
   cloudflared tunnel --url http://localhost:3080
   ```
   Copy the generated `https://...trycloudflare.com` URL into `PUBLIC_BASE_URL` in `.env`.

---

## Example WhatsApp Prompts

- *"La ce facturi mai am de plată?"*
- *"Plătește factura de la ENGIE"*
- *"Am plătit Hidroelectrica"*
- *"Am vreun abonament activ sau vreun free trial?"*
- *"Verifică Gmail-ul dacă am vreun trial nou"*
- *"Mi-am făcut trial la Canva 14 zile, după e 55 lei pe lună"*
- *"Am anulat trial-ul la Adobe"*
- *"Compară-mi plățile de luna asta cu luna trecută și fă-mi un rating"*
- *"Am 2400 lei în cont, cât pot cheltui în siguranță luna asta?"*

---

## Team

Built as a team project for **Hack2026**:

| Name | GitHub | Role |
|---|---|---|
| *(Banciu Alexandru)* | `@AlexTM033` | Backend / AI Architecture |
| *(Sandru Gabriel)* | `@gabi0511-bot` | Invoice X-Ray & Integrations |
| *(Hodos Mihnea)* | `@MihneaHodos` | Frontend / Checkout UI & Testing |
