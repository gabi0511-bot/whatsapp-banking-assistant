import { CashflowEngine } from '../src/cashflow/cashflow.engine.js';
import { DemoBalanceService } from '../src/cashflow/demo-balance.service.js';
import { InMemoryDemoBalanceRepository } from '../src/db/repositories/demo-balance.repo.js';
import { InMemoryFreeTrialRepository } from '../src/db/repositories/free-trial.repo.js';
import { InMemoryInvoiceRepository } from '../src/db/repositories/invoice.repo.js';
import { InMemoryMemoryRepository } from '../src/db/repositories/memory.repo.js';
import { InMemoryPriceHikeRepository } from '../src/db/repositories/price-hike.repo.js';
import { InMemorySubscriptionChargeRepository } from '../src/db/repositories/subscription-charge.repo.js';
import { InMemorySubscriptionRepository } from '../src/db/repositories/subscription.repo.js';
import { InMemoryWhatsappPaymentRepository } from '../src/db/repositories/whatsapp-payment.repo.js';
import { formatCentsRo } from '../src/extraction/schema.js';
import type { MessagingAdapter } from '../src/messaging/adapter.interface.js';
import { formatSubscriptionRadarReport } from '../src/messaging/formatter.js';
import { DemoChargeFeedSource } from '../src/subscriptions/charge-source.interface.js';
import { FreeTrialService } from '../src/subscriptions/free-trial.service.js';
import { GmailRadarService } from '../src/subscriptions/gmail-radar.service.js';
import { SubscriptionRadarService } from '../src/subscriptions/radar.service.js';
import { RecurrenceEngine } from '../src/subscriptions/recurrence.engine.js';
import { RuleBasedEmailTrialExtractor } from '../src/subscriptions/trial.extractor.js';

class ConsoleRadarMessaging implements MessagingAdapter {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onMessage(): void {}
  async sendText(toJid: string, text: string): Promise<void> {
    console.log(`\n┌── [WhatsApp → ${toJid}] ${'─'.repeat(42)}`);
    for (const line of text.split('\n')) {
      console.log(`│ ${line}`);
    }
    console.log(`└${'─'.repeat(72)}`);
  }
}

