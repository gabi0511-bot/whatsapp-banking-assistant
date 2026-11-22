CREATE TABLE IF NOT EXISTS provider_configs (
    id BIGSERIAL PRIMARY KEY,
    provider_cui VARCHAR(30) UNIQUE NOT NULL,
    provider_name VARCHAR(120) NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('ELECTRICITY', 'GAS', 'TELECOM', 'WATER', 'OTHER')),
    dispute_email VARCHAR(255),
    self_reading_window_start INT CHECK (self_reading_window_start BETWEEN 1 AND 31),
    self_reading_window_end INT CHECK (self_reading_window_end BETWEEN 1 AND 31),
    contractual_unit_price_net NUMERIC(14, 6),
    unit_price_alert_threshold_pct NUMERIC(5, 2) NOT NULL DEFAULT 2.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS parsed_invoices (
    id BIGSERIAL PRIMARY KEY,
    gmail_message_id VARCHAR(128),
    file_sha256 VARCHAR(64) UNIQUE NOT NULL,
    source_format VARCHAR(10) NOT NULL CHECK (source_format IN ('PDF', 'XML')),
    provider_cui VARCHAR(30) NOT NULL,
    provider_name VARCHAR(120) NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('ELECTRICITY', 'GAS', 'TELECOM', 'WATER', 'OTHER')),
    client_code VARCHAR(100),
    consumption_point_id VARCHAR(120) NOT NULL,
    invoice_series VARCHAR(40),
    invoice_number VARCHAR(100) NOT NULL,
    issue_date DATE NOT NULL,
    due_date DATE NOT NULL,
    billing_period_start DATE,
    billing_period_end DATE,
    billing_days INT NOT NULL CHECK (billing_days > 0),
    reading_type VARCHAR(25) NOT NULL CHECK (reading_type IN ('SELF_READ', 'OPERATOR_READ', 'ESTIMATED', 'REGULARIZATION', 'N_A')),
    old_index NUMERIC(14, 3),
    new_index NUMERIC(14, 3),
    consumption_value NUMERIC(14, 3),
    consumption_unit VARCHAR(20),
    self_reading_window_start INT CHECK (self_reading_window_start BETWEEN 1 AND 31),
    self_reading_window_end INT CHECK (self_reading_window_end BETWEEN 1 AND 31),
    total_amount_cents BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'RON',
    extraction_confidence VARCHAR(10) NOT NULL CHECK (extraction_confidence IN ('HIGH', 'LOW')),
    payment_status VARCHAR(25) NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PAID_ON_TIME', 'PAID_LATE', 'NO_PAYMENT_NEEDED', 'HOLD_BEFORE_PAYMENT')),
    audit_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_extracted_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_line_items (
    id BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT NOT NULL REFERENCES parsed_invoices(id) ON DELETE CASCADE,
    line_type VARCHAR(30) NOT NULL CHECK (line_type IN (
        'ACTIVE_ENERGY', 'GAS_ENERGY', 'DISTRIBUTION_TAX',
        'BASE_SUBSCRIPTION', 'DISCOUNT', 'PENALTY', 'REGULARIZATION', 'OTHER'
    )),
    raw_label VARCHAR(255) NOT NULL,
    quantity NUMERIC(14, 4) NOT NULL,
    unit VARCHAR(20),
    unit_price_net NUMERIC(14, 6) NOT NULL,
    vat_rate_pct NUMERIC(5, 2) NOT NULL DEFAULT 19.00,
    line_total_gross_cents BIGINT NOT NULL,
    is_storno BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS scheduled_reminders (
    id BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT NOT NULL REFERENCES parsed_invoices(id) ON DELETE CASCADE,
    recipient_jid VARCHAR(100) NOT NULL,
    reminder_type VARCHAR(30) NOT NULL CHECK (reminder_type IN ('SELF_READING')),
    trigger_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'CANCELLED')),
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispute_drafts (
    id BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT UNIQUE NOT NULL REFERENCES parsed_invoices(id) ON DELETE CASCADE,
    recipient_email VARCHAR(255) NOT NULL,
    subject VARCHAR(300) NOT NULL,
    body TEXT NOT NULL,
    anomaly_summary JSONB NOT NULL,
    gmail_draft_id VARCHAR(128),
    status VARCHAR(25) NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'SAVED_TO_GMAIL')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_action_contexts (
    recipient_jid VARCHAR(100) PRIMARY KEY,
    latest_invoice_id BIGINT NOT NULL REFERENCES parsed_invoices(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_history
    ON parsed_invoices(provider_cui, consumption_point_id, issue_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_line_items_invoice
    ON invoice_line_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_reminders_pending
    ON scheduled_reminders(status, trigger_at) WHERE status = 'PENDING';
