import type { StoredInvoice } from '../audit/types.js';
import type { Queryable } from '../db/pool.js';
import type {
  MemoryRepository,
  StoredMemoryEvent,
} from '../db/repositories/memory.repo.js';
import type {
  PaymentCompletedVia,
  StoredPaymentLink,
} from '../db/repositories/payment-link.repo.js';
import type { StoredWhatsappPayment } from '../db/repositories/whatsapp-payment.repo.js';
import { formatCentsRo } from '../extraction/schema.js';

export class FinancialMemoryService {
  constructor(private readonly memoryRepo: MemoryRepository) {}

  async recordInvoiceDetected(
    ownerJid: string,
    invoice: StoredInvoice,
    db?: Queryable,
  ): Promise<StoredMemoryEvent> {
    return this.memoryRepo.record(
      {
        ownerJid,
        eventType: 'INVOICE_DETECTED',
        entityType: 'INVOICE',
        entityId: invoice.id,
        summaryText: `Factură nouă detectată: ${invoice.providerName} nr. ${invoice.invoiceNumber} — ${formatCentsRo(invoice.totalAmountCents, invoice.currency)}, scadență ${invoice.dueDate}, status ${invoice.paymentStatus}.`,
        amountCents: invoice.totalAmountCents,
        currency: invoice.currency,
        metadata: {
          providerName: invoice.providerName,
          invoiceNumber: invoice.invoiceNumber,
          dueDate: invoice.dueDate,
          paymentStatus: invoice.paymentStatus,
          readingType: invoice.readingType,
        },
      },
      db,
    );
  }

  async recordInvoiceAnomalyFlagged(
    ownerJid: string,
    invoice: StoredInvoice,
    db?: Queryable,
  ): Promise<StoredMemoryEvent | null> {
    if (invoice.auditFlags.length === 0) {
      return null;
    }
    const codes = invoice.auditFlags.map((f) => f.code).join(', ');
    return this.memoryRepo.record(
      {
        ownerJid,
        eventType: 'INVOICE_ANOMALY_FLAGGED',
        entityType: 'INVOICE',
        entityId: invoice.id,
        summaryText: `Anomalii Invoice X-Ray la ${invoice.providerName} (#${invoice.id}, nr. ${invoice.invoiceNumber}): ${codes}.`,
        amountCents: invoice.totalAmountCents,
        currency: invoice.currency,
        metadata: {
          flags: invoice.auditFlags.map((f) => ({
            code: f.code,
            severity: f.severity,
            message: f.message,
          })),
        },
      },
      db,
    );
  }

  async recordDisputeDraftCreated(
    ownerJid: string,
    invoice: StoredInvoice,
    recipientEmail: string,
    db?: Queryable,
  ): Promise<StoredMemoryEvent> {
    return this.memoryRepo.record(
      {
        ownerJid,
        eventType: 'DISPUTE_DRAFT_CREATED',
        entityType: 'INVOICE',
        entityId: invoice.id,
        summaryText: `Draft contestație pregătit pentru ${invoice.providerName} nr. ${invoice.invoiceNumber} către ${recipientEmail}.`,
        amountCents: invoice.totalAmountCents,
        currency: invoice.currency,
        metadata: { recipientEmail, invoiceNumber: invoice.invoiceNumber },
      },
      db,
    );
  }

  async recordWhatsappPaymentLogged(
    ownerJid: string,
    payment: StoredWhatsappPayment,
    db?: Queryable,
  ): Promise<StoredMemoryEvent> {
    return this.memoryRepo.record(
      {
        ownerJid,
        eventType: 'WHATSAPP_PAYMENT_LOGGED',
        entityType: 'WHATSAPP_PAYMENT',
        entityId: payment.id,
        summaryText: `Plată înregistrată pe WhatsApp: "${payment.title}" către ${payment.payeeName} — ${formatCentsRo(payment.amountCents, payment.currency)}${payment.dueDate ? `, scadență ${payment.dueDate}` : ''}, status ${payment.paymentStatus}.`,
        amountCents: payment.amountCents,
        currency: payment.currency,
        metadata: {
          title: payment.title,
          payeeName: payment.payeeName,
          category: payment.category,
          dueDate: payment.dueDate,
          paymentStatus: payment.paymentStatus,
        },
      },
      db,
    );
  }

