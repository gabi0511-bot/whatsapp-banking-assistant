import { randomBytes } from 'node:crypto';
import { Decimal } from 'decimal.js';
import QRCode from 'qrcode';
import { getBucharestDateParts } from '../audit/rules/reading.rule.js';
import type { StoredInvoice } from '../audit/types.js';
import type { Queryable } from '../db/pool.js';
import type { InvoiceRepository } from '../db/repositories/invoice.repo.js';
import type {
  PaymentCompletedVia,
  PaymentLinkRepository,
  PaymentLinkTargetType,
  StoredPaymentLink,
} from '../db/repositories/payment-link.repo.js';
import type {
  StoredWhatsappPayment,
  WhatsappPaymentRepository,
} from '../db/repositories/whatsapp-payment.repo.js';
import { formatCentsRo, formatIsoDateRo } from '../extraction/schema.js';
import type { MessagingAdapter } from '../messaging/adapter.interface.js';
import type { FinancialMemoryService } from '../twin/memory.service.js';

export interface QrTrackingServiceDeps {
  publicBaseUrl: string;
  paymentLinkRepo: PaymentLinkRepository;
  invoiceRepo: InvoiceRepository;
  whatsappPaymentRepo: WhatsappPaymentRepository;
  memoryService: FinancialMemoryService;
  messaging: MessagingAdapter;
  ownerRevolutTag?: string;
}

export interface GeneratedTrackedQr {
  link: StoredPaymentLink;
  trackingUrl: string;
  pngBuffer: Buffer;
}

export interface PaymentConfirmationOutcome {
  found: boolean;
  alreadyCompleted: boolean;
  link: StoredPaymentLink | null;
  paidStatus?: 'PAID_ON_TIME' | 'PAID_LATE';
}

export function generateTrackingToken(): string {
  return randomBytes(24).toString('base64url');
}

