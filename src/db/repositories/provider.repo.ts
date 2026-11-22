import type { ProviderConfig } from '../../audit/types.js';
import { ROMANIAN_PROVIDERS_SEED } from '../../config/providers.seed.js';
import { normalizeCui, type InvoiceCategory } from '../../extraction/schema.js';
import type { Queryable } from '../pool.js';

export interface ProviderRepository {
  findByCui(providerCui: string, db?: Queryable): Promise<ProviderConfig | null>;
  listAll(db?: Queryable): Promise<ProviderConfig[]>;
}

interface ProviderRow {
  id: string;
  provider_cui: string;
  provider_name: string;
  category: InvoiceCategory;
  dispute_email: string | null;
  self_reading_window_start: number | null;
  self_reading_window_end: number | null;
  contractual_unit_price_net: string | null;
  unit_price_alert_threshold_pct: string;
}

function mapRow(row: ProviderRow): ProviderConfig {
  return {
    id: Number(row.id),
    providerCui: row.provider_cui,
    providerName: row.provider_name,
    category: row.category,
    disputeEmail: row.dispute_email,
    selfReadingWindowStart: row.self_reading_window_start,
    selfReadingWindowEnd: row.self_reading_window_end,
    contractualUnitPriceNet: row.contractual_unit_price_net,
    unitPriceAlertThresholdPct: row.unit_price_alert_threshold_pct,
  };
}

export class PgProviderRepository implements ProviderRepository {
  constructor(private readonly pool: Queryable) {}

  async findByCui(providerCui: string, db?: Queryable): Promise<ProviderConfig | null> {
    const normalized = normalizeCui(providerCui);
    const runner = db ?? this.pool;
    const res = await runner.query<ProviderRow>(
      'SELECT * FROM provider_configs WHERE provider_cui = $1 LIMIT 1',
      [normalized],
    );
    const row = res.rows[0];
    return row ? mapRow(row) : null;
  }

  async listAll(db?: Queryable): Promise<ProviderConfig[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<ProviderRow>(
      'SELECT * FROM provider_configs ORDER BY provider_name ASC',
    );
    return res.rows.map(mapRow);
  }
}

export class InMemoryProviderRepository implements ProviderRepository {
  private readonly providers = new Map<string, ProviderConfig>();

  constructor(initial?: ProviderConfig[]) {
    if (initial) {
      for (const p of initial) {
        this.providers.set(normalizeCui(p.providerCui), p);
      }
    } else {
      ROMANIAN_PROVIDERS_SEED.forEach((seed, idx) => {
        this.providers.set(normalizeCui(seed.providerCui), {
          id: idx + 1,
          ...seed,
        });
      });
    }
  }

  async findByCui(providerCui: string): Promise<ProviderConfig | null> {
    return this.providers.get(normalizeCui(providerCui)) ?? null;
  }

  async listAll(): Promise<ProviderConfig[]> {
    return Array.from(this.providers.values());
  }

  upsert(config: ProviderConfig): void {
    this.providers.set(normalizeCui(config.providerCui), config);
  }
}
