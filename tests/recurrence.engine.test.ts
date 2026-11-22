import { describe, expect, it } from 'vitest';
import { DemoBalanceService } from '../src/cashflow/demo-balance.service.js';
import { InMemoryDemoBalanceRepository } from '../src/db/repositories/demo-balance.repo.js';
import { InMemoryFreeTrialRepository } from '../src/db/repositories/free-trial.repo.js';
import { InMemoryMemoryRepository } from '../src/db/repositories/memory.repo.js';
import { InMemoryPriceHikeRepository } from '../src/db/repositories/price-hike.repo.js';
import { InMemorySubscriptionChargeRepository } from '../src/db/repositories/subscription-charge.repo.js';
import { InMemorySubscriptionRepository } from '../src/db/repositories/subscription.repo.js';
import type { MessagingAdapter } from '../src/messaging/adapter.interface.js';
import { SubscriptionRadarService } from '../src/subscriptions/radar.service.js';
import { RecurrenceEngine } from '../src/subscriptions/recurrence.engine.js';

class SpyMessaging implements MessagingAdapter {
  public readonly sent: Array<{ toJid: string; text: string }> = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onMessage(): void {}
  async sendText(toJid: string, text: string): Promise<void> {
    this.sent.push({ toJid, text });
  }
}

function setup() {
  const ownerJid = '40712345678@s.whatsapp.net';
  const demoBalanceRepo = new InMemoryDemoBalanceRepository();
  const demoBalanceService = new DemoBalanceService(demoBalanceRepo);
  const subscriptionRepo = new InMemorySubscriptionRepository();
  const chargeRepo = new InMemorySubscriptionChargeRepository();
  const priceHikeRepo = new InMemoryPriceHikeRepository();
  const freeTrialRepo = new InMemoryFreeTrialRepository();
  const memoryRepo = new InMemoryMemoryRepository();
  const messaging = new SpyMessaging();

  const engine = new RecurrenceEngine({
    subscriptionRepo,
    chargeRepo,
    priceHikeRepo,
    memoryRepo,
    demoBalanceService,
    messaging,
    zombieMicroThresholdCents: 10_000n,
    zombieMinUnconfirmedCharges: 3,
  });

  const radar = new SubscriptionRadarService({
    subscriptionRepo,
    priceHikeRepo,
    freeTrialRepo,
    memoryRepo,
    demoBalanceService,
  });

  return { ownerJid, demoBalanceService, subscriptionRepo, priceHikeRepo, engine, radar, messaging };
}

