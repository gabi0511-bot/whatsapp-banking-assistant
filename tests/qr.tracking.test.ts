import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryInvoiceRepository } from '../src/db/repositories/invoice.repo.js';
import { InMemoryMemoryRepository } from '../src/db/repositories/memory.repo.js';
import { InMemoryPaymentLinkRepository } from '../src/db/repositories/payment-link.repo.js';
import { InMemoryWhatsappPaymentRepository } from '../src/db/repositories/whatsapp-payment.repo.js';
import { validateAndNormalizeInvoice } from '../src/extraction/math.validator.js';
import type { CanonicalInvoice } from '../src/extraction/schema.js';
import type { MessagingAdapter } from '../src/messaging/adapter.interface.js';
import { QrTrackingService } from '../src/payments/qr.tracking.service.js';
import { PaymentReceiptMatcher } from '../src/payments/receipt.matcher.js';
import {
  isLinkPreviewBot,
  startTrackingServer,
  type RunningTrackingServer,
} from '../src/payments/tracking.server.js';
import { FinancialMemoryService } from '../src/twin/memory.service.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class CaptureMessaging implements MessagingAdapter {
  public readonly texts: Array<{ toJid: string; text: string }> = [];
  public readonly images: Array<{ toJid: string; size: number; caption?: string }> = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onMessage(): void {}
  async sendText(toJid: string, text: string): Promise<void> {
    this.texts.push({ toJid, text });
  }
  async sendImage(toJid: string, buf: Buffer, caption?: string): Promise<void> {
    this.images.push({ toJid, size: buf.length, caption });
  }
}

const sampleInvoice: CanonicalInvoice = {
  provider_name: 'Hidroelectrica',
  provider_cui: 'RO13267213',
  category: 'ELECTRICITY',
  client_code: '80045192',
  consumption_point_id: 'RO001E123456789',
  invoice_series: 'HID',
  invoice_number: '20260400999',
  issue_date: '2026-04-05',
  due_date: '2026-12-25',
  billing_period_start: '2026-03-01',
  billing_period_end: '2026-03-31',
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
      unit_price_net: 0.723469,
      vat_rate_pct: 19,
      line_total_gross: 189.4,
    },
  ],
};

