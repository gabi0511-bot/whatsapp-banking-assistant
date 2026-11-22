import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InMemoryActionContextRepository } from '../src/db/repositories/action-context.repo.js';
import { InMemoryDisputeRepository } from '../src/db/repositories/dispute.repo.js';
import { InMemoryInvoiceRepository } from '../src/db/repositories/invoice.repo.js';
import { InMemoryProviderRepository } from '../src/db/repositories/provider.repo.js';
import { InMemoryReminderRepository } from '../src/db/repositories/reminder.repo.js';
import { CanonicalInvoiceSchema } from '../src/extraction/schema.js';
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
import { InvoicePipeline } from '../src/pipeline/invoice.pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

class TestMessagingAdapter implements MessagingAdapter {
  public readonly sentMessages: Array<{ toJid: string; text: string }> = [];
  private readonly handlers: IncomingMessageHandler[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }
  async sendText(toJid: string, text: string): Promise<void> {
    this.sentMessages.push({ toJid, text });
  }
}

class TestGmailDraftClient implements GmailDraftClient {
  public readonly drafts: CreateDraftInput[] = [];
  async createGmailDraft(input: CreateDraftInput): Promise<string> {
    this.drafts.push(input);
    return `draft-${this.drafts.length}`;
  }
}

async function loadFixture(filename: string) {
  const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, filename), 'utf8')) as {
    raw_text: string;
    invoice: unknown;
  };
  return {
    rawText: raw.raw_text,
    invoice: CanonicalInvoiceSchema.parse(raw.invoice),
  };
}

