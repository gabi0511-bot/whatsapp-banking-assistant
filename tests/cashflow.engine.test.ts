import { describe, expect, it } from 'vitest';
import { CashflowEngine } from '../src/cashflow/cashflow.engine.js';
import { DemoBalanceService } from '../src/cashflow/demo-balance.service.js';
import { InMemoryDemoBalanceRepository } from '../src/db/repositories/demo-balance.repo.js';
import { InMemoryInvoiceRepository } from '../src/db/repositories/invoice.repo.js';
import { InMemorySubscriptionRepository } from '../src/db/repositories/subscription.repo.js';
import { InMemoryWhatsappPaymentRepository } from '../src/db/repositories/whatsapp-payment.repo.js';
import { validateAndNormalizeInvoice } from '../src/extraction/math.validator.js';
import type { CanonicalInvoice } from '../src/extraction/schema.js';

describe('CashflowEngine (Safe-to-Spend with Active Subscriptions & Deduplication)', () => {
  it('deducts upcoming 30-day invoices, WhatsApp payments, and active subscriptions without double-counting duplicates', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const demoBalanceService = new DemoBalanceService(new InMemoryDemoBalanceRepository());
    const invoiceRepo = new InMemoryInvoiceRepository();
    const waRepo = new InMemoryWhatsappPaymentRepository();
    const subRepo = new InMemorySubscriptionRepository();

    await demoBalanceService.setBalance(ownerJid, 240_000n, 'RON'); // 2400.00 RON

    const invCanonical: CanonicalInvoice = {
      provider_name: 'Hidroelectrica',
      provider_cui: 'RO13267213',
      category: 'ELECTRICITY',
      client_code: '80045192',
      consumption_point_id: 'POD-1',
      invoice_series: 'HID',
      invoice_number: '100',
      issue_date: '2026-11-15',
      due_date: '2026-12-05',
      billing_period_start: '2026-10-01',
      billing_period_end: '2026-10-31',
      total_amount: 200.0,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 100,
        new_index: 200,
        consumption_value: 100,
        consumption_unit: 'kWh',
        self_reading_window_start: 24,
        self_reading_window_end: 28,
      },
      line_items: [
        {
          line_type: 'ACTIVE_ENERGY',
          raw_label: 'Energie',
          quantity: 100,
          unit: 'kWh',
          unit_price_net: 1.680672,
          vat_rate_pct: 19,
          line_total_gross: 200.0,
        },
      ],
    };

    await invoiceRepo.insertInvoiceWithLines({
      validated: validateAndNormalizeInvoice({
        extracted: invCanonical,
        fileSha256: 'a'.repeat(64),
        sourceFormat: 'PDF',
      }),
      effectiveReadingType: 'SELF_READ',
      paymentStatus: 'UNPAID',
      auditFlags: [],
    });

    // Manual WhatsApp payment for Netflix (59 RON) -> should deduplicate against tracked_subscriptions Netflix!
    await waRepo.create({
      ownerJid,
      title: 'Netflix',
      payeeName: 'Netflix',
      category: 'SUBSCRIPTION',
      amountCents: 5900n,
      currency: 'RON',
      dueDate: '2026-12-01',
    });

    // Tracked subscription: Netflix (duplicate of WA payment above -> MUST NOT double count!)
    await subRepo.upsert({
      ownerJid,
      merchantName: 'Netflix',
      normalizedMerchant: 'netflix',
      category: 'STREAMING',
      billingCycleDays: 30,
      billingPeriod: 'MONTHLY',
      currentAmountCents: 5900n,
      previousAmountCents: null,
      currency: 'RON',
      annualizedCostCents: 5900n * 12n,
      status: 'ACTIVE',
      zombieReason: null,
      chargeCount: 2,
      priceHikeCount: 0,
      lastChargedDate: '2026-11-01',
      nextExpectedChargeDate: '2026-12-01',
      source: 'DEMO_FEED',
    });

    // Tracked subscription: Spotify (29 RON, due within 30d -> MUST count!)
    await subRepo.upsert({
      ownerJid,
      merchantName: 'Spotify',
      normalizedMerchant: 'spotify',
      category: 'MUSIC',
      billingCycleDays: 30,
      billingPeriod: 'MONTHLY',
      currentAmountCents: 2900n,
      previousAmountCents: null,
      currency: 'RON',
      annualizedCostCents: 2900n * 12n,
      status: 'ACTIVE',
      zombieReason: null,
      chargeCount: 3,
      priceHikeCount: 0,
      lastChargedDate: '2026-11-05',
      nextExpectedChargeDate: '2026-12-05',
      source: 'DEMO_FEED',
    });

    const engine = new CashflowEngine({
      demoBalanceService,
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      subscriptionRepo: subRepo,
    });

    const report = await engine.computeSafeToSpend(
      ownerJid,
      new Date('2026-11-22T10:00:00Z'),
      30,
    );

    expect(report.currentBalanceCents).toBe(240_000n);
    expect(report.totalUpcomingInvoicesCents).toBe(20_000n); // 200 RON
    expect(report.totalUpcomingWhatsappPaymentsCents).toBe(5900n); // 59 RON
    expect(report.totalUpcomingSubscriptionsCents).toBe(2900n); // ONLY Spotify (Netflix deduplicated!)
    expect(report.totalObligations30dCents).toBe(28_800n); // 288.00 RON
    expect(report.safeToSpendCents).toBe(211_200n); // 2112.00 RON
  });
});
