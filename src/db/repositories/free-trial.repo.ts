import type {
  BillingPeriod,
  FreeTrialSource,
  FreeTrialStatus,
  StoredFreeTrial,
} from '../../subscriptions/types.js';
import type { Queryable } from '../pool.js';

export interface CreateFreeTrialInput {
  ownerJid: string;
  externalRef: string;
  serviceName: string;
  normalizedService: string;
  trialStartAt: Date | null;
  trialEndAt: Date;
  postTrialAmountCents: bigint;
  currency: string;
  billingPeriod: BillingPeriod;
  cancellationUrl: string | null;
  source: FreeTrialSource;
  status: FreeTrialStatus;
  alert48hScheduledAt: Date;
  rawExtractedJson?: Record<string, unknown>;
}

export interface FreeTrialRepository {
  findById(id: number, db?: Queryable): Promise<StoredFreeTrial | null>;
  findByExternalRef(externalRef: string, db?: Queryable): Promise<StoredFreeTrial | null>;
  insertIfNew(
    input: CreateFreeTrialInput,
    db?: Queryable,
  ): Promise<{ inserted: boolean; trial: StoredFreeTrial }>;
  findActiveByOwner(ownerJid: string, db?: Queryable): Promise<StoredFreeTrial[]>;
  findActiveByService(
    ownerJid: string,
    normalizedService: string,
    db?: Queryable,
  ): Promise<StoredFreeTrial[]>;
  findDueFor48hAlert(now?: Date, db?: Queryable): Promise<StoredFreeTrial[]>;
  markAlert48hSent(id: number, sentAt?: Date, db?: Queryable): Promise<StoredFreeTrial | null>;
  markCancelled(id: number, db?: Queryable): Promise<StoredFreeTrial | null>;
  markExpired(id: number, db?: Queryable): Promise<StoredFreeTrial | null>;
}

interface FreeTrialRow {
  id: string;
  owner_jid: string;
  external_ref: string;
  service_name: string;
  normalized_service: string;
  trial_start_at: Date | null;
  trial_end_at: Date;
  post_trial_amount_cents: string;
  currency: string;
  billing_period: BillingPeriod;
  cancellation_url: string | null;
  source: FreeTrialSource;
  status: FreeTrialStatus;
  alert_48h_scheduled_at: Date;
  alert_48h_sent_at: Date | null;
  raw_extracted_json: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: FreeTrialRow): StoredFreeTrial {
  return {
    id: Number(row.id),
    ownerJid: row.owner_jid,
    externalRef: row.external_ref,
    serviceName: row.service_name,
    normalizedService: row.normalized_service,
    trialStartAt: row.trial_start_at ? new Date(row.trial_start_at) : null,
    trialEndAt: new Date(row.trial_end_at),
    postTrialAmountCents: BigInt(row.post_trial_amount_cents),
    currency: row.currency,
    billingPeriod: row.billing_period,
    cancellationUrl: row.cancellation_url,
    source: row.source,
    status: row.status,
    alert48hScheduledAt: new Date(row.alert_48h_scheduled_at),
    alert48hSentAt: row.alert_48h_sent_at ? new Date(row.alert_48h_sent_at) : null,
    rawExtractedJson: row.raw_extracted_json ?? {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PgFreeTrialRepository implements FreeTrialRepository {
  constructor(private readonly pool: Queryable) {}

  async findById(id: number, db?: Queryable): Promise<StoredFreeTrial | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      'SELECT * FROM free_trials WHERE id = $1 LIMIT 1',
      [id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async findByExternalRef(externalRef: string, db?: Queryable): Promise<StoredFreeTrial | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      'SELECT * FROM free_trials WHERE external_ref = $1 LIMIT 1',
      [externalRef],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async insertIfNew(
    input: CreateFreeTrialInput,
    db?: Queryable,
  ): Promise<{ inserted: boolean; trial: StoredFreeTrial }> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      `
      INSERT INTO free_trials (
        owner_jid, external_ref, service_name, normalized_service,
        trial_start_at, trial_end_at, post_trial_amount_cents, currency,
        billing_period, cancellation_url, source, status,
        alert_48h_scheduled_at, raw_extracted_json
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14::jsonb
      )
      ON CONFLICT (external_ref) DO NOTHING
      RETURNING *
      `,
      [
        input.ownerJid,
        input.externalRef,
        input.serviceName,
        input.normalizedService,
        input.trialStartAt ? input.trialStartAt.toISOString() : null,
        input.trialEndAt.toISOString(),
        input.postTrialAmountCents.toString(),
        input.currency.toUpperCase(),
        input.billingPeriod,
        input.cancellationUrl,
        input.source,
        input.status,
        input.alert48hScheduledAt.toISOString(),
        JSON.stringify(input.rawExtractedJson ?? {}),
      ],
    );

    if (res.rows[0]) {
      return { inserted: true, trial: mapRow(res.rows[0]) };
    }
    const existing = await this.findByExternalRef(input.externalRef, runner);
    return { inserted: false, trial: existing! };
  }

  async findActiveByOwner(ownerJid: string, db?: Queryable): Promise<StoredFreeTrial[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      `
      SELECT * FROM free_trials
      WHERE owner_jid = $1 AND status IN ('ACTIVE', 'ALERT_48H_SENT')
      ORDER BY trial_end_at ASC
      `,
      [ownerJid],
    );
    return res.rows.map(mapRow);
  }

  async findActiveByService(
    ownerJid: string,
    normalizedService: string,
    db?: Queryable,
  ): Promise<StoredFreeTrial[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      `
      SELECT * FROM free_trials
      WHERE owner_jid = $1
        AND normalized_service = $2
        AND status IN ('ACTIVE', 'ALERT_48H_SENT')
      ORDER BY trial_end_at ASC
      `,
      [ownerJid, normalizedService],
    );
    return res.rows.map(mapRow);
  }

  async findDueFor48hAlert(now: Date = new Date(), db?: Queryable): Promise<StoredFreeTrial[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      `
      SELECT * FROM free_trials
      WHERE status = 'ACTIVE' AND alert_48h_scheduled_at <= $1
      ORDER BY alert_48h_scheduled_at ASC
      `,
      [now.toISOString()],
    );
    return res.rows.map(mapRow);
  }

  async markAlert48hSent(
    id: number,
    sentAt: Date = new Date(),
    db?: Queryable,
  ): Promise<StoredFreeTrial | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      `
      UPDATE free_trials
      SET status = 'ALERT_48H_SENT', alert_48h_sent_at = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING *
      `,
      [id, sentAt.toISOString()],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async markCancelled(id: number, db?: Queryable): Promise<StoredFreeTrial | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      `
      UPDATE free_trials
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async markExpired(id: number, db?: Queryable): Promise<StoredFreeTrial | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<FreeTrialRow>(
      `
      UPDATE free_trials
      SET status = 'EXPIRED', updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }
}