export function getBucharestIsoDate(date: Date = new Date()): string {
  const p = getBucharestDateParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function computePaidOnTimeStatus(
  dueDate: string | null,
  paidAt: Date = new Date(),
): 'PAID_ON_TIME' | 'PAID_LATE' {
  if (!dueDate) {
    return 'PAID_ON_TIME';
  }
  const todayRo = getBucharestIsoDate(paidAt);
  return todayRo <= dueDate ? 'PAID_ON_TIME' : 'PAID_LATE';
}

export function buildRevolutRedirectUrl(
  revolutTag: string | null | undefined,
  amountCents: bigint,
  currency: string,
): string | null {
  if (!revolutTag || !revolutTag.trim()) {
    return null;
  }
  const cleanTag = revolutTag.trim().replace(/^@+/, '');
  const amountDecimal = new Decimal(amountCents.toString()).div(100).toFixed(2);
  return `https://revolut.me/${encodeURIComponent(cleanTag)}/${amountDecimal}/${currency.toLowerCase()}`;
}

export class QrTrackingService {
  private readonly baseUrl: string;

  constructor(private readonly deps: QrTrackingServiceDeps) {
    this.baseUrl = deps.publicBaseUrl.replace(/\/+$/, '');
  }

  buildTrackingUrl(token: string): string {
    return `${this.baseUrl}/pay/${token}`;
  }

  async generateQrPngBuffer(trackingUrl: string): Promise<Buffer> {
    return QRCode.toBuffer(trackingUrl, {
      type: 'png',
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });
  }

  async createForInvoice(
    invoice: StoredInvoice,
    recipientJid: string,
    opts?: { createdAt?: Date; db?: Queryable },
  ): Promise<GeneratedTrackedQr> {
    if (invoice.totalAmountCents <= 0n) {
      throw new Error('Cannot generate a tracked payment QR for non-positive invoice amount');
    }

    const token = generateTrackingToken();
    const trackingUrl = this.buildTrackingUrl(token);
    const reference = invoice.invoiceSeries
      ? `Factura ${invoice.invoiceSeries} ${invoice.invoiceNumber}${invoice.clientCode ? ` | Cod client ${invoice.clientCode}` : ''}`
      : `Factura ${invoice.invoiceNumber}${invoice.clientCode ? ` | Cod client ${invoice.clientCode}` : ''}`;

    const redirectUrl = buildRevolutRedirectUrl(
      this.deps.ownerRevolutTag,
      invoice.totalAmountCents,
      invoice.currency,
    );

    const link = await this.deps.paymentLinkRepo.create(
      {
        token,
        recipientJid,
        targetType: 'INVOICE',
        invoiceId: invoice.id,
        amountCents: invoice.totalAmountCents,
        currency: invoice.currency,
        payeeName: invoice.providerName,
        redirectUrl,
        paymentReference: reference,
        dueDate: invoice.dueDate,
        createdAt: opts?.createdAt,
      },
      opts?.db,
    );

    await this.deps.paymentLinkRepo.appendEvent(
      link.id,
      'QR_GENERATED',
      {
        trackingUrl,
        targetType: 'INVOICE',
        invoiceId: invoice.id,
      },
      opts?.db,
    );

    await this.deps.memoryService.recordQrGenerated(recipientJid, link, trackingUrl, opts?.db);

    const pngBuffer = await this.generateQrPngBuffer(trackingUrl);
    return { link, trackingUrl, pngBuffer };
  }

  async createForWhatsappPayment(
    payment: StoredWhatsappPayment,
    recipientJid: string,
    opts?: { createdAt?: Date; db?: Queryable },
  ): Promise<GeneratedTrackedQr> {
    const token = generateTrackingToken();
    const trackingUrl = this.buildTrackingUrl(token);
    const revolutTag = payment.payeeRevolutTag ?? this.deps.ownerRevolutTag;
    const redirectUrl = buildRevolutRedirectUrl(revolutTag, payment.amountCents, payment.currency);

    const link = await this.deps.paymentLinkRepo.create(
      {
        token,
        recipientJid,
        targetType: 'WHATSAPP_PAYMENT',
        whatsappPaymentId: payment.id,
        amountCents: payment.amountCents,
        currency: payment.currency,
        payeeName: payment.payeeName,
        payeeIban: payment.payeeIban,
        redirectUrl,
        paymentReference: payment.paymentReference ?? payment.title,
        dueDate: payment.dueDate,
        createdAt: opts?.createdAt,
      },
      opts?.db,
    );

    await this.deps.paymentLinkRepo.appendEvent(
      link.id,
      'QR_GENERATED',
      {
        trackingUrl,
        targetType: 'WHATSAPP_PAYMENT',
        whatsappPaymentId: payment.id,
      },
      opts?.db,
    );

    await this.deps.memoryService.recordQrGenerated(recipientJid, link, trackingUrl, opts?.db);

    const pngBuffer = await this.generateQrPngBuffer(trackingUrl);
    return { link, trackingUrl, pngBuffer };
  }

  async getOrCreateForTarget(
    targetType: PaymentLinkTargetType,
    targetId: number,
    recipientJid: string,
  ): Promise<GeneratedTrackedQr> {
    const existing = await this.deps.paymentLinkRepo.findLatestForTarget(targetType, targetId);
    if (existing && (existing.status === 'CREATED' || existing.status === 'QR_ACCESSED')) {
      const trackingUrl = this.buildTrackingUrl(existing.token);
      const pngBuffer = await this.generateQrPngBuffer(trackingUrl);
      return { link: existing, trackingUrl, pngBuffer };
    }

    if (targetType === 'INVOICE') {
      const invoice = await this.deps.invoiceRepo.findById(targetId);
      if (!invoice) {
        throw new Error(`Factura #${targetId} nu a fost găsită.`);
      }
      return this.createForInvoice(invoice, recipientJid);
    }

    const payment = await this.deps.whatsappPaymentRepo.findById(targetId);
    if (!payment) {
      throw new Error(`Plata WhatsApp #${targetId} nu a fost găsită.`);
    }
    return this.createForWhatsappPayment(payment, recipientJid);
  }

  async sendQrToWhatsApp(generated: GeneratedTrackedQr): Promise<void> {
    const { link, trackingUrl, pngBuffer } = generated;
    const duePart = link.dueDate ? `\nScadență: *${formatIsoDateRo(link.dueDate)}*` : '';
    const refPart = link.paymentReference ? `\nReferință: ${link.paymentReference}` : '';

    const caption = [
      `📲 *Cod QR de plată monitorizat — ${link.payeeName}*`,
      `Sumă: *${formatCentsRo(link.amountCents, link.currency)}*${duePart}${refPart}`,
      '',
      `Scanează codul QR sau deschide direct linkul de plată:`,
      trackingUrl,
    ].join('\n');

    if (this.deps.messaging.sendImage) {
      try {
        await this.deps.messaging.sendImage(link.recipientJid, pngBuffer, caption);
      } catch {
        await this.deps.messaging.sendText(link.recipientJid, caption);
      }
    } else {
      await this.deps.messaging.sendText(link.recipientJid, caption);
    }

    await this.deps.paymentLinkRepo.appendEvent(link.id, 'QR_SENT_WHATSAPP', {
      recipientJid: link.recipientJid,
      trackingUrl,
    });
  }

  async recordHumanQrAccess(
    token: string,
    userAgent: string,
    accessedAt: Date = new Date(),
  ): Promise<StoredPaymentLink | null> {
    const updated = await this.deps.paymentLinkRepo.recordAccess(token, accessedAt);
    if (!updated) {
      return null;
    }

    await this.deps.paymentLinkRepo.appendEvent(updated.id, 'QR_ACCESSED', {
      userAgent,
      accessedAt: accessedAt.toISOString(),
      accessCount: updated.accessCount,
    });

    await this.deps.memoryService.recordQrAccessed(
      updated.recipientJid,
      updated,
      accessedAt,
      userAgent,
    );

    return updated;
  }

  async confirmPaymentByToken(
    token: string,
    completedVia: PaymentCompletedVia,
    opts?: { completedAt?: Date; notifyWhatsApp?: boolean },
  ): Promise<PaymentConfirmationOutcome> {
    const link = await this.deps.paymentLinkRepo.findByToken(token);
    if (!link) {
      return { found: false, alreadyCompleted: false, link: null };
    }

    if (link.status === 'COMPLETED') {
      return { found: true, alreadyCompleted: true, link };
    }

    const completedAt = opts?.completedAt ?? new Date();
    const paidStatus = computePaidOnTimeStatus(link.dueDate, completedAt);

    const updatedLink = await this.deps.paymentLinkRepo.markCompleted(
      link.id,
      completedVia,
      completedAt,
    );

    if (link.targetType === 'INVOICE' && link.invoiceId !== null) {
      await this.deps.invoiceRepo.updatePaymentStatus(link.invoiceId, paidStatus);
    } else if (link.targetType === 'WHATSAPP_PAYMENT' && link.whatsappPaymentId !== null) {
      await this.deps.whatsappPaymentRepo.markPaid(link.whatsappPaymentId, paidStatus, completedAt);
    }

    await this.deps.paymentLinkRepo.appendEvent(link.id, 'PAYMENT_COMPLETED', {
      completedVia,
      paidStatus,
      completedAt: completedAt.toISOString(),
    });

    await this.deps.memoryService.recordPaymentCompleted(link.recipientJid, {
      entityType: link.targetType === 'INVOICE' ? 'INVOICE' : 'WHATSAPP_PAYMENT',
      entityId: link.invoiceId ?? link.whatsappPaymentId ?? link.id,
      payeeName: link.payeeName,
      amountCents: link.amountCents,
      currency: link.currency,
      completedVia,
    });

    if (opts?.notifyWhatsApp !== false) {
      await this.deps.messaging.sendText(
        link.recipientJid,
        `✅ Plată confirmată: *${link.payeeName}* — *${formatCentsRo(link.amountCents, link.currency)}*. Am actualizat situația ta financiară și am oprit reminderele pentru această plată.`,
      );
    }

    return {
      found: true,
      alreadyCompleted: false,
      link: updatedLink,
      paidStatus,
    };
  }

  async confirmPaymentForTarget(
    targetType: PaymentLinkTargetType,
    targetId: number,
    ownerJid: string,
    completedVia: PaymentCompletedVia,
    completedAt: Date = new Date(),
  ): Promise<{
    found: boolean;
    payeeName?: string;
    amountCents?: bigint;
    currency?: string;
    paidStatus?: 'PAID_ON_TIME' | 'PAID_LATE';
  }> {
    let payeeName: string;
    let amountCents: bigint;
    let currency: string;
    let dueDate: string | null;

    if (targetType === 'INVOICE') {
      const invoice = await this.deps.invoiceRepo.findById(targetId);
      if (!invoice) return { found: false };
      payeeName = invoice.providerName;
      amountCents = invoice.totalAmountCents;
      currency = invoice.currency;
      dueDate = invoice.dueDate;
      const paidStatus = computePaidOnTimeStatus(dueDate, completedAt);
      await this.deps.invoiceRepo.updatePaymentStatus(invoice.id, paidStatus);

      const link = await this.deps.paymentLinkRepo.findLatestForTarget('INVOICE', invoice.id);
      if (link && link.status !== 'COMPLETED') {
        await this.deps.paymentLinkRepo.markCompleted(link.id, completedVia, completedAt);
        await this.deps.paymentLinkRepo.appendEvent(link.id, 'PAYMENT_COMPLETED', {
          completedVia,
          paidStatus,
          completedAt: completedAt.toISOString(),
        });
      }

      await this.deps.memoryService.recordPaymentCompleted(ownerJid, {
        entityType: 'INVOICE',
        entityId: invoice.id,
        payeeName,
        amountCents,
        currency,
        completedVia,
      });

      return { found: true, payeeName, amountCents, currency, paidStatus };
    }

    const payment = await this.deps.whatsappPaymentRepo.findById(targetId);
    if (!payment) return { found: false };
    payeeName = payment.payeeName;
    amountCents = payment.amountCents;
    currency = payment.currency;
    dueDate = payment.dueDate;
    const paidStatus = computePaidOnTimeStatus(dueDate, completedAt);
    await this.deps.whatsappPaymentRepo.markPaid(payment.id, paidStatus, completedAt);

    const link = await this.deps.paymentLinkRepo.findLatestForTarget('WHATSAPP_PAYMENT', payment.id);
    if (link && link.status !== 'COMPLETED') {
      await this.deps.paymentLinkRepo.markCompleted(link.id, completedVia, completedAt);
      await this.deps.paymentLinkRepo.appendEvent(link.id, 'PAYMENT_COMPLETED', {
        completedVia,
        paidStatus,
        completedAt: completedAt.toISOString(),
      });
    }

    await this.deps.memoryService.recordPaymentCompleted(ownerJid, {
      entityType: 'WHATSAPP_PAYMENT',
      entityId: payment.id,
      payeeName,
      amountCents,
      currency,
      completedVia,
    });

    return { found: true, payeeName, amountCents, currency, paidStatus };
  }
}
