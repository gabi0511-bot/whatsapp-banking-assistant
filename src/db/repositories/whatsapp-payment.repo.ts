import type { Queryable } from '../pool.js';

export const WHATSAPP_PAYMENT_CATEGORIES = [
  'RENT',
  'UTILITY',
  'TELECOM',
  'SUBSCRIPTION',
  'TAX',
  'PERSONAL_TRANSFER',
  'OTHER',
] as const;
export type WhatsappPaymentCategory = (typeof WHATSAPP_PAYMENT_CATEGORIES)[number];

export type WhatsappPaymentStatus = 'UNPAID' | 'PAID_ON_TIME' | 'PAID_LATE' | 'CANCELLED';

export interface StoredWhatsappPayment {
  id: number;
  ownerJid: string;
  title: string;
  payeeName: string;
  category: WhatsappPaymentCategory;
  amountCents: bigint;
  currency: string;
  dueDate: string | null;
  payeeIban: string | null;
  payeeRevolutTag: string | null;
  paymentReference: string | null;
  paymentStatus: WhatsappPaymentStatus;
  paidAt: Date | null;
  notes: string | null;
  sourceMessageText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWhatsappPaymentInput {
  ownerJid: string;
  title: string;
  payeeName: string;
  category?: WhatsappPaymentCategory;
  amountCents: bigint;
  currency?: string;
  dueDate?: string | null;
  payeeIban?: string | null;
  payeeRevolutTag?: string | null;
  paymentReference?: string | null;
  paymentStatus?: WhatsappPaymentStatus;
  paidAt?: Date | null;
  notes?: string | null;
  sourceMessageText?: string | null;
}

export interface WhatsappPaymentFilter {
  status?: WhatsappPaymentStatus;
  search?: string;
  limit?: number;
}

export interface WhatsappPaymentRepository {
  create(input: CreateWhatsappPaymentInput, db?: Queryable): Promise<StoredWhatsappPayment>;
  findById(id: number, db?: Queryable): Promise<StoredWhatsappPayment | null>;
  findByOwner(
    ownerJid: string,
    filter?: WhatsappPaymentFilter,
    db?: Queryable,
  ): Promise<StoredWhatsappPayment[]>;
  markPaid(
    id: number,
    status: 'PAID_ON_TIME' | 'PAID_LATE',
    paidAt?: Date,
    db?: Queryable,
  ): Promise<StoredWhatsappPayment | null>;
}

interface WhatsappPaymentRow {
  id: string;
  owner_jid: string;
  title: string;
  payee_name: string;
  category: WhatsappPaymentCategory;
  amount_cents: string;
  currency: string;
  due_date: string | null;
  payee_iban: string | null;
  payee_revolut_tag: string | null;
  payment_reference: string | null;
  payment_status: WhatsappPaymentStatus;
  paid_at: Date | null;
  notes: string | null;
  source_message_text: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: WhatsappPaymentRow): StoredWhatsappPayment {
  return {
    id: Number(row.id),
    ownerJid: row.owner_jid,
    title: row.title,
    payeeName: row.payee_name,
    category: row.category,
    amountCents: BigInt(row.amount_cents),
    currency: row.currency,
    dueDate: row.due_date,
    payeeIban: row.payee_iban,
    payeeRevolutTag: row.payee_revolut_tag,
    paymentReference: row.payment_reference,
    paymentStatus: row.payment_status,
    paidAt: row.paid_at ? new Date(row.paid_at) : null,
    notes: row.notes,
    sourceMessageText: row.source_message_text,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PgWhatsappPaymentRepository implements WhatsappPaymentRepository {
  constructor(private readonly pool: Queryable) {}

  async create(
    input: CreateWhatsappPaymentInput,
    db?: Queryable,
  ): Promise<StoredWhatsappPayment> {
    const runner = db ?? this.pool;
    const res = await runner.query<WhatsappPaymentRow>(
      `
      INSERT INTO whatsapp_payments (
        owner_jid, title, payee_name, category, amount_cents, currency,
        due_date, payee_iban, payee_revolut_tag, payment_reference,
        payment_status, paid_at, notes, source_message_text
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14
      )
      RETURNING *
      `,
      [
        input.ownerJid,
        input.title,
        input.payeeName,
        input.category ?? 'OTHER',
        input.amountCents.toString(),
        (input.currency ?? 'RON').toUpperCase(),
        input.dueDate ?? null,
        input.payeeIban ?? null,
        input.payeeRevolutTag ?? null,
        input.paymentReference ?? null,
        input.paymentStatus ?? 'UNPAID',
        input.paidAt ? input.paidAt.toISOString() : null,
        input.notes ?? null,
        input.sourceMessageText ?? null,
      ],
    );
    return mapRow(res.rows[0]!);
  }

  async findById(id: number, db?: Queryable): Promise<StoredWhatsappPayment | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<WhatsappPaymentRow>(
      'SELECT * FROM whatsapp_payments WHERE id = $1 LIMIT 1',
      [id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async findByOwner(
    ownerJid: string,
    filter: WhatsappPaymentFilter = {},
    db?: Queryable,
  ): Promise<StoredWhatsappPayment[]> {
    const runner = db ?? this.pool;
    const clauses: string[] = ['owner_jid = $1'];
    const params: unknown[] = [ownerJid];

    if (filter.status) {
      params.push(filter.status);
      clauses.push(`payment_status = $${params.length}`);
    }
    if (filter.search) {
      params.push(`%${filter.search}%`);
      clauses.push(`(title ILIKE $${params.length} OR payee_name ILIKE $${params.length})`);
    }

    const limitClause = filter.limit ? `LIMIT ${Math.max(1, Math.min(200, filter.limit))}` : '';
    const res = await runner.query<WhatsappPaymentRow>(
      `
      SELECT * FROM whatsapp_payments
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(due_date, created_at::date) ASC, created_at DESC, id DESC
      ${limitClause}
      `,
      params,
    );
    return res.rows.map(mapRow);
  }

  async markPaid(
    id: number,
    status: 'PAID_ON_TIME' | 'PAID_LATE',
    paidAt: Date = new Date(),
    db?: Queryable,
  ): Promise<StoredWhatsappPayment | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<WhatsappPaymentRow>(
      `
      UPDATE whatsapp_payments
      SET payment_status = $2, paid_at = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id, status, paidAt.toISOString()],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }
}

export class InMemoryWhatsappPaymentRepository implements WhatsappPaymentRepository {
  private nextId = 1;
  private readonly items: StoredWhatsappPayment[] = [];

  async create(input: CreateWhatsappPaymentInput): Promise<StoredWhatsappPayment> {
    const now = new Date();
    const record: StoredWhatsappPayment = {
      id: this.nextId++,
      ownerJid: input.ownerJid,
      title: input.title,
      payeeName: input.payeeName,
      category: input.category ?? 'OTHER',
      amountCents: input.amountCents,
      currency: (input.currency ?? 'RON').toUpperCase(),
      dueDate: input.dueDate ?? null,
      payeeIban: input.payeeIban ?? null,
      payeeRevolutTag: input.payeeRevolutTag ?? null,
      paymentReference: input.paymentReference ?? null,
      paymentStatus: input.paymentStatus ?? 'UNPAID',
      paidAt: input.paidAt ?? null,
      notes: input.notes ?? null,
      sourceMessageText: input.sourceMessageText ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(record);
    return record;
  }

  async findById(id: number): Promise<StoredWhatsappPayment | null> {
    return this.items.find((i) => i.id === id) ?? null;
  }

  async findByOwner(
    ownerJid: string,
    filter: WhatsappPaymentFilter = {},
  ): Promise<StoredWhatsappPayment[]> {
    let list = this.items.filter((i) => i.ownerJid === ownerJid);
    if (filter.status) {
      list = list.filter((i) => i.paymentStatus === filter.status);
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      list = list.filter(
        (i) => i.title.toLowerCase().includes(q) || i.payeeName.toLowerCase().includes(q),
      );
    }
    list = [...list].sort((a, b) => {
      const aDate = a.dueDate ?? a.createdAt.toISOString().slice(0, 10);
      const bDate = b.dueDate ?? b.createdAt.toISOString().slice(0, 10);
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return b.id - a.id;
    });
    return filter.limit ? list.slice(0, filter.limit) : list;
  }

  async markPaid(
    id: number,
    status: 'PAID_ON_TIME' | 'PAID_LATE',
    paidAt: Date = new Date(),
  ): Promise<StoredWhatsappPayment | null> {
    const found = this.items.find((i) => i.id === id);
    if (!found) return null;
    found.paymentStatus = status;
    found.paidAt = paidAt;
    found.updatedAt = new Date();
    return found;
  }
}
