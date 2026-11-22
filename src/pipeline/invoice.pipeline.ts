import type pg from 'pg';
import type { Logger } from 'pino';
import type {
  AuditResult,
  SourceFormat,
  StoredDisputeDraft,
  StoredInvoice,
  StoredReminder,
} from '../audit/types.js';
import { XRayEngine } from '../audit/xray.engine.js';
import { withTransaction } from '../db/pool.js';
import type { ActionContextRepository } from '../db/repositories/action-context.repo.js';
import type { DisputeRepository } from '../db/repositories/dispute.repo.js';
import type { InvoiceRepository } from '../db/repositories/invoice.repo.js';
import type { ProviderRepository } from '../db/repositories/provider.repo.js';
import type { ReminderRepository } from '../db/repositories/reminder.repo.js';
import type { InvoiceExtractor } from '../extraction/llm.extractor.js';
import { validateAndNormalizeInvoice } from '../extraction/math.validator.js';
import type { CanonicalInvoice } from '../extraction/schema.js';
import {
  computeSha256Hex,
  type FetchedInvoiceEmail,
} from '../ingestion/gmail.client.js';
import { extractTextFromPdfBuffer } from '../ingestion/pdf.parser.js';
import { isUblInvoiceXml, parseUblInvoiceXml } from '../ingestion/xml.parser.js';
import type { MessagingAdapter } from '../messaging/adapter.interface.js';
import { formatInvoiceXRayAlert } from '../messaging/formatter.js';
import type { StoredPaymentLink } from '../db/repositories/payment-link.repo.js';
import type { QrTrackingService } from '../payments/qr.tracking.service.js';
import type { FinancialMemoryService } from '../twin/memory.service.js';

export interface InvoicePipelineDeps {
  pool?: pg.Pool;
  providerRepo: ProviderRepository;
  invoiceRepo: InvoiceRepository;
  reminderRepo: ReminderRepository;
  disputeRepo: DisputeRepository;
  actionContextRepo: ActionContextRepository;
  extractor?: InvoiceExtractor;
  messaging: MessagingAdapter;
  ownerWhatsappJid: string;
  userFullName: string;
  xrayEngine?: XRayEngine;
  memoryService?: FinancialMemoryService;
  qrTrackingService?: QrTrackingService;
  autoSendPaymentQr?: boolean;
  logger?: Logger;
}

export interface ProcessDocumentInput {
  sourceFormat: SourceFormat;
  fileSha256: string;
  gmailMessageId?: string | null;
  xmlContent?: string;
  pdfBuffer?: Buffer;
  preExtractedInvoice?: CanonicalInvoice;
  rawText?: string;
  now?: Date;
}

export interface PipelineProcessResult {
  skipped: boolean;
  reason?: 'DUPLICATE_SHA256';
  invoice: StoredInvoice;
  auditResult?: AuditResult;
  reminder?: StoredReminder | null;
  disputeDraft?: StoredDisputeDraft | null;
  paymentLink?: StoredPaymentLink | null;
  notificationText?: string;
}

export class InvoicePipeline {
  private readonly xrayEngine: XRayEngine;

  constructor(private readonly deps: InvoicePipelineDeps) {
    this.xrayEngine = deps.xrayEngine ?? new XRayEngine();
  }

  /**
   * Processes a fetched Gmail message with XML-first deterministic preference.
   * If both UBL XML and PDF attachments exist in the same email, parses the XML
   * deterministically (zero LLM call) and optionally extracts raw PDF text for
   * Pillar 1 estimation keyword cross-checking.
   */
  async processEmail(email: FetchedInvoiceEmail, now?: Date): Promise<PipelineProcessResult[]> {
    const xmlAttachments = email.attachments.filter((att) => {
      if (att.format !== 'XML') {
        return false;
      }
      return isUblInvoiceXml(att.buffer.toString('utf8'));
    });
    const pdfAttachments = email.attachments.filter((att) => att.format === 'PDF');

    const results: PipelineProcessResult[] = [];

    if (xmlAttachments.length > 0) {
      let companionPdfRawText: string | undefined;
      if (pdfAttachments[0]) {
        try {
          const parsedPdf = await extractTextFromPdfBuffer(pdfAttachments[0].buffer);
          companionPdfRawText = parsedPdf.fullRawText;
        } catch (err) {
          this.deps.logger?.warn(
            { err, messageId: email.messageId },
            'Could not extract companion PDF text; continuing with deterministic XML.',
          );
        }
      }

      for (const xmlAtt of xmlAttachments) {
        const res = await this.processDocument({
          sourceFormat: 'XML',
          fileSha256: xmlAtt.sha256,
          gmailMessageId: email.messageId,
          xmlContent: xmlAtt.buffer.toString('utf8'),
          rawText: companionPdfRawText,
          now,
        });
        results.push(res);
      }
      return results;
    }

    for (const pdfAtt of pdfAttachments) {
      const res = await this.processDocument({
        sourceFormat: 'PDF',
        fileSha256: pdfAtt.sha256,
        gmailMessageId: email.messageId,
        pdfBuffer: pdfAtt.buffer,
        now,
      });
      results.push(res);
    }

    return results;
  }

