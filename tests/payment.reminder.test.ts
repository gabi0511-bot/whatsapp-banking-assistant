import { describe, expect, it } from 'vitest';
import { InMemoryInvoiceRepository } from '../src/db/repositories/invoice.repo.js';
import { InMemoryMemoryRepository } from '../src/db/repositories/memory.repo.js';
import { InMemoryPaymentLinkRepository } from '../src/db/repositories/payment-link.repo.js';
import { InMemoryWhatsappPaymentRepository } from '../src/db/repositories/whatsapp-payment.repo.js';
import { validateAndNormalizeInvoice } from '../src/extraction/math.validator.js';
import type { CanonicalInvoice } from '../src/extraction/schema.js';
import type { MessagingAdapter } from '../src/messaging/adapter.interface.js';
import { PaymentReminderService } from '../src/payments/payment.reminder.service.js';
import { QrTrackingService } from '../src/payments/qr.tracking.service.js';
import { FinancialMemoryService } from '../src/twin/memory.service.js';

class SpyMessaging implements MessagingAdapter {
  public readonly sent: Array<{ toJid: string; text: string }> = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onMessage(): void {}
  async sendText(toJid: string, text: string): Promise<void> {
    this.sent.push({ toJid, text });
  }
}

function makeCanonical(invoiceNumber: string, dueDate: string): CanonicalInvoice {
  return {
    provider_name: 'Digi Romania',
    provider_cui: 'RO5888716',
    category: 'TELECOM',
    client_code: '44109822',
    consumption_point_id: 'DIGI-44109822',
    invoice_series: 'DIGI',
    invoice_number: invoiceNumber,
    issue_date: '2026-04-01',
    due_date: dueDate,
    billing_period_start: '2026-03-01',
    billing_period_end: '2026-03-31',
    total_amount: 50.0,
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
        raw_label: 'Abonament Fiberlink 1000',
        quantity: 1,
        unit: 'luna',
        unit_price_net: 42.016807,
        vat_rate_pct: 19,
        line_total_gross: 50.0,
      },
    ],
  };
}

function setup() {
  const ownerJid = '40712345678@s.whatsapp.net';
  const invoiceRepo = new InMemoryInvoiceRepository();
  const waRepo = new InMemoryWhatsappPaymentRepository();
  const linkRepo = new InMemoryPaymentLinkRepository();
  const memoryRepo = new InMemoryMemoryRepository();
  const memoryService = new FinancialMemoryService(memoryRepo);
  const messaging = new SpyMessaging();

  const qrService = new QrTrackingService({
    publicBaseUrl: 'https://pay.example.ro',
    paymentLinkRepo: linkRepo,
    invoiceRepo,
    whatsappPaymentRepo: waRepo,
    memoryService,
    messaging,
  });

  const reminderService = new PaymentReminderService({
    publicBaseUrl: 'https://pay.example.ro',
    paymentLinkRepo: linkRepo,
    invoiceRepo,
    whatsappPaymentRepo: waRepo,
    memoryService,
    messaging,
    unaccessedReminderHours: 24,
    abandonedReminderMinutes: 120,
  });

  return { ownerJid, invoiceRepo, waRepo, linkRepo, memoryRepo, qrService, reminderService, messaging };
}