async function main(): Promise<void> {
  const ownerJid = '40712345678@s.whatsapp.net';

  const demoBalanceService = new DemoBalanceService(new InMemoryDemoBalanceRepository());
  const invoiceRepo = new InMemoryInvoiceRepository();
  const waPaymentRepo = new InMemoryWhatsappPaymentRepository();
  const subscriptionRepo = new InMemorySubscriptionRepository();
  const chargeRepo = new InMemorySubscriptionChargeRepository();
  const priceHikeRepo = new InMemoryPriceHikeRepository();
  const freeTrialRepo = new InMemoryFreeTrialRepository();
  const memoryRepo = new InMemoryMemoryRepository();
  const messaging = new ConsoleRadarMessaging();

  const recurrenceEngine = new RecurrenceEngine({
    subscriptionRepo,
    chargeRepo,
    priceHikeRepo,
    memoryRepo,
    demoBalanceService,
    messaging,
    zombieMicroThresholdCents: 10_000n,
    zombieMinUnconfirmedCharges: 3,
  });

  const freeTrialService = new FreeTrialService({
    freeTrialRepo,
    memoryRepo,
    demoBalanceService,
    messaging,
  });

  const gmailRadarService = new GmailRadarService({
    gmailClient: {
      fetchMatchingInvoiceEmails: async () => [],
      createGmailDraft: async () => 'mock-draft',
    },
    extractor: new RuleBasedEmailTrialExtractor(),
    freeTrialService,
    recurrenceEngine,
    ownerJid,
    freeTrialQuery: '',
    subscriptionReceiptQuery: '',
  });

  const radarService = new SubscriptionRadarService({
    subscriptionRepo,
    priceHikeRepo,
    freeTrialRepo,
    memoryRepo,
    demoBalanceService,
  });

  const cashflowEngine = new CashflowEngine({
    demoBalanceService,
    invoiceRepo,
    whatsappPaymentRepo: waPaymentRepo,
    subscriptionRepo,
  });

  console.log('=========================================================================');
  console.log('   SUBSCRIPTION "ZOMBIE" RADAR, PRICE-HIKE & 48H FREE-TRIAL SIMULATOR');
  console.log('   Mode: 100% Offline (Demo Balance + Demo Feed + Simulated Gmail Trial)');
  console.log('=========================================================================');

  // 1. Set Demo Balance: 2.400,00 RON
  await demoBalanceService.setBalance(ownerJid, 240_000n, 'RON');
  console.log('\n▶ STEP 1: Demo Balance set -> Sold curent (Demo): 2400,00 RON');

  // 2. Feed 3 months of recurring ~30d charges
  console.log('\n▶ STEP 2: Ingesting 3 months of recurring ~30-day micro-subscription charges...');
  const months = ['2026-08-10', '2026-09-09', '2026-10-09'];
  const demoFeed = new DemoChargeFeedSource([
    ...months.map((d, i) => ({
      ownerJid,
      externalRef: `demo:spotify-${i}`,
      merchantName: `SPOTIFY*P23${i}AB`,
      amountCents: 2400n,
      currency: 'RON',
      chargedDate: d,
      source: 'DEMO_FEED' as const,
    })),
    ...months.map((d, i) => ({
      ownerJid,
      externalRef: `demo:netflix-${i}`,
      merchantName: `NETFLIX.COM*88${i}`,
      amountCents: 4900n,
      currency: 'RON',
      chargedDate: d,
      source: 'DEMO_FEED' as const,
    })),
    ...months.map((d, i) => ({
      ownerJid,
      externalRef: `demo:icloud-${i}`,
      merchantName: 'APPLE.COM/BILL ICLOUD',
      amountCents: 1500n,
      currency: 'RON',
      chargedDate: d,
      source: 'DEMO_FEED' as const,
    })),
    ...months.map((d, i) => ({
      ownerJid,
      externalRef: `demo:disney-${i}`,
      merchantName: 'DISNEY PLUS EUROPE',
      amountCents: 3700n,
      currency: 'RON',
      chargedDate: d,
      source: 'DEMO_FEED' as const,
    })),
    ...months.map((d, i) => ({
      ownerJid,
      externalRef: `demo:worldclass-${i}`,
      merchantName: 'WORLD CLASS ROMANIA',
      amountCents: 28_000n,
      currency: 'RON',
      chargedDate: d,
      source: 'DEMO_FEED' as const,
    })),
  ]);

  const initialCharges = await demoFeed.fetchCharges(ownerJid);
  for (const charge of initialCharges) {
    await recurrenceEngine.ingestChargeEvent(charge);
  }

  // 3. Month 4: Netflix jumps 49 -> 59 RON, Spotify jumps 24 -> 29 RON
  console.log('\n▶ STEP 3: Month 4 — Silent Price Hikes (Netflix 49 -> 59 RON, Spotify 24 -> 29 RON)...');
  await recurrenceEngine.ingestChargeEvent({
    ownerJid,
    externalRef: 'demo:netflix-m4',
    merchantName: 'NETFLIX.COM*999',
    amountCents: 5900n,
    currency: 'RON',
    chargedDate: '2026-11-08',
    source: 'DEMO_FEED',
  });

  await recurrenceEngine.ingestChargeEvent({
    ownerJid,
    externalRef: 'demo:spotify-m4',
    merchantName: 'Spotify AB',
    amountCents: 2900n,
    currency: 'RON',
    chargedDate: '2026-11-08',
    source: 'DEMO_FEED',
  });

  // 4. Simulated Gmail Free-Trial Activation Email (Adobe Creative Cloud — 14 days, 149 RON/month)
  console.log('\n▶ STEP 4: Simulated Gmail Free-Trial Email -> Scheduling 48h Alert...');
  const emailDate = new Date('2026-11-21T10:00:00Z');
  await gmailRadarService.processEmail(
    {
      messageId: 'sim-gmail-adobe-trial',
      subject: 'Perioadă de probă gratuită Adobe Creative Cloud — 14 zile',
      from: 'Adobe <billing@adobe.com>',
      bodyText:
        'Bun venit! Perioada de probă gratuită de 14 zile este activă. Reînnoire automată 149,00 RON/lună după expirare. Gestionează abonamentul la https://account.adobe.com/plans',
      extractedLinks: ['https://account.adobe.com/plans'],
      receivedAt: emailDate,
    },
    emailDate,
  );

  // Advance clock to T-48h (2026-12-03T10:05:00Z) and fire cron dispatcher
  console.log('\n▶ STEP 4b: Advancing clock to T-48h (2026-12-03 10:05 UTC) & dispatching 48h alert...');
  await freeTrialService.dispatchDue48hAlerts(new Date('2026-12-03T10:05:00Z'));

  // 5. Full /abonamente Radar Report + Safe-to-Spend 30-day breakdown
  console.log('\n▶ STEP 5: Full Subscription Radar Report & Safe-to-Spend (30 days)...');
  const radarReport = await radarService.getRadarReport(ownerJid);
  await messaging.sendText(ownerJid, formatSubscriptionRadarReport(radarReport));

  const safeReport = await cashflowEngine.computeSafeToSpend(
    ownerJid,
    new Date('2026-11-22T10:00:00Z'),
    30,
  );
  console.log('\n💰 [Safe-to-Spend 30d Breakdown]');
  console.log(`   Sold curent (Demo):           ${formatCentsRo(safeReport.currentBalanceCents, safeReport.currency)}`);
  console.log(`   Abonamente scadente (30 zile): -${formatCentsRo(safeReport.totalUpcomingSubscriptionsCents, safeReport.currency)}`);
  console.log(`   Safe-to-Spend estimat:        ${formatCentsRo(safeReport.safeToSpendCents, safeReport.currency)}`);

  console.log('\n=========================================================================');
  console.log('   Subscription Radar & 48h Free-Trial Simulation Finished Cleanly!');
  console.log('=========================================================================');
}

main().catch((err) => {
  console.error('Radar simulation failed:', err);
  process.exit(1);
});
