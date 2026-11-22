import { describe, expect, it } from 'vitest';
import {
  computeSelfReadingTriggerAt,
  evaluateReadingRule,
  getBucharestDateParts,
} from '../src/audit/rules/reading.rule.js';
import type { ProviderConfig, StoredInvoice, ValidatedInvoice } from '../src/audit/types.js';
import { validateAndNormalizeInvoice } from '../src/extraction/math.validator.js';
import type { CanonicalInvoice } from '../src/extraction/schema.js';

const hidroProvider: ProviderConfig = {
  id: 1,
  providerCui: 'RO13267213',
  providerName: 'Hidroelectrica',
  category: 'ELECTRICITY',
  disputeEmail: 'clienti@hidroelectrica.ro',
  selfReadingWindowStart: 24,
  selfReadingWindowEnd: 28,
  contractualUnitPriceNet: null,
  unitPriceAlertThresholdPct: '2.00',
};

function buildValidated(overrides?: Partial<CanonicalInvoice>): ValidatedInvoice {
  const base: CanonicalInvoice = {
    provider_name: 'Hidroelectrica',
    provider_cui: 'RO13267213',
    category: 'ELECTRICITY',
    client_code: '80045192',
    consumption_point_id: 'RO001E123456789',
    invoice_series: 'HID',
    invoice_number: '20260301199',
    issue_date: '2026-04-05',
    due_date: '2026-04-25',
    billing_period_start: '2026-03-01',
    billing_period_end: '2026-03-31',
    total_amount: 189.4,
    currency: 'RON',
    meter_reading: {
      reading_type: 'SELF_READ',
      old_index: 14250,
      new_index: 14470,
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
        raw_label: 'Distribuție',
        quantity: 220,
        unit: 'kWh',
        unit_price_net: 0.439649,
        vat_rate_pct: 19,
        line_total_gross: 115.1,
      },
    ],
    ...overrides,
  };
  return validateAndNormalizeInvoice({
    extracted: base,
    fileSha256: '1'.repeat(64),
    sourceFormat: 'PDF',
  });
}

function asStored(v: ValidatedInvoice, id = 1): StoredInvoice {
  return {
    ...v,
    id,
    auditFlags: [],
    lineItems: v.lineItems.map((l, idx) => ({ ...l, id: idx + 1, invoiceId: id })),
    createdAt: new Date('2026-02-05T10:00:00Z'),
  };
}

