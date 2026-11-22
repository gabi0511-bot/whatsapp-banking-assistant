import type {
  StoredSubscriptionCharge,
  SubscriptionCategory,
  SubscriptionSource,
} from '../../subscriptions/types.js';
import type { Queryable } from '../pool.js';

export interface InsertSubscriptionChargeInput {
  ownerJid: string;
  externalRef: string;
  merchantName: string;
  normalizedMerchant: string;
  category: SubscriptionCategory;
  amountCents: bigint;
  currency: string;
  chargedDate: string;
  isExplicitRecurring: boolean;
  source: SubscriptionSource;
  rawSnippet?: string | null;
}

export interface SubscriptionChargeRepository {
  findByExternalRef(externalRef: string, db?: Queryable): Promise<StoredSubscriptionCharge | null>;
  insertIfNew(
    input: InsertSubscriptionChargeInput,
    db?: Queryable,
  ): Promise<{ inserted: boolean; charge: StoredSubscriptionCharge }>;
  findHistoryForMerchant(
    ownerJid: string,
    normalizedMerchant: string,
    currency: string,
    db?: Queryable,
  ): Promise<StoredSubscriptionCharge[]>;
  attachToSubscription(
    chargeIds: number[],
    subscriptionId: number,
    db?: Queryable,
  ): Promise<void>;
}

interface ChargeRow {
  id: string;
  owner_jid: string;
  subscription_id: string | null;
  external_ref: string;
  merchant_name: string;
  normalized_merchant: string;
  category: SubscriptionCategory;
  amount_cents: string;
  currency: string;
  charged_date: string;
  is_explicit_recurring: boolean;
  source: SubscriptionSource;
  raw_snippet: string | null;
  created_at: Date;
}

function mapRow(row: ChargeRow): StoredSubscriptionCharge {
  return {
    id: Number(row.id),
    ownerJid: row.owner_jid,
    subscriptionId: row.subscription_id !== null ? Number(row.subscription_id) : null,
    externalRef: row.external_ref,
    merchantName: row.merchant_name,
    normalizedMerchant: row.normalized_merchant,
    category: row.category,
    amountCents: BigInt(row.amount_cents),
    currency: row.currency,
    chargedDate: row.charged_date,
    isExplicitRecurring: row.is_explicit_recurring,
    source: row.source,
    rawSnippet: row.raw_snippet,
    createdAt: new Date(row.created_at),
  };
}

export class PgSubscriptionChargeRepository implements SubscriptionChargeRepository {
  constructor(private readonly pool: Queryable) {}

  async findByExternalRef(
    externalRef: string,
    db?: Queryable,
  ): Promise<StoredSubscriptionCharge | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<ChargeRow>(
      'SELECT * FROM subscription_charge_events WHERE external_ref = $1 LIMIT 1',
      [externalRef],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async insertIfNew(
    input: InsertSubscriptionChargeInput,
    db?: Queryable,
  ): Promise<{ inserted: boolean; charge: StoredSubscriptionCharge }> {
    const runner = db ?? this.pool;
    const res = await runner.query<ChargeRow>(
      `
      INSERT INTO subscription_charge_events (
        owner_jid, external_ref, merchant_name, normalized_merchant,
        category, amount_cents, currency, charged_date,
        is_explicit_recurring, source, raw_snippet
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (external_ref) DO NOTHING
      RETURNING *
      `,
      [
        input.ownerJid,
        input.externalRef,
        input.merchantName,
        input.normalizedMerchant,
        input.category,
        input.amountCents.toString(),
        input.currency.toUpperCase(),
        input.chargedDate,
        input.isExplicitRecurring,
        input.source,
        input.rawSnippet ?? null,
      ],
    );

    if (res.rows[0]) {
      return { inserted: true, charge: mapRow(res.rows[0]) };
    }
    const existing = await this.findByExternalRef(input.externalRef, runner);
    return { inserted: false, charge: existing! };
  }

  async findHistoryForMerchant(
    ownerJid: string,
    normalizedMerchant: string,
    currency: string,
    db?: Queryable,
  ): Promise<StoredSubscriptionCharge[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<ChargeRow>(
      `
      SELECT * FROM subscription_charge_events
      WHERE owner_jid = $1 AND normalized_merchant = $2 AND currency = $3
      ORDER BY charged_date DESC, id DESC
      `,
      [ownerJid, normalizedMerchant, currency.toUpperCase()],
    );
    return res.rows.map(mapRow);
  }

  async attachToSubscription(
    chargeIds: number[],
    subscriptionId: number,
    db?: Queryable,
  ): Promise<void> {
    if (chargeIds.length === 0) return;
    const runner = db ?? this.pool;
    await runner.query(
      'UPDATE subscription_charge_events SET subscription_id = $2 WHERE id = ANY($1::bigint[])',
      [chargeIds, subscriptionId],
    );
  }
}

export class InMemorySubscriptionChargeRepository implements SubscriptionChargeRepository {
  private nextId = 1;
  private readonly charges: StoredSubscriptionCharge[] = [];

  async findByExternalRef(externalRef: string): Promise<StoredSubscriptionCharge | null> {
    return this.charges.find((c) => c.externalRef === externalRef) ?? null;
  }

  async insertIfNew(
    input: InsertSubscriptionChargeInput,
  ): Promise<{ inserted: boolean; charge: StoredSubscriptionCharge }> {
    const existing = await this.findByExternalRef(input.externalRef);
    if (existing) {
      return { inserted: false, charge: existing };
    }
    const created: StoredSubscriptionCharge = {
      id: this.nextId++,
      ownerJid: input.ownerJid,
      subscriptionId: null,
      externalRef: input.externalRef,
      merchantName: input.merchantName,
      normalizedMerchant: input.normalizedMerchant,
      category: input.category,
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      chargedDate: input.chargedDate,
      isExplicitRecurring: input.isExplicitRecurring,
      source: input.source,
      rawSnippet: input.rawSnippet ?? null,
      createdAt: new Date(),
    };
    this.charges.push(created);
    return { inserted: true, charge: created };
  }

  async findHistoryForMerchant(
    ownerJid: string,
    normalizedMerchant: string,
    currency: string,
  ): Promise<StoredSubscriptionCharge[]> {
    const cur = currency.toUpperCase();
    return this.charges
      .filter(
        (c) =>
          c.ownerJid === ownerJid &&
          c.normalizedMerchant === normalizedMerchant &&
          c.currency === cur,
      )
      .sort((a, b) => {
        if (a.chargedDate !== b.chargedDate) {
          return a.chargedDate < b.chargedDate ? 1 : -1;
        }
        return b.id - a.id;
      });
  }

  async attachToSubscription(chargeIds: number[], subscriptionId: number): Promise<void> {
    const set = new Set(chargeIds);
    for (const c of this.charges) {
      if (set.has(c.id)) {
        c.subscriptionId = subscriptionId;
      }
    }
  }
}
