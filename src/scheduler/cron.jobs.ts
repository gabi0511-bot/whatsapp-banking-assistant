import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import type { ReminderRepository } from '../db/repositories/reminder.repo.js';
import type { GmailPollerClient } from '../ingestion/gmail.client.js';
import type { MessagingAdapter } from '../messaging/adapter.interface.js';
import { formatSelfReadingReminder } from '../messaging/formatter.js';
import type { PaymentReminderService } from '../payments/payment.reminder.service.js';
import type { PaymentReceiptMatcher } from '../payments/receipt.matcher.js';
import type { InvoicePipeline } from '../pipeline/invoice.pipeline.js';
import type { FreeTrialService } from '../subscriptions/free-trial.service.js';
import type { GmailRadarService } from '../subscriptions/gmail-radar.service.js';
import type { MonthlyReviewService } from '../review/monthly-review.service.js';

export interface SchedulerDeps {
  gmailClient: GmailPollerClient;
  gmailSearchQuery: string;
  pipeline: InvoicePipeline;
  reminderRepo: ReminderRepository;
  messaging: MessagingAdapter;
  cronGmailPoll: string;
  cronReminderDispatch: string;
  cronPaymentReminders?: string;
  paymentReminderService?: PaymentReminderService;
  receiptMatcher?: PaymentReceiptMatcher;
  cronSubscriptionGmailPoll?: string;
  cronFreeTrialAlerts?: string;
  gmailRadarService?: GmailRadarService;
  freeTrialService?: FreeTrialService;
  cronMonthlyReview?: string;
  monthlyReviewService?: MonthlyReviewService;
  ownerWhatsappJid?: string;
  logger: Logger;
}

export class InvoiceXRayScheduler {
  private pollTask: ScheduledTask | null = null;
  private reminderTask: ScheduledTask | null = null;
  private paymentReminderTask: ScheduledTask | null = null;
  private subscriptionGmailTask: ScheduledTask | null = null;
  private freeTrialAlertTask: ScheduledTask | null = null;
  private monthlyReviewTask: ScheduledTask | null = null;

  private isPolling = false;
  private isDispatchingReminders = false;
  private isDispatchingPaymentReminders = false;
  private isPollingSubscriptions = false;
  private isDispatchingFreeTrials = false;
  private isDispatchingMonthlyReview = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.pollTask = cron.schedule(
      this.deps.cronGmailPoll,
      () => {
        void this.runGmailPollOnce();
      },
      { timezone: 'Europe/Bucharest' },
    );

    this.reminderTask = cron.schedule(
      this.deps.cronReminderDispatch,
      () => {
        void this.dispatchDueRemindersOnce();
      },
      { timezone: 'Europe/Bucharest' },
    );

    if (this.deps.paymentReminderService) {
      this.paymentReminderTask = cron.schedule(
        this.deps.cronPaymentReminders ?? '*/15 * * * *',
        () => {
          void this.dispatchPaymentRemindersOnce();
        },
        { timezone: 'Europe/Bucharest' },
      );
    }

    if (this.deps.gmailRadarService) {
      this.subscriptionGmailTask = cron.schedule(
        this.deps.cronSubscriptionGmailPoll ?? '*/30 * * * *',
        () => {
          void this.runSubscriptionGmailPollOnce();
        },
        { timezone: 'Europe/Bucharest' },
      );
    }

    if (this.deps.freeTrialService) {
      this.freeTrialAlertTask = cron.schedule(
        this.deps.cronFreeTrialAlerts ?? '*/10 * * * *',
        () => {
          void this.dispatchFreeTrialAlertsOnce();
        },
        { timezone: 'Europe/Bucharest' },
      );
    }

    if (this.deps.monthlyReviewService && this.deps.ownerWhatsappJid) {
      this.monthlyReviewTask = cron.schedule(
        this.deps.cronMonthlyReview ?? '0 20 28-31 * *',
        () => {
          void this.dispatchEndOfMonthReviewOnce();
        },
        { timezone: 'Europe/Bucharest' },
      );
    }

