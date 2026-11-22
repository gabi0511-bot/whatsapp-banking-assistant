import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { loadPartialEnv } from '../config/env.js';
import type { AuditFlag, PaymentStatus } from '../audit/types.js';
import { validateAndNormalizeInvoice } from '../extraction/math.validator.js';
import type { CanonicalInvoice } from '../extraction/schema.js';
import { createPool } from './pool.js';
import { PgInvoiceRepository } from './repositories/invoice.repo.js';
import { PgMemoryRepository } from './repositories/memory.repo.js';
import { formatCentsRo } from '../extraction/schema.js';

dotenv.config();

interface HistoricalSeedEntry {
  seedKey: string;
  paymentStatus: PaymentStatus;
  auditFlags: AuditFlag[];
  invoice: CanonicalInvoice;
}

function sha256(seedKey: string): string {
  return createHash('sha256').update(seedKey).digest('hex');
}

const HISTORICAL_INVOICES: HistoricalSeedEntry[] = [
  // ================= LUNA TRECUTĂ: OCTOMBRIE 2026 (2026-10) =================
  {
    seedKey: 'seed:history:2026-10:water:compania-de-apa',
    paymentStatus: 'PAID_ON_TIME',
    auditFlags: [],
    invoice: {
      provider_name: 'Compania de Apă Someș S.A.',
      provider_cui: 'RO201217',
      category: 'WATER',
      client_code: '4401928',
      consumption_point_id: 'APA-CJ-4401928',
      invoice_series: 'CAS',
      invoice_number: '2026-104821',
      issue_date: '2026-10-08',
      due_date: '2026-10-23',
      billing_period_start: '2026-09-01',
      billing_period_end: '2026-09-30',
      total_amount: 92.4,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 214,
        new_index: 223,
        consumption_value: 9,
        consumption_unit: 'mc',
        self_reading_window_start: 20,
        self_reading_window_end: 25,
      },
      line_items: [
        {
          line_type: 'OTHER',
          raw_label: 'Apă potabilă și canalizare',
          quantity: 9,
          unit: 'mc',
          unit_price_net: 9.419,
          vat_rate_pct: 9,
          line_total_gross: 92.4,
        },
      ],
    },
  },
  {
    seedKey: 'seed:history:2026-10:gas:engie',
    paymentStatus: 'PAID_LATE',
    auditFlags: [
      {
        code: 'LATE_FEE_DETECTED',
        severity: 'WARNING',
        pillar: 'PRICING',
        message: 'Penalități de întârziere detectate: 12,50 RON.',
      },
    ],
    invoice: {
      provider_name: 'ENGIE Romania S.A.',
      provider_cui: 'RO13093222',
      category: 'GAS',
      client_code: '10492817',
      consumption_point_id: 'CLC-ENGIE-10492817',
      invoice_series: 'ENG',
      invoice_number: '2026-711409',
      issue_date: '2026-10-18',
      due_date: '2026-11-02',
      billing_period_start: '2026-09-15',
      billing_period_end: '2026-10-14',
      total_amount: 782.5,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 5420,
        new_index: 5608,
        consumption_value: 1980,
        consumption_unit: 'kWh',
        self_reading_window_start: 10,
        self_reading_window_end: 15,
      },
      line_items: [
        {
          line_type: 'GAS_ENERGY',
          raw_label: 'Furnizare gaze naturale',
          quantity: 1980,
          unit: 'kWh',
          unit_price_net: 0.3268,
          vat_rate_pct: 19,
          line_total_gross: 770.0,
        },
        {
          line_type: 'PENALTY',
          raw_label: 'Penalități de întârziere',
          quantity: 1,
          unit: 'buc',
          unit_price_net: 12.5,
          vat_rate_pct: 0,
          line_total_gross: 12.5,
        },
      ],
    },
  },
  {
    seedKey: 'seed:history:2026-10:electricity:hidroelectrica',
    paymentStatus: 'PAID_ON_TIME',
    auditFlags: [],
    invoice: {
      provider_name: 'S.P.E.E.H. Hidroelectrica S.A.',
      provider_cui: 'RO13267213',
      category: 'ELECTRICITY',
      client_code: '80045192',
      consumption_point_id: 'RO001E123456789',
      invoice_series: 'HID',
      invoice_number: '2026-398114',
      issue_date: '2026-10-16',
      due_date: '2026-10-31',
      billing_period_start: '2026-09-01',
      billing_period_end: '2026-09-30',
      total_amount: 366.2,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 14120,
        new_index: 14405,
        consumption_value: 285,
        consumption_unit: 'kWh',
        self_reading_window_start: 24,
        self_reading_window_end: 28,
      },
      line_items: [
        {
          line_type: 'ACTIVE_ENERGY',
          raw_label: 'Energie electrică activă',
          quantity: 285,
          unit: 'kWh',
          unit_price_net: 1.0798,
          vat_rate_pct: 19,
          line_total_gross: 366.2,
        },
      ],
    },
  },
  {
    seedKey: 'seed:history:2026-10:telecom:digi',
    paymentStatus: 'PAID_ON_TIME',
    auditFlags: [],
    invoice: {
      provider_name: 'DIGI ROMANIA S.A.',
      provider_cui: 'RO5888716',
      category: 'TELECOM',
      client_code: '109482736',
      consumption_point_id: 'DIGI-109482736',
      invoice_series: 'DIGI',
      invoice_number: '2026-795104',
      issue_date: '2026-10-20',
      due_date: '2026-11-05',
      billing_period_start: '2026-10-01',
      billing_period_end: '2026-10-31',
      total_amount: 48.5,
      currency: 'RON',
      meter_reading: {
        reading_type: 'N_A',
        old_index: null,
        new_index: null,
        consumption_value: null,
        consumption_unit: null,
        self_reading_window_start: null,
        self_reading_window_end: null,
      },
      line_items: [
        {
          line_type: 'BASE_SUBSCRIPTION',
          raw_label: 'Abonament Digi Mobil Optim Nelimitat + Fiberlink',
          quantity: 1,
          unit: 'luna',
          unit_price_net: 40.7563,
          vat_rate_pct: 19,
          line_total_gross: 48.5,
        },
      ],
    },
  },

  // ================= ACUM 2 LUNI: SEPTEMBRIE 2026 (2026-09) =================
  {
    seedKey: 'seed:history:2026-09:water:compania-de-apa',
    paymentStatus: 'PAID_ON_TIME',
    auditFlags: [],
    invoice: {
      provider_name: 'Compania de Apă Someș S.A.',
      provider_cui: 'RO201217',
      category: 'WATER',
      client_code: '4401928',
      consumption_point_id: 'APA-CJ-4401928',
      invoice_series: 'CAS',
      invoice_number: '2026-093410',
      issue_date: '2026-09-08',
      due_date: '2026-09-23',
      billing_period_start: '2026-08-01',
      billing_period_end: '2026-08-31',
      total_amount: 84.1,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 206,
        new_index: 214,
        consumption_value: 8,
        consumption_unit: 'mc',
        self_reading_window_start: 20,
        self_reading_window_end: 25,
      },
      line_items: [
        {
          line_type: 'OTHER',
          raw_label: 'Apă potabilă și canalizare',
          quantity: 8,
          unit: 'mc',
          unit_price_net: 9.6445,
          vat_rate_pct: 9,
          line_total_gross: 84.1,
        },
      ],
    },
  },
  {
    seedKey: 'seed:history:2026-09:gas:engie',
    paymentStatus: 'PAID_ON_TIME',
    auditFlags: [],
    invoice: {
      provider_name: 'ENGIE Romania S.A.',
      provider_cui: 'RO13093222',
      category: 'GAS',
      client_code: '10492817',
      consumption_point_id: 'CLC-ENGIE-10492817',
      invoice_series: 'ENG',
      invoice_number: '2026-652880',
      issue_date: '2026-09-18',
      due_date: '2026-10-03',
      billing_period_start: '2026-08-15',
      billing_period_end: '2026-09-14',
      total_amount: 348.9,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 5332,
        new_index: 5420,
        consumption_value: 920,
        consumption_unit: 'kWh',
        self_reading_window_start: 10,
        self_reading_window_end: 15,
      },
      line_items: [
        {
          line_type: 'GAS_ENERGY',
          raw_label: 'Furnizare gaze naturale',
          quantity: 920,
          unit: 'kWh',
          unit_price_net: 0.3187,
          vat_rate_pct: 19,
          line_total_gross: 348.9,
        },
      ],
    },
  },
  {
    seedKey: 'seed:history:2026-09:electricity:hidroelectrica',
    paymentStatus: 'PAID_ON_TIME',
    auditFlags: [],
    invoice: {
      provider_name: 'S.P.E.E.H. Hidroelectrica S.A.',
      provider_cui: 'RO13267213',
      category: 'ELECTRICITY',
      client_code: '80045192',
      consumption_point_id: 'RO001E123456789',
      invoice_series: 'HID',
      invoice_number: '2026-341002',
      issue_date: '2026-09-16',
      due_date: '2026-10-01',
      billing_period_start: '2026-08-01',
      billing_period_end: '2026-08-31',
      total_amount: 308.4,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 13880,
        new_index: 14120,
        consumption_value: 240,
        consumption_unit: 'kWh',
        self_reading_window_start: 24,
        self_reading_window_end: 28,
      },
      line_items: [
        {
          line_type: 'ACTIVE_ENERGY',
          raw_label: 'Energie electrică activă',
          quantity: 240,
          unit: 'kWh',
          unit_price_net: 1.0798,
          vat_rate_pct: 19,
          line_total_gross: 308.4,
        },
      ],
    },
  },
  {
    seedKey: 'seed:history:2026-09:telecom:digi',
    paymentStatus: 'PAID_ON_TIME',
    auditFlags: [],
    invoice: {
      provider_name: 'DIGI ROMANIA S.A.',
      provider_cui: 'RO5888716',
      category: 'TELECOM',
      client_code: '109482736',
      consumption_point_id: 'DIGI-109482736',
      invoice_series: 'DIGI',
      invoice_number: '2026-731902',
      issue_date: '2026-09-20',
      due_date: '2026-10-05',
      billing_period_start: '2026-09-01',
      billing_period_end: '2026-09-30',
      total_amount: 48.5,
      currency: 'RON',
      meter_reading: {
        reading_type: 'N_A',
        old_index: null,
        new_index: null,
        consumption_value: null,
        consumption_unit: null,
        self_reading_window_start: null,
        self_reading_window_end: null,
      },
      line_items: [
        {
          line_type: 'BASE_SUBSCRIPTION',
          raw_label: 'Abonament Digi Mobil Optim Nelimitat + Fiberlink',
          quantity: 1,
          unit: 'luna',
          unit_price_net: 40.7563,
          vat_rate_pct: 19,
          line_total_gross: 48.5,
        },
      ],
    },
  },
];

