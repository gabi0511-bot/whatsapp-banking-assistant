import type { DemoBalanceRecord } from '../../subscriptions/types.js';
import type { Queryable } from '../pool.js';

export interface DemoBalanceRepository {
  get(ownerJid: string, db?: Queryable): Promise<DemoBalanceRecord>;
  set(
    ownerJid: string,
    balanceCents: bigint,
    currency?: string,
    db?: Queryable,
  ): Promise<DemoBalanceRecord>;
}

interface DemoBalanceRow {
  owner_jid: string;
  balance_cents: string;
  currency: string;
  updated_at: Date;
}

function mapRow(row: DemoBalanceRow): DemoBalanceRecord {
  return {
    ownerJid: row.owner_jid,
    balanceCents: BigInt(row.balance_cents),
    currency: row.currency,
    updatedAt: new Date(row.updated_at),
  };
}

export class PgDemoBalanceRepository implements DemoBalanceRepository {
  constructor(private readonly pool: Queryable) {}

  async get(ownerJid: string, db?: Queryable): Promise<DemoBalanceRecord> {
    const runner = db ?? this.pool;
    const res = await runner.query<DemoBalanceRow>(
      'SELECT * FROM demo_balances WHERE owner_jid = $1 LIMIT 1',
      [ownerJid],
    );
    if (res.rows[0]) {
      return mapRow(res.rows[0]);
    }
    return {
      ownerJid,
      balanceCents: 0n,
      currency: 'RON',
      updatedAt: new Date(),
    };
  }

  async set(
    ownerJid: string,
    balanceCents: bigint,
    currency = 'RON',
    db?: Queryable,
  ): Promise<DemoBalanceRecord> {
    const runner = db ?? this.pool;
    const res = await runner.query<DemoBalanceRow>(
      `
      INSERT INTO demo_balances (owner_jid, balance_cents, currency, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (owner_jid) DO UPDATE SET
        balance_cents = EXCLUDED.balance_cents,
        currency = EXCLUDED.currency,
        updated_at = NOW()
      RETURNING *
      `,
      [ownerJid, balanceCents.toString(), currency.toUpperCase()],
    );
    return mapRow(res.rows[0]!);
  }
}

export class InMemoryDemoBalanceRepository implements DemoBalanceRepository {
  private readonly store = new Map<string, DemoBalanceRecord>();

  async get(ownerJid: string): Promise<DemoBalanceRecord> {
    return (
      this.store.get(ownerJid) ?? {
        ownerJid,
        balanceCents: 0n,
        currency: 'RON',
        updatedAt: new Date(),
      }
    );
  }

  async set(
    ownerJid: string,
    balanceCents: bigint,
    currency = 'RON',
  ): Promise<DemoBalanceRecord> {
    const rec: DemoBalanceRecord = {
      ownerJid,
      balanceCents,
      currency: currency.toUpperCase(),
      updatedAt: new Date(),
    };
    this.store.set(ownerJid, rec);
    return rec;
  }
}
