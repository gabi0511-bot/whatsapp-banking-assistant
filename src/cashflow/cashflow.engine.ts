import type { InvoiceRepository } from '../db/repositories/invoice.repo.js';
import type { SubscriptionRepository } from '../db/repositories/subscription.repo.js';
import type { WhatsappPaymentRepository } from '../db/repositories/whatsapp-payment.repo.js';
import { getBucharestIsoDate } from '../payments/qr.tracking.service.js';
import { normalizeMerchantDescriptor } from '../subscriptions/merchant.normalizer.js';
import type { DemoBalanceService } from './demo-balance.service.js';

export interface SafeToSpendObligation {
  source: 'INVOICE' | 'WHATSAPP_PAYMENT' | 'SUBSCRIPTION';
  id: number;
  name: string;
  normalizedKey: string;
  amountCents: bigint;
  currency: string;
  dueDate: string;
}

export interface SafeToSpendReport {
  asOfDate: string;
  horizonDays: number;
  currentBalanceCents: bigint;
  currency: string;
  totalUpcomingInvoicesCents: bigint;
  totalUpcomingWhatsappPaymentsCents: bigint;
  totalUpcomingSubscriptionsCents: bigint;
  totalObligations30dCents: bigint;
  safeToSpendCents: bigint;
  obligations: SafeToSpendObligation[];
}

export interface CashflowEngineDeps {
  demoBalanceService: DemoBalanceService;
  invoiceRepo: InvoiceRepository;
  whatsappPaymentRepo: WhatsappPaymentRepository;
  subscriptionRepo?: SubscriptionRepository;
}

function addDaysIso(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export class CashflowEngine {
  constructor(private readonly deps: CashflowEngineDeps) {}

  async computeSafeToSpend(
    ownerJid: string,
    now: Date = new Date(),
    horizonDays = 30,
  ): Promise<SafeToSpendReport> {
    const todayIso = getBucharestIsoDate(now);
    const horizonIso = addDaysIso(todayIso, horizonDays);

    const [balance, unpaidInvoices, unpaidWaPayments, activeSubs] = await Promise.all([
      this.deps.demoBalanceService.getBalance(ownerJid),
      this.deps.invoiceRepo.findUnpaidOrHeld(),
      this.deps.whatsappPaymentRepo.findByOwner(ownerJid, { status: 'UNPAID' }),
      this.deps.subscriptionRepo
        ? this.deps.subscriptionRepo.findByOwner(ownerJid, { includeCancelled: false })
        : Promise.resolve([]),
    ]);

    const obligations: SafeToSpendObligation[] = [];
    const countedNormalizedMerchants = new Set<string>();

    let totalUpcomingInvoicesCents = 0n;
    for (const inv of unpaidInvoices) {
      if (inv.totalAmountCents <= 0n || inv.currency !== balance.currency) continue;
      if (inv.dueDate <= horizonIso) {
        const norm = normalizeMerchantDescriptor(inv.providerName).normalizedMerchant;
        countedNormalizedMerchants.add(norm);
        totalUpcomingInvoicesCents += inv.totalAmountCents;
        obligations.push({
          source: 'INVOICE',
          id: inv.id,
          name: inv.providerName,
          normalizedKey: norm,
          amountCents: inv.totalAmountCents,
          currency: inv.currency,
          dueDate: inv.dueDate,
        });
      }
    }

    let totalUpcomingWhatsappPaymentsCents = 0n;
    for (const p of unpaidWaPayments) {
      if (p.currency !== balance.currency) continue;
      const due = p.dueDate ?? todayIso;
      if (due <= horizonIso) {
        const normPayee = normalizeMerchantDescriptor(p.payeeName).normalizedMerchant;
        const normTitle = normalizeMerchantDescriptor(p.title).normalizedMerchant;
        countedNormalizedMerchants.add(normPayee);
        countedNormalizedMerchants.add(normTitle);
        totalUpcomingWhatsappPaymentsCents += p.amountCents;
        obligations.push({
          source: 'WHATSAPP_PAYMENT',
          id: p.id,
          name: p.title,
          normalizedKey: normPayee,
          amountCents: p.amountCents,
          currency: p.currency,
          dueDate: due,
        });
      }
    }

    let totalUpcomingSubscriptionsCents = 0n;
    for (const sub of activeSubs) {
      if (sub.currency !== balance.currency) continue;
      if (sub.nextExpectedChargeDate >= todayIso && sub.nextExpectedChargeDate <= horizonIso) {
        // Strict deduplication: never double-count a subscription already counted in invoices or WhatsApp payments
        if (countedNormalizedMerchants.has(sub.normalizedMerchant)) {
          continue;
        }
        countedNormalizedMerchants.add(sub.normalizedMerchant);
        totalUpcomingSubscriptionsCents += sub.currentAmountCents;
        obligations.push({
          source: 'SUBSCRIPTION',
          id: sub.id,
          name: sub.merchantName,
          normalizedKey: sub.normalizedMerchant,
          amountCents: sub.currentAmountCents,
          currency: sub.currency,
          dueDate: sub.nextExpectedChargeDate,
        });
      }
    }

    obligations.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    const totalObligations30dCents =
      totalUpcomingInvoicesCents +
      totalUpcomingWhatsappPaymentsCents +
      totalUpcomingSubscriptionsCents;

    return {
      asOfDate: todayIso,
      horizonDays,
      currentBalanceCents: balance.balanceCents,
      currency: balance.currency,
      totalUpcomingInvoicesCents,
      totalUpcomingWhatsappPaymentsCents,
      totalUpcomingSubscriptionsCents,
      totalObligations30dCents,
      safeToSpendCents: balance.balanceCents - totalObligations30dCents,
      obligations,
    };
  }
}
