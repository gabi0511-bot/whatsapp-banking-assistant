export const SUBSCRIPTION_CATEGORIES = [
  'STREAMING',
  'CLOUD',
  'SOFTWARE_AI',
  'FITNESS',
  'MUSIC',
  'GAMING',
  'NEWS',
  'OTHER',
] as const;
export type SubscriptionCategory = (typeof SUBSCRIPTION_CATEGORIES)[number];

export const BILLING_PERIODS = ['WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export type SubscriptionStatus = 'ACTIVE' | 'ZOMBIE_SUSPECTED' | 'CANCELLED' | 'PAUSED';
export type SubscriptionSource = 'GMAIL_RECEIPT' | 'WHATSAPP_MANUAL' | 'DEMO_FEED';

export type FreeTrialStatus =
  | 'ACTIVE'
  | 'ALERT_48H_SENT'
  | 'CANCELLED'
  | 'CONVERTED'
  | 'EXPIRED';
export type FreeTrialSource = 'GMAIL_EMAIL' | 'WHATSAPP_MANUAL' | 'DEMO_FEED';

export interface StoredSubscription {
  id: number;
  ownerJid: string;
  merchantName: string;
  normalizedMerchant: string;
  category: SubscriptionCategory;
  billingCycleDays: number;
  billingPeriod: BillingPeriod;
  currentAmountCents: bigint;
  previousAmountCents: bigint | null;
  currency: string;
  annualizedCostCents: bigint;
  status: SubscriptionStatus;
  zombieReason: string | null;
  chargeCount: number;
  priceHikeCount: number;
  lastChargedDate: string;
  nextExpectedChargeDate: string;
  lastConfirmedUsedAt: Date | null;
  source: SubscriptionSource;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredSubscriptionCharge {
  id: number;
  ownerJid: string;
  subscriptionId: number | null;
  externalRef: string;
  merchantName: string;
  normalizedMerchant: string;
  category: SubscriptionCategory;
  amountCents: bigint;
  currency: string;
  chargedDate: string;
  isExplicitRecurring: boolean;
  source: SubscriptionSource;
  rawSnippet: string | null;
  createdAt: Date;
}

export interface StoredPriceHike {
  id: number;
  subscriptionId: number;
  ownerJid: string;
  previousAmountCents: bigint;
  newAmountCents: bigint;
  monthlyDeltaCents: bigint;
  annualDeltaCents: bigint;
  deltaPct: string;
  currency: string;
  detectedOnDate: string;
  notifiedWhatsappAt: Date | null;
  createdAt: Date;
}

export interface StoredFreeTrial {
  id: number;
  ownerJid: string;
  externalRef: string;
  serviceName: string;
  normalizedService: string;
  trialStartAt: Date | null;
  trialEndAt: Date;
  postTrialAmountCents: bigint;
  currency: string;
  billingPeriod: BillingPeriod;
  cancellationUrl: string | null;
  source: FreeTrialSource;
  status: FreeTrialStatus;
  alert48hScheduledAt: Date;
  alert48hSentAt: Date | null;
  rawExtractedJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DemoBalanceRecord {
  ownerJid: string;
  balanceCents: bigint;
  currency: string;
  updatedAt: Date;
}

export interface PriceHikeAlert {
  subscription: StoredSubscription;
  hike: StoredPriceHike;
  currentBalanceCents: bigint;
  balanceCurrency: string;
  whatsappMessage: string;
}

export interface RadarReport {
  ownerJid: string;
  currentBalanceCents: bigint;
  balanceCurrency: string;
  activeSubscriptions: StoredSubscription[];
  zombieSubscriptions: StoredSubscription[];
  recentPriceHikes: StoredPriceHike[];
  activeFreeTrials: StoredFreeTrial[];
  totalMonthlyCents: bigint;
  totalAnnualCents: bigint;
  potentialZombieAnnualSavingsCents: bigint;
}
