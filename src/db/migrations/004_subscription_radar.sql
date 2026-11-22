-- 0. Demo Balance (strictly only the balance amount in integer bani/cents — zero bank OAuth)
CREATE TABLE IF NOT EXISTS demo_balances (
    owner_jid VARCHAR(100) PRIMARY KEY,
    balance_cents BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'RON',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. Grouped Recurring Subscriptions (Micro-subscriptions & Zombie Radar)
CREATE TABLE IF NOT EXISTS tracked_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    owner_jid VARCHAR(100) NOT NULL,
    merchant_name VARCHAR(150) NOT NULL,
    normalized_merchant VARCHAR(150) NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'OTHER' CHECK (category IN (
        'STREAMING', 'CLOUD', 'SOFTWARE_AI', 'FITNESS', 'MUSIC', 'GAMING', 'NEWS', 'OTHER'
    )),
    billing_cycle_days INT NOT NULL DEFAULT 30 CHECK (billing_cycle_days > 0),
    billing_period VARCHAR(15) NOT NULL DEFAULT 'MONTHLY' CHECK (billing_period IN (
        'WEEKLY', 'MONTHLY', 'YEARLY'
    )),
    current_amount_cents BIGINT NOT NULL CHECK (current_amount_cents > 0),
    previous_amount_cents BIGINT,
    currency VARCHAR(3) NOT NULL DEFAULT 'RON',
    annualized_cost_cents BIGINT NOT NULL CHECK (annualized_cost_cents > 0),
    status VARCHAR(25) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
        'ACTIVE', 'ZOMBIE_SUSPECTED', 'CANCELLED', 'PAUSED'
    )),
    zombie_reason VARCHAR(255),
    charge_count INT NOT NULL DEFAULT 1,
    price_hike_count INT NOT NULL DEFAULT 0,
    last_charged_date DATE NOT NULL,
    next_expected_charge_date DATE NOT NULL,
    last_confirmed_used_at TIMESTAMPTZ,
    source VARCHAR(25) NOT NULL CHECK (source IN (
        'GMAIL_RECEIPT', 'WHATSAPP_MANUAL', 'DEMO_FEED'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_jid, normalized_merchant, currency)
);

-- 2. Raw Subscription Charge Events (used to detect ~30-day recurrence & month-over-month price hikes)
CREATE TABLE IF NOT EXISTS subscription_charge_events (
    id BIGSERIAL PRIMARY KEY,
    owner_jid VARCHAR(100) NOT NULL,
    subscription_id BIGINT REFERENCES tracked_subscriptions(id) ON DELETE SET NULL,
    external_ref VARCHAR(160) UNIQUE NOT NULL,
    merchant_name VARCHAR(150) NOT NULL,
    normalized_merchant VARCHAR(150) NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'OTHER',
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'RON',
    charged_date DATE NOT NULL,
    is_explicit_recurring BOOLEAN NOT NULL DEFAULT FALSE,
    source VARCHAR(25) NOT NULL CHECK (source IN (
        'GMAIL_RECEIPT', 'WHATSAPP_MANUAL', 'DEMO_FEED'
    )),
    raw_snippet TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Immutable Price-Hike Alert History (so AI Twin remembers every silent increase)
CREATE TABLE IF NOT EXISTS subscription_price_hikes (
    id BIGSERIAL PRIMARY KEY,
    subscription_id BIGINT NOT NULL REFERENCES tracked_subscriptions(id) ON DELETE CASCADE,
    owner_jid VARCHAR(100) NOT NULL,
    previous_amount_cents BIGINT NOT NULL,
    new_amount_cents BIGINT NOT NULL,
    monthly_delta_cents BIGINT NOT NULL,
    annual_delta_cents BIGINT NOT NULL,
    delta_pct NUMERIC(6, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'RON',
    detected_on_date DATE NOT NULL,
    notified_whatsapp_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Tracked Free Trials (detected from Gmail or programmed manually via WhatsApp/AI Twin)
CREATE TABLE IF NOT EXISTS free_trials (
    id BIGSERIAL PRIMARY KEY,
    owner_jid VARCHAR(100) NOT NULL,
    external_ref VARCHAR(160) UNIQUE NOT NULL,
    service_name VARCHAR(150) NOT NULL,
    normalized_service VARCHAR(150) NOT NULL,
    trial_start_at TIMESTAMPTZ,
    trial_end_at TIMESTAMPTZ NOT NULL,
    post_trial_amount_cents BIGINT NOT NULL CHECK (post_trial_amount_cents > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'RON',
    billing_period VARCHAR(15) NOT NULL DEFAULT 'MONTHLY' CHECK (billing_period IN (
        'WEEKLY', 'MONTHLY', 'YEARLY'
    )),
    cancellation_url TEXT,
    source VARCHAR(25) NOT NULL CHECK (source IN ('GMAIL_EMAIL', 'WHATSAPP_MANUAL', 'DEMO_FEED')),
    status VARCHAR(25) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
        'ACTIVE', 'ALERT_48H_SENT', 'CANCELLED', 'CONVERTED', 'EXPIRED'
    )),
    alert_48h_scheduled_at TIMESTAMPTZ NOT NULL,
    alert_48h_sent_at TIMESTAMPTZ,
    raw_extracted_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Safely extend financial_memory_events CHECK constraints for subscriptions & free trials
ALTER TABLE financial_memory_events
    DROP CONSTRAINT IF EXISTS financial_memory_events_event_type_check;
ALTER TABLE financial_memory_events
    ADD CONSTRAINT financial_memory_events_event_type_check CHECK (event_type IN (
        'INVOICE_DETECTED',
        'INVOICE_ANOMALY_FLAGGED',
        'DISPUTE_DRAFT_CREATED',
        'WHATSAPP_PAYMENT_LOGGED',
        'QR_GENERATED',
        'QR_ACCESSED',
        'PAYMENT_COMPLETED',
        'PAYMENT_REMINDER_SENT',
        'SUBSCRIPTION_DETECTED',
        'SUBSCRIPTION_PRICE_HIKE',
        'SUBSCRIPTION_ZOMBIE_FLAGGED',
        'FREE_TRIAL_DETECTED',
        'FREE_TRIAL_48H_ALERT_SENT',
        'SUBSCRIPTION_CANCELLED',
        'FREE_TRIAL_CANCELLED'
    ));

ALTER TABLE financial_memory_events
    DROP CONSTRAINT IF EXISTS financial_memory_events_entity_type_check;
ALTER TABLE financial_memory_events
    ADD CONSTRAINT financial_memory_events_entity_type_check CHECK (entity_type IN (
        'INVOICE', 'WHATSAPP_PAYMENT', 'PAYMENT_LINK', 'SUBSCRIPTION', 'FREE_TRIAL'
    ));

CREATE INDEX IF NOT EXISTS idx_subs_owner_status
    ON tracked_subscriptions(owner_jid, status, next_expected_charge_date);
CREATE INDEX IF NOT EXISTS idx_sub_charges_grouping
    ON subscription_charge_events(owner_jid, normalized_merchant, currency, charged_date DESC);
CREATE INDEX IF NOT EXISTS idx_price_hikes_owner
    ON subscription_price_hikes(owner_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_free_trials_pending_alert
    ON free_trials(status, alert_48h_scheduled_at) WHERE status = 'ACTIVE';
