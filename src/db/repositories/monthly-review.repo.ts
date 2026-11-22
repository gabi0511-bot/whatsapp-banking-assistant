import type { Queryable } from '../pool.js';

export type BetterMonthOutcome = 'CURRENT' | 'PREVIOUS' | 'TIE' | 'INSUFFICIENT_DATA';

export interface StoredMonthlyReview {
  id: number;
  ownerJid: string;
  reviewMonth: string;
  previousMonth: string;
  currentPaidCents: bigint;
  previousPaidCents: bigint;
  savedCents: bigint;
  currentScore: number | null;
  previousScore: number | null;
  currentGrade: string | null;
  betterMonth: BetterMonthOutcome;
  metricsJson: Record<string, unknown>;
  generatedMessage: string;
  sentAt: Date | null;
  createdAt: Date;
}

export interface SaveMonthlyReviewInput {
  ownerJid: string;
  reviewMonth: string;
  previousMonth: string;
  currentPaidCents: bigint;
  previousPaidCents: bigint;
  savedCents: bigint;
  currentScore: number | null;
  previousScore: number | null;
  currentGrade: string | null;
  betterMonth: BetterMonthOutcome;
  metricsJson: Record<string, unknown>;
  generatedMessage: string;
  sentAt?: Date | null;
}

export interface MonthlyReviewRepository {
  findByMonth(
    ownerJid: string,
    reviewMonth: string,
    db?: Queryable,
  ): Promise<StoredMonthlyReview | null>;
  insertIfNew(
    input: SaveMonthlyReviewInput,
    db?: Queryable,
  ): Promise<{ inserted: boolean; review: StoredMonthlyReview }>;
  findRecent(ownerJid: string, limit?: number, db?: Queryable): Promise<StoredMonthlyReview[]>;
}

interface MonthlyReviewRow {
  id: string;
  owner_jid: string;
  review_month: string;
  previous_month: string;
  current_paid_cents: string;
  previous_paid_cents: string;
  saved_cents: string;
  current_score: number | null;
  previous_score: number | null;
  current_grade: string | null;
  better_month: BetterMonthOutcome;
  metrics_json: Record<string, unknown>;
  generated_message: string;
  sent_at: Date | null;
  created_at: Date;
}

function mapRow(row: MonthlyReviewRow): StoredMonthlyReview {
  return {
    id: Number(row.id),
    ownerJid: row.owner_jid,
    reviewMonth: row.review_month,
    previousMonth: row.previous_month,
    currentPaidCents: BigInt(row.current_paid_cents),
    previousPaidCents: BigInt(row.previous_paid_cents),
    savedCents: BigInt(row.saved_cents),
    currentScore: row.current_score,
    previousScore: row.previous_score,
    currentGrade: row.current_grade,
    betterMonth: row.better_month,
    metricsJson: row.metrics_json ?? {},
    generatedMessage: row.generated_message,
    sentAt: row.sent_at ? new Date(row.sent_at) : null,
    createdAt: new Date(row.created_at),
  };
}

export class PgMonthlyReviewRepository implements MonthlyReviewRepository {
  constructor(private readonly pool: Queryable) {}

  async findByMonth(
    ownerJid: string,
    reviewMonth: string,
    db?: Queryable,
  ): Promise<StoredMonthlyReview | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<MonthlyReviewRow>(
      `
      SELECT * FROM monthly_efficiency_reviews
      WHERE owner_jid = $1 AND review_month = $2
      LIMIT 1
      `,
      [ownerJid, reviewMonth],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async insertIfNew(
    input: SaveMonthlyReviewInput,
    db?: Queryable,
  ): Promise<{ inserted: boolean; review: StoredMonthlyReview }> {
    const runner = db ?? this.pool;
    const res = await runner.query<MonthlyReviewRow>(
      `
      INSERT INTO monthly_efficiency_reviews (
        owner_jid, review_month, previous_month,
        current_paid_cents, previous_paid_cents, saved_cents,
        current_score, previous_score, current_grade, better_month,
        metrics_json, generated_message, sent_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9, $10,
        $11::jsonb, $12, $13
      )
      ON CONFLICT (owner_jid, review_month) DO NOTHING
      RETURNING *
      `,
      [
        input.ownerJid,
        input.reviewMonth,
        input.previousMonth,
        input.currentPaidCents.toString(),
        input.previousPaidCents.toString(),
        input.savedCents.toString(),
        input.currentScore,
        input.previousScore,
        input.currentGrade,
        input.betterMonth,
        JSON.stringify(input.metricsJson),
        input.generatedMessage,
        input.sentAt ? input.sentAt.toISOString() : null,
      ],
    );

    if (res.rows[0]) {
      return { inserted: true, review: mapRow(res.rows[0]) };
    }
    const existing = await this.findByMonth(input.ownerJid, input.reviewMonth, runner);
    return { inserted: false, review: existing! };
  }

  async findRecent(
    ownerJid: string,
    limit = 6,
    db?: Queryable,
  ): Promise<StoredMonthlyReview[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<MonthlyReviewRow>(
      `
      SELECT * FROM monthly_efficiency_reviews
      WHERE owner_jid = $1
      ORDER BY review_month DESC
      LIMIT $2
      `,
      [ownerJid, limit],
    );
    return res.rows.map(mapRow);
  }
}

export class InMemoryMonthlyReviewRepository implements MonthlyReviewRepository {
  private nextId = 1;
  private readonly items: StoredMonthlyReview[] = [];

  async findByMonth(ownerJid: string, reviewMonth: string): Promise<StoredMonthlyReview | null> {
    return (
      this.items.find((r) => r.ownerJid === ownerJid && r.reviewMonth === reviewMonth) ?? null
    );
  }

  async insertIfNew(
    input: SaveMonthlyReviewInput,
  ): Promise<{ inserted: boolean; review: StoredMonthlyReview }> {
    const existing = await this.findByMonth(input.ownerJid, input.reviewMonth);
    if (existing) {
      return { inserted: false, review: existing };
    }
    const created: StoredMonthlyReview = {
      id: this.nextId++,
      ownerJid: input.ownerJid,
      reviewMonth: input.reviewMonth,
      previousMonth: input.previousMonth,
      currentPaidCents: input.currentPaidCents,
      previousPaidCents: input.previousPaidCents,
      savedCents: input.savedCents,
      currentScore: input.currentScore,
      previousScore: input.previousScore,
      currentGrade: input.currentGrade,
      betterMonth: input.betterMonth,
      metricsJson: input.metricsJson,
      generatedMessage: input.generatedMessage,
      sentAt: input.sentAt ?? null,
      createdAt: new Date(),
    };
    this.items.push(created);
    return { inserted: true, review: created };
  }

  async findRecent(ownerJid: string, limit = 6): Promise<StoredMonthlyReview[]> {
    return this.items
      .filter((r) => r.ownerJid === ownerJid)
      .sort((a, b) => b.reviewMonth.localeCompare(a.reviewMonth))
      .slice(0, limit);
  }
}
