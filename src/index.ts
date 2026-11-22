import pino from 'pino';
import { CashflowEngine } from './cashflow/cashflow.engine.js';
import { DemoBalanceService } from './cashflow/demo-balance.service.js';
import { loadEnv } from './config/env.js';
import { DEFAULT_GEMINI_PRIMARY_MODEL } from './config/gemini.models.js';
import { runMigrationsAndSeed } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { PgActionContextRepository } from './db/repositories/action-context.repo.js';
import { PgDemoBalanceRepository } from './db/repositories/demo-balance.repo.js';
import { PgDisputeRepository } from './db/repositories/dispute.repo.js';
import { PgFreeTrialRepository } from './db/repositories/free-trial.repo.js';
import { PgInvoiceRepository } from './db/repositories/invoice.repo.js';
import { PgMemoryRepository } from './db/repositories/memory.repo.js';
import { PgMonthlyReviewRepository } from './db/repositories/monthly-review.repo.js';
import { PgPaymentLinkRepository } from './db/repositories/payment-link.repo.js';
import { PgPriceHikeRepository } from './db/repositories/price-hike.repo.js';
import { PgProviderRepository } from './db/repositories/provider.repo.js';
import { PgReminderRepository } from './db/repositories/reminder.repo.js';
import { PgSubscriptionChargeRepository } from './db/repositories/subscription-charge.repo.js';
import { PgSubscriptionRepository } from './db/repositories/subscription.repo.js';
import { PgTwinChatRepository } from './db/repositories/twin-chat.repo.js';
import { PgWhatsappPaymentRepository } from './db/repositories/whatsapp-payment.repo.js';
import { GeminiInvoiceExtractor } from './extraction/llm.extractor.js';
import { toBaniCents } from './extraction/math.validator.js';
import { GoogleGmailClient } from './ingestion/gmail.client.js';
import { BaileysWhatsAppAdapter } from './messaging/baileys.adapter.js';
import { WhatsAppCommandRouter } from './messaging/command.router.js';
import { PaymentReminderService } from './payments/payment.reminder.service.js';
import { QrTrackingService } from './payments/qr.tracking.service.js';
import { PaymentReceiptMatcher } from './payments/receipt.matcher.js';
import { startTrackingServer } from './payments/tracking.server.js';
import { InvoicePipeline } from './pipeline/invoice.pipeline.js';
import {
  GeminiMonthlyReviewComposer,
  MonthlyReviewService,
} from './review/monthly-review.service.js';
import { InvoiceXRayScheduler } from './scheduler/cron.jobs.js';
import { GeminiAlertComposer } from './subscriptions/ai-alert.composer.js';
import { FreeTrialService } from './subscriptions/free-trial.service.js';
import { GmailRadarService } from './subscriptions/gmail-radar.service.js';
import { SubscriptionRadarService } from './subscriptions/radar.service.js';
import { RecurrenceEngine } from './subscriptions/recurrence.engine.js';
import { GeminiEmailTrialExtractor } from './subscriptions/trial.extractor.js';
import { FinancialToolExecutor } from './twin/financial.tools.js';
import { FinancialGuardrail, GeminiIntentGatekeeper } from './twin/guardrail.js';
import { FinancialMemoryService } from './twin/memory.service.js';
import { GeminiTwinGenerator, TwinService } from './twin/twin.service.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: env.LOG_LEVEL });

  logger.info(
    'Starting Invoice X-Ray + Financial AI Twin + Tracked Payment QR + Subscription & Free-Trial Radar...',
  );

  // 1. PostgreSQL pool & idempotent migrations (001 + 002 + 004) + provider seeding
  const pool = createPool(env.DATABASE_URL);
  const { appliedMigrations, seededProviders } = await runMigrationsAndSeed(pool);
  logger.info(
    { appliedMigrations, seededProviders },
    'Database migrations and Romanian provider seed ready.',
  );

  // 2. Repositories
  const providerRepo = new PgProviderRepository(pool);
  const invoiceRepo = new PgInvoiceRepository(pool);
  const reminderRepo = new PgReminderRepository(pool);
  const disputeRepo = new PgDisputeRepository(pool);
  const actionContextRepo = new PgActionContextRepository(pool);
  const whatsappPaymentRepo = new PgWhatsappPaymentRepository(pool);
  const paymentLinkRepo = new PgPaymentLinkRepository(pool);
  const memoryRepo = new PgMemoryRepository(pool);
  const twinChatRepo = new PgTwinChatRepository(pool);
  const demoBalanceRepo = new PgDemoBalanceRepository(pool);
  const subscriptionRepo = new PgSubscriptionRepository(pool);
  const subscriptionChargeRepo = new PgSubscriptionChargeRepository(pool);
  const priceHikeRepo = new PgPriceHikeRepository(pool);
  const freeTrialRepo = new PgFreeTrialRepository(pool);
  const monthlyReviewRepo = new PgMonthlyReviewRepository(pool);

  // 3. External clients (Gmail API + Gemini 3.8 Flash + Baileys WhatsApp)
  const gmailClient = new GoogleGmailClient({
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    refreshToken: env.GMAIL_REFRESH_TOKEN,
  });

  const extractor = new GeminiInvoiceExtractor(env.GEMINI_API_KEY, DEFAULT_GEMINI_PRIMARY_MODEL);
  const alertComposer = new GeminiAlertComposer(env.GEMINI_API_KEY, DEFAULT_GEMINI_PRIMARY_MODEL);
  const trialExtractor = new GeminiEmailTrialExtractor(env.GEMINI_API_KEY, DEFAULT_GEMINI_PRIMARY_MODEL);

  const whatsapp = new BaileysWhatsAppAdapter({
    authDir: env.BAILEYS_AUTH_DIR,
    ownerJid: env.OWNER_WHATSAPP_JID,
    logger,
  });

  // 4. Demo Balance, Cashflow, Financial Memory, Tracked QR, Subscriptions & Free-Trial Radar
  const demoBalanceService = new DemoBalanceService(demoBalanceRepo);
  const cashflowEngine = new CashflowEngine({
    demoBalanceService,
    invoiceRepo,
    whatsappPaymentRepo,
    subscriptionRepo,
  });
  const memoryService = new FinancialMemoryService(memoryRepo);

  const qrTrackingService = new QrTrackingService({
    publicBaseUrl: env.PUBLIC_BASE_URL,
    paymentLinkRepo,
    invoiceRepo,
    whatsappPaymentRepo,
    memoryService,
    messaging: whatsapp,
    ownerRevolutTag: env.OWNER_REVOLUT_TAG,
  });

  const paymentReminderService = new PaymentReminderService({
    publicBaseUrl: env.PUBLIC_BASE_URL,
    paymentLinkRepo,
    invoiceRepo,
    whatsappPaymentRepo,
    memoryService,
    messaging: whatsapp,
    unaccessedReminderHours: env.QR_UNACCESSED_REMINDER_HOURS,
    abandonedReminderMinutes: env.QR_ABANDONED_REMINDER_MINUTES,
  });

  const receiptMatcher = new PaymentReceiptMatcher(
    paymentLinkRepo,
    invoiceRepo,
    qrTrackingService,
  );

  const recurrenceEngine = new RecurrenceEngine({
    subscriptionRepo,
    chargeRepo: subscriptionChargeRepo,
    priceHikeRepo,
    memoryRepo,
    demoBalanceService,
    messaging: whatsapp,
    alertComposer,
    zombieMicroThresholdCents: toBaniCents(env.ZOMBIE_MICRO_THRESHOLD_RON),
    zombieMinUnconfirmedCharges: env.ZOMBIE_MIN_UNCONFIRMED_CHARGES,
  });

  const freeTrialService = new FreeTrialService({
    freeTrialRepo,
    memoryRepo,
    demoBalanceService,
    messaging: whatsapp,
    alertComposer,
  });

  const gmailRadarService = new GmailRadarService({
    gmailClient,
    extractor: trialExtractor,
    freeTrialService,
    recurrenceEngine,
    freeTrialRepo,
    chargeRepo: subscriptionChargeRepo,
    ownerJid: env.OWNER_WHATSAPP_JID,
    freeTrialQuery: env.GMAIL_FREE_TRIAL_QUERY,
    subscriptionReceiptQuery: env.GMAIL_SUBSCRIPTION_RECEIPT_QUERY,
    logger,
  });

  const subscriptionRadarService = new SubscriptionRadarService({
    subscriptionRepo,
    priceHikeRepo,
    freeTrialRepo,
    memoryRepo,
    demoBalanceService,
  });

  const monthlyReviewService = new MonthlyReviewService({
    invoiceRepo,
    whatsappPaymentRepo,
    demoBalanceService,
    monthlyReviewRepo,
    messaging: whatsapp,
    composer: new GeminiMonthlyReviewComposer(env.GEMINI_API_KEY, DEFAULT_GEMINI_PRIMARY_MODEL),
  });

  // 5. Strictly-Scoped 3-Layer Financial AI Twin (natural language, zero rigid commands)
  const guardrail = new FinancialGuardrail(
    new GeminiIntentGatekeeper(env.GEMINI_API_KEY, DEFAULT_GEMINI_PRIMARY_MODEL),
  );
  const toolExecutor = new FinancialToolExecutor({
    invoiceRepo,
    whatsappPaymentRepo,
    paymentLinkRepo,
    memoryService,
    qrTrackingService,
    demoBalanceService,
    cashflowEngine,
    subscriptionRadarService,
    freeTrialService,
    recurrenceEngine,
    gmailRadarService,
    subscriptionRepo,
    freeTrialRepo,
    monthlyReviewService,
  });
  const twinService = new TwinService({
    guardrail,
    generator: new GeminiTwinGenerator(env.GEMINI_API_KEY, DEFAULT_GEMINI_PRIMARY_MODEL, logger),
    toolExecutor,
    memoryService,
    twinChatRepo,
    qrTrackingService,
    logger,
  });

  // 6. Pipeline & WhatsApp Command Router
  const pipeline = new InvoicePipeline({
    pool,
    providerRepo,
    invoiceRepo,
    reminderRepo,
    disputeRepo,
    actionContextRepo,
    extractor,
    messaging: whatsapp,
    ownerWhatsappJid: env.OWNER_WHATSAPP_JID,
    userFullName: env.USER_FULL_NAME,
    memoryService,
    qrTrackingService,
    autoSendPaymentQr: env.AUTO_SEND_PAYMENT_QR,
    logger,
  });

  const commandRouter = new WhatsAppCommandRouter({
    invoiceRepo,
    providerRepo,
    disputeRepo,
    reminderRepo,
    actionContextRepo,
    gmailDraftClient: gmailClient,
    messaging: whatsapp,
    userFullName: env.USER_FULL_NAME,
    qrTrackingService,
    twinService,
    subscriptionRadarService,
    freeTrialService,
  });

  whatsapp.onMessage(async (msg) => {
    await commandRouter.handleMessage(msg);
  });

  // 7. Start Payment Tracking HTTP Server + WhatsApp Bot + Cron Scheduler
  const trackingServer = await startTrackingServer(
    { paymentLinkRepo, qrTrackingService },
    env.TRACKING_SERVER_PORT,
  );
  logger.info(
    { port: trackingServer.port, publicBaseUrl: env.PUBLIC_BASE_URL },
    'Tracked payment QR HTTP server listening.',
  );

  await whatsapp.connect();

  const scheduler = new InvoiceXRayScheduler({
    gmailClient,
    gmailSearchQuery: env.GMAIL_SEARCH_QUERY,
    pipeline,
    reminderRepo,
    messaging: whatsapp,
    cronGmailPoll: env.CRON_GMAIL_POLL,
    cronReminderDispatch: env.CRON_REMINDER_DISPATCH,
    cronPaymentReminders: env.CRON_PAYMENT_REMINDERS,
    paymentReminderService,
    receiptMatcher,
    cronSubscriptionGmailPoll: env.CRON_SUBSCRIPTION_GMAIL_POLL,
    cronFreeTrialAlerts: env.CRON_FREE_TRIAL_ALERTS,
    gmailRadarService,
    freeTrialService,
    cronMonthlyReview: env.CRON_MONTHLY_REVIEW,
    monthlyReviewService,
    ownerWhatsappJid: env.OWNER_WHATSAPP_JID,
    logger,
  });

  scheduler.start();

  // Trigger an initial background scan shortly after startup so new Gmail trials are caught promptly
  setTimeout(() => {
    void scheduler.runSubscriptionGmailPollOnce().then(() => scheduler.dispatchFreeTrialAlertsOnce());
  }, 10_000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Invoice X-Ray & AI Twin...');
    scheduler.stop();
    await trackingServer.close();
    await whatsapp.disconnect();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
