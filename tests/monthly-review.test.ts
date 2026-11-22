import { describe, expect, it } from 'vitest';
import { DemoBalanceService } from '../src/cashflow/demo-balance.service.js';
import { InMemoryDemoBalanceRepository } from '../src/db/repositories/demo-balance.repo.js';
import { InMemoryInvoiceRepository } from '../src/db/repositories/invoice.repo.js';
import { InMemoryMonthlyReviewRepository } from '../src/db/repositories/monthly-review.repo.js';
import { InMemoryWhatsappPaymentRepository } from '../src/db/repositories/whatsapp-payment.repo.js';
import { validateAndNormalizeInvoice } from '../src/extraction/math.validator.js';
import type { CanonicalInvoice } from '../src/extraction/schema.js';
import type { MessagingAdapter } from '../src/messaging/adapter.interface.js';
import {
  MonthlyReviewService,
  getPreviousYearMonth,
  isLastDayOfMonthBucharest,
} from '../src/review/monthly-review.service.js';

class SpyMessaging implements MessagingAdapter {
  public readonly sent: Array<{ toJid: string; text: string }> = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onMessage(): void {}
  async sendText(toJid: string, text: string): Promise<void> {
    this.sent.push({ toJid, text });
  }
}

function makeInvoice(params: {
  provider: string;
  number: string;
  issueDate: string;
  dueDate: string;
  totalAmount: number;
  withPenalty?: boolean;
}): CanonicalInvoice {
  return {
    provider_name: params.provider,
    provider_cui: 'RO13267213',
    category: 'ELECTRICITY',
    client_code: '80045192',
    consumption_point_id: 'POD-1',
    invoice_series: 'HID',
    invoice_number: params.number,
    issue_date: params.issueDate,
    due_date: params.dueDate,
    billing_period_start: params.issueDate,
    billing_period_end: params.dueDate,
    total_amount: params.totalAmount,
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
        raw_label: 'Energie activă',
        quantity: 100,
        unit: 'kWh',
        unit_price_net: 1.0,
        vat_rate_pct: 19,
        line_total_gross: params.withPenalty ? params.totalAmount - 15 : params.totalAmount,
      },
      ...(params.withPenalty
        ? [
            {
              line_type: 'PENALTY' as const,
              raw_label: 'Penalități întârziere',
              quantity: 1,
              unit: 'buc',
              unit_price_net: 15,
              vat_rate_pct: 0,
              line_total_gross: 15,
            },
          ]
        : []),
    ],
  };
}

describe('MonthlyReviewService (End-of-Month Rating, Comparison & Savings Recommendation)', () => {
  it('handles previous-month rollover and Europe/Bucharest last-day-of-month detection accurately', () => {
    expect(getPreviousYearMonth('2027-01')).toBe('2026-12');
    expect(getPreviousYearMonth('2026-11')).toBe('2026-10');

    expect(isLastDayOfMonthBucharest(new Date('2026-02-28T18:00:00Z'))).toBe(true);
    expect(isLastDayOfMonthBucharest(new Date('2028-02-28T18:00:00Z'))).toBe(false);
    expect(isLastDayOfMonthBucharest(new Date('2028-02-29T18:00:00Z'))).toBe(true);
    expect(isLastDayOfMonthBucharest(new Date('2026-11-30T18:00:00Z'))).toBe(true);
    expect(isLastDayOfMonthBucharest(new Date('2026-11-29T18:00:00Z'))).toBe(false);
  });

  it('compares current vs previous month, rates efficiency, recommends saving/investing exact difference, and sends once on last day of month', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const invoiceRepo = new InMemoryInvoiceRepository();
    const waRepo = new InMemoryWhatsappPaymentRepository();
    const demoBalanceService = new DemoBalanceService(new InMemoryDemoBalanceRepository());
    const monthlyReviewRepo = new InMemoryMonthlyReviewRepository();
    const messaging = new SpyMessaging();

    await demoBalanceService.setBalance(ownerJid, 240_000n, 'RON'); // 2400.00 RON

    // Previous month (2026-10): 600 RON paid late WITH penalty -> lower efficiency rating
    await invoiceRepo.insertInvoiceWithLines({
      validated: validateAndNormalizeInvoice({
        extracted: makeInvoice({
          provider: 'ENGIE Romania',
          number: 'OCT-1',
          issueDate: '2026-10-05',
          dueDate: '2026-10-20',
          totalAmount: 600,
          withPenalty: true,
        }),
        fileSha256: '1'.repeat(64),
        sourceFormat: 'PDF',
      }),
      effectiveReadingType: 'SELF_READ',
      paymentStatus: 'PAID_LATE',
      auditFlags: [
        {
          code: 'LATE_FEE_DETECTED',
          severity: 'WARNING',
          pillar: 'PRICING',
          message: 'Penalitate 15 RON',
        },
      ],
    });

    // Current month (2026-11): 414.50 RON paid ON TIME with ZERO penalties -> 100/100 A+ and 185.50 RON saved!
    await invoiceRepo.insertInvoiceWithLines({
      validated: validateAndNormalizeInvoice({
        extracted: makeInvoice({
          provider: 'Hidroelectrica',
          number: 'NOV-1',
          issueDate: '2026-11-05',
          dueDate: '2026-11-25',
          totalAmount: 414.5,
        }),
        fileSha256: '2'.repeat(64),
        sourceFormat: 'PDF',
      }),
      effectiveReadingType: 'SELF_READ',
      paymentStatus: 'PAID_ON_TIME',
      auditFlags: [],
    });

    const service = new MonthlyReviewService({
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      demoBalanceService,
      monthlyReviewRepo,
      messaging,
    });

    const report = await service.buildComparisonReport(
      ownerJid,
      '2026-11',
      new Date('2026-11-30T18:00:00Z'),
    );

    expect(report.currentMonth.totalPaidCents).toBe(41_450n);
    expect(report.previousMonth.totalPaidCents).toBe(60_000n);
    expect(report.currentMonth.efficiencyScore).toBe(100);
    expect(report.currentMonth.grade).toContain('A+');
    expect(report.previousMonth.efficiencyScore).toBe(75);
    expect(report.betterMonth).toBe('CURRENT');
    expect(report.recommendSavingsOrInvestment).toBe(true);
    expect(report.savedVsPreviousMonthCents).toBe(18_550n); // 185.50 RON saved!

    // Non-last day (Nov 29) -> does NOT auto-dispatch
    const notYet = await service.dispatchEndOfMonthReviewIfDue(
      ownerJid,
      new Date('2026-11-29T18:00:00Z'),
    );
    expect(notYet.sent).toBe(false);
    expect(messaging.sent).toHaveLength(0);

    // Last day of month (Nov 30 20:00 Bucharest = 18:00Z) -> dispatches custom review!
    const sent1 = await service.dispatchEndOfMonthReviewIfDue(
      ownerJid,
      new Date('2026-11-30T18:00:00Z'),
    );
    expect(sent1.sent).toBe(true);
    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.text).toContain('185,50 RON');
    expect(messaging.sent[0]?.text).toContain('economii');
    expect(messaging.sent[0]?.text).toContain('100/100');
    expect(messaging.sent[0]?.text).toContain('2400,00 RON');

    // Second cron tick same day -> idempotent, ZERO duplicate send
    const sent2 = await service.dispatchEndOfMonthReviewIfDue(
      ownerJid,
      new Date('2026-11-30T18:30:00Z'),
    );
    expect(sent2.sent).toBe(false);
    expect(messaging.sent).toHaveLength(1);
  });
});
