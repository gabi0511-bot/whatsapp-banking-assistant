import type { StoredPriceHike } from '../../subscriptions/types.js';
import type { Queryable } from '../pool.js';

export interface CreatePriceHikeInput {
  subscriptionId: number;
  ownerJid: string;
  previousAmountCents: bigint;
  newAmountCents: bigint;
  monthlyDeltaCents: bigint;
  annualDeltaCents: bigint;
  deltaPct: string;
  currency: string;
  detectedOnDate: string;
  notifiedWhatsappAt?: Date | null;
}

export interface PriceHikeRepository {
  create(input: CreatePriceHikeInput, db?: Queryable): Promise<StoredPriceHike>;
  findRecentByOwner(
    ownerJid: string,
    limit?: number,
    db?: Queryable,
  ): Promise<StoredPriceHike[]>;
}

interface PriceHikeRow {
  id: string;
  subscription_id: string;
  owner_jid: string;
  previous_amount_cents: string;
  new_amount_cents: string;
  monthly_delta_cents: string;
  annual_delta_cents: string;
  delta_pct: string;
  currency: string;
  detected_on_date: string;
  notified_whatsapp_at: Date | null;
  created_at: Date;
}

function mapRow(row: PriceHikeRow): StoredPriceHike {
  return {
    id: Number(row.id),
    subscriptionId: Number(row.subscription_id),
    ownerJid: row.owner_jid,
    previousAmountCents: BigInt(row.previous_amount_cents),
    newAmountCents: BigInt(row.new_amount_cents),
    monthlyDeltaCents: BigInt(row.monthly_delta_cents),
    annualDeltaCents: BigInt(row.annual_delta_cents),
    deltaPct: row.delta_pct,
    currency: row.currency,
    detectedOnDate: row.detected_on_date,
    notifiedWhatsappAt: row.notified_whatsapp_at ? new Date(row.notified_whatsapp_at) : null,
    createdAt: new Date(row.created_at),
  };
}

export class PgPriceHikeRepository implements PriceHikeRepository {
  constructor(private readonly pool: Queryable) {}

  async create(input: CreatePriceHikeInput, db?: Queryable): Promise<StoredPriceHike> {
    const runner = db ?? this.pool;
    const res = await runner.query<PriceHikeRow>(
      `
      INSERT INTO subscription_price_hikes (
        subscription_id, owner_jid, previous_amount_cents, new_amount_cents,
        monthly_delta_cents, annual_delta_cents, delta_pct, currency,
        detected_on_date, notified_whatsapp_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        input.subscriptionId,
        input.ownerJid,
        input.previousAmountCents.toString(),
        input.newAmountCents.toString(),
        input.monthlyDeltaCents.toString(),
        input.annualDeltaCents.toString(),
        input.deltaPct,
        input.currency.toUpperCase(),
        input.detectedOnDate,
        input.notifiedWhatsappAt ? input.notifiedWhatsappAt.toISOString() : null,
      ],
    );
    return mapRow(res.rows[0]!);
  }

  async findRecentByOwner(
    ownerJid: string,
    limit = 10,
    db?: Queryable,
  ): Promise<StoredPriceHike[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<PriceHikeRow>(
      `
      SELECT * FROM subscription_price_hikes
      WHERE owner_jid = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      `,
      [ownerJid, limit],
    );
    return res.rows.map(mapRow);
  }
}

export class InMemoryPriceHikeRepository implements PriceHikeRepository {
  private nextId = 1;
  private readonly items: StoredPriceHike[] = [];

  async create(input: CreatePriceHikeInput): Promise<StoredPriceHike> {
    const created: StoredPriceHike = {
      id: this.nextId++,
      subscriptionId: input.subscriptionId,
      ownerJid: input.ownerJid,
      previousAmountCents: input.previousAmountCents,
      newAmountCents: input.newAmountCents,
      monthlyDeltaCents: input.monthlyDeltaCents,
      annualDeltaCents: input.annualDeltaCents,
      deltaPct: input.deltaPct,
      currency: input.currency.toUpperCase(),
      detectedOnDate: input.detectedOnDate,
      notifiedWhatsappAt: input.notifiedWhatsappAt ?? null,
      createdAt: new Date(),
    };
    this.items.push(created);
    return created;
  }

  async findRecentByOwner(ownerJid: string, limit = 10): Promise<StoredPriceHike[]> {
    return this.items
      .filter((i) => i.ownerJid === ownerJid)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
}
