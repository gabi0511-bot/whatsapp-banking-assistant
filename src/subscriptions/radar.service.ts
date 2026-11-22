import type { DemoBalanceService } from '../cashflow/demo-balance.service.js';
import type { FreeTrialRepository } from '../db/repositories/free-trial.repo.js';
import type { MemoryRepository } from '../db/repositories/memory.repo.js';
import type { PriceHikeRepository } from '../db/repositories/price-hike.repo.js';
import type { SubscriptionRepository } from '../db/repositories/subscription.repo.js';
import { formatCentsRo } from '../extraction/schema.js';
import type { RadarReport, StoredSubscription } from './types.js';

export interface SubscriptionRadarServiceDeps {
  subscriptionRepo: SubscriptionRepository;
  priceHikeRepo: PriceHikeRepository;
  freeTrialRepo: FreeTrialRepository;
  memoryRepo: MemoryRepository;
  demoBalanceService: DemoBalanceService;
}

export class SubscriptionRadarService {
  constructor(private readonly deps: SubscriptionRadarServiceDeps) {}

  async getRadarReport(ownerJid: string): Promise<RadarReport> {
    const [balance, subs, recentPriceHikes, activeFreeTrials] = await Promise.all([
      this.deps.demoBalanceService.getBalance(ownerJid),
      this.deps.subscriptionRepo.findByOwner(ownerJid, { includeCancelled: false }),
      this.deps.priceHikeRepo.findRecentByOwner(ownerJid, 10),
      this.deps.freeTrialRepo.findActiveByOwner(ownerJid),
    ]);

    const zombieSubscriptions = subs.filter((s) => s.status === 'ZOMBIE_SUSPECTED');

    let totalMonthlyCents = 0n;
    let totalAnnualCents = 0n;
    for (const sub of subs) {
      totalAnnualCents += sub.annualizedCostCents;
      if (sub.billingPeriod === 'MONTHLY') {
        totalMonthlyCents += sub.currentAmountCents;
      } else if (sub.billingPeriod === 'WEEKLY') {
        totalMonthlyCents += (sub.currentAmountCents * 52n) / 12n;
      } else {
        totalMonthlyCents += sub.currentAmountCents / 12n;
      }
    }

    const potentialZombieAnnualSavingsCents = zombieSubscriptions.reduce(
      (acc, s) => acc + s.annualizedCostCents,
      0n,
    );

    return {
      ownerJid,
      currentBalanceCents: balance.balanceCents,
      balanceCurrency: balance.currency,
      activeSubscriptions: subs,
      zombieSubscriptions,
      recentPriceHikes,
      activeFreeTrials,
      totalMonthlyCents,
      totalAnnualCents,
      potentialZombieAnnualSavingsCents,
    };
  }

  async cancelSubscription(
    subscriptionId: number,
    ownerJid: string,
  ): Promise<StoredSubscription | null> {
    const updated = await this.deps.subscriptionRepo.markCancelled(subscriptionId);
    if (!updated) return null;

    await this.deps.memoryRepo.record({
      ownerJid,
      eventType: 'SUBSCRIPTION_CANCELLED',
      entityType: 'SUBSCRIPTION',
      entityId: updated.id,
      summaryText: `Abonament anulat: ${updated.merchantName} (economie ${formatCentsRo(updated.annualizedCostCents, updated.currency)}/an).`,
      amountCents: updated.annualizedCostCents,
      currency: updated.currency,
    });

    return updated;
  }

  async confirmSubscriptionUsed(
    subscriptionId: number,
  ): Promise<StoredSubscription | null> {
    return this.deps.subscriptionRepo.markConfirmedUsed(subscriptionId, new Date());
  }
}
