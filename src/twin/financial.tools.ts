import { Type, type FunctionDeclaration } from '@google/genai';
import { getBucharestDateParts } from '../audit/rules/reading.rule.js';
import type { CashflowEngine } from '../cashflow/cashflow.engine.js';
import type { DemoBalanceService } from '../cashflow/demo-balance.service.js';
import type { FreeTrialRepository } from '../db/repositories/free-trial.repo.js';
import type { InvoiceRepository } from '../db/repositories/invoice.repo.js';
import type { PaymentLinkRepository } from '../db/repositories/payment-link.repo.js';
import type { SubscriptionRepository } from '../db/repositories/subscription.repo.js';
import {
  WHATSAPP_PAYMENT_CATEGORIES,
  type WhatsappPaymentCategory,
  type WhatsappPaymentRepository,
} from '../db/repositories/whatsapp-payment.repo.js';
import { toBaniCents } from '../extraction/math.validator.js';
import { formatCentsRo, normalizeDiacritics } from '../extraction/schema.js';
import {
  getBucharestIsoDate,
  type GeneratedTrackedQr,
  type QrTrackingService,
} from '../payments/qr.tracking.service.js';
import type { FreeTrialService } from '../subscriptions/free-trial.service.js';
import type { GmailRadarService } from '../subscriptions/gmail-radar.service.js';
import { normalizeMerchantDescriptor } from '../subscriptions/merchant.normalizer.js';
import type { SubscriptionRadarService } from '../subscriptions/radar.service.js';
import type { RecurrenceEngine } from '../subscriptions/recurrence.engine.js';
import type { MonthlyReviewService } from '../review/monthly-review.service.js';
import {
  BILLING_PERIODS,
  SUBSCRIPTION_CATEGORIES,
  type BillingPeriod,
  type SubscriptionCategory,
} from '../subscriptions/types.js';
import type { FinancialMemoryService } from './memory.service.js';

export interface FinancialToolsDeps {
  invoiceRepo: InvoiceRepository;
  whatsappPaymentRepo: WhatsappPaymentRepository;
  paymentLinkRepo: PaymentLinkRepository;
  memoryService: FinancialMemoryService;
  qrTrackingService: QrTrackingService;
  demoBalanceService?: DemoBalanceService;
  cashflowEngine?: CashflowEngine;
  subscriptionRadarService?: SubscriptionRadarService;
  freeTrialService?: FreeTrialService;
  recurrenceEngine?: RecurrenceEngine;
  gmailRadarService?: GmailRadarService;
  subscriptionRepo?: SubscriptionRepository;
  freeTrialRepo?: FreeTrialRepository;
  monthlyReviewService?: MonthlyReviewService;
}

export interface ToolExecutionContext {
  ownerJid: string;
  sourceMessageText?: string;
  now?: Date;
  queuedQrSends: GeneratedTrackedQr[];
}

