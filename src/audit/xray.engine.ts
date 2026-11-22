import { buildDisputeDraft } from './rules/dispute.rule.js';
import { evaluatePricingRule } from './rules/pricing.rule.js';
import { evaluateReadingRule } from './rules/reading.rule.js';
import type { AuditContext, AuditResult, PaymentStatus } from './types.js';

export class XRayEngine {
  audit(ctx: AuditContext): AuditResult {
    const {
      invoice,
      rawText,
      previousInvoice,
      recentRealInvoices,
      recentEstimatedInvoices,
      providerConfig,
      userFullName,
      now,
    } = ctx;

    // Pillar 1: Reading audit (estimated vs real, index overlap, repeated estimate, self-reading reminder)
    const readingResult = evaluateReadingRule({
      invoice,
      rawText,
      previousInvoice,
      providerConfig,
      now,
    });

    // Pillar 2: Pricing, promo expiration, penalties, daily consumption spike, regularization audit
    const pricingFlags = evaluatePricingRule({
      invoice,
      effectiveReadingType: readingResult.effectiveReadingType,
      previousInvoice,
      recentRealInvoices,
      recentEstimatedInvoices,
      providerConfig,
    });

    const allFlags = [
      ...invoice.validationFlags,
      ...readingResult.flags,
      ...pricingFlags,
    ];

    // Pillar 3: Dispute draft generation (auto-generated on any CRITICAL flag)
    const disputeDraft = buildDisputeDraft({
      invoice,
      flags: allFlags,
      providerConfig,
      userFullName,
      includeWarnings: false,
    });

    const hasCriticalFlag = allFlags.some((f) => f.severity === 'CRITICAL');

    let paymentStatus: PaymentStatus = invoice.paymentStatus;
    if (invoice.totalAmountCents <= 0n) {
      paymentStatus = 'NO_PAYMENT_NEEDED';
    } else if (hasCriticalFlag) {
      paymentStatus = 'HOLD_BEFORE_PAYMENT';
    } else {
      paymentStatus = 'UNPAID';
    }

    return {
      readingType: readingResult.effectiveReadingType,
      paymentStatus,
      flags: allFlags,
      scheduledReminder: readingResult.scheduledReminder,
      disputeDraft,
    };
  }
}