  async recordQrGenerated(
    ownerJid: string,
    link: StoredPaymentLink,
    trackingUrl: string,
    db?: Queryable,
  ): Promise<StoredMemoryEvent> {
    return this.memoryRepo.record(
      {
        ownerJid,
        eventType: 'QR_GENERATED',
        entityType: 'PAYMENT_LINK',
        entityId: link.id,
        summaryText: `Cod QR de plată generat pentru ${link.payeeName} — ${formatCentsRo(link.amountCents, link.currency)} (${trackingUrl}).`,
        amountCents: link.amountCents,
        currency: link.currency,
        metadata: {
          token: link.token,
          targetType: link.targetType,
          invoiceId: link.invoiceId,
          whatsappPaymentId: link.whatsappPaymentId,
          trackingUrl,
        },
      },
      db,
    );
  }

  async recordQrAccessed(
    ownerJid: string,
    link: StoredPaymentLink,
    accessedAt: Date,
    userAgent: string,
    db?: Queryable,
  ): Promise<StoredMemoryEvent> {
    return this.memoryRepo.record(
      {
        ownerJid,
        eventType: 'QR_ACCESSED',
        entityType: 'PAYMENT_LINK',
        entityId: link.id,
        summaryText: `Codul QR pentru ${link.payeeName} (${formatCentsRo(link.amountCents, link.currency)}) a fost accesat/scanat (accesări totale: ${link.accessCount}).`,
        amountCents: link.amountCents,
        currency: link.currency,
        metadata: {
          token: link.token,
          accessCount: link.accessCount,
          accessedAt: accessedAt.toISOString(),
          userAgent,
        },
      },
      db,
    );
  }

  async recordPaymentCompleted(
    ownerJid: string,
    params: {
      entityType: 'INVOICE' | 'WHATSAPP_PAYMENT' | 'PAYMENT_LINK';
      entityId: number;
      payeeName: string;
      amountCents: bigint;
      currency: string;
      completedVia: PaymentCompletedVia;
    },
    db?: Queryable,
  ): Promise<StoredMemoryEvent> {
    return this.memoryRepo.record(
      {
        ownerJid,
        eventType: 'PAYMENT_COMPLETED',
        entityType: params.entityType,
        entityId: params.entityId,
        summaryText: `Plată finalizată: ${params.payeeName} — ${formatCentsRo(params.amountCents, params.currency)} (confirmată prin ${params.completedVia}).`,
        amountCents: params.amountCents,
        currency: params.currency,
        metadata: {
          payeeName: params.payeeName,
          completedVia: params.completedVia,
        },
      },
      db,
    );
  }

  async recordPaymentReminderSent(
    ownerJid: string,
    link: StoredPaymentLink,
    reminderKind: 'REMINDER_QR_UNACCESSED' | 'REMINDER_QR_ABANDONED' | 'REMINDER_OVERDUE',
    db?: Queryable,
  ): Promise<StoredMemoryEvent> {
    return this.memoryRepo.record(
      {
        ownerJid,
        eventType: 'PAYMENT_REMINDER_SENT',
        entityType: 'PAYMENT_LINK',
        entityId: link.id,
        summaryText: `Reminder (${reminderKind}) trimis pentru ${link.payeeName} — ${formatCentsRo(link.amountCents, link.currency)}.`,
        amountCents: link.amountCents,
        currency: link.currency,
        metadata: {
          reminderKind,
          token: link.token,
          payeeName: link.payeeName,
          dueDate: link.dueDate,
        },
      },
      db,
    );
  }

  async getRecentTimeline(
    ownerJid: string,
    opts?: { limit?: number; searchTerm?: string },
  ): Promise<StoredMemoryEvent[]> {
    return this.memoryRepo.findRecent(ownerJid, opts);
  }
}
