import { Decimal } from 'decimal.js';
import type { DemoBalanceService } from '../cashflow/demo-balance.service.js';
import type { MemoryRepository } from '../db/repositories/memory.repo.js';
import type { PriceHikeRepository } from '../db/repositories/price-hike.repo.js';
import type { SubscriptionChargeRepository } from '../db/repositories/subscription-charge.repo.js';
import type { SubscriptionRepository } from '../db/repositories/subscription.repo.js';
import { formatCentsRo } from '../extraction/schema.js';
import type { MessagingAdapter } from '../messaging/adapter.interface.js';
import {
  computeAnnualizedCents,
  FallbackAlertComposer,
  type AlertMessageComposer,
} from './ai-alert.composer.js';
import type { RawSubscriptionCharge } from './charge-source.interface.js';
import { normalizeMerchantDescriptor } from './merchant.normalizer.js';
import type {
  BillingPeriod,
  PriceHikeAlert,
  StoredSubscription,
  StoredSubscriptionCharge,
  SubscriptionCategory,
} from './types.js';

const DISCRETIONARY_OVERLAP_CATEGORIES = new Set<SubscriptionCategory>([
  'STREAMING',
  'MUSIC',
  'CLOUD',
  'FITNESS',
  'GAMING',
]);

export interface RecurrenceEngineDeps {
  subscriptionRepo: SubscriptionRepository;
  chargeRepo: SubscriptionChargeRepository;
  priceHikeRepo: PriceHikeRepository;
  memoryRepo: MemoryRepository;
  demoBalanceService: DemoBalanceService;
  messaging: MessagingAdapter;
  alertComposer?: AlertMessageComposer;
  zombieMicroThresholdCents?: bigint;
  zombieMinUnconfirmedCharges?: number;
}

export interface IngestChargeResult {
  deduplicated: boolean;
  charge: StoredSubscriptionCharge;
  subscription: StoredSubscription | null;
  priceHikeAlert: PriceHikeAlert | null;
}

function diffDaysIso(olderIso: string, newerIso: string): number {
  const olderMs = Date.parse(`${olderIso}T00:00:00Z`);
  const newerMs = Date.parse(`${newerIso}T00:00:00Z`);
  return Math.round((newerMs - olderMs) / 86_400_000);
}

