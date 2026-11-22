import type { Queryable } from '../pool.js';

export type PaymentLinkTargetType = 'INVOICE' | 'WHATSAPP_PAYMENT';

export type PaymentLinkStatus =
  | 'CREATED'
  | 'QR_ACCESSED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELLED';

export type PaymentCompletedVia =
  | 'WEB_CONFIRM'
  | 'WHATSAPP_COMMAND'
  | 'AI_TWIN_CHAT'
  | 'EMAIL_RECEIPT'
  | 'EXTERNAL_WEBHOOK';

export type TrackedPaymentEventType =
  | 'QR_GENERATED'
  | 'QR_SENT_WHATSAPP'
  | 'QR_ACCESSED'
  | 'REMINDER_QR_UNACCESSED'
  | 'REMINDER_QR_ABANDONED'
  | 'REMINDER_OVERDUE'
  | 'PAYMENT_COMPLETED'
  | 'LINK_EXPIRED';

export interface StoredPaymentLink {
  id: number;
  token: string;
  recipientJid: string;
  targetType: PaymentLinkTargetType;
  invoiceId: number | null;
  whatsappPaymentId: number | null;
  amountCents: bigint;
  currency: string;
  payeeName: string;
  payeeIban: string | null;
  redirectUrl: string | null;
  paymentReference: string | null;
  dueDate: string | null;
  status: PaymentLinkStatus;
  firstAccessedAt: Date | null;
  lastAccessedAt: Date | null;
  accessCount: number;
  completedAt: Date | null;
  completedVia: PaymentCompletedVia | null;
  unaccessedReminderCount: number;
  lastUnaccessedReminderAt: Date | null;
  abandonedReminderCount: number;
  lastAbandonedReminderAt: Date | null;
  overdueReminderCount: number;
  lastOverdueReminderAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredPaymentEvent {
  id: number;
  paymentLinkId: number;
  eventType: TrackedPaymentEventType;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface CreatePaymentLinkInput {
  token: string;
  recipientJid: string;
  targetType: PaymentLinkTargetType;
  invoiceId?: number | null;
  whatsappPaymentId?: number | null;
  amountCents: bigint;
  currency?: string;
  payeeName: string;
  payeeIban?: string | null;
  redirectUrl?: string | null;
  paymentReference?: string | null;
  dueDate?: string | null;
  createdAt?: Date;
}

export interface PaymentLinkRepository {
  create(input: CreatePaymentLinkInput, db?: Queryable): Promise<StoredPaymentLink>;
  findById(id: number, db?: Queryable): Promise<StoredPaymentLink | null>;
  findByToken(token: string, db?: Queryable): Promise<StoredPaymentLink | null>;
  findLatestForTarget(
    targetType: PaymentLinkTargetType,
    targetId: number,
    db?: Queryable,
  ): Promise<StoredPaymentLink | null>;
  findActiveLinks(db?: Queryable): Promise<StoredPaymentLink[]>;
  findAllForRecipient(
    recipientJid: string,
    opts?: { onlyPending?: boolean; invoiceId?: number; whatsappPaymentId?: number },
    db?: Queryable,
  ): Promise<StoredPaymentLink[]>;
  recordAccess(token: string, accessedAt?: Date, db?: Queryable): Promise<StoredPaymentLink | null>;
  markCompleted(
    linkId: number,
    completedVia: PaymentCompletedVia,
    completedAt?: Date,
    db?: Queryable,
  ): Promise<StoredPaymentLink | null>;
  recordReminderSent(
    linkId: number,
    kind: 'UNACCESSED' | 'ABANDONED' | 'OVERDUE',
    sentAt?: Date,
    db?: Queryable,
  ): Promise<StoredPaymentLink | null>;
  appendEvent(
    paymentLinkId: number,
    eventType: TrackedPaymentEventType,
    metadata?: Record<string, unknown>,
    db?: Queryable,
  ): Promise<StoredPaymentEvent>;
  listEvents(paymentLinkId: number, db?: Queryable): Promise<StoredPaymentEvent[]>;
}

interface PaymentLinkRow {
  id: string;
  token: string;
  recipient_jid: string;
  target_type: PaymentLinkTargetType;
  invoice_id: string | null;
  whatsapp_payment_id: string | null;
  amount_cents: string;
  currency: string;
  payee_name: string;
  payee_iban: string | null;
  redirect_url: string | null;
  payment_reference: string | null;
  due_date: string | null;
  status: PaymentLinkStatus;
  first_accessed_at: Date | null;
  last_accessed_at: Date | null;
  access_count: number;
  completed_at: Date | null;
  completed_via: PaymentCompletedVia | null;
  unaccessed_reminder_count: number;
  last_unaccessed_reminder_at: Date | null;
  abandoned_reminder_count: number;
  last_abandoned_reminder_at: Date | null;
  overdue_reminder_count: number;
  last_overdue_reminder_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PaymentEventRow {
  id: string;
  payment_link_id: string;
  event_type: TrackedPaymentEventType;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapLink(row: PaymentLinkRow): StoredPaymentLink {
  return {
    id: Number(row.id),
    token: row.token,
    recipientJid: row.recipient_jid,
    targetType: row.target_type,
    invoiceId: row.invoice_id !== null ? Number(row.invoice_id) : null,
    whatsappPaymentId: row.whatsapp_payment_id !== null ? Number(row.whatsapp_payment_id) : null,
    amountCents: BigInt(row.amount_cents),
    currency: row.currency,
    payeeName: row.payee_name,
    payeeIban: row.payee_iban,
    redirectUrl: row.redirect_url,
    paymentReference: row.payment_reference,
    dueDate: row.due_date,
    status: row.status,
    firstAccessedAt: row.first_accessed_at ? new Date(row.first_accessed_at) : null,
    lastAccessedAt: row.last_accessed_at ? new Date(row.last_accessed_at) : null,
    accessCount: row.access_count,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    completedVia: row.completed_via,
    unaccessedReminderCount: row.unaccessed_reminder_count,
    lastUnaccessedReminderAt: row.last_unaccessed_reminder_at
      ? new Date(row.last_unaccessed_reminder_at)
      : null,
    abandonedReminderCount: row.abandoned_reminder_count,
    lastAbandonedReminderAt: row.last_abandoned_reminder_at
      ? new Date(row.last_abandoned_reminder_at)
      : null,
    overdueReminderCount: row.overdue_reminder_count,
    lastOverdueReminderAt: row.last_overdue_reminder_at
      ? new Date(row.last_overdue_reminder_at)
      : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapEvent(row: PaymentEventRow): StoredPaymentEvent {
  return {
    id: Number(row.id),
    paymentLinkId: Number(row.payment_link_id),
    eventType: row.event_type,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  };
}

export class PgPaymentLinkRepository implements PaymentLinkRepository {
  constructor(private readonly pool: Queryable) {}

  async create(input: CreatePaymentLinkInput, db?: Queryable): Promise<StoredPaymentLink> {
    const runner = db ?? this.pool;
    const createdAt = input.createdAt ?? new Date();
    const res = await runner.query<PaymentLinkRow>(
      `
      INSERT INTO tracked_payment_links (
        token, recipient_jid, target_type, invoice_id, whatsapp_payment_id,
        amount_cents, currency, payee_name, payee_iban, redirect_url,
        payment_reference, due_date, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $13
      )
      RETURNING *
      `,
      [
        input.token,
        input.recipientJid,
        input.targetType,
        input.invoiceId ?? null,
        input.whatsappPaymentId ?? null,
        input.amountCents.toString(),
        (input.currency ?? 'RON').toUpperCase(),
        input.payeeName,
        input.payeeIban ?? null,
        input.redirectUrl ?? null,
        input.paymentReference ?? null,
        input.dueDate ?? null,
        createdAt.toISOString(),
      ],
    );
    return mapLink(res.rows[0]!);
  }

  async findById(id: number, db?: Queryable): Promise<StoredPaymentLink | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<PaymentLinkRow>(
      'SELECT * FROM tracked_payment_links WHERE id = $1 LIMIT 1',
      [id],
    );
    return res.rows[0] ? mapLink(res.rows[0]) : null;
  }

  async findByToken(token: string, db?: Queryable): Promise<StoredPaymentLink | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<PaymentLinkRow>(
      'SELECT * FROM tracked_payment_links WHERE token = $1 LIMIT 1',
      [token],
    );
    return res.rows[0] ? mapLink(res.rows[0]) : null;
  }

  async findLatestForTarget(
    targetType: PaymentLinkTargetType,
    targetId: number,
    db?: Queryable,
  ): Promise<StoredPaymentLink | null> {
    const runner = db ?? this.pool;
    const column = targetType === 'INVOICE' ? 'invoice_id' : 'whatsapp_payment_id';
    const res = await runner.query<PaymentLinkRow>(
      `
      SELECT * FROM tracked_payment_links
      WHERE target_type = $1 AND ${column} = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      `,
      [targetType, targetId],
    );
    return res.rows[0] ? mapLink(res.rows[0]) : null;
  }

  async findActiveLinks(db?: Queryable): Promise<StoredPaymentLink[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<PaymentLinkRow>(
      `
      SELECT * FROM tracked_payment_links
      WHERE status IN ('CREATED', 'QR_ACCESSED')
      ORDER BY due_date ASC NULLS LAST, created_at ASC
      `,
    );
    return res.rows.map(mapLink);
  }

  async findAllForRecipient(
    recipientJid: string,
    opts: { onlyPending?: boolean; invoiceId?: number; whatsappPaymentId?: number } = {},
    db?: Queryable,
  ): Promise<StoredPaymentLink[]> {
    const runner = db ?? this.pool;
    const clauses: string[] = ['recipient_jid = $1'];
    const params: unknown[] = [recipientJid];

    if (opts.onlyPending) {
      clauses.push(`status IN ('CREATED', 'QR_ACCESSED')`);
    }
    if (opts.invoiceId !== undefined) {
      params.push(opts.invoiceId);
      clauses.push(`invoice_id = $${params.length}`);
    }
    if (opts.whatsappPaymentId !== undefined) {
      params.push(opts.whatsappPaymentId);
      clauses.push(`whatsapp_payment_id = $${params.length}`);
    }

    const res = await runner.query<PaymentLinkRow>(
      `
      SELECT * FROM tracked_payment_links
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      `,
      params,
    );
    return res.rows.map(mapLink);
  }

  async recordAccess(
    token: string,
    accessedAt: Date = new Date(),
    db?: Queryable,
  ): Promise<StoredPaymentLink | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<PaymentLinkRow>(
      `
      UPDATE tracked_payment_links
      SET
        first_accessed_at = COALESCE(first_accessed_at, $2),
        last_accessed_at = $2,
        access_count = access_count + 1,
        status = CASE WHEN status = 'CREATED' THEN 'QR_ACCESSED' ELSE status END,
        updated_at = $2
      WHERE token = $1
      RETURNING *
      `,
      [token, accessedAt.toISOString()],
    );
    return res.rows[0] ? mapLink(res.rows[0]) : null;
  }

  async markCompleted(
    linkId: number,
    completedVia: PaymentCompletedVia,
    completedAt: Date = new Date(),
    db?: Queryable,
  ): Promise<StoredPaymentLink | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<PaymentLinkRow>(
      `
      UPDATE tracked_payment_links
      SET
        status = 'COMPLETED',
        completed_at = COALESCE(completed_at, $2),
        completed_via = COALESCE(completed_via, $3),
        updated_at = $2
      WHERE id = $1
      RETURNING *
      `,
      [linkId, completedAt.toISOString(), completedVia],
    );
    return res.rows[0] ? mapLink(res.rows[0]) : null;
  }

  async recordReminderSent(
    linkId: number,
    kind: 'UNACCESSED' | 'ABANDONED' | 'OVERDUE',
    sentAt: Date = new Date(),
    db?: Queryable,
  ): Promise<StoredPaymentLink | null> {
    const runner = db ?? this.pool;
    const colMap = {
      UNACCESSED: ['unaccessed_reminder_count', 'last_unaccessed_reminder_at'],
      ABANDONED: ['abandoned_reminder_count', 'last_abandoned_reminder_at'],
      OVERDUE: ['overdue_reminder_count', 'last_overdue_reminder_at'],
    } as const;
    const [countCol, atCol] = colMap[kind];

    const res = await runner.query<PaymentLinkRow>(
      `
      UPDATE tracked_payment_links
      SET ${countCol} = ${countCol} + 1, ${atCol} = $2, updated_at = $2
      WHERE id = $1
      RETURNING *
      `,
      [linkId, sentAt.toISOString()],
    );
    return res.rows[0] ? mapLink(res.rows[0]) : null;
  }

  async appendEvent(
    paymentLinkId: number,
    eventType: TrackedPaymentEventType,
    metadata: Record<string, unknown> = {},
    db?: Queryable,
  ): Promise<StoredPaymentEvent> {
    const runner = db ?? this.pool;
    const res = await runner.query<PaymentEventRow>(
      `
      INSERT INTO tracked_payment_events (payment_link_id, event_type, metadata)
      VALUES ($1, $2, $3::jsonb)
      RETURNING *
      `,
      [paymentLinkId, eventType, JSON.stringify(metadata)],
    );
    return mapEvent(res.rows[0]!);
  }

  async listEvents(paymentLinkId: number, db?: Queryable): Promise<StoredPaymentEvent[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<PaymentEventRow>(
      `
      SELECT * FROM tracked_payment_events
      WHERE payment_link_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [paymentLinkId],
    );
    return res.rows.map(mapEvent);
  }
}

export class InMemoryPaymentLinkRepository implements PaymentLinkRepository {
  private nextLinkId = 1;
  private nextEventId = 1;
  private readonly links: StoredPaymentLink[] = [];
  private readonly events: StoredPaymentEvent[] = [];

  async create(input: CreatePaymentLinkInput): Promise<StoredPaymentLink> {
    const now = input.createdAt ?? new Date();
    const record: StoredPaymentLink = {
      id: this.nextLinkId++,
      token: input.token,
      recipientJid: input.recipientJid,
      targetType: input.targetType,
      invoiceId: input.invoiceId ?? null,
      whatsappPaymentId: input.whatsappPaymentId ?? null,
      amountCents: input.amountCents,
      currency: (input.currency ?? 'RON').toUpperCase(),
      payeeName: input.payeeName,
      payeeIban: input.payeeIban ?? null,
      redirectUrl: input.redirectUrl ?? null,
      paymentReference: input.paymentReference ?? null,
      dueDate: input.dueDate ?? null,
      status: 'CREATED',
      firstAccessedAt: null,
      lastAccessedAt: null,
      accessCount: 0,
      completedAt: null,
      completedVia: null,
      unaccessedReminderCount: 0,
      lastUnaccessedReminderAt: null,
      abandonedReminderCount: 0,
      lastAbandonedReminderAt: null,
      overdueReminderCount: 0,
      lastOverdueReminderAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.links.push(record);
    return record;
  }

  async findById(id: number): Promise<StoredPaymentLink | null> {
    return this.links.find((l) => l.id === id) ?? null;
  }

  async findByToken(token: string): Promise<StoredPaymentLink | null> {
    return this.links.find((l) => l.token === token) ?? null;
  }

  async findLatestForTarget(
    targetType: PaymentLinkTargetType,
    targetId: number,
  ): Promise<StoredPaymentLink | null> {
    const matching = this.links
      .filter(
        (l) =>
          l.targetType === targetType &&
          (targetType === 'INVOICE'
            ? l.invoiceId === targetId
            : l.whatsappPaymentId === targetId),
      )
      .sort((a, b) => b.id - a.id);
    return matching[0] ?? null;
  }

  async findActiveLinks(): Promise<StoredPaymentLink[]> {
    return this.links
      .filter((l) => l.status === 'CREATED' || l.status === 'QR_ACCESSED')
      .sort((a, b) => {
        const aDue = a.dueDate ?? '9999-12-31';
        const bDue = b.dueDate ?? '9999-12-31';
        if (aDue !== bDue) return aDue.localeCompare(bDue);
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
  }

  async findAllForRecipient(
    recipientJid: string,
    opts: { onlyPending?: boolean; invoiceId?: number; whatsappPaymentId?: number } = {},
  ): Promise<StoredPaymentLink[]> {
    let list = this.links.filter((l) => l.recipientJid === recipientJid);
    if (opts.onlyPending) {
      list = list.filter((l) => l.status === 'CREATED' || l.status === 'QR_ACCESSED');
    }
    if (opts.invoiceId !== undefined) {
      list = list.filter((l) => l.invoiceId === opts.invoiceId);
    }
    if (opts.whatsappPaymentId !== undefined) {
      list = list.filter((l) => l.whatsappPaymentId === opts.whatsappPaymentId);
    }
    return [...list].sort((a, b) => b.id - a.id);
  }

  async recordAccess(token: string, accessedAt: Date = new Date()): Promise<StoredPaymentLink | null> {
    const link = this.links.find((l) => l.token === token);
    if (!link) return null;
    if (!link.firstAccessedAt) {
      link.firstAccessedAt = accessedAt;
    }
    link.lastAccessedAt = accessedAt;
    link.accessCount += 1;
    if (link.status === 'CREATED') {
      link.status = 'QR_ACCESSED';
    }
    link.updatedAt = accessedAt;
    return link;
  }

  async markCompleted(
    linkId: number,
    completedVia: PaymentCompletedVia,
    completedAt: Date = new Date(),
  ): Promise<StoredPaymentLink | null> {
    const link = this.links.find((l) => l.id === linkId);
    if (!link) return null;
    link.status = 'COMPLETED';
    if (!link.completedAt) {
      link.completedAt = completedAt;
    }
    if (!link.completedVia) {
      link.completedVia = completedVia;
    }
    link.updatedAt = completedAt;
    return link;
  }

  async recordReminderSent(
    linkId: number,
    kind: 'UNACCESSED' | 'ABANDONED' | 'OVERDUE',
    sentAt: Date = new Date(),
  ): Promise<StoredPaymentLink | null> {
    const link = this.links.find((l) => l.id === linkId);
    if (!link) return null;
    if (kind === 'UNACCESSED') {
      link.unaccessedReminderCount += 1;
      link.lastUnaccessedReminderAt = sentAt;
    } else if (kind === 'ABANDONED') {
      link.abandonedReminderCount += 1;
      link.lastAbandonedReminderAt = sentAt;
    } else {
      link.overdueReminderCount += 1;
      link.lastOverdueReminderAt = sentAt;
    }
    link.updatedAt = sentAt;
    return link;
  }

  async appendEvent(
    paymentLinkId: number,
    eventType: TrackedPaymentEventType,
    metadata: Record<string, unknown> = {},
  ): Promise<StoredPaymentEvent> {
    const ev: StoredPaymentEvent = {
      id: this.nextEventId++,
      paymentLinkId,
      eventType,
      metadata,
      createdAt: new Date(),
    };
    this.events.push(ev);
    return ev;
  }

  async listEvents(paymentLinkId: number): Promise<StoredPaymentEvent[]> {
    return this.events
      .filter((e) => e.paymentLinkId === paymentLinkId)
      .sort((a, b) => b.id - a.id);
  }
}
