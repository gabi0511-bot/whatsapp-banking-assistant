import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { formatBucharestDateRo } from '../src/audit/rules/reading.rule.js';
import { loadPartialEnv } from '../src/config/env.js';
import { runMigrationsAndSeed } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import {
  InMemoryActionContextRepository,
  PgActionContextRepository,
  type ActionContextRepository,
} from '../src/db/repositories/action-context.repo.js';
import {
  InMemoryDisputeRepository,
  PgDisputeRepository,
  type DisputeRepository,
} from '../src/db/repositories/dispute.repo.js';
import {
  InMemoryInvoiceRepository,
  PgInvoiceRepository,
  type InvoiceRepository,
} from '../src/db/repositories/invoice.repo.js';
import {
  InMemoryProviderRepository,
  PgProviderRepository,
  type ProviderRepository,
} from '../src/db/repositories/provider.repo.js';
import {
  InMemoryReminderRepository,
  PgReminderRepository,
  type ReminderRepository,
} from '../src/db/repositories/reminder.repo.js';
import { CanonicalInvoiceSchema, type CanonicalInvoice } from '../src/extraction/schema.js';
import {
  computeSha256Hex,
  type CreateDraftInput,
  type GmailDraftClient,
} from '../src/ingestion/gmail.client.js';
import type {
  IncomingMessageHandler,
  MessagingAdapter,
} from '../src/messaging/adapter.interface.js';
import { WhatsAppCommandRouter } from '../src/messaging/command.router.js';
import { formatSelfReadingReminder } from '../src/messaging/formatter.js';
import { InvoicePipeline } from '../src/pipeline/invoice.pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../tests/fixtures');

interface JsonFixtureFile {
  raw_text: string;
  invoice: CanonicalInvoice;
}

class ConsoleMessagingAdapter implements MessagingAdapter {
  private readonly handlers: IncomingMessageHandler[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  async sendText(toJid: string, text: string): Promise<void> {
    console.log(`\n┌── [WhatsApp → ${toJid}] ${'─'.repeat(42)}`);
    for (const line of text.split('\n')) {
      console.log(`│ ${line}`);
    }
    console.log(`└${'─'.repeat(72)}`);
  }

  async simulateIncoming(fromJid: string, text: string): Promise<void> {
    console.log(`\n>>> [User WhatsApp Reply from ${fromJid}]: "${text}"`);
    for (const handler of this.handlers) {
      await handler({ fromJid, text, timestamp: new Date() });
    }
  }
}

class MockGmailDraftClient implements GmailDraftClient {
  public readonly savedDrafts: Array<CreateDraftInput & { draftId: string }> = [];
  private seq = 1;

