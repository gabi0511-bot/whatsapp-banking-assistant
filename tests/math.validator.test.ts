import { describe, expect, it } from 'vitest';
import {
  computeBillingDays,
  toBaniCents,
  validateAndNormalizeInvoice,
} from '../src/extraction/math.validator.js';
import type { CanonicalInvoice } from '../src/extraction/schema.js';

function makeBaseInvoice(overrides?: Partial<CanonicalInvoice>): CanonicalInvoice {
  return {
    provider_name: 'Hidroelectrica',
    provider_cui: 'RO13267213',
    category: 'ELECTRICITY',
    client_code: '80045192',
    consumption_point_id: 'RO001E123456789',
    invoice_series: 'HID',
    invoice_number: '20260100451',
    issue_date: '2026-02-05',
    due_date: '2026-02-25',
    billing_period_start: '2026-01-01',
    billing_period_end: '2026-01-31',
    total_amount: 189.4,
    currency: 'RON',
    meter_reading: {
      reading_type: 'SELF_READ',
      old_index: 14030,
      new_index: 14250,
      consumption_value: 220,
      consumption_unit: 'kWh',
      self_reading_window_start: 24,
      self_reading_window_end: 28,
    },
    line_items: [
      {
        line_type: 'ACTIVE_ENERGY',
        raw_label: 'Energie activă',
        quantity: 220,
        unit: 'kWh',
        unit_price_net: 0.28382,
        vat_rate_pct: 19,
        line_total_gross: 74.3,
      },
      {
        line_type: 'DISTRIBUTION_TAX',
        raw_label: 'Tarif distribuție',
        quantity: 220,
        unit: 'kWh',
        unit_price_net: 0.439649,
        vat_rate_pct: 19,
        line_total_gross: 115.1,
      },
    ],
    ...overrides,
  };
}

describe('math.validator', () => {
  it('converts decimals to exact integer bani/cents using ROUND_HALF_UP without float drift', () => {
    expect(toBaniCents(245.8)).toBe(24580n);
    expect(toBaniCents(0.1 + 0.2)).toBe(30n);
    expect(toBaniCents('19.995')).toBe(2000n);
    expect(toBaniCents(-85.4)).toBe(-8540n);
  });

  it('computes inclusive billing_days and defaults to 30 when period is missing', () => {
    expect(computeBillingDays('2026-01-01', '2026-01-31')).toBe(31);
    expect(computeBillingDays('2026-02-01', '2026-02-28')).toBe(28);
    expect(computeBillingDays(null, null)).toBe(30);
  });

  it('marks extraction_confidence HIGH when line sum matches within 0.05 RON tolerance', () => {
    const validated = validateAndNormalizeInvoice({
      extracted: makeBaseInvoice({ total_amount: 189.44 }), // 0.04 RON diff <= 0.05 RON
      fileSha256: 'a'.repeat(64),
      sourceFormat: 'PDF',
    });

    expect(validated.extractionConfidence).toBe('HIGH');
    expect(validated.validationFlags).toHaveLength(0);
    expect(validated.totalAmountCents).toBe(18944n);
    expect(validated.billingDays).toBe(31);
  });

  it('flags MATH_MISMATCH_LOW_CONFIDENCE when line sum differs by > 0.05 RON', () => {
    const validated = validateAndNormalizeInvoice({
      extracted: makeBaseInvoice({ total_amount: 195.0 }), // 5.60 RON diff
      fileSha256: 'b'.repeat(64),
      sourceFormat: 'PDF',
    });

    expect(validated.extractionConfidence).toBe('LOW');
    const flag = validated.validationFlags.find((f) => f.code === 'MATH_MISMATCH_LOW_CONFIDENCE');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('WARNING');
  });

  it('tags negative non-DISCOUNT lines as isStorno=true while keeping DISCOUNT lines isStorno=false', () => {
    const validated = validateAndNormalizeInvoice({
      extracted: makeBaseInvoice({
        total_amount: 30.0,
        line_items: [
          {
            line_type: 'GAS_ENERGY',
            raw_label: 'Storno consum estimat',
            quantity: -100,
            unit: 'kWh',
            unit_price_net: 0.25,
            vat_rate_pct: 19,
            line_total_gross: -29.75,
          },
          {
            line_type: 'GAS_ENERGY',
            raw_label: 'Consum real',
            quantity: 234.4538,
            unit: 'kWh',
            unit_price_net: 0.25,
            vat_rate_pct: 19,
            line_total_gross: 69.75,
          },
          {
            line_type: 'DISCOUNT',
            raw_label: 'Reducere promo',
            quantity: 1,
            unit: 'luna',
            unit_price_net: -8.403361,
            vat_rate_pct: 19,
            line_total_gross: -10.0,
          },
        ],
      }),
      fileSha256: 'c'.repeat(64),
      sourceFormat: 'PDF',
    });

    expect(validated.lineItems[0]?.isStorno).toBe(true);
    expect(validated.lineItems[1]?.isStorno).toBe(false);
    expect(validated.lineItems[2]?.isStorno).toBe(false);
    expect(validated.extractionConfidence).toBe('HIGH');
  });

  it('detects negative creditor balance and sets NO_PAYMENT_NEEDED + CREDITOR_BALANCE INFO flag', () => {
    const validated = validateAndNormalizeInvoice({
      extracted: makeBaseInvoice({
        total_amount: -85.4,
        line_items: [
          {
            line_type: 'GAS_ENERGY',
            raw_label: 'Storno estimare',
            quantity: -400,
            unit: 'kWh',
            unit_price_net: 0.260504,
            vat_rate_pct: 19,
            line_total_gross: -124.0,
          },
          {
            line_type: 'GAS_ENERGY',
            raw_label: 'Consum real',
            quantity: 124.5161,
            unit: 'kWh',
            unit_price_net: 0.260504,
            vat_rate_pct: 19,
            line_total_gross: 38.6,
          },
        ],
      }),
      fileSha256: 'd'.repeat(64),
      sourceFormat: 'PDF',
    });

    expect(validated.totalAmountCents).toBe(-8540n);
    expect(validated.paymentStatus).toBe('NO_PAYMENT_NEEDED');
    const flag = validated.validationFlags.find((f) => f.code === 'CREDITOR_BALANCE');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('INFO');
    expect(flag?.message).toContain('85,40 RON');
  });
});
