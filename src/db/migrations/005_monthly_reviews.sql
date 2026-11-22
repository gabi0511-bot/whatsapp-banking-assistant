CREATE TABLE IF NOT EXISTS monthly_efficiency_reviews (
    id BIGSERIAL PRIMARY KEY,
    owner_jid VARCHAR(100) NOT NULL,
    review_month VARCHAR(7) NOT NULL,         -- YYYY-MM (current month)
    previous_month VARCHAR(7) NOT NULL,       -- YYYY-MM (previous month)
    current_paid_cents BIGINT NOT NULL DEFAULT 0,
    previous_paid_cents BIGINT NOT NULL DEFAULT 0,
    saved_cents BIGINT NOT NULL DEFAULT 0,
    current_score INT,
    previous_score INT,
    current_grade VARCHAR(40),
    better_month VARCHAR(20) NOT NULL CHECK (better_month IN ('CURRENT', 'PREVIOUS', 'TIE', 'INSUFFICIENT_DATA')),
    metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    generated_message TEXT NOT NULL,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_jid, review_month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_reviews_owner
    ON monthly_efficiency_reviews(owner_jid, review_month DESC);