describe('PaymentReminderService (Unaccessed / Abandoned / Overdue + Safety)', () => {
  it('fires REMINDER_QR_UNACCESSED after 24h and enforces 24h anti-spam cooldown', async () => {
    const { ownerJid, invoiceRepo, linkRepo, qrService, reminderService, messaging } = setup();
    const validated = validateAndNormalizeInvoice({
      extracted: makeCanonical('DIGI-1', '2026-04-20'),
      fileSha256: '1'.repeat(64),
      sourceFormat: 'PDF',
    });
    const inv = await invoiceRepo.insertInvoiceWithLines({
      validated,
      effectiveReadingType: 'N_A',
      paymentStatus: 'UNPAID',
      auditFlags: [],
    });

    const createdAt = new Date('2026-04-05T08:00:00Z');
    const gen = await qrService.createForInvoice(inv, ownerJid, { createdAt });

    // 10 hours later -> too early
    const early = await reminderService.evaluateAndDispatch(new Date('2026-04-05T18:00:00Z'));
    expect(early).toHaveLength(0);

    // 25 hours later -> fires REMINDER_QR_UNACCESSED
    const first = await reminderService.evaluateAndDispatch(new Date('2026-04-06T09:00:00Z'));
    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe('REMINDER_QR_UNACCESSED');
    expect(messaging.sent[0]?.text).toContain('Nu ai accesat încă codul QR');

    // 5 hours after first reminder -> blocked by 24h anti-spam cooldown
    const cooldown = await reminderService.evaluateAndDispatch(new Date('2026-04-06T14:00:00Z'));
    expect(cooldown).toHaveLength(0);

    const updatedLink = await linkRepo.findById(gen.link.id);
    expect(updatedLink?.unaccessedReminderCount).toBe(1);
  });

  it('fires REMINDER_QR_ABANDONED when QR was accessed but payment was not completed after 120 minutes', async () => {
    const { ownerJid, invoiceRepo, qrService, reminderService, messaging } = setup();
    const validated = validateAndNormalizeInvoice({
      extracted: makeCanonical('DIGI-2', '2026-04-20'),
      fileSha256: '2'.repeat(64),
      sourceFormat: 'PDF',
    });
    const inv = await invoiceRepo.insertInvoiceWithLines({
      validated,
      effectiveReadingType: 'N_A',
      paymentStatus: 'UNPAID',
      auditFlags: [],
    });

    const gen = await qrService.createForInvoice(inv, ownerJid, {
      createdAt: new Date('2026-04-05T08:00:00Z'),
    });

    await qrService.recordHumanQrAccess(
      gen.link.token,
      'Mozilla/5.0 (iPhone)',
      new Date('2026-04-05T10:00:00Z'),
    );

    // 60 minutes later -> not yet abandoned
    expect(
      await reminderService.evaluateAndDispatch(new Date('2026-04-05T11:00:00Z')),
    ).toHaveLength(0);

    // 130 minutes later -> fires REMINDER_QR_ABANDONED
    const sent = await reminderService.evaluateAndDispatch(new Date('2026-04-05T12:10:00Z'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('REMINDER_QR_ABANDONED');
    expect(messaging.sent[0]?.text).toContain('Reminder plată nefinalizată');
  });

  it('fires REMINDER_OVERDUE after due_date passes while unpaid and stops all reminders once COMPLETED', async () => {
    const { ownerJid, invoiceRepo, qrService, reminderService, messaging } = setup();
    const validated = validateAndNormalizeInvoice({
      extracted: makeCanonical('DIGI-3', '2026-04-10'),
      fileSha256: '3'.repeat(64),
      sourceFormat: 'PDF',
    });
    const inv = await invoiceRepo.insertInvoiceWithLines({
      validated,
      effectiveReadingType: 'N_A',
      paymentStatus: 'UNPAID',
      auditFlags: [],
    });

    const gen = await qrService.createForInvoice(inv, ownerJid, {
      createdAt: new Date('2026-04-05T08:00:00Z'),
    });

    // Past due_date (2026-04-12 in Bucharest)
    const overdue = await reminderService.evaluateAndDispatch(new Date('2026-04-12T09:00:00Z'));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.type).toBe('REMINDER_OVERDUE');
    expect(messaging.sent[0]?.text).toContain('Plată restantă');

    // Mark completed -> ZERO reminders should ever fire afterward
    await qrService.confirmPaymentByToken(gen.link.token, 'WEB_CONFIRM', {
      completedAt: new Date('2026-04-12T10:00:00Z'),
      notifyWhatsApp: false,
    });

    const afterCompletion = await reminderService.evaluateAndDispatch(
      new Date('2026-04-20T09:00:00Z'),
    );
    expect(afterCompletion).toHaveLength(0);
  });

  it('NEVER sends payment reminders for invoices on HOLD_BEFORE_PAYMENT (critical Invoice X-Ray anomaly)', async () => {
    const { ownerJid, invoiceRepo, qrService, reminderService } = setup();
    const validated = validateAndNormalizeInvoice({
      extracted: makeCanonical('DIGI-HOLD', '2026-04-10'),
      fileSha256: '4'.repeat(64),
      sourceFormat: 'PDF',
    });
    const heldInv = await invoiceRepo.insertInvoiceWithLines({
      validated,
      effectiveReadingType: 'N_A',
      paymentStatus: 'HOLD_BEFORE_PAYMENT',
      auditFlags: [],
    });

    await qrService.createForInvoice(heldInv, ownerJid, {
      createdAt: new Date('2026-04-01T08:00:00Z'),
    });

    // Even when well past due date, ZERO reminders may be dispatched for a held anomalous invoice
    const sent = await reminderService.evaluateAndDispatch(new Date('2026-04-20T09:00:00Z'));
    expect(sent).toHaveLength(0);
  });
});