  async processDocument(input: ProcessDocumentInput): Promise<PipelineProcessResult> {
    const fileSha256 =
      input.fileSha256 ||
      computeSha256Hex(
        input.xmlContent ?? input.pdfBuffer ?? JSON.stringify(input.preExtractedInvoice ?? {}),
      );

    // 1. Deduplicate by SHA-256
    const existing = await this.deps.invoiceRepo.findBySha256(fileSha256);
    if (existing) {
      this.deps.logger?.info(
        { fileSha256, invoiceId: existing.id },
        'Skipping already processed invoice attachment (SHA-256 deduplication).',
      );
      return {
        skipped: true,
        reason: 'DUPLICATE_SHA256',
        invoice: existing,
      };
    }

    // 2. Extract CanonicalInvoice (XML deterministic fast path OR PDF + LLM OR pre-extracted)
    let canonical: CanonicalInvoice;
    let rawText = input.rawText;

    if (input.preExtractedInvoice) {
      canonical = input.preExtractedInvoice;
    } else if (input.sourceFormat === 'XML' && input.xmlContent) {
      canonical = parseUblInvoiceXml(input.xmlContent);
      rawText = rawText ?? input.xmlContent;
    } else if (input.sourceFormat === 'PDF' && input.pdfBuffer) {
      if (!this.deps.extractor) {
        throw new Error('InvoiceExtractor is required to process PDF invoices');
      }
      const parsedPdf = await extractTextFromPdfBuffer(input.pdfBuffer);
      rawText = rawText ?? parsedPdf.fullRawText;
      canonical = await this.deps.extractor.extractFromText(parsedPdf.filteredText);
    } else {
      throw new Error('Invalid ProcessDocumentInput: provide xmlContent, pdfBuffer, or preExtractedInvoice');
    }

    // 3. Deterministic math & sanity validation
    const validated = validateAndNormalizeInvoice({
      extracted: canonical,
      fileSha256,
      sourceFormat: input.sourceFormat,
      gmailMessageId: input.gmailMessageId ?? null,
    });

    // 4. Fetch historical context for exact (provider_cui, consumption_point_id)
    const [providerConfig, previousInvoice, recentRealInvoices, recentEstimatedInvoices] =
      await Promise.all([
        this.deps.providerRepo.findByCui(validated.providerCui),
        this.deps.invoiceRepo.findLatestForConsumptionPoint(
          validated.providerCui,
          validated.consumptionPointId,
        ),
        this.deps.invoiceRepo.findRecentRealInvoices(
          validated.providerCui,
          validated.consumptionPointId,
          3,
        ),
        this.deps.invoiceRepo.findRecentEstimatedInvoicesSinceLastReal(
          validated.providerCui,
          validated.consumptionPointId,
          3,
        ),
      ]);

    // 5. Run 3-Pillar X-Ray Audit Engine
    const auditResult = this.xrayEngine.audit({
      invoice: validated,
      rawText,
      previousInvoice,
      recentRealInvoices,
      recentEstimatedInvoices,
      providerConfig,
      userFullName: this.deps.userFullName,
      now: input.now,
    });

    // 6. Persist atomically (invoice + lines + reminder + dispute draft + WhatsApp context)
    const persistAll = async (db?: pg.PoolClient) => {
      const storedInvoice = await this.deps.invoiceRepo.insertInvoiceWithLines(
        {
          validated,
          effectiveReadingType: auditResult.readingType,
          paymentStatus: auditResult.paymentStatus,
          auditFlags: auditResult.flags,
        },
        db,
      );

      let storedReminder: StoredReminder | null = null;
      if (auditResult.scheduledReminder) {
        storedReminder = await this.deps.reminderRepo.create(
          storedInvoice.id,
          this.deps.ownerWhatsappJid,
          auditResult.scheduledReminder,
          db,
        );
      }

      let storedDispute: StoredDisputeDraft | null = null;
      if (auditResult.disputeDraft) {
        storedDispute = await this.deps.disputeRepo.upsertReady(
          storedInvoice.id,
          auditResult.disputeDraft,
          db,
        );
      }

      await this.deps.actionContextRepo.upsertLatestInvoice(
        this.deps.ownerWhatsappJid,
        storedInvoice.id,
        db,
      );

      return { storedInvoice, storedReminder, storedDispute };
    };

    const persisted = this.deps.pool
      ? await withTransaction(this.deps.pool, (client) => persistAll(client))
      : await persistAll();

    // 6b. Record financial memory events for the AI Twin
    if (this.deps.memoryService) {
      await this.deps.memoryService.recordInvoiceDetected(
        this.deps.ownerWhatsappJid,
        persisted.storedInvoice,
      );
      if (persisted.storedInvoice.auditFlags.length > 0) {
        await this.deps.memoryService.recordInvoiceAnomalyFlagged(
          this.deps.ownerWhatsappJid,
          persisted.storedInvoice,
        );
      }
      if (persisted.storedDispute) {
        await this.deps.memoryService.recordDisputeDraftCreated(
          this.deps.ownerWhatsappJid,
          persisted.storedInvoice,
          persisted.storedDispute.recipientEmail,
        );
      }
    }

    // 7. Notify owner via WhatsApp
    const notificationText = formatInvoiceXRayAlert(persisted.storedInvoice);
    await this.deps.messaging.sendText(this.deps.ownerWhatsappJid, notificationText);

    // 8. Generate tracked payment QR for payable invoices (excluding NO_PAYMENT_NEEDED)
    let paymentLink: StoredPaymentLink | null = null;
    if (
      this.deps.qrTrackingService &&
      persisted.storedInvoice.totalAmountCents > 0n &&
      persisted.storedInvoice.paymentStatus !== 'NO_PAYMENT_NEEDED'
    ) {
      const generatedQr = await this.deps.qrTrackingService.createForInvoice(
        persisted.storedInvoice,
        this.deps.ownerWhatsappJid,
        { createdAt: input.now },
      );
      paymentLink = generatedQr.link;

      if (this.deps.autoSendPaymentQr !== false) {
        await this.deps.qrTrackingService.sendQrToWhatsApp(generatedQr);
      }
    }

    return {
      skipped: false,
      invoice: persisted.storedInvoice,
      auditResult,
      reminder: persisted.storedReminder,
      disputeDraft: persisted.storedDispute,
      paymentLink,
      notificationText,
    };
  }
}
