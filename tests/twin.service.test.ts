import { describe, expect, it } from 'vitest';
import { InMemoryInvoiceRepository } from '../src/db/repositories/invoice.repo.js';
import { InMemoryMemoryRepository } from '../src/db/repositories/memory.repo.js';
import { InMemoryPaymentLinkRepository } from '../src/db/repositories/payment-link.repo.js';
import { InMemoryTwinChatRepository } from '../src/db/repositories/twin-chat.repo.js';
import { InMemoryWhatsappPaymentRepository } from '../src/db/repositories/whatsapp-payment.repo.js';
import { validateAndNormalizeInvoice } from '../src/extraction/math.validator.js';
import type { CanonicalInvoice } from '../src/extraction/schema.js';
import type { MessagingAdapter } from '../src/messaging/adapter.interface.js';
import { QrTrackingService } from '../src/payments/qr.tracking.service.js';
import { FinancialToolExecutor } from '../src/twin/financial.tools.js';
import { FinancialGuardrail, RuleBasedIntentGatekeeper } from '../src/twin/guardrail.js';
import { FinancialMemoryService } from '../src/twin/memory.service.js';
import { DeterministicTwinGenerator, TwinService } from '../src/twin/twin.service.js';

class MockMessaging implements MessagingAdapter {
  public readonly sentTexts: string[] = [];
  public readonly sentImages: Array<{ size: number; caption?: string }> = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onMessage(): void {}
  async sendText(_to: string, text: string): Promise<void> {
    this.sentTexts.push(text);
  }
  async sendImage(_to: string, buf: Buffer, caption?: string): Promise<void> {
    this.sentImages.push({ size: buf.length, caption });
  }
}

