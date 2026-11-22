import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadPartialEnv } from '../config/env.js';
import { ROMANIAN_PROVIDERS_SEED } from '../config/providers.seed.js';
import { createPool, withTransaction } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrationsAndSeed(pool: pg.Pool): Promise<{
  appliedMigrations: string[];
  seededProviders: number;
}> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const entries = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const existingResult = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const existing = new Set(existingResult.rows.map((r) => r.filename));

  const appliedMigrations: string[] = [];

  for (const filename of entries) {
    if (existing.has(filename)) {
      continue;
    }
    const sqlPath = path.join(migrationsDir, filename);
    const sql = await readFile(sqlPath, 'utf8');

    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
        [filename],
      );
    });
    appliedMigrations.push(filename);
  }

  let seededProviders = 0;
  for (const p of ROMANIAN_PROVIDERS_SEED) {
    const res = await pool.query(
      `
      INSERT INTO provider_configs (
        provider_cui,
        provider_name,
        category,
        dispute_email,
        self_reading_window_start,
        self_reading_window_end,
        contractual_unit_price_net,
        unit_price_alert_threshold_pct
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (provider_cui) DO NOTHING
      `,
      [
        p.providerCui,
        p.providerName,
        p.category,
        p.disputeEmail,
        p.selfReadingWindowStart,
        p.selfReadingWindowEnd,
        p.contractualUnitPriceNet,
        p.unitPriceAlertThresholdPct,
      ],
    );
    seededProviders += res.rowCount ?? 0;
  }

  return { appliedMigrations, seededProviders };
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const env = loadPartialEnv();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required to run migrations.');
    process.exit(1);
  }
  const pool = createPool(env.DATABASE_URL);
  runMigrationsAndSeed(pool)
    .then(({ appliedMigrations, seededProviders }) => {
      console.log(
        `Migrations complete. Applied: ${appliedMigrations.length > 0 ? appliedMigrations.join(', ') : 'none (up to date)'}. Seeded new providers: ${seededProviders}.`,
      );
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      return pool.end().finally(() => process.exit(1));
    });
}