export class InMemoryFreeTrialRepository implements FreeTrialRepository {
  private nextId = 1;
  private readonly items: StoredFreeTrial[] = [];

  async findById(id: number): Promise<StoredFreeTrial | null> {
    return this.items.find((t) => t.id === id) ?? null;
  }

  async findByExternalRef(externalRef: string): Promise<StoredFreeTrial | null> {
    return this.items.find((t) => t.externalRef === externalRef) ?? null;
  }

  async insertIfNew(
    input: CreateFreeTrialInput,
  ): Promise<{ inserted: boolean; trial: StoredFreeTrial }> {
    const existing = await this.findByExternalRef(input.externalRef);
    if (existing) {
      return { inserted: false, trial: existing };
    }
    const now = new Date();
    const created: StoredFreeTrial = {
      id: this.nextId++,
      ownerJid: input.ownerJid,
      externalRef: input.externalRef,
      serviceName: input.serviceName,
      normalizedService: input.normalizedService,
      trialStartAt: input.trialStartAt,
      trialEndAt: input.trialEndAt,
      postTrialAmountCents: input.postTrialAmountCents,
      currency: input.currency.toUpperCase(),
      billingPeriod: input.billingPeriod,
      cancellationUrl: input.cancellationUrl,
      source: input.source,
      status: input.status,
      alert48hScheduledAt: input.alert48hScheduledAt,
      alert48hSentAt: null,
      rawExtractedJson: input.rawExtractedJson ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(created);
    return { inserted: true, trial: created };
  }

  async findActiveByOwner(ownerJid: string): Promise<StoredFreeTrial[]> {
    return this.items
      .filter(
        (t) =>
          t.ownerJid === ownerJid && (t.status === 'ACTIVE' || t.status === 'ALERT_48H_SENT'),
      )
      .sort((a, b) => a.trialEndAt.getTime() - b.trialEndAt.getTime());
  }

  async findActiveByService(
    ownerJid: string,
    normalizedService: string,
  ): Promise<StoredFreeTrial[]> {
    return this.items
      .filter(
        (t) =>
          t.ownerJid === ownerJid &&
          t.normalizedService === normalizedService &&
          (t.status === 'ACTIVE' || t.status === 'ALERT_48H_SENT'),
      )
      .sort((a, b) => a.trialEndAt.getTime() - b.trialEndAt.getTime());
  }

  async findDueFor48hAlert(now: Date = new Date()): Promise<StoredFreeTrial[]> {
    return this.items
      .filter(
        (t) => t.status === 'ACTIVE' && t.alert48hScheduledAt.getTime() <= now.getTime(),
      )
      .sort((a, b) => a.alert48hScheduledAt.getTime() - b.alert48hScheduledAt.getTime());
  }

  async markAlert48hSent(id: number, sentAt: Date = new Date()): Promise<StoredFreeTrial | null> {
    const found = this.items.find((t) => t.id === id && t.status === 'ACTIVE');
    if (!found) return null;
    found.status = 'ALERT_48H_SENT';
    found.alert48hSentAt = sentAt;
    found.updatedAt = new Date();
    return found;
  }

  async markCancelled(id: number): Promise<StoredFreeTrial | null> {
    const found = this.items.find((t) => t.id === id);
    if (!found) return null;
    found.status = 'CANCELLED';
    found.updatedAt = new Date();
    return found;
  }

  async markExpired(id: number): Promise<StoredFreeTrial | null> {
    const found = this.items.find((t) => t.id === id);
    if (!found) return null;
    found.status = 'EXPIRED';
    found.updatedAt = new Date();
    return found;
  }
}