describe('reading.rule (Pillar 1)', () => {
  it('overrides LLM SELF_READ via diacritic-insensitive Romanian raw-text keyword and schedules reminder', () => {
    const invoice = buildValidated(); // LLM mistakenly said SELF_READ
    const result = evaluateReadingRule({
      invoice,
      rawText: 'Factură emisă pe baza de convenție de consum — citire estimată.',
      previousInvoice: null,
      providerConfig: hidroProvider,
      now: new Date('2026-04-10T10:00:00Z'),
    });

    expect(result.effectiveReadingType).toBe('ESTIMATED');
    const flag = result.flags.find((f) => f.code === 'ESTIMATED_READING');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('WARNING');
    expect(flag?.message).toContain('24.04.2026');
    expect(result.scheduledReminder).not.toBeNull();
    expect(result.scheduledReminder?.payload.window_start).toBe(24);
    expect(result.scheduledReminder?.payload.window_end).toBe(28);
  });

  it('detects INDEX_OVERLAP_ANOMALY (CRITICAL) with exact double-billed units', () => {
    const prev = asStored(
      buildValidated({
        invoice_number: '20260100451',
        meter_reading: {
          reading_type: 'SELF_READ',
          old_index: 14030,
          new_index: 14250,
          consumption_value: 220,
          consumption_unit: 'kWh',
          self_reading_window_start: 24,
          self_reading_window_end: 28,
        },
      }),
    );

    const curr = buildValidated({
      invoice_number: '20260301199',
      meter_reading: {
        reading_type: 'ESTIMATED',
        old_index: 14000,
        new_index: 14500,
        consumption_value: 500,
        consumption_unit: 'kWh',
        self_reading_window_start: 24,
        self_reading_window_end: 28,
      },
    });

    const result = evaluateReadingRule({
      invoice: curr,
      rawText: 'Consum estimat',
      previousInvoice: prev,
      providerConfig: hidroProvider,
      now: new Date('2026-04-10T10:00:00Z'),
    });

    const overlapFlag = result.flags.find((f) => f.code === 'INDEX_OVERLAP_ANOMALY');
    expect(overlapFlag).toBeDefined();
    expect(overlapFlag?.severity).toBe('CRITICAL');
    expect(overlapFlag?.metadata?.overlap).toBe('250.000');
    expect(overlapFlag?.message).toContain('250');
  });

  it('detects SUSPECTED_REPEATED_ESTIMATE on identical non-zero multiples of 50', () => {
    const prev = asStored(
      buildValidated({
        invoice_number: '202601001',
        meter_reading: {
          reading_type: 'SELF_READ',
          old_index: 1000,
          new_index: 1250,
          consumption_value: 250,
          consumption_unit: 'kWh',
          self_reading_window_start: 24,
          self_reading_window_end: 28,
        },
      }),
    );

    const curr = buildValidated({
      invoice_number: '202602001',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 1250,
        new_index: 1500,
        consumption_value: 250,
        consumption_unit: 'kWh',
        self_reading_window_start: 24,
        self_reading_window_end: 28,
      },
    });

    const result = evaluateReadingRule({
      invoice: curr,
      previousInvoice: prev,
      providerConfig: hidroProvider,
      now: new Date('2026-04-10T10:00:00Z'),
    });

    expect(result.flags.some((f) => f.code === 'SUSPECTED_REPEATED_ESTIMATE')).toBe(true);
    expect(result.scheduledReminder).not.toBeNull();
  });

  it('calculates Europe/Bucharest reminder trigger dates accurately across before/inside/after/February edge cases', () => {
    // Before window: Apr 10 -> Apr 24 at 09:00 Europe/Bucharest (EEST UTC+3 -> 06:00Z)
    const before = computeSelfReadingTriggerAt(24, 28, new Date('2026-04-10T08:00:00Z'));
    const beforeParts = getBucharestDateParts(before);
    expect(beforeParts).toMatchObject({ year: 2026, month: 4, day: 24, hour: 9, minute: 0 });

    // Inside window: Apr 26 -> now + 1 minute
    const insideNow = new Date('2026-04-26T12:00:00Z');
    const inside = computeSelfReadingTriggerAt(24, 28, insideNow);
    expect(inside.getTime() - insideNow.getTime()).toBe(60_000);

    // After window: Apr 29 -> May 24 at 09:00 Europe/Bucharest
    const after = computeSelfReadingTriggerAt(24, 28, new Date('2026-04-29T10:00:00Z'));
    const afterParts = getBucharestDateParts(after);
    expect(afterParts).toMatchObject({ year: 2026, month: 5, day: 24, hour: 9, minute: 0 });

    // Short month clamping: window 29-31 in non-leap February 2026 -> Feb 28 at 09:00 Bucharest
    const feb = computeSelfReadingTriggerAt(29, 31, new Date('2026-02-10T10:00:00Z'));
    const febParts = getBucharestDateParts(feb);
    expect(febParts).toMatchObject({ year: 2026, month: 2, day: 28, hour: 9, minute: 0 });

    // Leap year February 2028: window 29-31 -> Feb 29 at 09:00 Bucharest
    const leapFeb = computeSelfReadingTriggerAt(29, 31, new Date('2028-02-10T10:00:00Z'));
    const leapFebParts = getBucharestDateParts(leapFeb);
    expect(leapFebParts).toMatchObject({ year: 2028, month: 2, day: 29, hour: 9, minute: 0 });
  });
});