describe('Invoice X-Ray End-to-End 3-Pillar Pipeline', () => {
  it('audits Hidroelectrica M1 -> M2 -> M3, schedules reminder, holds payment, deduplicates SHA-256, and saves Gmail draft on WhatsApp "1"', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const providerRepo = new InMemoryProviderRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const reminderRepo = new InMemoryReminderRepository();
    const disputeRepo = new InMemoryDisputeRepository();
    const actionContextRepo = new InMemoryActionContextRepository();
    const messaging = new TestMessagingAdapter();
    const gmailDrafts = new TestGmailDraftClient();

    const pipeline = new InvoicePipeline({
      providerRepo,
      invoiceRepo,
      reminderRepo,
      disputeRepo,
      actionContextRepo,
      messaging,
      ownerWhatsappJid: ownerJid,
      userFullName: 'Ion Popescu',
    });

    const router = new WhatsAppCommandRouter({
      invoiceRepo,
      providerRepo,
      disputeRepo,
      reminderRepo,
      actionContextRepo,
      gmailDraftClient: gmailDrafts,
      messaging,
      userFullName: 'Ion Popescu',
    });

    const simNow = new Date('2026-04-10T09:00:00Z');

    // M1 baseline
    const m1Fix = await loadFixture('hidroelectrica_m1_baseline.json');
    const m1Sha = computeSha256Hex('m1');
    const m1Res = await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: m1Sha,
      preExtractedInvoice: m1Fix.invoice,
      rawText: m1Fix.rawText,
      now: simNow,
    });
    expect(m1Res.skipped).toBe(false);
    expect(m1Res.invoice.auditFlags).toHaveLength(0);
    expect(m1Res.invoice.paymentStatus).toBe('UNPAID');
    expect(m1Res.notificationText).toContain('✅ OK DE PLATĂ');

    // Duplicate SHA-256 must be skipped without sending a second WhatsApp message
    const dupRes = await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: m1Sha,
      preExtractedInvoice: m1Fix.invoice,
      rawText: m1Fix.rawText,
      now: simNow,
    });
    expect(dupRes.skipped).toBe(true);
    expect(dupRes.reason).toBe('DUPLICATE_SHA256');
    expect(messaging.sentMessages).toHaveLength(1);

    // M2 hidden price hike despite lower bill total
    const m2Fix = await loadFixture('hidroelectrica_m2_hidden_price_hike.json');
    const m2Res = await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex('m2'),
      preExtractedInvoice: m2Fix.invoice,
      rawText: m2Fix.rawText,
      now: simNow,
    });
    expect(m2Res.invoice.auditFlags.some((f) => f.code === 'UNIT_PRICE_INCREASE')).toBe(true);
    expect(m2Res.notificationText).toContain('⚠️ ATENȚIE ÎNAINTE DE PLATĂ');

    // M3 estimated + index overlap + daily spike -> HOLD_BEFORE_PAYMENT + reminder + dispute draft
    const m3Fix = await loadFixture('hidroelectrica_m3_estimated_overlap_spike.json');
    const m3Res = await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex('m3'),
      preExtractedInvoice: m3Fix.invoice,
      rawText: m3Fix.rawText,
      now: simNow,
    });

    const m3Codes = m3Res.invoice.auditFlags.map((f) => f.code);
    expect(m3Codes).toContain('ESTIMATED_READING');
    expect(m3Codes).toContain('INDEX_OVERLAP_ANOMALY');
    expect(m3Codes).toContain('CONSUMPTION_SPIKE');
    expect(m3Res.invoice.paymentStatus).toBe('HOLD_BEFORE_PAYMENT');
    expect(m3Res.reminder).not.toBeNull();
    expect(m3Res.disputeDraft).not.toBeNull();
    expect(m3Res.disputeDraft?.status).toBe('READY');
    expect(m3Res.notificationText).toContain('🚨 VERIFICĂ ÎNAINTE DE PLATĂ');

    // User replies "1" on WhatsApp -> saves draft to Gmail Drafts
    const reply = await router.handleMessage({
      fromJid: ownerJid,
      text: '1',
      timestamp: simNow,
    });

    expect(reply).toContain('salvat în Gmail Drafts');
    expect(gmailDrafts.drafts).toHaveLength(1);
    expect(gmailDrafts.drafts[0]?.to).toBe('clienti@hidroelectrica.ro');
    expect(gmailDrafts.drafts[0]?.subject).toContain('20260301199');
    expect(gmailDrafts.drafts[0]?.subject).toContain('80045192');

    const updatedDraft = await disputeRepo.findByInvoiceId(m3Res.invoice.id);
    expect(updatedDraft?.status).toBe('SAVED_TO_GMAIL');
    expect(updatedDraft?.gmailDraftId).toBe('draft-1');
  });

  it('audits Digi M1 -> platita -> Digi M2 promo expired + erroneous CRITICAL penalty and Engie XML fast path', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const providerRepo = new InMemoryProviderRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const reminderRepo = new InMemoryReminderRepository();
    const disputeRepo = new InMemoryDisputeRepository();
    const actionContextRepo = new InMemoryActionContextRepository();
    const messaging = new TestMessagingAdapter();
    const gmailDrafts = new TestGmailDraftClient();

    const pipeline = new InvoicePipeline({
      providerRepo,
      invoiceRepo,
      reminderRepo,
      disputeRepo,
      actionContextRepo,
      messaging,
      ownerWhatsappJid: ownerJid,
      userFullName: 'Ion Popescu',
    });

    const router = new WhatsAppCommandRouter({
      invoiceRepo,
      providerRepo,
      disputeRepo,
      reminderRepo,
      actionContextRepo,
      gmailDraftClient: gmailDrafts,
      messaging,
      userFullName: 'Ion Popescu',
    });

    const digiM1 = await loadFixture('digi_m1_with_promo.json');
    await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex('digi-m1'),
      preExtractedInvoice: digiM1.invoice,
      rawText: digiM1.rawText,
    });

    await router.handleMessage({ fromJid: ownerJid, text: 'platita', timestamp: new Date() });

    const digiM2 = await loadFixture('digi_m2_promo_expired_and_penalty.json');
    const digiM2Res = await pipeline.processDocument({
      sourceFormat: 'PDF',
      fileSha256: computeSha256Hex('digi-m2'),
      preExtractedInvoice: digiM2.invoice,
      rawText: digiM2.rawText,
    });

    expect(digiM2Res.invoice.paymentStatus).toBe('HOLD_BEFORE_PAYMENT');
    expect(digiM2Res.invoice.auditFlags.some((f) => f.code === 'PROMO_EXPIRED')).toBe(true);
    const penalty = digiM2Res.invoice.auditFlags.find((f) => f.code === 'LATE_FEE_DETECTED');
    expect(penalty?.severity).toBe('CRITICAL');
    expect(digiM2Res.disputeDraft).not.toBeNull();

    // Process e-Factura XML directly without any LLM extractor configured
    const xmlContent = await readFile(path.join(FIXTURES_DIR, 'efactura_sample.xml'), 'utf8');
    const xmlRes = await pipeline.processDocument({
      sourceFormat: 'XML',
      fileSha256: computeSha256Hex(xmlContent),
      xmlContent,
    });

    expect(xmlRes.skipped).toBe(false);
    expect(xmlRes.invoice.sourceFormat).toBe('XML');
    expect(xmlRes.invoice.providerCui).toBe('RO13093222');
    expect(xmlRes.invoice.totalAmountCents).toBe(13388n);
    expect(xmlRes.invoice.extractionConfidence).toBe('HIGH');
  });
});