describe('RecurrenceEngine (30d Grouping, sumă × 12, Silent Price Hikes & Zombie Radar)', () => {
  it('groups ~30-day charges into 1 subscription and ignores one-off charges 4 days apart', async () => {
    const { ownerJid, engine } = setup();

    // One-off coffee shop charges 4 days apart -> MUST NOT be grouped as monthly subscription
    const c1 = await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:coffee-1',
      merchantName: '5 TO GO BUCHAREST',
      amountCents: 1800n,
      currency: 'RON',
      chargedDate: '2026-09-01',
      source: 'DEMO_FEED',
    });
    const c2 = await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:coffee-2',
      merchantName: '5 TO GO BUCHAREST',
      amountCents: 1800n,
      currency: 'RON',
      chargedDate: '2026-09-05',
      source: 'DEMO_FEED',
    });
    expect(c1.subscription).toBeNull();
    expect(c2.subscription).toBeNull();

    // Netflix charges 30 days apart -> grouped into 1 monthly subscription with exact sumă × 12
    const n1 = await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:nf-1',
      merchantName: 'NETFLIX.COM*111',
      amountCents: 4900n,
      currency: 'RON',
      chargedDate: '2026-08-10',
      source: 'DEMO_FEED',
    });
    expect(n1.subscription).toBeNull();

    const n2 = await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:nf-2',
      merchantName: 'Netflix Romania',
      amountCents: 4900n,
      currency: 'RON',
      chargedDate: '2026-09-09',
      source: 'DEMO_FEED',
    });
    expect(n2.subscription).not.toBeNull();
    expect(n2.subscription?.normalizedMerchant).toBe('netflix');
    expect(n2.subscription?.currentAmountCents).toBe(4900n);
    expect(n2.subscription?.annualizedCostCents).toBe(4900n * 12n); // 588.00 RON
  });

  it('detects instant silent price hike (49 -> 59 RON) and sends WhatsApp alert with Sold curent (Demo)', async () => {
    const { ownerJid, demoBalanceService, engine, priceHikeRepo, messaging } = setup();
    await demoBalanceService.setBalance(ownerJid, 240_000n, 'RON'); // 2400.00 RON

    await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:nf-m1',
      merchantName: 'NETFLIX.COM*101',
      amountCents: 4900n,
      currency: 'RON',
      chargedDate: '2026-08-10',
      source: 'DEMO_FEED',
    });
    await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:nf-m2',
      merchantName: 'NETFLIX.COM*102',
      amountCents: 4900n,
      currency: 'RON',
      chargedDate: '2026-09-09',
      source: 'DEMO_FEED',
    });

    // Month 3 silent price hike: 49.00 -> 59.00 RON (+10.00/mo, +120.00/yr, +20.41%)
    const hikeRes = await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:nf-m3',
      merchantName: 'NETFLIX.COM*103',
      amountCents: 5900n,
      currency: 'RON',
      chargedDate: '2026-10-09',
      source: 'DEMO_FEED',
    });

    expect(hikeRes.priceHikeAlert).not.toBeNull();
    expect(hikeRes.priceHikeAlert?.hike.monthlyDeltaCents).toBe(1000n);
    expect(hikeRes.priceHikeAlert?.hike.annualDeltaCents).toBe(12_000n);
    expect(hikeRes.priceHikeAlert?.hike.deltaPct).toBe('20.41');
    expect(hikeRes.subscription?.annualizedCostCents).toBe(5900n * 12n);

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.text).toContain('49,00 RON');
    expect(messaging.sent[0]?.text).toContain('59,00 RON');
    expect(messaging.sent[0]?.text).toContain('120,00 RON');
    expect(messaging.sent[0]?.text).toContain('2400,00 RON');
    expect(messaging.sent[0]?.text).toContain('Sold curent (Demo)');

    const hikes = await priceHikeRepo.findRecentByOwner(ownerJid);
    expect(hikes).toHaveLength(1);

    // Duplicate externalRef must NOT fire a second alert
    const dup = await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:nf-m3',
      merchantName: 'NETFLIX.COM*103',
      amountCents: 5900n,
      currency: 'RON',
      chargedDate: '2026-10-09',
      source: 'DEMO_FEED',
    });
    expect(dup.deduplicated).toBe(true);
    expect(messaging.sent).toHaveLength(1);
  });

  it('flags zombie micro-subscriptions (3+ charges & category overlap) and handles cancel/confirm-used', async () => {
    const { ownerJid, demoBalanceService, engine, radar } = setup();
    await demoBalanceService.setBalance(ownerJid, 240_000n, 'RON');

    // Spotify 3 months (micro-drain <= 100 RON, 3 charges)
    for (const [idx, date] of ['2026-08-05', '2026-09-04', '2026-10-04'].entries()) {
      await engine.ingestChargeEvent({
        ownerJid,
        externalRef: `demo:sp-${idx}`,
        merchantName: `SPOTIFY*P00${idx}`,
        amountCents: 2400n,
        currency: 'RON',
        chargedDate: date,
        source: 'DEMO_FEED',
      });
    }

    // Two overlapping STREAMING services (Netflix + Disney+)
    await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:nf-r1',
      merchantName: 'Netflix',
      amountCents: 4900n,
      currency: 'RON',
      chargedDate: '2026-10-01',
      isExplicitRecurring: true,
      source: 'GMAIL_RECEIPT',
    });
    const disneyRes = await engine.ingestChargeEvent({
      ownerJid,
      externalRef: 'demo:dp-r1',
      merchantName: 'Disney+',
      amountCents: 3700n,
      currency: 'RON',
      chargedDate: '2026-10-02',
      isExplicitRecurring: true,
      source: 'GMAIL_RECEIPT',
    });

    const report1 = await radar.getRadarReport(ownerJid);
    expect(report1.activeSubscriptions).toHaveLength(3);
    expect(report1.totalMonthlyCents).toBe(2400n + 4900n + 3700n); // 110.00 RON
    expect(report1.totalAnnualCents).toBe((2400n + 4900n + 3700n) * 12n); // 1320.00 RON
    expect(report1.zombieSubscriptions.length).toBe(3);

    const spotify = report1.activeSubscriptions.find((s) => s.normalizedMerchant === 'spotify')!;
    expect(spotify.zombieReason).toContain('Micro-abonament recurent');

    // User confirms they actively use Spotify -> clears zombie flag
    await radar.confirmSubscriptionUsed(spotify.id);
    // User cancels Disney+ -> removed from active totals
    await radar.cancelSubscription(disneyRes.subscription!.id, ownerJid);
    await engine.evaluateZombieCandidates(ownerJid);

    const report2 = await radar.getRadarReport(ownerJid);
    expect(report2.activeSubscriptions).toHaveLength(2);
    expect(report2.totalMonthlyCents).toBe(2400n + 4900n);
    expect(report2.zombieSubscriptions).toHaveLength(0);
  });
});
