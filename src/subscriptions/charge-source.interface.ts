import type { SubscriptionCategory, SubscriptionSource } from './types.js';

export interface RawSubscriptionCharge {
  ownerJid: string;
  externalRef: string;
  merchantName: string;
  category?: SubscriptionCategory;
  amountCents: bigint;
  currency: string;
  chargedDate: string; // YYYY-MM-DD
  isExplicitRecurring?: boolean;
  source: SubscriptionSource;
  rawSnippet?: string | null;
}

/**
 * Pluggable charge feed interface (implemented by Gmail receipt scanner,
 * WhatsApp manual entry, or Demo feed — zero bank OAuth required).
 */
export interface SubscriptionChargeSource {
  readonly sourceName: SubscriptionSource;
  fetchCharges(ownerJid: string): Promise<RawSubscriptionCharge[]>;
}

export class DemoChargeFeedSource implements SubscriptionChargeSource {
  readonly sourceName: SubscriptionSource = 'DEMO_FEED';

  constructor(private readonly charges: RawSubscriptionCharge[] = []) {}

  async fetchCharges(ownerJid: string): Promise<RawSubscriptionCharge[]> {
    return this.charges.filter((c) => c.ownerJid === ownerJid);
  }
}
