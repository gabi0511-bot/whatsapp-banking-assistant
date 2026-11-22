import type { Queryable } from '../pool.js';

export interface ActionContextRepository {
  upsertLatestInvoice(
    recipientJid: string,
    invoiceId: number,
    db?: Queryable,
  ): Promise<void>;
  getLatestInvoiceId(recipientJid: string, db?: Queryable): Promise<number | null>;
}

export class PgActionContextRepository implements ActionContextRepository {
  constructor(private readonly pool: Queryable) {}

  async upsertLatestInvoice(
    recipientJid: string,
    invoiceId: number,
    db?: Queryable,
  ): Promise<void> {
    const runner = db ?? this.pool;
    await runner.query(
      `
      INSERT INTO whatsapp_action_contexts (recipient_jid, latest_invoice_id, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (recipient_jid) DO UPDATE SET
        latest_invoice_id = EXCLUDED.latest_invoice_id,
        updated_at = NOW()
      `,
      [recipientJid, invoiceId],
    );
  }

  async getLatestInvoiceId(recipientJid: string, db?: Queryable): Promise<number | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<{ latest_invoice_id: string }>(
      'SELECT latest_invoice_id FROM whatsapp_action_contexts WHERE recipient_jid = $1 LIMIT 1',
      [recipientJid],
    );
    const row = res.rows[0];
    return row ? Number(row.latest_invoice_id) : null;
  }
}

export class InMemoryActionContextRepository implements ActionContextRepository {
  private readonly contexts = new Map<string, number>();

  async upsertLatestInvoice(recipientJid: string, invoiceId: number): Promise<void> {
    this.contexts.set(recipientJid, invoiceId);
  }

  async getLatestInvoiceId(recipientJid: string): Promise<number | null> {
    return this.contexts.get(recipientJid) ?? null;
  }
}