function addDaysIso(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function detectCadence(gapDays: number): { period: BillingPeriod; cycleDays: number } | null {
  if (gapDays >= 25 && gapDays <= 35) {
    return { period: 'MONTHLY', cycleDays: 30 };
  }
  if (gapDays >= 350 && gapDays <= 380) {
    return { period: 'YEARLY', cycleDays: 365 };
  }
  if (gapDays >= 6 && gapDays <= 8) {
    return { period: 'WEEKLY', cycleDays: 7 };
  }
  return null;
}

export class RecurrenceEngine {
  private readonly composer: AlertMessageComposer;
  private readonly zombieMicroThresholdCents: bigint;
  private readonly zombieMinUnconfirmedCharges: number;

  constructor(private readonly deps: RecurrenceEngineDeps) {
    this.composer = deps.alertComposer ?? new FallbackAlertComposer();
    this.zombieMicroThresholdCents = deps.zombieMicroThresholdCents ?? 10_000n;
    this.zombieMinUnconfirmedCharges = deps.zombieMinUnconfirmedCharges ?? 3;
  }

  async ingestChargeEvent(raw: RawSubscriptionCharge): Promise<IngestChargeResult> {
    const normalized = normalizeMerchantDescriptor(raw.merchantName, raw.category);
    const currency = raw.currency.toUpperCase();

    // 1. Idempotent insert keyed by external_ref
    const { inserted, charge } = await this.deps.chargeRepo.insertIfNew({
      ownerJid: raw.ownerJid,
      externalRef: raw.externalRef,
      merchantName: normalized.displayName,
      normalizedMerchant: normalized.normalizedMerchant,
      category: normalized.category,
      amountCents: raw.amountCents,
      currency,
      chargedDate: raw.chargedDate,
      isExplicitRecurring: Boolean(raw.isExplicitRecurring),
      source: raw.source,
      rawSnippet: raw.rawSnippet ?? null,
    });

    if (!inserted) {
      const existingSub = await this.deps.subscriptionRepo.findByKey(
        raw.ownerJid,
        normalized.normalizedMerchant,
        currency,
      );
      return {
        deduplicated: true,
        charge,
        subscription: existingSub,
        priceHikeAlert: null,
      };
    }

    // 2. Check recurrence history for (owner_jid, normalized_merchant, currency)
    const historyDesc = await this.deps.chargeRepo.findHistoryForMerchant(
      raw.ownerJid,
      normalized.normalizedMerchant,
      currency,
    );
    // Chronological ascending order for gap detection
    const historyAsc = [...historyDesc].sort((a, b) => {
      if (a.chargedDate !== b.chargedDate) {
        return a.chargedDate.localeCompare(b.chargedDate);
      }
      return a.id - b.id;
    });

    const existingSub = await this.deps.subscriptionRepo.findByKey(
      raw.ownerJid,
      normalized.normalizedMerchant,
      currency,
    );

    let detectedCadence: { period: BillingPeriod; cycleDays: number } | null = null;
    for (let i = historyAsc.length - 1; i > 0; i--) {
      const newer = historyAsc[i]!;
      const older = historyAsc[i - 1]!;
      const gap = diffDaysIso(older.chargedDate, newer.chargedDate);
      const cadence = detectCadence(gap);
      if (cadence) {
        detectedCadence = cadence;
        break;
      }
    }

    const isRecurring =
      existingSub !== null ||
      detectedCadence !== null ||
      historyAsc.some((c) => c.isExplicitRecurring);

    if (!isRecurring) {
      return {
        deduplicated: false,
        charge,
        subscription: null,
        priceHikeAlert: null,
      };
    }

    const period: BillingPeriod = detectedCadence?.period ?? existingSub?.billingPeriod ?? 'MONTHLY';
    const cycleDays = detectedCadence?.cycleDays ?? existingSub?.billingCycleDays ?? 30;
    const latestCharge = historyAsc[historyAsc.length - 1]!;
    const annualizedCostCents = computeAnnualizedCents(latestCharge.amountCents, period);
    const nextExpectedChargeDate = addDaysIso(latestCharge.chargedDate, cycleDays);

    // Detect silent price hike (ANY increase on a newer chronological charge)
    const isNewerThanSub =
      existingSub !== null && raw.chargedDate > existingSub.lastChargedDate;
    const isPriceHikeOnExisting =
      isNewerThanSub && raw.amountCents > existingSub.currentAmountCents;

    // Also handle first-time grouping where the 2nd charge (forming the ~30d subscription) already jumped vs charge #1
    const prevChronCharge =
      historyAsc.length >= 2 ? historyAsc[historyAsc.length - 2]! : null;
    const isPriceHikeOnFormation =
      existingSub === null &&
      prevChronCharge !== null &&
      latestCharge.id === charge.id &&
      latestCharge.amountCents > prevChronCharge.amountCents;

    const hasPriceHike = isPriceHikeOnExisting || isPriceHikeOnFormation;
    const prevAmountForHike = isPriceHikeOnExisting
      ? existingSub.currentAmountCents
      : isPriceHikeOnFormation && prevChronCharge
        ? prevChronCharge.amountCents
        : existingSub?.previousAmountCents ?? null;

    const newPriceHikeCount =
      (existingSub?.priceHikeCount ?? 0) + (hasPriceHike ? 1 : 0);

    const subscription = await this.deps.subscriptionRepo.upsert({
      ownerJid: raw.ownerJid,
      merchantName: normalized.displayName,
      normalizedMerchant: normalized.normalizedMerchant,
      category: normalized.category,
      billingCycleDays: cycleDays,
      billingPeriod: period,
      currentAmountCents: latestCharge.amountCents,
      previousAmountCents: hasPriceHike
        ? prevAmountForHike
        : existingSub?.previousAmountCents ?? prevChronCharge?.amountCents ?? null,
      currency,
      annualizedCostCents,
      status: existingSub?.status === 'CANCELLED' ? 'ACTIVE' : (existingSub?.status ?? 'ACTIVE'),
      zombieReason: existingSub?.zombieReason ?? null,
      chargeCount: historyAsc.length,
      priceHikeCount: newPriceHikeCount,
      lastChargedDate: latestCharge.chargedDate,
      nextExpectedChargeDate,
      lastConfirmedUsedAt: existingSub?.lastConfirmedUsedAt ?? null,
      source: raw.source,
    });

    await this.deps.chargeRepo.attachToSubscription(
      historyAsc.map((c) => c.id),
      subscription.id,
    );

    if (!existingSub) {
      await this.deps.memoryRepo.record({
        ownerJid: raw.ownerJid,
        eventType: 'SUBSCRIPTION_DETECTED',
        entityType: 'SUBSCRIPTION',
        entityId: subscription.id,
        summaryText: `Abonament recurent detectat: ${subscription.merchantName} — ${formatCentsRo(subscription.currentAmountCents, currency)}/lună (${formatCentsRo(subscription.annualizedCostCents, currency)}/an).`,
        amountCents: subscription.currentAmountCents,
        currency,
        metadata: {
          category: subscription.category,
          billingPeriod: subscription.billingPeriod,
          annualizedCostCents: subscription.annualizedCostCents.toString(),
        },
      });
    }

    let priceHikeAlert: PriceHikeAlert | null = null;
    if (hasPriceHike && prevAmountForHike !== null && prevAmountForHike > 0n) {
      const monthlyDeltaCents = latestCharge.amountCents - prevAmountForHike;
      const annualDeltaCents = computeAnnualizedCents(monthlyDeltaCents, period);
      const deltaPct = new Decimal(monthlyDeltaCents.toString())
        .div(new Decimal(prevAmountForHike.toString()))
        .mul(100)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toFixed(2);

      const balance = await this.deps.demoBalanceService.getBalance(raw.ownerJid);

      const hike = await this.deps.priceHikeRepo.create({
        subscriptionId: subscription.id,
        ownerJid: raw.ownerJid,
        previousAmountCents: prevAmountForHike,
        newAmountCents: latestCharge.amountCents,
        monthlyDeltaCents,
        annualDeltaCents,
        deltaPct,
        currency,
        detectedOnDate: latestCharge.chargedDate,
        notifiedWhatsappAt: new Date(),
      });

      const whatsappMessage = await this.composer.composePriceHikeAlert({
        subscription,
        hike,
        currentBalanceCents: balance.balanceCents,
        balanceCurrency: balance.currency,
      });

      await this.deps.messaging.sendText(raw.ownerJid, whatsappMessage);

      await this.deps.memoryRepo.record({
        ownerJid: raw.ownerJid,
        eventType: 'SUBSCRIPTION_PRICE_HIKE',
        entityType: 'SUBSCRIPTION',
        entityId: subscription.id,
        summaryText: `Scumpire silențioasă la ${subscription.merchantName}: de la ${formatCentsRo(prevAmountForHike, currency)} la ${formatCentsRo(latestCharge.amountCents, currency)} (+${deltaPct}%, +${formatCentsRo(annualDeltaCents, currency)}/an).`,
        amountCents: monthlyDeltaCents,
        currency,
        metadata: {
          previousAmountCents: prevAmountForHike.toString(),
          newAmountCents: latestCharge.amountCents.toString(),
          annualDeltaCents: annualDeltaCents.toString(),
          deltaPct,
        },
      });

      priceHikeAlert = {
        subscription,
        hike,
        currentBalanceCents: balance.balanceCents,
        balanceCurrency: balance.currency,
        whatsappMessage,
      };
    }

    // Re-evaluate zombie micro-subscription flags across all owner subscriptions
    await this.evaluateZombieCandidates(raw.ownerJid);
    const refreshed = await this.deps.subscriptionRepo.findById(subscription.id);

    return {
      deduplicated: false,
      charge,
      subscription: refreshed ?? subscription,
      priceHikeAlert,
    };
  }

  async evaluateZombieCandidates(
    ownerJid: string,
    now: Date = new Date(),
  ): Promise<StoredSubscription[]> {
    const activeSubs = await this.deps.subscriptionRepo.findByOwner(ownerJid, {
      includeCancelled: false,
    });
    const ninetyDaysMs = 90 * 86_400_000;

    // Group by discretionary category for overlap detection
    const byCategory = new Map<SubscriptionCategory, StoredSubscription[]>();
    for (const sub of activeSubs) {
      if (DISCRETIONARY_OVERLAP_CATEGORIES.has(sub.category)) {
        const list = byCategory.get(sub.category) ?? [];
        list.push(sub);
        byCategory.set(sub.category, list);
      }
    }

    const flagged: StoredSubscription[] = [];

    for (const sub of activeSubs) {
      const recentlyConfirmed =
        sub.lastConfirmedUsedAt !== null &&
        now.getTime() - sub.lastConfirmedUsedAt.getTime() < ninetyDaysMs;

      if (recentlyConfirmed) {
        if (sub.status === 'ZOMBIE_SUSPECTED') {
          await this.deps.subscriptionRepo.updateZombieState(sub.id, 'ACTIVE', null);
        }
        continue;
      }

      const reasons: string[] = [];

      // Rule 1: Silent micro-drain
      if (
        sub.chargeCount >= this.zombieMinUnconfirmedCharges &&
        sub.currentAmountCents <= this.zombieMicroThresholdCents
      ) {
        reasons.push(
          `Micro-abonament recurent de ${sub.chargeCount} luni neconfirmat ca utilizat`,
        );
      }

      // Rule 2: Category overlap (2+ active services in same discretionary category)
      const sameCategory = byCategory.get(sub.category) ?? [];
      if (sameCategory.length >= 2) {
        const combinedAnnual = sameCategory.reduce((acc, s) => acc + s.annualizedCostCents, 0n);
        reasons.push(
          `Suprapunere categorie ${sub.category} (${sameCategory.length} servicii active: ${formatCentsRo(combinedAnnual, sub.currency)}/an)`,
        );
      }

      // Rule 3: Repeated price hike on unconfirmed service
      if (sub.priceHikeCount >= 1) {
        reasons.push(`Scumpire detectată (${sub.priceHikeCount}x) pe serviciu neconfirmat`);
      }

      if (reasons.length > 0) {
        const reasonText = reasons.join('; ');
        const wasAlreadyZombie = sub.status === 'ZOMBIE_SUSPECTED';
        const updated = await this.deps.subscriptionRepo.updateZombieState(
          sub.id,
          'ZOMBIE_SUSPECTED',
          reasonText,
        );
        if (updated) {
          flagged.push(updated);
          if (!wasAlreadyZombie) {
            await this.deps.memoryRepo.record({
              ownerJid,
              eventType: 'SUBSCRIPTION_ZOMBIE_FLAGGED',
              entityType: 'SUBSCRIPTION',
              entityId: updated.id,
              summaryText: `Posibil abonament „zombie”: ${updated.merchantName} (${formatCentsRo(updated.annualizedCostCents, updated.currency)}/an) — ${reasonText}.`,
              amountCents: updated.annualizedCostCents,
              currency: updated.currency,
              metadata: { reason: reasonText },
            });
          }
        }
      } else if (sub.status === 'ZOMBIE_SUSPECTED') {
        await this.deps.subscriptionRepo.updateZombieState(sub.id, 'ACTIVE', null);
      }
    }

    return flagged;
  }
}
