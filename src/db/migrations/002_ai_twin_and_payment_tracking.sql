-- 1. Other payments tracked/remembered on WhatsApp (rent, manual transfers, ad-hoc payments, non-Gmail bills)
CREATE TABLE IF NOT EXISTS whatsapp_payments (
    id BIGSERIAL PRIMARY KEY,
    owner_jid VARCHAR(100) NOT NULL,
    title VARCHAR(200) NOT NULL,
    payee_name VARCHAR(150) NOT NULL,
    category VARCHAR(40) NOT NULL DEFAULT 'OTHER' CHECK (category IN (
        'RENT', 'UTILITY', 'TELECOM', 'SUBSCRIPTION', 'TAX', 'PERSONAL_TRANSFER', 'OTHER'
    )),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'RON',
    due_date DATE,
    payee_iban VARCHAR(40),
    payee_revolut_tag VARCHAR(100),
    payment_reference VARCHAR(200),
    payment_status VARCHAR(25) NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN (
        'UNPAID', 'PAID_ON_TIME', 'PAID_LATE', 'CANCELLED'
    )),
    paid_at TIMESTAMPTZ,
    notes TEXT,
    source_message_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tracked Payment QR Codes (links to EITHER a parsed_invoice OR a whatsapp_payment)
CREATE TABLE IF NOT EXISTS tracked_payment_links (
    id BIGSERIAL PRIMARY KEY,
    token VARCHAR(64) UNIQUE NOT NULL,
    recipient_jid VARCHAR(100) NOT NULL,
    target_type VARCHAR(25) NOT NULL CHECK (target_type IN ('INVOICE', 'WHATSAPP_PAYMENT')),
    invoice_id BIGINT REFERENCES parsed_invoices(id) ON DELETE CASCADE,
    whatsapp_payment_id BIGINT REFERENCES whatsapp_payments(id) ON DELETE CASCADE,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'RON',
    payee_name VARCHAR(150) NOT NULL,
    payee_iban VARCHAR(40),
    redirect_url TEXT,
    payment_reference VARCHAR(255),
    due_date DATE,
    status VARCHAR(25) NOT NULL DEFAULT 'CREATED' CHECK (status IN (
        'CREATED', 'QR_ACCESSED', 'COMPLETED', 'EXPIRED', 'CANCELLED'
    )),
    first_accessed_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ,
    access_count INT NOT NULL DEFAULT 0,
    completed_at TIMESTAMPTZ,
    completed_via VARCHAR(30) CHECK (completed_via IN (
        'WEB_CONFIRM', 'WHATSAPP_COMMAND', 'AI_TWIN_CHAT', 'EMAIL_RECEIPT', 'EXTERNAL_WEBHOOK'
    )),
    unaccessed_reminder_count INT NOT NULL DEFAULT 0,
    last_unaccessed_reminder_at TIMESTAMPTZ,
    abandoned_reminder_count INT NOT NULL DEFAULT 0,
    last_abandoned_reminder_at TIMESTAMPTZ,
    overdue_reminder_count INT NOT NULL DEFAULT 0,
    last_overdue_reminder_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (target_type = 'INVOICE' AND invoice_id IS NOT NULL AND whatsapp_payment_id IS NULL) OR
        (target_type = 'WHATSAPP_PAYMENT' AND whatsapp_payment_id IS NOT NULL AND invoice_id IS NULL)
    )
);

-- 3. Immutable audit trail of every QR scan, payment confirmation, and reminder sent
CREATE TABLE IF NOT EXISTS tracked_payment_events (
    id BIGSERIAL PRIMARY KEY,
    payment_link_id BIGINT NOT NULL REFERENCES tracked_payment_links(id) ON DELETE CASCADE,
    event_type VARCHAR(40) NOT NULL CHECK (event_type IN (
        'QR_GENERATED',
        'QR_SENT_WHATSAPP',
        'QR_ACCESSED',
        'REMINDER_QR_UNACCESSED',
        'REMINDER_QR_ABANDONED',
        'REMINDER_OVERDUE',
        'PAYMENT_COMPLETED',
        'LINK_EXPIRED'
    )),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Persistent WhatsApp Financial Memory Log (unified timeline of every bill, payment, QR, and status change)
CREATE TABLE IF NOT EXISTS financial_memory_events (
    id BIGSERIAL PRIMARY KEY,
    owner_jid VARCHAR(100) NOT NULL,
    event_type VARCHAR(40) NOT NULL CHECK (event_type IN (
        'INVOICE_DETECTED',
        'INVOICE_ANOMALY_FLAGGED',
        'DISPUTE_DRAFT_CREATED',
        'WHATSAPP_PAYMENT_LOGGED',
        'QR_GENERATED',
        'QR_ACCESSED',
        'PAYMENT_COMPLETED',
        'PAYMENT_REMINDER_SENT'
    )),
    entity_type VARCHAR(25) NOT NULL CHECK (entity_type IN ('INVOICE', 'WHATSAPP_PAYMENT', 'PAYMENT_LINK')),
    entity_id BIGINT NOT NULL,
    summary_text TEXT NOT NULL,
    amount_cents BIGINT,
    currency VARCHAR(3) DEFAULT 'RON',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Persistent AI Twin Conversation History (scoped strictly to financial turns)
CREATE TABLE IF NOT EXISTS twin_conversation_messages (
    id BIGSERIAL PRIMARY KEY,
    owner_jid VARCHAR(100) NOT NULL,
    role VARCHAR(15) NOT NULL CHECK (role IN ('USER', 'ASSISTANT')),
    content TEXT NOT NULL,
    classified_intent VARCHAR(40) NOT NULL,
    was_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    tool_calls_used JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_payments_owner_status
    ON whatsapp_payments(owner_jid, payment_status, due_date);
CREATE INDEX IF NOT EXISTS idx_payment_links_active
    ON tracked_payment_links(status, due_date) WHERE status IN ('CREATED', 'QR_ACCESSED');
CREATE INDEX IF NOT EXISTS idx_payment_links_invoice
    ON tracked_payment_links(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_events_link
    ON tracked_payment_events(payment_link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_events_owner_time
    ON financial_memory_events(owner_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twin_chat_owner_time
    ON twin_conversation_messages(owner_jid, created_at DESC);