  async createGmailDraft(input: CreateDraftInput): Promise<string> {
    const draftId = `mock-gmail-draft-${this.seq++}`;
    this.savedDrafts.push({ ...input, draftId });

    console.log(`\n╔══ [Mock Gmail Draft Saved: ${draftId}] ${'═'.repeat(30)}`);
    console.log(`║ To:      ${input.to}`);
    console.log(`║ Subject: ${input.subject}`);
    console.log(`╠${'═'.repeat(72)}`);
    for (const line of input.body.split('\n')) {
      console.log(`║ ${line}`);
    }
    console.log(`╚${'═'.repeat(72)}`);

    return draftId;
  }
}

async function loadJsonFixture(filename: string): Promise<JsonFixtureFile> {
  const content = await readFile(path.join(FIXTURES_DIR, filename), 'utf8');
  const parsed = JSON.parse(content) as { raw_text: string; invoice: unknown };
  return {
    raw_text: parsed.raw_text,
    invoice: CanonicalInvoiceSchema.parse(parsed.invoice),
  };
}

async function initRepositories(databaseUrl?: string): Promise<{
  mode: 'POSTGRESQL' | 'IN-MEMORY';
  pool?: pg.Pool;
  providerRepo: ProviderRepository;
  invoiceRepo: InvoiceRepository;
  reminderRepo: ReminderRepository;
  disputeRepo: DisputeRepository;
  actionContextRepo: ActionContextRepository;
}> {
  if (databaseUrl) {
    const pool = createPool(databaseUrl);
    try {
      await pool.query('SELECT 1');
      await runMigrationsAndSeed(pool);
      return {
        mode: 'POSTGRESQL',
        pool,
        providerRepo: new PgProviderRepository(pool),
        invoiceRepo: new PgInvoiceRepository(pool),
        reminderRepo: new PgReminderRepository(pool),
        disputeRepo: new PgDisputeRepository(pool),
        actionContextRepo: new PgActionContextRepository(pool),
      };
    } catch {
      await pool.end().catch(() => {});
    }
  }

  return {
    mode: 'IN-MEMORY',
    providerRepo: new InMemoryProviderRepository(),
    invoiceRepo: new InMemoryInvoiceRepository(),
    reminderRepo: new InMemoryReminderRepository(),
    disputeRepo: new InMemoryDisputeRepository(),
    actionContextRepo: new InMemoryActionContextRepository(),
  };
}

async function main(): Promise<void> {
  const env = loadPartialEnv();
  const storage = await initRepositories(env.DATABASE_URL);
  const runSalt = storage.mode === 'POSTGRESQL' ? `-${Date.now()}` : '';
  const simNow = new Date('2026-04-10T09:00:00Z');

  console.log('=========================================================================');
  console.log('         INVOICE X-RAY — OFFLINE ROMANIAN PIPELINE SIMULATOR');
  console.log(`         Storage Mode: ${storage.mode}`);
  console.log('=========================================================================');

  const messaging = new ConsoleMessagingAdapter();
  const gmailDrafts = new MockGmailDraftClient();

  const pipeline = new InvoicePipeline({
    pool: storage.pool,
    providerRepo: storage.providerRepo,
    invoiceRepo: storage.invoiceRepo,
    reminderRepo: storage.reminderRepo,
    disputeRepo: storage.disputeRepo,
    actionContextRepo: storage.actionContextRepo,
    messaging,
    ownerWhatsappJid: env.OWNER_WHATSAPP_JID,
    userFullName: env.USER_FULL_NAME,
  });

  const router = new WhatsAppCommandRouter({
    invoiceRepo: storage.invoiceRepo,
    providerRepo: storage.providerRepo,
    disputeRepo: storage.disputeRepo,
    reminderRepo: storage.reminderRepo,
    actionContextRepo: storage.actionContextRepo,
    gmailDraftClient: gmailDrafts,
    messaging,
    userFullName: env.USER_FULL_NAME,
  });

  messaging.onMessage(async (msg) => {
    await router.handleMessage(msg);
  });

  try {
    // 1. Hidroelectrica M1 Baseline
    console.log('\n▶ STEP 1: Hidroelectrica M1 — Baseline real self-reading (220 kWh, 189.40 RON)');
    const hidM1 = await loadJsonFixture('hidroelectrica_m1_baseline.json');
    await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex(`hid-m1${runSalt}`),
      preExtractedInvoice: hidM1.invoice,
      rawText: hidM1.raw_text,
      now: simNow,
    });

