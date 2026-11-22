import { Decimal } from 'decimal.js';
import type { InvoiceRepository } from '../db/repositories/invoice.repo.js';
import type {
  PaymentLinkRepository,
  StoredPaymentLink,
} from '../db/repositories/payment-link.repo.js';
import { normalizeDiacritics } from '../extraction/schema.js';
import type { QrTrackingService } from './qr.tracking.service.js';

export interface ReceiptEmailCandidate {
  messageId: string;
  subject: string;
  from: string;
  bodyText: string;
  receivedAt?: Date;
}

export interface ReceiptMatchResult {
  matched: boolean;
  paymentLink?: StoredPaymentLink;
  messageId: string;
}

const RECEIPT_KEYWORDS = [
  'confirmare plata',
  'plata confirmata',
  'plata a fost efectuata',
  'plata procesata',
  'tranzactie reusita',
  'achitat cu succes',
  'payment confirmation',
  'payment receipt',
  'payment successful',
] as const;

export function isPaymentReceiptEmail(subject: string, bodyText: string): boolean {
  const combined = normalizeDiacritics(`${subject} ${bodyText}`).toLowerCase();
  return RECEIPT_KEYWORDS.some((kw) => combined.includes(kw));
}

export function extractCandidateAmountsCents(text: string): Set<bigint> {
  const results = new Set<bigint>();
  // Matches Romanian formatted amounts like 1.234,56 or 245,80 and standard 245.80
  const regex = /\b(\d{1,3}(?:\.\d{3})*,\d{2}|\d+[.,]\d{2})\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const normalized = raw.includes(',')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw;
    try {
      const cents = BigInt(
        new Decimal(normalized).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
      );
      if (cents > 0n) {
        results.add(cents);
      }
    } catch {
      // Ignore unparseable token
    }
  }
  return results;
}

export class PaymentReceiptMatcher {
  constructor(
    private readonly paymentLinkRepo: PaymentLinkRepository,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly qrTrackingService: QrTrackingService,
  ) {}

  async matchAndReconcile(email: ReceiptEmailCandidate): Promise<ReceiptMatchResult> {
    if (!isPaymentReceiptEmail(email.subject, email.bodyText)) {
      return { matched: false, messageId: email.messageId };
    }

    const amounts = extractCandidateAmountsCents(`${email.subject}\n${email.bodyText}`);
    if (amounts.size === 0) {
      return { matched: false, messageId: email.messageId };
    }

    const normalizedText = normalizeDiacritics(
      `${email.subject} ${email.from} ${email.bodyText}`,
    ).toLowerCase();

    const activeLinks = await this.paymentLinkRepo.findActiveLinks();

    for (const link of activeLinks) {
      if (!amounts.has(link.amountCents)) {
        continue;
      }

      const payeeNorm = normalizeDiacritics(link.payeeName).toLowerCase();
      const payeeFirstToken = payeeNorm.split(/\s+/)[0] ?? payeeNorm;
      const matchesPayee =
        normalizedText.includes(payeeNorm) ||
        (payeeFirstToken.length >= 3 && normalizedText.includes(payeeFirstToken));

      let matchesInvoiceNumber = false;
      if (link.targetType === 'INVOICE' && link.invoiceId !== null) {
        const inv = await this.invoiceRepo.findById(link.invoiceId);
        if (inv && normalizedText.includes(inv.invoiceNumber.toLowerCase())) {
          matchesInvoiceNumber = true;
        }
      }

      const matchesReference =
        link.paymentReference !== null &&
        link.paymentReference.length >= 4 &&
        normalizedText.includes(normalizeDiacritics(link.paymentReference).toLowerCase());

      if (matchesPayee || matchesInvoiceNumber || matchesReference) {
        await this.qrTrackingService.confirmPaymentByToken(link.token, 'EMAIL_RECEIPT', {
          completedAt: email.receivedAt ?? new Date(),
          notifyWhatsApp: true,
        });
        return {
          matched: true,
          paymentLink: link,
          messageId: email.messageId,
        };
      }
    }

    return { matched: false, messageId: email.messageId };
  }
}