export const TWIN_GEMINI_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'get_financial_status_summary',
    description:
      'Returns exact aggregated financial status totals (unpaid, paid, held anomalies, overdue, upcoming next 7 days) across both Invoice X-Ray parsed_invoices and whatsapp_payments.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        period: {
          type: Type.STRING,
          enum: ['CURRENT_MONTH', 'LAST_30_DAYS', 'ALL_TIME'],
          description: 'Time period filter (defaults to ALL_TIME for unpaid snapshot + period breakdown).',
        },
      },
    },
  },
  {
    name: 'query_bills_and_payments',
    description:
      'Searches Invoice X-Ray bills (including audit flags, meter reading type, due date) and WhatsApp payments by status or provider/payee name.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description: 'Optional status filter: UNPAID, PAID, HOLD_BEFORE_PAYMENT, OVERDUE, or ALL.',
        },
        provider_or_payee: {
          type: Type.STRING,
          description: 'Optional substring to match provider name, payee name, or title (e.g. Hidroelectrica, Digi, chirie).',
        },
        include_invoices: { type: Type.BOOLEAN },
        include_whatsapp_payments: { type: Type.BOOLEAN },
        limit: { type: Type.INTEGER },
      },
    },
  },
  {
    name: 'get_qr_and_payment_tracking',
    description:
      'Checks tracked payment QR codes: whether a QR was sent, whether/when it was accessed/scanned (first_accessed_at, access_count), whether payment was completed, and how many reminders were sent.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        invoice_id: { type: Type.INTEGER },
        whatsapp_payment_id: { type: Type.INTEGER },
        only_pending: { type: Type.BOOLEAN },
      },
    },
  },
  {
    name: 'log_whatsapp_payment',
    description:
      'Logs a non-Gmail payment mentioned on WhatsApp (e.g. rent, maintenance, transfer) into PostgreSQL and optionally generates a tracked payment QR code.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        payee_name: { type: Type.STRING },
        amount_ron: { type: Type.NUMBER },
        currency: { type: Type.STRING },
        category: { type: Type.STRING, enum: [...WHATSAPP_PAYMENT_CATEGORIES] },
        due_date: { type: Type.STRING, description: 'Optional ISO date YYYY-MM-DD' },
        payee_iban: { type: Type.STRING },
        notes: { type: Type.STRING },
        already_paid: { type: Type.BOOLEAN },
        generate_qr: { type: Type.BOOLEAN },
      },
      required: ['title', 'payee_name', 'amount_ron'],
    },
  },
  {
    name: 'mark_payment_completed',
    description:
      'Marks an Invoice X-Ray invoice or a WhatsApp payment as completed/paid (PAID_ON_TIME or PAID_LATE), updates tracked QR status to COMPLETED, and stops further reminders.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target_type: { type: Type.STRING, enum: ['INVOICE', 'WHATSAPP_PAYMENT'] },
        id: { type: Type.INTEGER },
        paid_date: { type: Type.STRING, description: 'Optional ISO date YYYY-MM-DD' },
      },
      required: ['target_type', 'id'],
    },
  },
  {
    name: 'resend_payment_qr',
    description:
      'Retrieves or creates a tracked payment QR link for an invoice or WhatsApp payment and queues the PNG QR image to be sent on WhatsApp. ALWAYS call this when the user asks to pay a bill (e.g. "plătește factura de la Engie", "vreau să plătesc Hidroelectrica", "plătește toate facturile") or asks for a payment QR/link.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target_type: { type: Type.STRING, enum: ['INVOICE', 'WHATSAPP_PAYMENT'] },
        id: { type: Type.INTEGER },
      },
      required: ['target_type', 'id'],
    },
  },
  {
    name: 'get_financial_timeline_memory',
    description:
      'Searches persistent financial_memory_events (bills detected, anomalies, QR scans, reminders sent, WhatsApp payments logged, subscriptions, price hikes, free trials, completions).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.INTEGER },
        search_term: { type: Type.STRING },
      },
    },
  },
  {
    name: 'get_subscriptions_radar',
    description:
      'Returns Sold curent (Demo), all active and zombie recurring subscriptions grouped by category, exact monthly total, cumulative annual cost (sumă × 12), recent silent price hikes, and active free trials.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_active_free_trials',
    description:
      'Returns Sold curent (Demo) and all active free trials with exact expiration dates, post-trial charges, 48-hour alert schedules, and cancellation URLs.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'schedule_free_trial_alert',
    description:
      'Registers a free trial mentioned naturally by the user on WhatsApp (e.g. "am activat trial la Adobe, expiră pe 5 decembrie, 149 RON/lună" or "am făcut trial 14 zile la Canva Pro") and automatically schedules a 48h pre-expiry alert.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        service_name: { type: Type.STRING },
        post_trial_amount_ron: { type: Type.NUMBER },
        trial_end_date: { type: Type.STRING, description: 'Optional ISO date YYYY-MM-DD' },
        trial_duration_days: { type: Type.INTEGER, description: 'Optional number of trial days if end date not stated' },
        currency: { type: Type.STRING },
        billing_period: { type: Type.STRING, enum: [...BILLING_PERIODS] },
        cancellation_url: { type: Type.STRING },
      },
      required: ['service_name', 'post_trial_amount_ron'],
    },
  },
  {
    name: 'log_subscription_charge',
    description:
      'Logs a recurring subscription charge (e.g. Netflix, Spotify, iCloud, gym) into the Subscription Radar to detect ~30-day recurrence and silent price hikes.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        merchant_name: { type: Type.STRING },
        amount_ron: { type: Type.NUMBER },
        charged_date: { type: Type.STRING, description: 'Optional ISO date YYYY-MM-DD' },
        currency: { type: Type.STRING },
        category: { type: Type.STRING, enum: [...SUBSCRIPTION_CATEGORIES] },
        is_explicit_recurring: { type: Type.BOOLEAN },
      },
      required: ['merchant_name', 'amount_ron'],
    },
  },
  {
    name: 'update_subscription_or_trial_status',
    description:
      'Marks a subscription or free trial as CANCELLED (e.g. "am anulat trial-ul la Adobe", "am dezactivat Disney+") or CONFIRM_USED (e.g. "folosesc Spotify, nu e zombie"). Can match by numeric id OR service/merchant name.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, enum: ['SUBSCRIPTION', 'FREE_TRIAL'] },
        id: { type: Type.INTEGER },
        name: { type: Type.STRING, description: 'Optional service or merchant name if id is unknown' },
        action: { type: Type.STRING, enum: ['CANCEL', 'CONFIRM_USED'] },
      },
      required: ['target', 'action'],
    },
  },
  {
    name: 'scan_gmail_for_trials_and_subscriptions',
    description:
      'Immediately scans the user Gmail inbox with AI to detect any new free-trial activation emails, cancellation emails, or subscription receipts, schedules 48h reminders, and returns what was found.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'manage_demo_balance',
    description:
      'Reads or updates Sold curent (Demo) and computes exact 30-day Safe-to-Spend after upcoming invoices, WhatsApp payments, and active subscriptions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        new_balance_ron: { type: Type.NUMBER, description: 'Optional new Demo Balance in RON to save' },
        currency: { type: Type.STRING },
      },
    },
  },
  {
    name: 'get_monthly_efficiency_review',
    description:
      'Compares the user payments of the current month vs. the previous month, calculates exact efficiency ratings (0-100 & grade A+..D based on on-time payments, late payments, overdue bills, and penalties), determines which month was handled more efficiently, and computes exact savings to recommend moving into a savings or investment account if the user paid less than last month.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target_month: {
          type: Type.STRING,
          description: 'Optional YYYY-MM month to evaluate (defaults to current month).',
        },
      },
    },
  },
];