describe('AI Twin Memory, Combined Totals & Tool Grounding', () => {
  it('computes exact combined unpaid totals across parsed_invoices AND whatsapp_payments, reports QR access status, logs payments, and marks bills paid', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const invoiceRepo = new InMemoryInvoiceRepository();
    const waRepo = new InMemoryWhatsappPaymentRepository();
    const linkRepo = new InMemoryPaymentLinkRepository();
    const memoryRepo = new InMemoryMemoryRepository();
    const twinChatRepo = new InMemoryTwinChatRepository();
    const memoryService = new FinancialMemoryService(memoryRepo);
    const messaging = new MockMessaging();

    const qrService = new QrTrackingService({
      publicBaseUrl: 'http://localhost:3080',
      paymentLinkRepo: linkRepo,
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      memoryService,
      messaging,
    });

    const toolExecutor = new FinancialToolExecutor({
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      paymentLinkRepo: linkRepo,
      memoryService,
      qrTrackingService: qrService,
    });

    const twin = new TwinService({
      guardrail: new FinancialGuardrail(new RuleBasedIntentGatekeeper()),
      generator: new DeterministicTwinGenerator(),
      toolExecutor,
      memoryService,
      twinChatRepo,
      qrTrackingService: qrService,
    });

    // Seed 1 Invoice X-Ray bill: Hidroelectrica 189.40 RON
    const hidCanonical: CanonicalInvoice = {
      provider_name: 'Hidroelectrica',
      provider_cui: 'RO13267213',
      category: 'ELECTRICITY',
      client_code: '80045192',
      consumption_point_id: 'RO001E123456789',
      invoice_series: 'HID',
      invoice_number: '20260401',
      issue_date: '2026-04-05',
      due_date: '2026-04-25',
      billing_period_start: '2026-03-01',
      billing_period_end: '2026-03-31',
      total_amount: 189.4,
      currency: 'RON',
      meter_reading: {
        reading_type: 'SELF_READ',
        old_index: 100,
        new_index: 320,
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
          unit_price_net: 0.723469,
          vat_rate_pct: 19,
          line_total_gross: 189.4,
        },
      ],
    };

    const inv = await invoiceRepo.insertInvoiceWithLines({
      validated: validateAndNormalizeInvoice({
        extracted: hidCanonical,
        fileSha256: 'f'.repeat(64),
        sourceFormat: 'PDF',
      }),
      effectiveReadingType: 'SELF_READ',
      paymentStatus: 'UNPAID',
      auditFlags: [],
    });
    const hidQr = await qrService.createForInvoice(inv, ownerJid);

    // 1. User logs a WhatsApp payment via AI Twin chat (Chirie 2000 RON -> auto-generates QR)
    const logRes = await twin.handleMessage(
      ownerJid,
      'Ține minte că trebuie să plătesc chiria 2000 RON până pe 25',
      new Date('2026-04-10T10:00:00Z'),
    );
    expect(logRes.wasBlocked).toBe(false);
    expect(logRes.toolCallsUsed).toContain('log_whatsapp_payment');
    expect(logRes.sentQrCount).toBe(1);
    expect(messaging.sentImages).toHaveLength(1);

    // 2. Ask combined financial status: 189.40 + 2000.00 = 2189.40 RON
    const statusRes = await twin.handleMessage(
      ownerJid,
      'Care este situația mea financiară acum?',
      new Date('2026-04-10T10:05:00Z'),
    );
    expect(statusRes.wasBlocked).toBe(false);
    expect(statusRes.reply).toContain('2189,40 RON');
    expect(statusRes.reply).toContain('Hidroelectrica');
    expect(statusRes.reply).toContain('Chirie');

    // 3. Simulate scanning the Hidroelectrica QR code and ask the AI Twin about QR status
    await qrService.recordHumanQrAccess(
      hidQr.link.token,
      'Mozilla/5.0 (iPhone)',
      new Date('2026-04-10T11:30:00Z'),
    );

    const qrRes = await twin.handleMessage(
      ownerJid,
      'Am accesat codul QR pentru Hidroelectrica?',
      new Date('2026-04-10T12:00:00Z'),
    );
    expect(qrRes.wasBlocked).toBe(false);
    expect(qrRes.toolCallsUsed).toContain('get_qr_and_payment_tracking');
    expect(qrRes.reply).toContain('QR_ACCESSED');
    expect(qrRes.reply).toContain('2026-04-10T11:30:00.000Z');

    // 4. Tell AI Twin naturally "Am plătit factura la Hidroelectrica" -> updates invoice + QR + memory
    const paidRes = await twin.handleMessage(
      ownerJid,
      'Am plătit factura la Hidroelectrica acum',
      new Date('2026-04-10T12:15:00Z'),
    );
    expect(paidRes.wasBlocked).toBe(false);
    expect(paidRes.toolCallsUsed).toContain('mark_payment_completed');
    expect((await invoiceRepo.findById(inv.id))?.paymentStatus).toBe('PAID_ON_TIME');
    expect((await linkRepo.findById(hidQr.link.id))?.status).toBe('COMPLETED');
    expect((await linkRepo.findById(hidQr.link.id))?.completedVia).toBe('AI_TWIN_CHAT');

    // 5. Verify updated unpaid total is now strictly 2000.00 RON (only Chirie remains)
    const afterPaidStatus = await twin.handleMessage(
      ownerJid,
      'Cât mai am de plată?',
      new Date('2026-04-10T12:20:00Z'),
    );
    expect(afterPaidStatus.reply).toContain('2000,00 RON');
    expect(afterPaidStatus.reply).toContain('189,40 RON');

    // 6. Verify persistent financial_memory_events recorded the full lifecycle
    const timeline = await memoryRepo.findRecent(ownerJid, { limit: 20 });
    const types = timeline.map((e) => e.eventType);
    expect(types).toContain('WHATSAPP_PAYMENT_LOGGED');
    expect(types).toContain('QR_GENERATED');
    expect(types).toContain('QR_ACCESSED');
    expect(types).toContain('PAYMENT_COMPLETED');
  });

  it('sends tracked payment QR + link when user asks to pay a bill ("plateste factura de la engie") without marking it paid prematurely', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const invoiceRepo = new InMemoryInvoiceRepository();
    const waRepo = new InMemoryWhatsappPaymentRepository();
    const linkRepo = new InMemoryPaymentLinkRepository();
    const memoryRepo = new InMemoryMemoryRepository();
    const twinChatRepo = new InMemoryTwinChatRepository();
    const memoryService = new FinancialMemoryService(memoryRepo);
    const messaging = new MockMessaging();

    const qrService = new QrTrackingService({
      publicBaseUrl: 'http://localhost:3080',
      paymentLinkRepo: linkRepo,
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      memoryService,
      messaging,
    });

    const toolExecutor = new FinancialToolExecutor({
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      paymentLinkRepo: linkRepo,
      memoryService,
      qrTrackingService: qrService,
    });

    const twin = new TwinService({
      guardrail: new FinancialGuardrail(new RuleBasedIntentGatekeeper()),
      generator: new DeterministicTwinGenerator(),
      toolExecutor,
      memoryService,
      twinChatRepo,
      qrTrackingService: qrService,
    });

    const engieCanonical: CanonicalInvoice = {
      provider_name: 'ENGIE Romania S.A.',
      provider_cui: 'RO13093222',
      category: 'GAS',
      client_code: '55012345',
      consumption_point_id: 'RO003G445566',
      invoice_series: 'ENG',
      invoice_number: '2026-778301',
      issue_date: '2026-11-20',
      due_date: '2026-12-19',
      billing_period_start: '2026-10-01',
      billing_period_end: '2026-10-31',
      total_amount: 664.74,
      currency: 'RON',
      meter_reading: {
        reading_type: 'ESTIMATED',
        old_index: 2100,
        new_index: 2300,
        consumption_value: 2000,
        consumption_unit: 'kWh',
        self_reading_window_start: 20,
        self_reading_window_end: 25,
      },
      line_items: [
        {
          line_type: 'GAS_ENERGY',
          raw_label: 'Gaze naturale',
          quantity: 2000,
          unit: 'kWh',
          unit_price_net: 0.279302,
          vat_rate_pct: 19,
          line_total_gross: 664.74,
        },
      ],
    };

    const inv = await invoiceRepo.insertInvoiceWithLines({
      validated: validateAndNormalizeInvoice({
        extracted: engieCanonical,
        fileSha256: 'e'.repeat(64),
        sourceFormat: 'PDF',
      }),
      effectiveReadingType: 'ESTIMATED',
      paymentStatus: 'UNPAID',
      auditFlags: [],
    });

    const payRes = await twin.handleMessage(
      ownerJid,
      'plateste factura de la engie',
      new Date('2026-11-22T01:39:00Z'),
    );

    expect(payRes.wasBlocked).toBe(false);
    expect(payRes.toolCallsUsed).toContain('resend_payment_qr');
    expect(payRes.sentQrCount).toBe(1);
    expect(messaging.sentImages).toHaveLength(1);
    expect(payRes.reply).toContain('ENGIE Romania S.A.');
    expect(payRes.reply).toContain('664,74 RON');
    expect(payRes.reply).toContain('/pay/');
    // Must stay UNPAID until user actually completes the transfer
    expect((await invoiceRepo.findById(inv.id))?.paymentStatus).toBe('UNPAID');
  });
});