    // 2. Hidroelectrica M2 Hidden Unit Price Hike (Total bill DROPS, unit price JUMPS +30%!)
    console.log('\n▶ STEP 2: Hidroelectrica M2 — Lower total (184.10 RON) with hidden +30% tariff hike');
    const hidM2 = await loadJsonFixture('hidroelectrica_m2_hidden_price_hike.json');
    await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex(`hid-m2${runSalt}`),
      preExtractedInvoice: hidM2.invoice,
      rawText: hidM2.raw_text,
      now: simNow,
    });

    // 3. Hidroelectrica M3 Estimated + Index Overlap + Daily Spike
    console.log('\n▶ STEP 3: Hidroelectrica M3 — Estimated reading + Index overlap + Daily spike');
    const hidM3 = await loadJsonFixture('hidroelectrica_m3_estimated_overlap_spike.json');
    const hidM3Res = await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex(`hid-m3${runSalt}`),
      preExtractedInvoice: hidM3.invoice,
      rawText: hidM3.raw_text,
      now: simNow,
    });

    if (hidM3Res.reminder) {
      console.log(
        `\n⏰ [Scheduled Self-Reading Reminder] TriggerAt=${hidM3Res.reminder.triggerAt.toISOString()} (${formatBucharestDateRo(hidM3Res.reminder.triggerAt)} Bucharest)`,
      );
      console.log('   Payload:', JSON.stringify(hidM3Res.reminder.payload));
      console.log('   Preview WhatsApp reminder:\n' + formatSelfReadingReminder(hidM3Res.reminder));
    }

    // Simulate user replying "1" -> [Draft contestație] for Hidroelectrica M3
    await messaging.simulateIncoming(env.OWNER_WHATSAPP_JID, '1');

    // 4. Digi M1 with promo -> mark PAID_ON_TIME
    console.log('\n▶ STEP 4: Digi M1 — Subscription 50 RON + Promo -20 RON = 30.00 RON');
    const digiM1 = await loadJsonFixture('digi_m1_with_promo.json');
    await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex(`digi-m1${runSalt}`),
      preExtractedInvoice: digiM1.invoice,
      rawText: digiM1.raw_text,
      now: simNow,
    });
    await messaging.simulateIncoming(env.OWNER_WHATSAPP_JID, 'platita');

    // 5. Digi M2 expired promo + erroneous penalty
    console.log('\n▶ STEP 5: Digi M2 — Expired promo (-20 RON gone) + Erroneous 3.50 RON penalty');
    const digiM2 = await loadJsonFixture('digi_m2_promo_expired_and_penalty.json');
    await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex(`digi-m2${runSalt}`),
      preExtractedInvoice: digiM2.invoice,
      rawText: digiM2.raw_text,
      now: simNow,
    });
    await messaging.simulateIncoming(env.OWNER_WHATSAPP_JID, '1');

    // 6. E.ON Regularization Storno & Creditor Balance
    console.log('\n▶ STEP 6: E.ON Gas — Prior Estimate -> Broken Regularization -> Creditor Balance (-85.40 RON)');
    const eonRaw = JSON.parse(
      await readFile(path.join(FIXTURES_DIR, 'eon_regularization_storno_and_creditor.json'), 'utf8'),
    ) as {
      prior_estimated_invoice: { raw_text: string; invoice: unknown };
      regularization_invoice: { raw_text: string; invoice: unknown };
      creditor_invoice: { raw_text: string; invoice: unknown };
    };

    await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex(`eon-est${runSalt}`),
      preExtractedInvoice: CanonicalInvoiceSchema.parse(eonRaw.prior_estimated_invoice.invoice),
      rawText: eonRaw.prior_estimated_invoice.raw_text,
      now: simNow,
    });

    await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex(`eon-reg${runSalt}`),
      preExtractedInvoice: CanonicalInvoiceSchema.parse(eonRaw.regularization_invoice.invoice),
      rawText: eonRaw.regularization_invoice.raw_text,
      now: simNow,
    });

    await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex(`eon-cred${runSalt}`),
      preExtractedInvoice: CanonicalInvoiceSchema.parse(eonRaw.creditor_invoice.invoice),
      rawText: eonRaw.creditor_invoice.raw_text,
      now: simNow,
    });

    // 7. e-Factura UBL 2.1 XML Deterministic Fast Path (Zero LLM)
    console.log('\n▶ STEP 7: Engie Romania — e-Factura UBL 2.1 XML Deterministic Fast Path (Zero LLM)');
    const xmlContent = await readFile(path.join(FIXTURES_DIR, 'efactura_sample.xml'), 'utf8');
    await pipeline.processDocument({
      sourceFormat: 'XML',
      fileSha256: computeSha256Hex(`${xmlContent}${runSalt}`),
      xmlContent,
      now: simNow,
    });

    // 8. Check WhatsApp "status" command
    await messaging.simulateIncoming(env.OWNER_WHATSAPP_JID, 'status');

    console.log('\n=========================================================================');
    console.log(
      `Simulation finished cleanly. Saved ${gmailDrafts.savedDrafts.length} mock Gmail Draft(s).`,
    );
    console.log('=========================================================================');
  } finally {
    if (storage.pool) {
      await storage.pool.end();
    }
  }
}

main().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