    this.deps.logger.info(
      {
        cronGmailPoll: this.deps.cronGmailPoll,
        cronReminderDispatch: this.deps.cronReminderDispatch,
        cronPaymentReminders: this.deps.paymentReminderService
          ? (this.deps.cronPaymentReminders ?? '*/15 * * * *')
          : 'disabled',
        cronSubscriptionGmailPoll: this.deps.gmailRadarService
          ? (this.deps.cronSubscriptionGmailPoll ?? '*/30 * * * *')
          : 'disabled',
        cronFreeTrialAlerts: this.deps.freeTrialService
          ? (this.deps.cronFreeTrialAlerts ?? '*/10 * * * *')
          : 'disabled',
        timezone: 'Europe/Bucharest',
      },
      'Cron scheduler started.',
    );
  }

  stop(): void {
    this.pollTask?.stop();
    this.reminderTask?.stop();
    this.paymentReminderTask?.stop();
    this.subscriptionGmailTask?.stop();
    this.freeTrialAlertTask?.stop();
    this.monthlyReviewTask?.stop();
    this.pollTask = null;
    this.reminderTask = null;
    this.paymentReminderTask = null;
    this.subscriptionGmailTask = null;
    this.freeTrialAlertTask = null;
    this.monthlyReviewTask = null;
  }

  async runGmailPollOnce(): Promise<number> {
    if (this.isPolling) {
      this.deps.logger.debug('Gmail poll skipped: previous run still active.');
      return 0;
    }
    this.isPolling = true;
    let processedCount = 0;

    try {
      const emails = await this.deps.gmailClient.fetchMatchingInvoiceEmails(
        this.deps.gmailSearchQuery,
      );
      this.deps.logger.info({ emailCount: emails.length }, 'Gmail poll fetched matching emails.');

      for (const email of emails) {
        try {
          const results = await this.deps.pipeline.processEmail(email);
          processedCount += results.filter((r) => !r.skipped).length;
        } catch (err) {
          this.deps.logger.error(
            { err, messageId: email.messageId, subject: email.subject },
            'Failed processing invoice email.',
          );
        }
      }

      if (this.deps.receiptMatcher && this.deps.gmailClient.fetchRecentReceiptEmails) {
        try {
          const receipts = await this.deps.gmailClient.fetchRecentReceiptEmails();
          for (const receipt of receipts) {
            const matched = await this.deps.receiptMatcher.matchAndReconcile(receipt);
            if (matched.matched) {
              this.deps.logger.info(
                {
                  messageId: receipt.messageId,
                  paymentLinkId: matched.paymentLink?.id,
                },
                'Reconciled unpaid payment from Gmail payment confirmation receipt.',
              );
            }
          }
        } catch (err) {
          this.deps.logger.warn({ err }, 'Gmail payment receipt matching pass failed.');
        }
      }
    } catch (err) {
      this.deps.logger.error({ err }, 'Gmail polling cycle failed.');
    } finally {
      this.isPolling = false;
    }

    return processedCount;
  }

  async dispatchDueRemindersOnce(now: Date = new Date()): Promise<number> {
    if (this.isDispatchingReminders) {
      return 0;
    }
    this.isDispatchingReminders = true;
    let sentCount = 0;

    try {
      const dueReminders = await this.deps.reminderRepo.findDuePending(now);
      for (const reminder of dueReminders) {
        try {
          const message = formatSelfReadingReminder(reminder);
          await this.deps.messaging.sendText(reminder.recipientJid, message);
          await this.deps.reminderRepo.markSent(reminder.id, new Date());
          sentCount += 1;
          this.deps.logger.info(
            { reminderId: reminder.id, invoiceId: reminder.invoiceId },
            'Dispatched self-reading WhatsApp reminder.',
          );
        } catch (err) {
          this.deps.logger.error(
            { err, reminderId: reminder.id },
            'Failed dispatching self-reading reminder.',
          );
        }
      }
    } catch (err) {
      this.deps.logger.error({ err }, 'Reminder dispatcher cycle failed.');
    } finally {
      this.isDispatchingReminders = false;
    }

    return sentCount;
  }

  async dispatchPaymentRemindersOnce(now: Date = new Date()): Promise<number> {
    if (!this.deps.paymentReminderService || this.isDispatchingPaymentReminders) {
      return 0;
    }
    this.isDispatchingPaymentReminders = true;

    try {
      const sent = await this.deps.paymentReminderService.evaluateAndDispatch(now);
      if (sent.length > 0) {
        this.deps.logger.info(
          { count: sent.length, types: sent.map((s) => s.type) },
          'Dispatched tracked payment & QR abandonment WhatsApp reminders.',
        );
      }
      return sent.length;
    } catch (err) {
      this.deps.logger.error({ err }, 'Payment reminder dispatcher cycle failed.');
      return 0;
    } finally {
      this.isDispatchingPaymentReminders = false;
    }
  }

  async runSubscriptionGmailPollOnce(now: Date = new Date()): Promise<void> {
    if (!this.deps.gmailRadarService || this.isPollingSubscriptions) {
      return;
    }
    this.isPollingSubscriptions = true;
    try {
      const summary = await this.deps.gmailRadarService.scanGmailOnce(now);
      this.deps.logger.info(summary, 'Subscription & Free-Trial Gmail scan completed.');
    } catch (err) {
      this.deps.logger.error({ err }, 'Subscription & Free-Trial Gmail scan failed.');
    } finally {
      this.isPollingSubscriptions = false;
    }
  }

  async dispatchFreeTrialAlertsOnce(now: Date = new Date()): Promise<number> {
    if (!this.deps.freeTrialService || this.isDispatchingFreeTrials) {
      return 0;
    }
    this.isDispatchingFreeTrials = true;
    try {
      const dispatched = await this.deps.freeTrialService.dispatchDue48hAlerts(now);
      if (dispatched.length > 0) {
        this.deps.logger.info(
          { count: dispatched.length, services: dispatched.map((d) => d.trial.serviceName) },
          'Dispatched 48-hour Free Trial WhatsApp alerts.',
        );
      }
      return dispatched.length;
    } catch (err) {
      this.deps.logger.error({ err }, 'Free Trial 48h alert dispatcher failed.');
      return 0;
    } finally {
      this.isDispatchingFreeTrials = false;
    }
  }

  async dispatchEndOfMonthReviewOnce(now: Date = new Date()): Promise<boolean> {
    if (
      !this.deps.monthlyReviewService ||
      !this.deps.ownerWhatsappJid ||
      this.isDispatchingMonthlyReview
    ) {
      return false;
    }
    this.isDispatchingMonthlyReview = true;
    try {
      const res = await this.deps.monthlyReviewService.dispatchEndOfMonthReviewIfDue(
        this.deps.ownerWhatsappJid,
        now,
      );
      if (res.sent) {
        this.deps.logger.info(
          { reviewMonth: res.review?.reviewMonth, betterMonth: res.review?.betterMonth },
          'Dispatched custom AI end-of-month payment efficiency review on WhatsApp.',
        );
      }
      return res.sent;
    } catch (err) {
      this.deps.logger.error({ err }, 'End-of-month review dispatcher failed.');
      return false;
    } finally {
      this.isDispatchingMonthlyReview = false;
    }
  }
}
