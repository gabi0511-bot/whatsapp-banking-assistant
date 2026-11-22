import type { Queryable } from '../pool.js';

export type FinancialMemoryEventType =
  | 'INVOICE_DETECTED'
  | 'INVOICE_ANOMALY_FLAGGED'
  | 'DISPUTE_DRAFT_CREATED'
  | 'WHATSAPP_PAYMENT_LOGGED'
  | 'QR_GENERATED'
  | 'QR_ACCESSED'
  | 'PAYMENT_COMPLETED'
  | 'PAYMENT_REMINDER_SENT'
  | 'SUBSCRIPTION_DETECTED'
  | 'SUBSCRIPTION_PRICE_HIKE'
  | 'SUBSCRIPTION_ZOMBIE_FLAGGED'
  | 'FREE_TRIAL_DETECTED'
  | 'FREE_TRIAL_48H_ALERT_SENT'
  | 'SUBSCRIPTION_CANCELLED'
  | 'FREE_TRIAL_CANCELLED';

export type FinancialMemoryEntityType =
  | 'INVOICE'
  | 'WHATSAPP_PAYMENT'
  | 'PAYMENT_LINK'
  | 'SUBSCRIPTION'
  | 'FREE_TRIAL';

export interface StoredMemoryEvent {
  id: number;
  ownerJid: string;
  eventType: FinancialMemoryEventType;
  entityType: FinancialMemoryEntityType;
  entityId: number;
  summaryText: string;
  amountCents: bigint | null;
  currency: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateMemoryEventInput {
  ownerJid: string;
  eventType: FinancialMemoryEventType;
  entityType: FinancialMemoryEntityType;
  entityId: number;
  summaryText: string;
  amountCents?: bigint | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryRepository {
  record(input: CreateMemoryEventInput, db?: Queryable): Promise<StoredMemoryEvent>;
  findRecent(
    ownerJid: string,
    opts?: { limit?: number; searchTerm?: string },
    db?: Queryable,
  ): Promise<StoredMemoryEvent[]>;
}

interface MemoryRow {
  id: string;
  owner_jid: string;
  event_type: FinancialMemoryEventType;
  entity_type: FinancialMemoryEntityType;
  entity_id: string;
  summary_text: string;
  amount_cents: string | null;
  currency: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapRow(row: MemoryRow): StoredMemoryEvent {
  return {
    id: Number(row.id),
    ownerJid: row.owner_jid,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: Number(row.entity_id),
    summaryText: row.summary_text,
    amountCents: row.amount_cents !== null ? BigInt(row.amount_cents) : null,
    currency: row.currency,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  };
}

export class PgMemoryRepository implements MemoryRepository {
  constructor(private readonly pool: Queryable) {}

  async record(input: CreateMemoryEventInput, db?: Queryable): Promise<StoredMemoryEvent> {
    const runner = db ?? this.pool;
    const res = await runner.query<MemoryRow>(
      `
      INSERT INTO financial_memory_events (
        owner_jid, event_type, entity_type, entity_id, summary_text,
        amount_cents, currency, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING *
      `,
      [
        input.ownerJid,
        input.eventType,
        input.entityType,
        input.entityId,
        input.summaryText,
        input.amountCents !== undefined && input.amountCents !== null
          ? input.amountCents.toString()
          : null,
        input.currency ?? 'RON',
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapRow(res.rows[0]!);
  }

  async findRecent(
    ownerJid: string,
    opts: { limit?: number; searchTerm?: string } = {},
    db?: Queryable,
  ): Promise<StoredMemoryEvent[]> {
    const runner = db ?? this.pool;
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const params: unknown[] = [ownerJid];
    const clauses: string[] = ['owner_jid = $1'];

    if (opts.searchTerm && opts.searchTerm.trim().length > 0) {
      params.push(`%${opts.searchTerm.trim()}%`);
      clauses.push(
        `(summary_text ILIKE $${params.length} OR event_type ILIKE $${params.length} OR metadata::text ILIKE $${params.length})`,
      );
    }

    params.push(limit);
    const res = await runner.query<MemoryRow>(
      `
      SELECT * FROM financial_memory_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
      `,
      params,
    );
    return res.rows.map(mapRow);
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private nextId = 1;
  private readonly events: StoredMemoryEvent[] = [];

  async record(input: CreateMemoryEventInput): Promise<StoredMemoryEvent> {
    const ev: StoredMemoryEvent = {
      id: this.nextId++,
      ownerJid: input.ownerJid,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      summaryText: input.summaryText,
      amountCents: input.amountCents ?? null,
      currency: input.currency ?? 'RON',
      metadata: input.metadata ?? {},
      createdAt: new Date(),
    };
    this.events.push(ev);
    return ev;
  }

  async findRecent(
    ownerJid: string,
    opts: { limit?: number; searchTerm?: string } = {},
  ): Promise<StoredMemoryEvent[]> {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    let list = this.events.filter((e) => e.ownerJid === ownerJid);
    if (opts.searchTerm && opts.searchTerm.trim().length > 0) {
      const q = opts.searchTerm.trim().toLowerCase();
      list = list.filter(
        (e) =>
          e.summaryText.toLowerCase().includes(q) ||
          e.eventType.toLowerCase().includes(q) ||
          JSON.stringify(e.metadata).toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => b.id - a.id).slice(0, limit);
  }
}