function addDaysIso(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function isWithinPeriod(dateIso: string, period: string, now: Date): boolean {
  if (period === 'ALL_TIME') return true;
  const p = getBucharestDateParts(now);
  const todayIso = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  if (period === 'CURRENT_MONTH') {
    const monthPrefix = `${p.year}-${String(p.month).padStart(2, '0')}`;
    return dateIso.startsWith(monthPrefix);
  }
  if (period === 'LAST_30_DAYS') {
    const cutoff = addDaysIso(todayIso, -30);
    return dateIso >= cutoff;
  }
  return true;
}

export class FinancialToolExecutor {
  constructor(private readonly deps: FinancialToolsDeps) {}

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case 'get_financial_status_summary':
        return this.getFinancialStatusSummary(args, ctx);
      case 'query_bills_and_payments':
        return this.queryBillsAndPayments(args, ctx);
      case 'get_qr_and_payment_tracking':
        return this.getQrAndPaymentTracking(args, ctx);
      case 'log_whatsapp_payment':
        return this.logWhatsappPayment(args, ctx);
      case 'mark_payment_completed':
        return this.markPaymentCompleted(args, ctx);
      case 'resend_payment_qr':
        return this.resendPaymentQr(args, ctx);
      case 'get_financial_timeline_memory':
        return this.getFinancialTimelineMemory(args, ctx);
      case 'get_subscriptions_radar':
        return this.getSubscriptionsRadar(ctx);
      case 'get_active_free_trials':
        return this.getActiveFreeTrials(ctx);
      case 'schedule_free_trial_alert':
        return this.scheduleFreeTrialAlert(args, ctx);
      case 'log_subscription_charge':
        return this.logSubscriptionCharge(args, ctx);
      case 'update_subscription_or_trial_status':
        return this.updateSubscriptionOrTrialStatus(args, ctx);
      case 'scan_gmail_for_trials_and_subscriptions':
        return this.scanGmailForTrialsAndSubscriptions(ctx);
      case 'manage_demo_balance':
        return this.manageDemoBalance(args, ctx);
      case 'get_monthly_efficiency_review':
        return this.getMonthlyEfficiencyReview(args, ctx);
      default:
        return { error: `Unknown financial tool: ${name}` };
    }
  }

  async getFinancialStatusSummary(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const period =
      args.period === 'CURRENT_MONTH' || args.period === 'LAST_30_DAYS' || args.period === 'ALL_TIME'
        ? args.period
        : 'ALL_TIME';
    const now = ctx.now ?? new Date();
    const todayIso = getBucharestIsoDate(now);
    const in7DaysIso = addDaysIso(todayIso, 7);

    const [allInvoices, allWaPayments] = await Promise.all([
      this.deps.invoiceRepo.findAll(),
      this.deps.whatsappPaymentRepo.findByOwner(ctx.ownerJid),
    ]);

    const filteredInvoices = allInvoices.filter((inv) =>
      isWithinPeriod(inv.issueDate, period, now),
    );
    const filteredWa = allWaPayments.filter((p) => {
      const refDate = p.dueDate ?? p.createdAt.toISOString().slice(0, 10);
      return isWithinPeriod(refDate, period, now);
    });

    const unpaidByCurrency = new Map<string, bigint>();
    const paidByCurrency = new Map<string, bigint>();
    let totalUnpaidRonCents = 0n;
    let totalPaidRonCents = 0n;
    let heldAnomalyCount = 0;
    let overdueCount = 0;
    const upcomingNext7Days: Array<Record<string, unknown>> = [];

    const addMap = (m: Map<string, bigint>, currency: string, delta: bigint) => {
      m.set(currency, (m.get(currency) ?? 0n) + delta);
    };

    for (const inv of filteredInvoices) {
      if (inv.paymentStatus === 'UNPAID' || inv.paymentStatus === 'HOLD_BEFORE_PAYMENT') {
        if (inv.totalAmountCents > 0n) {
          addMap(unpaidByCurrency, inv.currency, inv.totalAmountCents);
          if (inv.currency === 'RON') totalUnpaidRonCents += inv.totalAmountCents;
        }
        if (inv.paymentStatus === 'HOLD_BEFORE_PAYMENT') {
          heldAnomalyCount += 1;
        }
        if (inv.dueDate < todayIso) {
          overdueCount += 1;
        } else if (inv.dueDate <= in7DaysIso) {
          upcomingNext7Days.push({
            source: 'INVOICE',
            id: inv.id,
            name: inv.providerName,
            amount_formatted: formatCentsRo(inv.totalAmountCents, inv.currency),
            due_date: inv.dueDate,
            status: inv.paymentStatus,
          });
        }
      } else if (inv.paymentStatus === 'PAID_ON_TIME' || inv.paymentStatus === 'PAID_LATE') {
        if (inv.totalAmountCents > 0n) {
          addMap(paidByCurrency, inv.currency, inv.totalAmountCents);
          if (inv.currency === 'RON') totalPaidRonCents += inv.totalAmountCents;
        }
      }
    }

    for (const p of filteredWa) {
      if (p.paymentStatus === 'UNPAID') {
        addMap(unpaidByCurrency, p.currency, p.amountCents);
        if (p.currency === 'RON') totalUnpaidRonCents += p.amountCents;
        if (p.dueDate && p.dueDate < todayIso) {
          overdueCount += 1;
        } else if (p.dueDate && p.dueDate <= in7DaysIso) {
          upcomingNext7Days.push({
            source: 'WHATSAPP_PAYMENT',
            id: p.id,
            name: `${p.title} (${p.payeeName})`,
            amount_formatted: formatCentsRo(p.amountCents, p.currency),
            due_date: p.dueDate,
            status: p.paymentStatus,
          });
        }
      } else if (p.paymentStatus === 'PAID_ON_TIME' || p.paymentStatus === 'PAID_LATE') {
        addMap(paidByCurrency, p.currency, p.amountCents);
        if (p.currency === 'RON') totalPaidRonCents += p.amountCents;
      }
    }

    return {
      period,
      as_of_date_ro: todayIso,
      total_unpaid_cents: totalUnpaidRonCents.toString(),
      total_unpaid_formatted_ron: formatCentsRo(totalUnpaidRonCents, 'RON'),
      total_paid_cents: totalPaidRonCents.toString(),
      total_paid_formatted_ron: formatCentsRo(totalPaidRonCents, 'RON'),
      unpaid_by_currency: Object.fromEntries(
        Array.from(unpaidByCurrency.entries()).map(([cur, c]) => [cur, formatCentsRo(c, cur)]),
      ),
      paid_by_currency: Object.fromEntries(
        Array.from(paidByCurrency.entries()).map(([cur, c]) => [cur, formatCentsRo(c, cur)]),
      ),
      invoices_count: filteredInvoices.length,
      unpaid_invoices_count: filteredInvoices.filter(
        (i) => i.paymentStatus === 'UNPAID' || i.paymentStatus === 'HOLD_BEFORE_PAYMENT',
      ).length,
      whatsapp_payments_count: filteredWa.length,
      unpaid_whatsapp_payments_count: filteredWa.filter((p) => p.paymentStatus === 'UNPAID').length,
      held_anomaly_count: heldAnomalyCount,
      overdue_count: overdueCount,
      upcoming_due_next_7_days: upcomingNext7Days,
    };
  }

  async queryBillsAndPayments(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const statusFilter = typeof args.status === 'string' ? args.status.toUpperCase() : 'ALL';
    const search =
      typeof args.provider_or_payee === 'string'
        ? normalizeDiacritics(args.provider_or_payee).toLowerCase().trim()
        : '';
    const includeInvoices = args.include_invoices !== false;
    const includeWa = args.include_whatsapp_payments !== false;
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 20;
    const todayIso = getBucharestIsoDate(ctx.now ?? new Date());

    const invoicesOut: Array<Record<string, unknown>> = [];
    const waOut: Array<Record<string, unknown>> = [];

    if (includeInvoices) {
      let invoices = await this.deps.invoiceRepo.findAll();
      if (search) {
        invoices = invoices.filter((inv) =>
          normalizeDiacritics(
            `${inv.providerName} ${inv.invoiceNumber} ${inv.category}`,
          )
            .toLowerCase()
            .includes(search),
        );
      }
      if (statusFilter === 'UNPAID') {
        invoices = invoices.filter(
          (i) => i.paymentStatus === 'UNPAID' || i.paymentStatus === 'HOLD_BEFORE_PAYMENT',
        );
      } else if (statusFilter === 'PAID') {
        invoices = invoices.filter(
          (i) => i.paymentStatus === 'PAID_ON_TIME' || i.paymentStatus === 'PAID_LATE',
        );
      } else if (statusFilter === 'HOLD_BEFORE_PAYMENT') {
        invoices = invoices.filter((i) => i.paymentStatus === 'HOLD_BEFORE_PAYMENT');
      } else if (statusFilter === 'OVERDUE') {
        invoices = invoices.filter(
          (i) =>
            (i.paymentStatus === 'UNPAID' || i.paymentStatus === 'HOLD_BEFORE_PAYMENT') &&
            i.dueDate < todayIso,
        );
      }

      for (const inv of invoices.slice(0, limit)) {
        invoicesOut.push({
          target_type: 'INVOICE',
          id: inv.id,
          provider_name: inv.providerName,
          invoice_number: inv.invoiceNumber,
          amount_cents: inv.totalAmountCents.toString(),
          amount_formatted: formatCentsRo(inv.totalAmountCents, inv.currency),
          issue_date: inv.issueDate,
          due_date: inv.dueDate,
          reading_type: inv.readingType,
          payment_status: inv.paymentStatus,
          audit_flags: inv.auditFlags.map((f) => ({
            code: f.code,
            severity: f.severity,
            message: f.message,
          })),
        });
      }
    }

    if (includeWa) {
      let waPayments = await this.deps.whatsappPaymentRepo.findByOwner(ctx.ownerJid);
      if (search) {
        waPayments = waPayments.filter((p) =>
          normalizeDiacritics(`${p.title} ${p.payeeName} ${p.category}`)
            .toLowerCase()
            .includes(search),
        );
      }
      if (statusFilter === 'UNPAID') {
        waPayments = waPayments.filter((p) => p.paymentStatus === 'UNPAID');
      } else if (statusFilter === 'PAID') {
        waPayments = waPayments.filter(
          (p) => p.paymentStatus === 'PAID_ON_TIME' || p.paymentStatus === 'PAID_LATE',
        );
      } else if (statusFilter === 'OVERDUE') {
        waPayments = waPayments.filter(
          (p) => p.paymentStatus === 'UNPAID' && p.dueDate !== null && p.dueDate < todayIso,
        );
      }

      for (const p of waPayments.slice(0, limit)) {
        waOut.push({
          target_type: 'WHATSAPP_PAYMENT',
          id: p.id,
          title: p.title,
          payee_name: p.payeeName,
          category: p.category,
          amount_cents: p.amountCents.toString(),
          amount_formatted: formatCentsRo(p.amountCents, p.currency),
          due_date: p.dueDate,
          payment_status: p.paymentStatus,
          notes: p.notes,
        });
      }
    }

    return {
      invoices: invoicesOut,
      whatsapp_payments: waOut,
    };
  }

  async getQrAndPaymentTracking(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const invoiceId = typeof args.invoice_id === 'number' ? args.invoice_id : undefined;
    const whatsappPaymentId =
      typeof args.whatsapp_payment_id === 'number' ? args.whatsapp_payment_id : undefined;
    const onlyPending = args.only_pending === true;

    const links = await this.deps.paymentLinkRepo.findAllForRecipient(ctx.ownerJid, {
      onlyPending,
      invoiceId,
      whatsappPaymentId,
    });

    const items = await Promise.all(
      links.map(async (link) => {
        const events = await this.deps.paymentLinkRepo.listEvents(link.id);
        return {
          payment_link_id: link.id,
          target_type: link.targetType,
          invoice_id: link.invoiceId,
          whatsapp_payment_id: link.whatsappPaymentId,
          payee_name: link.payeeName,
          amount_formatted: formatCentsRo(link.amountCents, link.currency),
          due_date: link.dueDate,
          status: link.status,
          qr_was_accessed: link.firstAccessedAt !== null,
          first_accessed_at: link.firstAccessedAt?.toISOString() ?? null,
          last_accessed_at: link.lastAccessedAt?.toISOString() ?? null,
          access_count: link.accessCount,
          completed_at: link.completedAt?.toISOString() ?? null,
          completed_via: link.completedVia,
          reminders_sent: {
            unaccessed: link.unaccessedReminderCount,
            abandoned: link.abandonedReminderCount,
            overdue: link.overdueReminderCount,
          },
          tracking_url: this.deps.qrTrackingService.buildTrackingUrl(link.token),
          recent_events: events.slice(0, 5).map((e) => ({
            type: e.eventType,
            at: e.createdAt.toISOString(),
          })),
        };
      }),
    );

    return {
      total_tracked_links: items.length,
      tracked_payment_links: items,
    };
  }

  async logWhatsappPayment(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const title = String(args.title ?? '').trim();
    const payeeName = String(args.payee_name ?? title).trim();
    const amountRon = Number(args.amount_ron);
    if (!title || Number.isNaN(amountRon) || amountRon <= 0) {
      return { error: 'Invalid title or positive amount_ron required.' };
    }

    const currency = typeof args.currency === 'string' ? args.currency.toUpperCase() : 'RON';
    const rawCat = typeof args.category === 'string' ? args.category.toUpperCase() : 'OTHER';
    const category: WhatsappPaymentCategory = (
      WHATSAPP_PAYMENT_CATEGORIES as readonly string[]
    ).includes(rawCat)
      ? (rawCat as WhatsappPaymentCategory)
      : 'OTHER';

    const dueDate = typeof args.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.due_date)
      ? args.due_date
      : null;
    const payeeIban = typeof args.payee_iban === 'string' ? args.payee_iban.trim() : null;
    const notes = typeof args.notes === 'string' ? args.notes.trim() : null;
    const alreadyPaid = args.already_paid === true;
    const generateQr = args.generate_qr === true && !alreadyPaid;

    const amountCents = toBaniCents(amountRon);
    const payment = await this.deps.whatsappPaymentRepo.create({
      ownerJid: ctx.ownerJid,
      title,
      payeeName,
      category,
      amountCents,
      currency,
      dueDate,
      payeeIban,
      paymentStatus: alreadyPaid ? 'PAID_ON_TIME' : 'UNPAID',
      paidAt: alreadyPaid ? (ctx.now ?? new Date()) : null,
      notes,
      sourceMessageText: ctx.sourceMessageText ?? null,
    });

    await this.deps.memoryService.recordWhatsappPaymentLogged(ctx.ownerJid, payment);

    let trackingUrl: string | null = null;
    if (generateQr) {
      const generated = await this.deps.qrTrackingService.createForWhatsappPayment(
        payment,
        ctx.ownerJid,
      );
      ctx.queuedQrSends.push(generated);
      trackingUrl = generated.trackingUrl;
    }

    return {
      ok: true,
      whatsapp_payment_id: payment.id,
      title: payment.title,
      payee_name: payment.payeeName,
      amount_formatted: formatCentsRo(payment.amountCents, payment.currency),
      due_date: payment.dueDate,
      payment_status: payment.paymentStatus,
      qr_generated: generateQr,
      tracking_url: trackingUrl,
    };
  }

  async markPaymentCompleted(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const targetType =
      args.target_type === 'WHATSAPP_PAYMENT' ? 'WHATSAPP_PAYMENT' : 'INVOICE';
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) {
      return { error: 'Valid positive integer id is required.' };
    }

    const paidDate =
      typeof args.paid_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.paid_date)
        ? new Date(`${args.paid_date}T12:00:00Z`)
        : (ctx.now ?? new Date());

    const res = await this.deps.qrTrackingService.confirmPaymentForTarget(
      targetType,
      id,
      ctx.ownerJid,
      'AI_TWIN_CHAT',
      paidDate,
    );

    if (!res.found) {
      return {
        ok: false,
        error: `${targetType} #${id} not found.`,
      };
    }

    return {
      ok: true,
      target_type: targetType,
      id,
      payee_name: res.payeeName,
      amount_formatted: formatCentsRo(res.amountCents ?? 0n, res.currency ?? 'RON'),
      payment_status: res.paidStatus,
    };
  }

  async resendPaymentQr(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const targetType =
      args.target_type === 'WHATSAPP_PAYMENT' ? 'WHATSAPP_PAYMENT' : 'INVOICE';
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) {
      return { error: 'Valid positive integer id is required.' };
    }

    try {
      const generated = await this.deps.qrTrackingService.getOrCreateForTarget(
        targetType,
        id,
        ctx.ownerJid,
      );
      ctx.queuedQrSends.push(generated);
      return {
        ok: true,
        target_type: targetType,
        id,
        payee_name: generated.link.payeeName,
        amount_formatted: formatCentsRo(generated.link.amountCents, generated.link.currency),
        tracking_url: generated.trackingUrl,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getFinancialTimelineMemory(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 15;
    const searchTerm = typeof args.search_term === 'string' ? args.search_term : undefined;

    const events = await this.deps.memoryService.getRecentTimeline(ctx.ownerJid, {
      limit,
      searchTerm,
    });

    return {
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        event_type: e.eventType,
        entity_type: e.entityType,
        entity_id: e.entityId,
        summary: e.summaryText,
        amount_formatted:
          e.amountCents !== null ? formatCentsRo(e.amountCents, e.currency ?? 'RON') : null,
        at: e.createdAt.toISOString(),
      })),
    };
  }

  async getSubscriptionsRadar(ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    if (!this.deps.subscriptionRadarService) {
      return { error: 'Subscription Radar service is not configured.' };
    }
    const report = await this.deps.subscriptionRadarService.getRadarReport(ctx.ownerJid);
    return {
      sold_curent_demo: formatCentsRo(report.currentBalanceCents, report.balanceCurrency),
      sold_curent_cents: report.currentBalanceCents.toString(),
      active_subscriptions_count: report.activeSubscriptions.length,
      total_monthly_formatted: formatCentsRo(report.totalMonthlyCents, report.balanceCurrency),
      total_annual_formatted: formatCentsRo(report.totalAnnualCents, report.balanceCurrency),
      zombie_count: report.zombieSubscriptions.length,
      potential_zombie_annual_savings: formatCentsRo(
        report.potentialZombieAnnualSavingsCents,
        report.balanceCurrency,
      ),
      subscriptions: report.activeSubscriptions.map((s) => ({
        id: s.id,
        merchant_name: s.merchantName,
        category: s.category,
        status: s.status,
        zombie_reason: s.zombieReason,
        billing_period: s.billingPeriod,
        current_amount_formatted: formatCentsRo(s.currentAmountCents, s.currency),
        previous_amount_formatted:
          s.previousAmountCents !== null
            ? formatCentsRo(s.previousAmountCents, s.currency)
            : null,
        annualized_cost_formatted: formatCentsRo(s.annualizedCostCents, s.currency),
        charge_count: s.chargeCount,
        price_hike_count: s.priceHikeCount,
        next_expected_charge_date: s.nextExpectedChargeDate,
      })),
      recent_price_hikes: report.recentPriceHikes.map((h) => ({
        subscription_id: h.subscriptionId,
        previous: formatCentsRo(h.previousAmountCents, h.currency),
        new: formatCentsRo(h.newAmountCents, h.currency),
        monthly_delta: formatCentsRo(h.monthlyDeltaCents, h.currency),
        annual_delta: formatCentsRo(h.annualDeltaCents, h.currency),
        delta_pct: h.deltaPct,
        detected_on_date: h.detectedOnDate,
      })),
      active_free_trials: report.activeFreeTrials.map((t) => ({
        id: t.id,
        service_name: t.serviceName,
        trial_end_at: t.trialEndAt.toISOString(),
        alert_48h_scheduled_at: t.alert48hScheduledAt.toISOString(),
        post_trial_amount_formatted: formatCentsRo(t.postTrialAmountCents, t.currency),
        billing_period: t.billingPeriod,
        cancellation_url: t.cancellationUrl,
        status: t.status,
      })),
    };
  }

  async getActiveFreeTrials(ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    if (!this.deps.subscriptionRadarService) {
      return { error: 'Free Trial service is not configured.' };
    }
    const report = await this.deps.subscriptionRadarService.getRadarReport(ctx.ownerJid);
    return {
      sold_curent_demo: formatCentsRo(report.currentBalanceCents, report.balanceCurrency),
      active_free_trials_count: report.activeFreeTrials.length,
      free_trials: report.activeFreeTrials.map((t) => ({
        id: t.id,
        service_name: t.serviceName,
        trial_end_at: t.trialEndAt.toISOString(),
        alert_48h_scheduled_at: t.alert48hScheduledAt.toISOString(),
        post_trial_amount_formatted: formatCentsRo(t.postTrialAmountCents, t.currency),
        billing_period: t.billingPeriod,
        cancellation_url: t.cancellationUrl,
        status: t.status,
      })),
    };
  }

  async scheduleFreeTrialAlert(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.freeTrialService || !this.deps.demoBalanceService) {
      return { error: 'Free Trial service is not configured.' };
    }
    const serviceName = String(args.service_name ?? '').trim();
    const amount = Number(args.post_trial_amount_ron);
    if (!serviceName || Number.isNaN(amount) || amount <= 0) {
      return { error: 'Valid service_name and positive post_trial_amount_ron are required.' };
    }

    const trialEndDate =
      typeof args.trial_end_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(args.trial_end_date)
        ? new Date(
            args.trial_end_date.includes('T')
              ? args.trial_end_date
              : `${args.trial_end_date}T10:00:00Z`,
          )
        : null;
    const durationDays =
      typeof args.trial_duration_days === 'number' && args.trial_duration_days > 0
        ? Math.round(args.trial_duration_days)
        : null;

    if (!trialEndDate && !durationDays) {
      return { error: 'Provide either trial_end_date (YYYY-MM-DD) or trial_duration_days.' };
    }

    const rawPeriod = typeof args.billing_period === 'string' ? args.billing_period.toUpperCase() : 'MONTHLY';
    const billingPeriod: BillingPeriod = (BILLING_PERIODS as readonly string[]).includes(rawPeriod)
      ? (rawPeriod as BillingPeriod)
      : 'MONTHLY';

    const res = await this.deps.freeTrialService.registerFreeTrial({
      ownerJid: ctx.ownerJid,
      serviceName,
      trialEndAt: trialEndDate,
      trialDurationDays: durationDays,
      postTrialAmountCents: toBaniCents(amount),
      currency: typeof args.currency === 'string' ? args.currency.toUpperCase() : 'RON',
      billingPeriod,
      cancellationUrl: typeof args.cancellation_url === 'string' ? args.cancellation_url : null,
      source: 'WHATSAPP_MANUAL',
      now: ctx.now,
      notifyOnRegister: false, // AI Twin will reply directly in chat
    });

    const balance = await this.deps.demoBalanceService.getBalance(ctx.ownerJid);

    return {
      ok: true,
      trial_id: res.trial.id,
      service_name: res.trial.serviceName,
      trial_end_at: res.trial.trialEndAt.toISOString(),
      alert_48h_scheduled_at: res.trial.alert48hScheduledAt.toISOString(),
      post_trial_amount_formatted: formatCentsRo(res.trial.postTrialAmountCents, res.trial.currency),
      status: res.trial.status,
      sold_curent_demo: formatCentsRo(balance.balanceCents, balance.currency),
    };
  }

  async logSubscriptionCharge(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.recurrenceEngine || !this.deps.demoBalanceService) {
      return { error: 'Recurrence engine is not configured.' };
    }
    const merchantName = String(args.merchant_name ?? '').trim();
    const amount = Number(args.amount_ron);
    if (!merchantName || Number.isNaN(amount) || amount <= 0) {
      return { error: 'Valid merchant_name and positive amount_ron are required.' };
    }

    const chargedDate =
      typeof args.charged_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.charged_date)
        ? args.charged_date
        : getBucharestIsoDate(ctx.now ?? new Date());
    const rawCat = typeof args.category === 'string' ? args.category.toUpperCase() : undefined;
    const category: SubscriptionCategory | undefined =
      rawCat && (SUBSCRIPTION_CATEGORIES as readonly string[]).includes(rawCat)
        ? (rawCat as SubscriptionCategory)
        : undefined;

    const res = await this.deps.recurrenceEngine.ingestChargeEvent({
      ownerJid: ctx.ownerJid,
      externalRef: `wa:${Date.now()}:${merchantName.toLowerCase().replace(/\s+/g, '_')}`,
      merchantName,
      category,
      amountCents: toBaniCents(amount),
      currency: typeof args.currency === 'string' ? args.currency.toUpperCase() : 'RON',
      chargedDate,
      isExplicitRecurring: args.is_explicit_recurring !== false,
      source: 'WHATSAPP_MANUAL',
      rawSnippet: ctx.sourceMessageText ?? null,
    });

    const balance = await this.deps.demoBalanceService.getBalance(ctx.ownerJid);

    return {
      ok: true,
      subscription_id: res.subscription?.id ?? null,
      merchant_name: res.subscription?.merchantName ?? res.charge.merchantName,
      current_amount_formatted: formatCentsRo(res.charge.amountCents, res.charge.currency),
      annualized_cost_formatted: res.subscription
        ? formatCentsRo(res.subscription.annualizedCostCents, res.subscription.currency)
        : null,
      price_hike_detected: res.priceHikeAlert !== null,
      sold_curent_demo: formatCentsRo(balance.balanceCents, balance.currency),
    };
  }

  async updateSubscriptionOrTrialStatus(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const target = args.target === 'FREE_TRIAL' ? 'FREE_TRIAL' : 'SUBSCRIPTION';
    const action = args.action === 'CONFIRM_USED' ? 'CONFIRM_USED' : 'CANCEL';
    let id = typeof args.id === 'number' && Number.isInteger(args.id) ? args.id : null;
    const nameQuery = typeof args.name === 'string' ? args.name.trim() : '';

    if (target === 'FREE_TRIAL') {
      if (!this.deps.freeTrialService || !this.deps.freeTrialRepo) {
        return { error: 'Free Trial service is not configured.' };
      }
      if (!id && nameQuery) {
        const norm = normalizeMerchantDescriptor(nameQuery).normalizedMerchant;
        const active = await this.deps.freeTrialRepo.findActiveByOwner(ctx.ownerJid);
        const found = active.find(
          (t) =>
            t.normalizedService === norm ||
            normalizeDiacritics(t.serviceName).toLowerCase().includes(normalizeDiacritics(nameQuery).toLowerCase()),
        );
        id = found?.id ?? null;
      }
      if (!id) {
        return { ok: false, error: 'Nu am găsit un free trial activ cu acel nume sau ID.' };
      }
      const updated = await this.deps.freeTrialService.cancelTrial(id, ctx.ownerJid);
      if (!updated) {
        return { ok: false, error: `Free trial #${id} nu a fost găsit.` };
      }
      const balance = this.deps.demoBalanceService
        ? await this.deps.demoBalanceService.getBalance(ctx.ownerJid)
        : null;
      return {
        ok: true,
        target: 'FREE_TRIAL',
        id: updated.id,
        service_name: updated.serviceName,
        status: updated.status,
        sold_curent_demo: balance ? formatCentsRo(balance.balanceCents, balance.currency) : null,
      };
    }

    if (!this.deps.subscriptionRadarService || !this.deps.subscriptionRepo) {
      return { error: 'Subscription Radar service is not configured.' };
    }
    if (!id && nameQuery) {
      const norm = normalizeMerchantDescriptor(nameQuery).normalizedMerchant;
      const active = await this.deps.subscriptionRepo.findByOwner(ctx.ownerJid);
      const found = active.find(
        (s) =>
          s.normalizedMerchant === norm ||
          normalizeDiacritics(s.merchantName).toLowerCase().includes(normalizeDiacritics(nameQuery).toLowerCase()),
      );
      id = found?.id ?? null;
    }
    if (!id) {
      return { ok: false, error: 'Nu am găsit un abonament activ cu acel nume sau ID.' };
    }

    const updated =
      action === 'CONFIRM_USED'
        ? await this.deps.subscriptionRadarService.confirmSubscriptionUsed(id)
        : await this.deps.subscriptionRadarService.cancelSubscription(id, ctx.ownerJid);

    if (!updated) {
      return { ok: false, error: `Abonamentul #${id} nu a fost găsit.` };
    }

    const balance = this.deps.demoBalanceService
      ? await this.deps.demoBalanceService.getBalance(ctx.ownerJid)
      : null;

    return {
      ok: true,
      target: 'SUBSCRIPTION',
      id: updated.id,
      merchant_name: updated.merchantName,
      status: updated.status,
      sold_curent_demo: balance ? formatCentsRo(balance.balanceCents, balance.currency) : null,
    };
  }

  async scanGmailForTrialsAndSubscriptions(
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.gmailRadarService) {
      return { error: 'Gmail Radar service is not configured.' };
    }
    const scanSummary = await this.deps.gmailRadarService.scanGmailOnce(ctx.now ?? new Date());
    const balance = this.deps.demoBalanceService
      ? await this.deps.demoBalanceService.getBalance(ctx.ownerJid)
      : null;
    const activeTrials = this.deps.freeTrialRepo
      ? await this.deps.freeTrialRepo.findActiveByOwner(ctx.ownerJid)
      : [];

    return {
      ok: true,
      scanned_emails: scanSummary.scannedEmails,
      newly_detected_trials: scanSummary.detectedTrials,
      newly_detected_receipts: scanSummary.detectedReceipts,
      auto_cancelled_trials: scanSummary.autoCancelledTrials,
      price_hikes_detected: scanSummary.priceHikesDetected,
      active_free_trials: activeTrials.map((t) => ({
        id: t.id,
        service_name: t.serviceName,
        trial_end_at: t.trialEndAt.toISOString(),
        alert_48h_scheduled_at: t.alert48hScheduledAt.toISOString(),
        post_trial_amount_formatted: formatCentsRo(t.postTrialAmountCents, t.currency),
      })),
      sold_curent_demo: balance ? formatCentsRo(balance.balanceCents, balance.currency) : null,
    };
  }

  async manageDemoBalance(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.demoBalanceService) {
      return { error: 'Demo Balance service is not configured.' };
    }
    if (typeof args.new_balance_ron === 'number' && !Number.isNaN(args.new_balance_ron)) {
      const currency = typeof args.currency === 'string' ? args.currency.toUpperCase() : 'RON';
      await this.deps.demoBalanceService.setBalance(
        ctx.ownerJid,
        toBaniCents(args.new_balance_ron),
        currency,
      );
    }

    const balance = await this.deps.demoBalanceService.getBalance(ctx.ownerJid);
    const safeReport = this.deps.cashflowEngine
      ? await this.deps.cashflowEngine.computeSafeToSpend(ctx.ownerJid, ctx.now ?? new Date(), 30)
      : null;

    return {
      sold_curent_demo: formatCentsRo(balance.balanceCents, balance.currency),
      safe_to_spend_30d: safeReport
        ? formatCentsRo(safeReport.safeToSpendCents, safeReport.currency)
        : null,
      upcoming_invoices_30d: safeReport
        ? formatCentsRo(safeReport.totalUpcomingInvoicesCents, safeReport.currency)
        : null,
      upcoming_whatsapp_payments_30d: safeReport
        ? formatCentsRo(safeReport.totalUpcomingWhatsappPaymentsCents, safeReport.currency)
        : null,
      upcoming_subscriptions_30d: safeReport
        ? formatCentsRo(safeReport.totalUpcomingSubscriptionsCents, safeReport.currency)
        : null,
      total_obligations_30d: safeReport
        ? formatCentsRo(safeReport.totalObligations30dCents, safeReport.currency)
        : null,
    };
  }

  async getMonthlyEfficiencyReview(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.monthlyReviewService) {
      return { error: 'Monthly Review service is not configured.' };
    }
    const targetMonth =
      typeof args.target_month === 'string' && /^\d{4}-\d{2}$/.test(args.target_month)
        ? args.target_month
        : undefined;

    const report = await this.deps.monthlyReviewService.buildComparisonReport(
      ctx.ownerJid,
      targetMonth,
      ctx.now ?? new Date(),
    );

    return {
      sold_curent_demo: formatCentsRo(report.currentBalanceCents, report.currency),
      current_month: {
        month: report.currentMonth.yearMonth,
        total_paid: formatCentsRo(report.currentMonth.totalPaidCents, report.currency),
        bills_count: report.currentMonth.billsCount,
        paid_on_time: report.currentMonth.paidOnTimeCount,
        paid_late: report.currentMonth.paidLateCount,
        unpaid_overdue: report.currentMonth.unpaidOverdueCount,
        penalties_count: report.currentMonth.penaltiesCount,
        penalties_total: formatCentsRo(report.currentMonth.penaltiesTotalCents, report.currency),
        on_time_rate_pct: report.currentMonth.onTimeRatePct,
        efficiency_score: report.currentMonth.efficiencyScore,
        grade: report.currentMonth.grade,
        bills: report.currentMonth.items.map((item) => ({
          name: item.name,
          amount: formatCentsRo(item.amountCents, report.currency),
          status: item.paymentStatus,
          due_date: item.dueDate,
          had_penalty: item.hasPenalty,
        })),
      },
      previous_month: {
        month: report.previousMonth.yearMonth,
        total_paid: formatCentsRo(report.previousMonth.totalPaidCents, report.currency),
        bills_count: report.previousMonth.billsCount,
        paid_on_time: report.previousMonth.paidOnTimeCount,
        paid_late: report.previousMonth.paidLateCount,
        unpaid_overdue: report.previousMonth.unpaidOverdueCount,
        penalties_count: report.previousMonth.penaltiesCount,
        penalties_total: formatCentsRo(report.previousMonth.penaltiesTotalCents, report.currency),
        on_time_rate_pct: report.previousMonth.onTimeRatePct,
        efficiency_score: report.previousMonth.efficiencyScore,
        grade: report.previousMonth.grade,
        bills: report.previousMonth.items.map((item) => ({
          name: item.name,
          amount: formatCentsRo(item.amountCents, report.currency),
          status: item.paymentStatus,
          due_date: item.dueDate,
          had_penalty: item.hasPenalty,
        })),
      },
      better_month: report.betterMonth,
      recommend_savings_or_investment: report.recommendSavingsOrInvestment,
      saved_vs_previous_month: formatCentsRo(report.savedVsPreviousMonthCents, report.currency),
      annualized_savings_potential: formatCentsRo(
        report.annualizedSavingsPotentialCents,
        report.currency,
      ),
      available_months_with_data: report.availableMonthsWithData,
    };
  }
}
