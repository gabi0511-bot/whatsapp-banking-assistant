import type {
  AuditFlag,
  DisputeDraftContent,
  StoredDisputeDraft,
} from '../../audit/types.js';
import type { Queryable } from '../pool.js';

export interface DisputeRepository {
  upsertReady(
    invoiceId: number,
    draft: DisputeDraftContent,
    db?: Queryable,
  ): Promise<StoredDisputeDraft>;
  findByInvoiceId(invoiceId: number, db?: Queryable): Promise<StoredDisputeDraft | null>;
  markSavedToGmail(
    invoiceId: number,
    gmailDraftId: string,
    db?: Queryable,
  ): Promise<StoredDisputeDraft | null>;
}

interface DisputeRow {
  id: string;
  invoice_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  anomaly_summary: AuditFlag[];
  gmail_draft_id: string | null;
  status: 'READY' | 'SAVED_TO_GMAIL';
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: DisputeRow): StoredDisputeDraft {
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    recipientEmail: row.recipient_email,
    subject: row.subject,
    body: row.body,
    anomalySummary: Array.isArray(row.anomaly_summary) ? row.anomaly_summary : [],
    gmailDraftId: row.gmail_draft_id,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PgDisputeRepository implements DisputeRepository {
  constructor(private readonly pool: Queryable) {}

  async upsertReady(
    invoiceId: number,
    draft: DisputeDraftContent,
    db?: Queryable,
  ): Promise<StoredDisputeDraft> {
    const runner = db ?? this.pool;
    const res = await runner.query<DisputeRow>(
      `
      INSERT INTO dispute_drafts (
        invoice_id, recipient_email, subject, body, anomaly_summary, status
      ) VALUES ($1, $2, $3, $4, $5::jsonb, 'READY')
      ON CONFLICT (invoice_id) DO UPDATE SET
        recipient_email = EXCLUDED.recipient_email,
        subject = EXCLUDED.subject,
        body = EXCLUDED.body,
        anomaly_summary = EXCLUDED.anomaly_summary,
        updated_at = NOW()
      RETURNING *
      `,
      [
        invoiceId,
        draft.recipientEmail,
        draft.subject,
        draft.body,
        JSON.stringify(draft.anomalySummary),
      ],
    );
    return mapRow(res.rows[0]!);
  }

  async findByInvoiceId(
    invoiceId: number,
    db?: Queryable,
  ): Promise<StoredDisputeDraft | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<DisputeRow>(
      'SELECT * FROM dispute_drafts WHERE invoice_id = $1 LIMIT 1',
      [invoiceId],
    );
    const row = res.rows[0];
    return row ? mapRow(row) : null;
  }

  async markSavedToGmail(
    invoiceId: number,
    gmailDraftId: string,
    db?: Queryable,
  ): Promise<StoredDisputeDraft | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<DisputeRow>(
      `
      UPDATE dispute_drafts
      SET gmail_draft_id = $2, status = 'SAVED_TO_GMAIL', updated_at = NOW()
      WHERE invoice_id = $1
      RETURNING *
      `,
      [invoiceId, gmailDraftId],
    );
    const row = res.rows[0];
    return row ? mapRow(row) : null;
  }
}

export class InMemoryDisputeRepository implements DisputeRepository {
  private nextId = 1;
  private readonly drafts = new Map<number, StoredDisputeDraft>();

  async upsertReady(
    invoiceId: number,
    draft: DisputeDraftContent,
  ): Promise<StoredDisputeDraft> {
    const existing = this.drafts.get(invoiceId);
    const now = new Date();
    if (existing) {
      existing.recipientEmail = draft.recipientEmail;
      existing.subject = draft.subject;
      existing.body = draft.body;
      existing.anomalySummary = draft.anomalySummary;
      existing.updatedAt = now;
      return existing;
    }
    const created: StoredDisputeDraft = {
      id: this.nextId++,
      invoiceId,
      recipientEmail: draft.recipientEmail,
      subject: draft.subject,
      body: draft.body,
      anomalySummary: draft.anomalySummary,
      gmailDraftId: null,
      status: 'READY',
      createdAt: now,
      updatedAt: now,
    };
    this.drafts.set(invoiceId, created);
    return created;
  }

  async findByInvoiceId(invoiceId: number): Promise<StoredDisputeDraft | null> {
    return this.drafts.get(invoiceId) ?? null;
  }

  async markSavedToGmail(
    invoiceId: number,
    gmailDraftId: string,
  ): Promise<StoredDisputeDraft | null> {
    const existing = this.drafts.get(invoiceId);
    if (!existing) {
      return null;
    }
    existing.gmailDraftId = gmailDraftId;
    existing.status = 'SAVED_TO_GMAIL';
    existing.updatedAt = new Date();
    return existing;
  }
}
