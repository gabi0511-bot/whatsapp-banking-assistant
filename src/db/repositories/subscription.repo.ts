import type {
  BillingPeriod,
  StoredSubscription,
  SubscriptionCategory,
  SubscriptionSource,
  SubscriptionStatus,
} from '../../subscriptions/types.js';
import type { Queryable } from '../pool.js';

export interface UpsertSubscriptionInput {
  ownerJid: string;
  merchantName: string;
  normalizedMerchant: string;
  category: SubscriptionCategory;
  billingCycleDays: number;
  billingPeriod: BillingPeriod;
  currentAmountCents: bigint;
  previousAmountCents: bigint | null;
  currency: string;
  annualizedCostCents: bigint;
  status: SubscriptionStatus;
  zombieReason: string | null;
  chargeCount: number;
  priceHikeCount: number;
  lastChargedDate: string;
  nextExpectedChargeDate: string;
  lastConfirmedUsedAt?: Date | null;
  source: SubscriptionSource;
}

export interface SubscriptionRepository {
  findById(id: number, db?: Queryable): Promise<StoredSubscription | null>;
  findByKey(
    ownerJid: string,
    normalizedMerchant: string,
    currency: string,
    db?: Queryable,
  ): Promise<StoredSubscription | null>;
  findByOwner(
    ownerJid: string,
    opts?: { includeCancelled?: boolean },
    db?: Queryable,
  ): Promise<StoredSubscription[]>;
  upsert(input: UpsertSubscriptionInput, db?: Queryable): Promise<StoredSubscription>;
  updateZombieState(
    id: number,
    status: 'ACTIVE' | 'ZOMBIE_SUSPECTED',
    zombieReason: string | null,
    db?: Queryable,
  ): Promise<StoredSubscription | null>;
  markCancelled(id: number, db?: Queryable): Promise<StoredSubscription | null>;
  markConfirmedUsed(
    id: number,
    confirmedAt?: Date,
    db?: Queryable,
  ): Promise<StoredSubscription | null>;
}

