import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluatePricingRule } from '../src/audit/rules/pricing.rule.js';
import type { ProviderConfig, StoredInvoice, ValidatedInvoice } from '../src/audit/types.js';
import { validateAndNormalizeInvoice } from '../src/extraction/math.validator.js';
import { CanonicalInvoiceSchema, type CanonicalInvoice } from '../src/extraction/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadFixtureInvoice(filename: string): Promise<ValidatedInvoice> {
  const raw = JSON.parse(
    await readFile(path.join(__dirname, 'fixtures', filename), 'utf8'),
  ) as { invoice: unknown };
  const parsed = CanonicalInvoiceSchema.parse(raw.invoice);
  return validateAndNormalizeInvoice({
    extracted: parsed,
    fileSha256: filename.padEnd(64, '0').slice(0, 64),
    sourceFormat: 'PDF',
  });
}

function toStored(
  v: ValidatedInvoice,
  id: number,
  paymentStatus: StoredInvoice['paymentStatus'] = 'UNPAID',
): StoredInvoice {
  return {
    ...v,
    id,
    paymentStatus,
    auditFlags: [],
    lineItems: v.lineItems.map((l, idx) => ({ ...l, id: idx + 1, invoiceId: id })),
    createdAt: new Date(),
  };
}

describe('pricing.rule (Pillar 2)', () => {
  it('fires UNIT_PRICE_INCREASE even when the invoice total amount DROPPED due to lower consumption', async () => {
    const m1 = toStored(await loadFixtureInvoice('hidroelectrica_m1_baseline.json'), 1);
    const m2 = await loadFixtureInvoice('hidroelectrica_m2_hidden_price_hike.json');

    expect(m2.totalAmountCents).toBeLessThan(m1.totalAmountCents);

    const flags = evaluatePricingRule({
      invoice: m2,
      effectiveReadingType: m2.readingType,
      previousInvoice: m1,
      recentRealInvoices: [m1],
      recentEstimatedInvoices: [],
      providerConfig: {
        id: 1,
        providerCui: 'RO13267213',
        providerName: 'Hidroelectrica',
        category: 'ELECTRICITY',
        disputeEmail: 'clienti@hidroelectrica.ro',
        selfReadingWindowStart: 24,
        selfReadingWindowEnd: 28,
        contractualUnitPriceNet: null,
        unitPriceAlertThresholdPct: '2.00',
      },
    });

    const hike = flags.find((f) => f.code === 'UNIT_PRICE_INCREASE');
    expect(hike).toBeDefined();
    expect(hike?.severity).toBe('WARNING');
    expect(Number(hike?.metadata?.deltaPct)).toBeCloseTo(30.01, 1);
  });

  it('NEVER compares mc against kWh on gas invoices', () => {
    const prevRaw: CanonicalInvoice = {
      provider_name: 'Engie Romania',
      provider_cui: 'RO13093222',
      category: 'GAS',
      client_code: '5501',
      consumption_point_id: 'CLC-1',
      invoice_series: 'ENG',
      invoice_number: '100',
      issue_date: '2026-01-10',
      due_date: '2026-01-30',
      billing_period_start: '2025-12-01',
      billing_period_end: '2025-12-31',
      total_amount: 148.75,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 100,
        new_index: 150,
        consumption_value: 50,
        consumption_unit: 'mc',
        self_reading_window_start: 20,
        self_reading_window_end: 25,
      },
      line_items: [
        {
          line_type: 'GAS_ENERGY',
          raw_label: 'Gaze naturale mc',
          quantity: 50,
          unit: 'mc',
          unit_price_net: 2.5,
          vat_rate_pct: 19,
          line_total_gross: 148.75,
        },
      ],
    };

    const currRaw: CanonicalInvoice = {
      ...prevRaw,
      invoice_number: '101',
      issue_date: '2026-02-10',
      due_date: '2026-02-28',
      total_amount: 154.7,
      meter_reading: {
        ...prevRaw.meter_reading,
        consumption_value: 500,
        consumption_unit: 'kWh',
      },
      line_items: [
        {
          line_type: 'GAS_ENERGY',
          raw_label: 'Gaze naturale kWh',
          quantity: 500,
          unit: 'kWh',
          unit_price_net: 0.26,
          vat_rate_pct: 19,
          line_total_gross: 154.7,
        },
      ],
    };

    const prev = toStored(
      validateAndNormalizeInvoice({ extracted: prevRaw, fileSha256: 'a'.repeat(64), sourceFormat: 'PDF' }),
      1,
    );
    const curr = validateAndNormalizeInvoice({
      extracted: currRaw,
      fileSha256: 'b'.repeat(64),
      sourceFormat: 'PDF',
    });

    const flags = evaluatePricingRule({
      invoice: curr,
      effectiveReadingType: 'SELF_READ',
      previousInvoice: prev,
      recentRealInvoices: [],
      recentEstimatedInvoices: [],
      providerConfig: null,
    });

    expect(flags.some((f) => f.code === 'UNIT_PRICE_INCREASE')).toBe(false);
  });

  it('upgrades to CONTRACTUAL_RATE_BREACH (CRITICAL) when net price exceeds contractual_unit_price_net by >0.5%', async () => {
    const m2 = await loadFixtureInvoice('hidroelectrica_m2_hidden_price_hike.json');
    const config: ProviderConfig = {
      id: 1,
      providerCui: 'RO13267213',
      providerName: 'Hidroelectrica',
      category: 'ELECTRICITY',
      disputeEmail: 'clienti@hidroelectrica.ro',
      selfReadingWindowStart: 24,
      selfReadingWindowEnd: 28,
      contractualUnitPriceNet: '0.283820',
      unitPriceAlertThresholdPct: '2.00',
    };

    const flags = evaluatePricingRule({
      invoice: m2,
      effectiveReadingType: m2.readingType,
      previousInvoice: null,
      recentRealInvoices: [],
      recentEstimatedInvoices: [],
      providerConfig: config,
    });

    const breach = flags.find((f) => f.code === 'CONTRACTUAL_RATE_BREACH');
    expect(breach).toBeDefined();
    expect(breach?.severity).toBe('CRITICAL');
  });

  it('detects PROMO_EXPIRED (20 RON/month, 240 RON/year) and upgrades LATE_FEE_DETECTED to CRITICAL when M1 was PAID_ON_TIME', async () => {
    const digiM1 = toStored(await loadFixtureInvoice('digi_m1_with_promo.json'), 10, 'PAID_ON_TIME');
    const digiM2 = await loadFixtureInvoice('digi_m2_promo_expired_and_penalty.json');

    const flags = evaluatePricingRule({
      invoice: digiM2,
      effectiveReadingType: digiM2.readingType,
      previousInvoice: digiM1,
      recentRealInvoices: [],
      recentEstimatedInvoices: [],
      providerConfig: {
        id: 6,
        providerCui: 'RO5888716',
        providerName: 'Digi Romania',
        category: 'TELECOM',
        disputeEmail: 'clienti@digi.ro',
        selfReadingWindowStart: null,
        selfReadingWindowEnd: null,
        contractualUnitPriceNet: null,
        unitPriceAlertThresholdPct: '0.50',
      },
    });

    const promoFlag = flags.find((f) => f.code === 'PROMO_EXPIRED');
    expect(promoFlag).toBeDefined();
    expect(promoFlag?.severity).toBe('WARNING');
    expect(promoFlag?.metadata?.monthlyLossCents).toBe('2000');
    expect(promoFlag?.metadata?.annualImpactCents).toBe('24000');
    expect(promoFlag?.message).toContain('20,00 RON/lună');
    expect(promoFlag?.message).toContain('240,00 RON/an');

    const penaltyFlag = flags.find((f) => f.code === 'LATE_FEE_DETECTED');
    expect(penaltyFlag).toBeDefined();
    expect(penaltyFlag?.severity).toBe('CRITICAL');
    expect(penaltyFlag?.metadata?.totalPenaltyCents).toBe('350');
  });

  it('detects CONSUMPTION_SPIKE (CRITICAL >= 80%) normalized by billing days', async () => {
    const m1 = toStored(await loadFixtureInvoice('hidroelectrica_m1_baseline.json'), 1);
    const m3 = await loadFixtureInvoice('hidroelectrica_m3_estimated_overlap_spike.json');

    const flags = evaluatePricingRule({
      invoice: m3,
      effectiveReadingType: 'ESTIMATED',
      previousInvoice: m1,
      recentRealInvoices: [m1],
      recentEstimatedInvoices: [],
      providerConfig: null,
    });

    const spike = flags.find((f) => f.code === 'CONSUMPTION_SPIKE');
    expect(spike).toBeDefined();
    expect(spike?.severity).toBe('CRITICAL');
    expect(Number(spike?.metadata?.spikePct)).toBeGreaterThan(100);
  });

  it('ignores storno lines for price comparison and detects REGULARIZATION_ANOMALY when storned qty < 90% of prior estimates', async () => {
    const eonRaw = JSON.parse(
      await readFile(
        path.join(__dirname, 'fixtures', 'eon_regularization_storno_and_creditor.json'),
        'utf8',
      ),
    ) as {
      prior_estimated_invoice: { invoice: unknown };
      regularization_invoice: { invoice: unknown };
    };

    const priorEst = toStored(
      validateAndNormalizeInvoice({
        extracted: CanonicalInvoiceSchema.parse(eonRaw.prior_estimated_invoice.invoice),
        fileSha256: 'p'.repeat(64),
        sourceFormat: 'PDF',
      }),
      20,
    );

    const regInv = validateAndNormalizeInvoice({
      extracted: CanonicalInvoiceSchema.parse(eonRaw.regularization_invoice.invoice),
      fileSha256: 'r'.repeat(64),
      sourceFormat: 'PDF',
    });

    const flags = evaluatePricingRule({
      invoice: regInv,
      effectiveReadingType: 'REGULARIZATION',
      previousInvoice: priorEst,
      recentRealInvoices: [],
      recentEstimatedInvoices: [priorEst],
      providerConfig: null,
    });

    expect(flags.some((f) => f.code === 'UNIT_PRICE_INCREASE')).toBe(false);
    const regFlag = flags.find((f) => f.code === 'REGULARIZATION_ANOMALY');
    expect(regFlag).toBeDefined();
    expect(regFlag?.severity).toBe('CRITICAL');
    expect(regFlag?.metadata?.stornedQty).toBe('300.000');
    expect(regFlag?.metadata?.priorEstimatedQty).toBe('500.000');
  });
});