describe('Tracked Payment QR, Scan Detection & Completion Server', () => {
  let runningServer: RunningTrackingServer | null = null;

  afterEach(async () => {
    if (runningServer) {
      await runningServer.close();
      runningServer = null;
    }
  });

  it('generates valid PNG QR encoding /pay/:token, ignores WhatsApp crawler preview, records human scan, and confirms payment idempotently', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const invoiceRepo = new InMemoryInvoiceRepository();
    const waRepo = new InMemoryWhatsappPaymentRepository();
    const linkRepo = new InMemoryPaymentLinkRepository();
    const memoryRepo = new InMemoryMemoryRepository();
    const memoryService = new FinancialMemoryService(memoryRepo);
    const messaging = new CaptureMessaging();

    const validated = validateAndNormalizeInvoice({
      extracted: sampleInvoice,
      fileSha256: 'a'.repeat(64),
      sourceFormat: 'PDF',
    });
    const storedInvoice = await invoiceRepo.insertInvoiceWithLines({
      validated,
      effectiveReadingType: 'SELF_READ',
      paymentStatus: 'UNPAID',
      auditFlags: [],
    });

    // Start on ephemeral port 0 so parallel test runs never collide
    const placeholderQrService = new QrTrackingService({
      publicBaseUrl: 'http://127.0.0.1:0',
      paymentLinkRepo: linkRepo,
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      memoryService,
      messaging,
      ownerRevolutTag: 'ionpopescu',
    });

    runningServer = await startTrackingServer(
      { paymentLinkRepo: linkRepo, qrTrackingService: placeholderQrService },
      0,
      '127.0.0.1',
    );
    const baseUrl = `http://127.0.0.1:${runningServer.port}`;

    const qrService = new QrTrackingService({
      publicBaseUrl: baseUrl,
      paymentLinkRepo: linkRepo,
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      memoryService,
      messaging,
      ownerRevolutTag: 'ionpopescu',
    });

    const generated = await qrService.createForInvoice(storedInvoice, ownerJid);

    // 1. Valid PNG header & tracking URL format
    expect(generated.pngBuffer.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(generated.trackingUrl).toBe(`${baseUrl}/pay/${generated.link.token}`);
    expect(generated.link.status).toBe('CREATED');
    expect(generated.link.redirectUrl).toContain('revolut.me/ionpopescu/189.40/ron');

    // 2. Link-preview crawler detection (WhatsApp / Facebook preview bots must NOT count as scan)
    expect(isLinkPreviewBot('WhatsApp/2.24.10 A')).toBe(true);
    expect(isLinkPreviewBot('facebookexternalhit/1.1')).toBe(true);
    expect(isLinkPreviewBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)')).toBe(false);

    const botResp = await fetch(generated.trackingUrl, {
      headers: { 'User-Agent': 'WhatsApp/2.24.10 A' },
    });
    expect(botResp.status).toBe(200);
    const afterBot = await linkRepo.findByToken(generated.link.token);
    expect(afterBot?.status).toBe('CREATED');
    expect(afterBot?.accessCount).toBe(0);
    expect(afterBot?.firstAccessedAt).toBeNull();

    // 3. Real mobile phone scan updates status -> QR_ACCESSED and logs events + memory
    const humanResp = await fetch(generated.trackingUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148 Safari/604.1',
      },
    });
    expect(humanResp.status).toBe(200);
    const html = await humanResp.text();
    expect(html).toContain('Hidroelectrica');
    expect(html).toContain('189,40 RON');
    expect(html).toContain('Confirmă că am finalizat plata');

    const afterHuman = await linkRepo.findByToken(generated.link.token);
    expect(afterHuman?.status).toBe('QR_ACCESSED');
    expect(afterHuman?.accessCount).toBe(1);
    expect(afterHuman?.firstAccessedAt).not.toBeNull();

    const eventsAfterScan = await linkRepo.listEvents(generated.link.id);
    expect(eventsAfterScan.some((e) => e.eventType === 'QR_ACCESSED')).toBe(true);
    const memoryEvents = await memoryRepo.findRecent(ownerJid, { limit: 10 });
    expect(memoryEvents.some((e) => e.eventType === 'QR_ACCESSED')).toBe(true);

    // 4. POST /pay/:token/confirm completes link + invoice + sends WhatsApp confirmation
    const confirmResp1 = await fetch(`${generated.trackingUrl}/confirm`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    expect(confirmResp1.status).toBe(200);
    const confirmBody1 = (await confirmResp1.json()) as {
      ok: boolean;
      alreadyCompleted: boolean;
      status: string;
    };
    expect(confirmBody1).toMatchObject({
      ok: true,
      alreadyCompleted: false,
      status: 'COMPLETED',
    });

    const updatedInv = await invoiceRepo.findById(storedInvoice.id);
    expect(updatedInv?.paymentStatus).toBe('PAID_ON_TIME');
    expect(messaging.texts).toHaveLength(1);
    expect(messaging.texts[0]?.text).toContain('Plată confirmată');

    // 5. Idempotent double-click must NOT send a duplicate WhatsApp confirmation
    const confirmResp2 = await fetch(`${generated.trackingUrl}/confirm`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const confirmBody2 = (await confirmResp2.json()) as {
      ok: boolean;
      alreadyCompleted: boolean;
    };
    expect(confirmBody2.ok).toBe(true);
    expect(confirmBody2.alreadyCompleted).toBe(true);
    expect(messaging.texts).toHaveLength(1);
  });

  it('reconciles unpaid tracked payment automatically from Gmail payment confirmation receipt', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const invoiceRepo = new InMemoryInvoiceRepository();
    const waRepo = new InMemoryWhatsappPaymentRepository();
    const linkRepo = new InMemoryPaymentLinkRepository();
    const memoryRepo = new InMemoryMemoryRepository();
    const memoryService = new FinancialMemoryService(memoryRepo);
    const messaging = new CaptureMessaging();

    const qrService = new QrTrackingService({
      publicBaseUrl: 'http://localhost:3080',
      paymentLinkRepo: linkRepo,
      invoiceRepo,
      whatsappPaymentRepo: waRepo,
      memoryService,
      messaging,
    });

    const validated = validateAndNormalizeInvoice({
      extracted: sampleInvoice,
      fileSha256: 'b'.repeat(64),
      sourceFormat: 'PDF',
    });
    const inv = await invoiceRepo.insertInvoiceWithLines({
      validated,
      effectiveReadingType: 'SELF_READ',
      paymentStatus: 'UNPAID',
      auditFlags: [],
    });
    const gen = await qrService.createForInvoice(inv, ownerJid);

    const matcher = new PaymentReceiptMatcher(linkRepo, invoiceRepo, qrService);
    const res = await matcher.matchAndReconcile({
      messageId: 'gmail-rcpt-1',
      subject: 'Confirmare plată Hidroelectrica',
      from: 'notificari@banca.ro',
      bodyText: 'Tranzacție reușită către Hidroelectrica în valoare de 189,40 RON pentru factura 20260400999.',
      receivedAt: new Date('2026-04-12T10:00:00Z'),
    });

    expect(res.matched).toBe(true);
    const updatedLink = await linkRepo.findById(gen.link.id);
    expect(updatedLink?.status).toBe('COMPLETED');
    expect(updatedLink?.completedVia).toBe('EMAIL_RECEIPT');
    expect((await invoiceRepo.findById(inv.id))?.paymentStatus).toBe('PAID_ON_TIME');
  });
});
