import { getBucharestDateParts } from '../audit/rules/reading.rule.js';
import type { InvoiceRepository } from '../db/repositories/invoice.repo.js';
import type {
  PaymentLinkRepository,
  StoredPaymentLink,
} from '../db/repositories/payment-link.repo.js';
import type { WhatsappPaymentRepository } from '../db/repositories/whatsapp-payment.repo.js';
import { formatCentsRo, formatIsoDateRo } from '../extraction/schema.js';
import type { MessagingAdapter } from '../messaging/adapter.interface.js';
import type { FinancialMemoryService } from '../twin/memory.service.js';
import { getBucharestIsoDate } from './qr.tracking.service.js';

export interface PaymentReminderServiceDeps {
  publicBaseUrl: string;
  paymentLinkRepo: PaymentLinkRepository;
  invoiceRepo: InvoiceRepository;
  whatsappPaymentRepo: WhatsappPaymentRepository;
  memoryService: FinancialMemoryService;
  messaging: MessagingAdapter;
  unaccessedReminderHours: number;
  abandonedReminderMinutes: number;
}

export interface SentReminderRecord {
  linkId: number;
  type: 'REMINDER_QR_UNACCESSED' | 'REMINDER_QR_ABANDONED' | 'REMINDER_OVERDUE';
  message: string;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const COOLDOWN_24H_MS = 24 * MS_PER_HOUR;
const COOLDOWN_48H_MS = 48 * MS_PER_HOUR;

function formatBucharestTimeRo(date: Date): string {
  const p = getBucharestDateParts(date);
  return `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}.${p.year} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function daysUntilDueDateRo(dueDateIso: string, now: Date): number {
  const todayRo = getBucharestIsoDate(now);
  const todayMs = Date.parse(`${todayRo}T00:00:00Z`);
  const dueMs = Date.parse(`${dueDateIso}T00:00:00Z`);
  return Math.round((dueMs - todayMs) / 86_400_000);
}

export class PaymentReminderService {
  private readonly baseUrl: string;

  constructor(private readonly deps: PaymentReminderServiceDeps) {
    this.baseUrl = deps.publicBaseUrl.replace(/\/+$/, '');
  }

  private buildTrackingUrl(token: string): string {
    return `${this.baseUrl}/pay/${token}`;
  }

  private async isTargetEligibleForReminder(link: StoredPaymentLink): Promise<boolean> {
    if (link.status !== 'CREATED' && link.status !== 'QR_ACCESSED') {
      return false;
    }

    if (link.targetType === 'INVOICE' && link.invoiceId !== null) {
      const inv = await this.deps.invoiceRepo.findById(link.invoiceId);
      if (!inv) return false;
      // NEVER nag the user to pay an invoice currently on HOLD_BEFORE_PAYMENT (critical X-Ray anomaly) or already paid.
      if (inv.paymentStatus !== 'UNPAID') {
        return false;
      }
      return true;
    }

    if (link.targetType === 'WHATSAPP_PAYMENT' && link.whatsappPaymentId !== null) {
      const payment = await this.deps.whatsappPaymentRepo.findById(link.whatsappPaymentId);
      if (!payment) return false;
      return payment.paymentStatus === 'UNPAID';
    }

    return true;
  }

  async evaluateAndDispatch(now: Date = new Date()): Promise<SentReminderRecord[]> {
    const activeLinks = await this.deps.paymentLinkRepo.findActiveLinks();
    const sent: SentReminderRecord[] = [];

    const unaccessedThresholdMs = this.deps.unaccessedReminderHours * MS_PER_HOUR;
    const abandonedThresholdMs = this.deps.abandonedReminderMinutes * MS_PER_MINUTE;

    for (const link of activeLinks) {
      const eligible = await this.isTargetEligibleForReminder(link);
      if (!eligible) {
        continue;
      }

      const trackingUrl = this.buildTrackingUrl(link.token);
      const formattedAmount = formatCentsRo(link.amountCents, link.currency);
      const daysUntilDue = link.dueDate ? daysUntilDueDateRo(link.dueDate, now) : null;

      // Case C: Overdue Unpaid Payment (due_date < today in Europe/Bucharest)
      if (daysUntilDue !== null && daysUntilDue < 0) {
        const canSendOverdue =
          link.overdueReminderCount < 3 &&
          (link.lastOverdueReminderAt === null ||
            now.getTime() - link.lastOverdueReminderAt.getTime() >= COOLDOWN_48H_MS);

        if (canSendOverdue) {
          const qrAccessedLabel = link.firstAccessedAt ? 'Da' : 'Nu';
          const dueDateRo = formatIsoDateRo(link.dueDate!);
          const message = [
            `🚨 *Plată restantă — ${link.payeeName}*`,
            `Suma de *${formattedAmount}* avea scadența pe *${dueDateRo}* și încă nu figurează ca achitată (QR accesat: ${qrAccessedLabel}).`,
            `Link plată: ${trackingUrl}`,
            `Dacă ai plătit-o deja, spune-mi *"am plătit ${link.payeeName}"*.`,
          ].join('\n');

          await this.dispatchReminder(link, 'OVERDUE', 'REMINDER_OVERDUE', message, now);
          sent.push({ linkId: link.id, type: 'REMINDER_OVERDUE', message });
        }
        continue;
      }

      // Case A: QR Accessed, Payment NOT Completed (abandoned after scan)
      if (
        link.status === 'QR_ACCESSED' &&
        link.completedAt === null &&
        link.lastAccessedAt !== null &&
        now.getTime() - link.lastAccessedAt.getTime() >= abandonedThresholdMs
      ) {
        const canSendAbandoned =
          link.abandonedReminderCount < 2 &&
          (link.lastAbandonedReminderAt === null ||
            now.getTime() - link.lastAbandonedReminderAt.getTime() >= COOLDOWN_24H_MS);

        if (canSendAbandoned) {
          const accessedTime = formatBucharestTimeRo(link.lastAccessedAt);
          const message = [
            `⏳ *Reminder plată nefinalizată — ${link.payeeName}*`,
            `Am observat că ai accesat codul QR pentru suma de *${formattedAmount}* (la ${accessedTime}), dar plata nu apare finalizată.`,
            `Dacă ai plătit deja, răspunde cu *"am plătit ${link.payeeName}"* sau apasă butonul de confirmare din link: ${trackingUrl}`,
          ].join('\n');

          await this.dispatchReminder(link, 'ABANDONED', 'REMINDER_QR_ABANDONED', message, now);
          sent.push({ linkId: link.id, type: 'REMINDER_QR_ABANDONED', message });
        }
        continue;
      }

      // Case B: QR Never Accessed
      if (link.status === 'CREATED' && link.firstAccessedAt === null) {
        const ageExceeded = now.getTime() - link.createdAt.getTime() >= unaccessedThresholdMs;
        const dueSoon = daysUntilDue !== null && daysUntilDue <= 2;

        if (ageExceeded || dueSoon) {
          const canSendUnaccessed =
            link.unaccessedReminderCount < 3 &&
            (link.lastUnaccessedReminderAt === null ||
              now.getTime() - link.lastUnaccessedReminderAt.getTime() >= COOLDOWN_24H_MS);

          if (canSendUnaccessed) {
            const dueDisplay = link.dueDate ? formatIsoDateRo(link.dueDate) : 'nespecificată';
            const message = [
              `🔔 *Nu ai accesat încă codul QR — ${link.payeeName}*`,
              `Factură/Plată: *${formattedAmount}* | Scadență: *${dueDisplay}*`,
              `Codul QR nu a fost scanat/deschis încă. Scanează codul QR de mai sus sau deschide direct linkul de plată: ${trackingUrl}`,
            ].join('\n');

            await this.dispatchReminder(link, 'UNACCESSED', 'REMINDER_QR_UNACCESSED', message, now);
            sent.push({ linkId: link.id, type: 'REMINDER_QR_UNACCESSED', message });
          }
        }
      }
    }

    return sent;
  }

  private async dispatchReminder(
    link: StoredPaymentLink,
    counterKind: 'UNACCESSED' | 'ABANDONED' | 'OVERDUE',
    eventType: 'REMINDER_QR_UNACCESSED' | 'REMINDER_QR_ABANDONED' | 'REMINDER_OVERDUE',
    message: string,
    sentAt: Date,
  ): Promise<void> {
    await this.deps.messaging.sendText(link.recipientJid, message);
    await this.deps.paymentLinkRepo.recordReminderSent(link.id, counterKind, sentAt);
    await this.deps.paymentLinkRepo.appendEvent(link.id, eventType, {
      sentAt: sentAt.toISOString(),
      payeeName: link.payeeName,
    });
    await this.deps.memoryService.recordPaymentReminderSent(link.recipientJid, link, eventType);
  }
}