async function main(): Promise<void> {
  const env = loadPartialEnv();
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing in .env');
  }

  const pool = createPool(env.DATABASE_URL);
  const invoiceRepo = new PgInvoiceRepository(pool);
  const memoryRepo = new PgMemoryRepository(pool);

  let inserted = 0;
  let skipped = 0;

  try {
    for (const entry of HISTORICAL_INVOICES) {
      const hash = sha256(entry.seedKey);
      const existing = await invoiceRepo.findBySha256(hash);
      if (existing) {
        skipped += 1;
        console.log(
          `[SKIP] Already exists: #${existing.id} ${existing.providerName} (${existing.issueDate}) — ${formatCentsRo(existing.totalAmountCents, existing.currency)}`,
        );
        continue;
      }

      const validated = validateAndNormalizeInvoice({
        extracted: entry.invoice,
        fileSha256: hash,
        sourceFormat: 'PDF',
      });

      const stored = await invoiceRepo.insertInvoiceWithLines({
        validated,
        effectiveReadingType: validated.readingType,
        paymentStatus: entry.paymentStatus,
        auditFlags: entry.auditFlags,
      });

      await memoryRepo.record({
        ownerJid: env.OWNER_WHATSAPP_JID,
        eventType: 'PAYMENT_COMPLETED',
        entityType: 'INVOICE',
        entityId: stored.id,
        summaryText: `Factură ${stored.providerName} (${stored.category}, emisă ${stored.issueDate}) achitată (${stored.paymentStatus}) — ${formatCentsRo(stored.totalAmountCents, stored.currency)}`,
        amountCents: stored.totalAmountCents,
        currency: stored.currency,
        metadata: {
          seeded: true,
          issueDate: stored.issueDate,
          dueDate: stored.dueDate,
          paymentStatus: stored.paymentStatus,
        },
      });

      inserted += 1;
      console.log(
        `[INSERT] #${stored.id} ${stored.providerName} [${stored.category}] (${stored.issueDate}) — ${formatCentsRo(stored.totalAmountCents, stored.currency)} (${stored.paymentStatus})`,
      );
    }

    console.log(`\nDone! Inserted: ${inserted}, Skipped (already present): ${skipped}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