interface SubscriptionRow {
  id: string;
  owner_jid: string;
  merchant_name: string;
  normalized_merchant: string;
  category: SubscriptionCategory;
  billing_cycle_days: number;
  billing_period: BillingPeriod;
  current_amount_cents: string;
  previous_amount_cents: string | null;
  currency: string;
  annualized_cost_cents: string;
  status: SubscriptionStatus;
  zombie_reason: string | null;
  charge_count: number;
  price_hike_count: number;
  last_charged_date: string;
  next_expected_charge_date: string;
  last_confirmed_used_at: Date | null;
  source: SubscriptionSource;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: SubscriptionRow): StoredSubscription {
  return {
    id: Number(row.id),
    ownerJid: row.owner_jid,
    merchantName: row.merchant_name,
    normalizedMerchant: row.normalized_merchant,
    category: row.category,
    billingCycleDays: row.billing_cycle_days,
    billingPeriod: row.billing_period,
    currentAmountCents: BigInt(row.current_amount_cents),
    previousAmountCents:
      row.previous_amount_cents !== null ? BigInt(row.previous_amount_cents) : null,
    currency: row.currency,
    annualizedCostCents: BigInt(row.annualized_cost_cents),
    status: row.status,
    zombieReason: row.zombie_reason,
    chargeCount: row.charge_count,
    priceHikeCount: row.price_hike_count,
    lastChargedDate: row.last_charged_date,
    nextExpectedChargeDate: row.next_expected_charge_date,
    lastConfirmedUsedAt: row.last_confirmed_used_at ? new Date(row.last_confirmed_used_at) : null,
    source: row.source,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PgSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly pool: Queryable) {}

  async findById(id: number, db?: Queryable): Promise<StoredSubscription | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<SubscriptionRow>(
      'SELECT * FROM tracked_subscriptions WHERE id = $1 LIMIT 1',
      [id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async findByKey(
    ownerJid: string,
    normalizedMerchant: string,
    currency: string,
    db?: Queryable,
  ): Promise<StoredSubscription | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<SubscriptionRow>(
      `
      SELECT * FROM tracked_subscriptions
      WHERE owner_jid = $1 AND normalized_merchant = $2 AND currency = $3
      LIMIT 1
      `,
      [ownerJid, normalizedMerchant, currency.toUpperCase()],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async findByOwner(
    ownerJid: string,
    opts: { includeCancelled?: boolean } = {},
    db?: Queryable,
  ): Promise<StoredSubscription[]> {
    const runner = db ?? this.pool;
    const filter = opts.includeCancelled ? '' : `AND status IN ('ACTIVE', 'ZOMBIE_SUSPECTED')`;
    const res = await runner.query<SubscriptionRow>(
      `
      SELECT * FROM tracked_subscriptions
      WHERE owner_jid = $1 ${filter}
      ORDER BY annualized_cost_cents DESC, merchant_name ASC
      `,
      [ownerJid],
    );
    return res.rows.map(mapRow);
  }

  async upsert(input: UpsertSubscriptionInput, db?: Queryable): Promise<StoredSubscription> {
    const runner = db ?? this.pool;
    const res = await runner.query<SubscriptionRow>(
      `
      INSERT INTO tracked_subscriptions (
        owner_jid, merchant_name, normalized_merchant, category,
        billing_cycle_days, billing_period, current_amount_cents, previous_amount_cents,
        currency, annualized_cost_cents, status, zombie_reason,
        charge_count, price_hike_count, last_charged_date, next_expected_charge_date,
        last_confirmed_used_at, source, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, NOW()
      )
      ON CONFLICT (owner_jid, normalized_merchant, currency) DO UPDATE SET
        merchant_name = EXCLUDED.merchant_name,
        category = EXCLUDED.category,
        billing_cycle_days = EXCLUDED.billing_cycle_days,
        billing_period = EXCLUDED.billing_period,
        current_amount_cents = EXCLUDED.current_amount_cents,
        previous_amount_cents = EXCLUDED.previous_amount_cents,
        annualized_cost_cents = EXCLUDED.annualized_cost_cents,
        status = EXCLUDED.status,
        zombie_reason = EXCLUDED.zombie_reason,
        charge_count = EXCLUDED.charge_count,
        price_hike_count = EXCLUDED.price_hike_count,
        last_charged_date = EXCLUDED.last_charged_date,
        next_expected_charge_date = EXCLUDED.next_expected_charge_date,
        source = EXCLUDED.source,
        updated_at = NOW()
      RETURNING *
      `,
      [
        input.ownerJid,
        input.merchantName,
        input.normalizedMerchant,
        input.category,
        input.billingCycleDays,
        input.billingPeriod,
        input.currentAmountCents.toString(),
        input.previousAmountCents !== null ? input.previousAmountCents.toString() : null,
        input.currency.toUpperCase(),
        input.annualizedCostCents.toString(),
        input.status,
        input.zombieReason,
        input.chargeCount,
        input.priceHikeCount,
        input.lastChargedDate,
        input.nextExpectedChargeDate,
        input.lastConfirmedUsedAt ? input.lastConfirmedUsedAt.toISOString() : null,
        input.source,
      ],
    );
    return mapRow(res.rows[0]!);
  }

  async updateZombieState(
    id: number,
    status: 'ACTIVE' | 'ZOMBIE_SUSPECTED',
    zombieReason: string | null,
    db?: Queryable,
  ): Promise<StoredSubscription | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<SubscriptionRow>(
      `
      UPDATE tracked_subscriptions
      SET status = $2, zombie_reason = $3, updated_at = NOW()
      WHERE id = $1 AND status IN ('ACTIVE', 'ZOMBIE_SUSPECTED')
      RETURNING *
      `,
      [id, status, zombieReason],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async markCancelled(id: number, db?: Queryable): Promise<StoredSubscription | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<SubscriptionRow>(
      `
      UPDATE tracked_subscriptions
      SET status = 'CANCELLED', zombie_reason = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async markConfirmedUsed(
    id: number,
    confirmedAt: Date = new Date(),
    db?: Queryable,
  ): Promise<StoredSubscription | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<SubscriptionRow>(
      `
      UPDATE tracked_subscriptions
      SET status = 'ACTIVE', zombie_reason = NULL, last_confirmed_used_at = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id, confirmedAt.toISOString()],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }
}

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private nextId = 1;
  private readonly items: StoredSubscription[] = [];

  async findById(id: number): Promise<StoredSubscription | null> {
    return this.items.find((s) => s.id === id) ?? null;
  }

  async findByKey(
    ownerJid: string,
    normalizedMerchant: string,
    currency: string,
  ): Promise<StoredSubscription | null> {
    const cur = currency.toUpperCase();
    return (
      this.items.find(
        (s) =>
          s.ownerJid === ownerJid &&
          s.normalizedMerchant === normalizedMerchant &&
          s.currency === cur,
      ) ?? null
    );
  }

  async findByOwner(
    ownerJid: string,
    opts: { includeCancelled?: boolean } = {},
  ): Promise<StoredSubscription[]> {
    return this.items
      .filter(
        (s) =>
          s.ownerJid === ownerJid &&
          (opts.includeCancelled || s.status === 'ACTIVE' || s.status === 'ZOMBIE_SUSPECTED'),
      )
      .sort((a, b) => {
        if (b.annualizedCostCents !== a.annualizedCostCents) {
          return b.annualizedCostCents > a.annualizedCostCents ? 1 : -1;
        }
        return a.merchantName.localeCompare(b.merchantName);
      });
  }

  async upsert(input: UpsertSubscriptionInput): Promise<StoredSubscription> {
    const cur = input.currency.toUpperCase();
    const existing = await this.findByKey(input.ownerJid, input.normalizedMerchant, cur);
    const now = new Date();
    if (existing) {
      existing.merchantName = input.merchantName;
      existing.category = input.category;
      existing.billingCycleDays = input.billingCycleDays;
      existing.billingPeriod = input.billingPeriod;
      existing.currentAmountCents = input.currentAmountCents;
      existing.previousAmountCents = input.previousAmountCents;
      existing.annualizedCostCents = input.annualizedCostCents;
      existing.status = input.status;
      existing.zombieReason = input.zombieReason;
      existing.chargeCount = input.chargeCount;
      existing.priceHikeCount = input.priceHikeCount;
      existing.lastChargedDate = input.lastChargedDate;
      existing.nextExpectedChargeDate = input.nextExpectedChargeDate;
      existing.source = input.source;
      existing.updatedAt = now;
      return existing;
    }

    const created: StoredSubscription = {
      id: this.nextId++,
      ownerJid: input.ownerJid,
      merchantName: input.merchantName,
      normalizedMerchant: input.normalizedMerchant,
      category: input.category,
      billingCycleDays: input.billingCycleDays,
      billingPeriod: input.billingPeriod,
      currentAmountCents: input.currentAmountCents,
      previousAmountCents: input.previousAmountCents,
      currency: cur,
      annualizedCostCents: input.annualizedCostCents,
      status: input.status,
      zombieReason: input.zombieReason,
      chargeCount: input.chargeCount,
      priceHikeCount: input.priceHikeCount,
      lastChargedDate: input.lastChargedDate,
      nextExpectedChargeDate: input.nextExpectedChargeDate,
      lastConfirmedUsedAt: input.lastConfirmedUsedAt ?? null,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(created);
    return created;
  }

  async updateZombieState(
    id: number,
    status: 'ACTIVE' | 'ZOMBIE_SUSPECTED',
    zombieReason: string | null,
  ): Promise<StoredSubscription | null> {
    const found = this.items.find(
      (s) => s.id === id && (s.status === 'ACTIVE' || s.status === 'ZOMBIE_SUSPECTED'),
    );
    if (!found) return null;
    found.status = status;
    found.zombieReason = zombieReason;
    found.updatedAt = new Date();
    return found;
  }

  async markCancelled(id: number): Promise<StoredSubscription | null> {
    const found = this.items.find((s) => s.id === id);
    if (!found) return null;
    found.status = 'CANCELLED';
    found.zombieReason = null;
    found.updatedAt = new Date();
    return found;
  }

  async markConfirmedUsed(
    id: number,
    confirmedAt: Date = new Date(),
  ): Promise<StoredSubscription | null> {
    const found = this.items.find((s) => s.id === id);
    if (!found) return null;
    found.status = 'ACTIVE';
    found.zombieReason = null;
    found.lastConfirmedUsedAt = confirmedAt;
    found.updatedAt = new Date();
    return found;
  }
}
