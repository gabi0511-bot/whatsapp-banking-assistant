import type { StoredPaymentLink } from '../db/repositories/payment-link.repo.js';

export interface PaymentVerificationResult {
  verified: boolean;
  providerReference?: string;
  verifiedAt?: Date;
  reason?: string;
}

export interface ExternalWebhookVerificationPayload {
  token?: string;
  providerReference: string;
  amountCents: bigint;
  currency: string;
  paidAt: Date;
}

/**
 * Extensible interface allowing future bank webhook / Open Banking payment
 * confirmation without changing core QR tracking or reminder logic.
 */
export interface PaymentVerificationAdapter {
  readonly name: string;
  verifyPayment(link: StoredPaymentLink): Promise<PaymentVerificationResult>;
}
