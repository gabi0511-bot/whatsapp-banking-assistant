import { buildDisputeDraft } from '../audit/rules/dispute.rule.js';
import type { ActionContextRepository } from '../db/repositories/action-context.repo.js';
import type { DisputeRepository } from '../db/repositories/dispute.repo.js';
import type { InvoiceRepository } from '../db/repositories/invoice.repo.js';
import type { ProviderRepository } from '../db/repositories/provider.repo.js';
import type { ReminderRepository } from '../db/repositories/reminder.repo.js';
import { toBaniCents } from '../extraction/math.validator.js';
import { formatCentsRo, normalizeDiacritics } from '../extraction/schema.js';
import type { GmailDraftClient } from '../ingestion/gmail.client.js';
import type { QrTrackingService } from '../payments/qr.tracking.service.js';
import type { FreeTrialService } from '../subscriptions/free-trial.service.js';
import type { SubscriptionRadarService } from '../subscriptions/radar.service.js';
import type { TwinService } from '../twin/twin.service.js';
import type { IncomingMessage, MessagingAdapter } from './adapter.interface.js';
import {
  formatActiveTrialsReport,
  formatHelpMessage,
  formatStatusReport,
  formatSubscriptionRadarReport,
} from './formatter.js';

export interface CommandRouterDeps {
  invoiceRepo: InvoiceRepository;
  providerRepo: ProviderRepository;
  disputeRepo: DisputeRepository;
  reminderRepo: ReminderRepository;
  actionContextRepo: ActionContextRepository;
  gmailDraftClient: GmailDraftClient;
  messaging: MessagingAdapter;
  userFullName: string;
  qrTrackingService?: QrTrackingService;
  twinService?: TwinService;
  subscriptionRadarService?: SubscriptionRadarService;
  freeTrialService?: FreeTrialService;
}

export class WhatsAppCommandRouter {
  constructor(private readonly deps: CommandRouterDeps) {}

  async handleMessage(message: IncomingMessage): Promise<string> {
    const raw = message.text.trim();
    const normalized = normalizeDiacritics(raw).toLowerCase();
    const tokens = normalized.split(/\s+/);
    const cmd = tokens[0] ?? '';

    if (cmd === '1' && (tokens.length === 1 || /^\d+$/.test(tokens[1] ?? ''))) {
      const explicitId = tokens[1] ? Number.parseInt(tokens[1], 10) : null;
      const reply = await this.handleDraftDispute(message.fromJid, explicitId);
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    if (cmd === 'platita' && (tokens.length === 1 || /^\d+$/.test(tokens[1] ?? ''))) {
      const explicitId = tokens[1] ? Number.parseInt(tokens[1], 10) : null;
      const reply = await this.handleMarkPaid(message.fromJid, explicitId);
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    if (cmd === 'qr' && (tokens.length === 1 || /^\d+$/.test(tokens[1] ?? ''))) {
      const explicitId = tokens[1] ? Number.parseInt(tokens[1], 10) : null;
      const reply = await this.handleSendQr(message.fromJid, explicitId);
      if (reply) {
        await this.deps.messaging.sendText(message.fromJid, reply);
      }
      return reply;
    }

    if (cmd === 'status' && tokens.length === 1) {
      const [unpaid, pendingReminders] = await Promise.all([
        this.deps.invoiceRepo.findUnpaidOrHeld(),
        this.deps.reminderRepo.findAllPending(),
      ]);
      const reply = formatStatusReport(unpaid, pendingReminders);
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    if ((cmd === 'ajutor' || cmd === 'help') && tokens.length === 1) {
      const reply = formatHelpMessage();
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    // Optional fast shortcuts for Subscription Radar & Free Trials (natural free-text still goes straight to AI Twin!)
    if ((cmd === '/abonamente' || cmd === 'abonamente') && tokens.length === 1 && this.deps.subscriptionRadarService) {
      const report = await this.deps.subscriptionRadarService.getRadarReport(message.fromJid);
      const reply = formatSubscriptionRadarReport(report);
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    if ((cmd === '/trials' || cmd === 'trials') && tokens.length === 1 && this.deps.subscriptionRadarService) {
      const report = await this.deps.subscriptionRadarService.getRadarReport(message.fromJid);
      const reply = formatActiveTrialsReport(report);
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    if (cmd === '/trial' && tokens.length >= 4 && this.deps.freeTrialService) {
      const reply = await this.handleManualTrialCommand(message.fromJid, raw);
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    if (cmd === 'anulat' && tokens[1] === 'trial' && /^\d+$/.test(tokens[2] ?? '') && this.deps.freeTrialService) {
      const id = Number.parseInt(tokens[2]!, 10);
      const updated = await this.deps.freeTrialService.cancelTrial(id, message.fromJid);
      const reply = updated
        ? `✅ Free trial-ul #${updated.id} (*${updated.serviceName}*) a fost marcat ca *ANULAT* și alerta 48h a fost oprită.`
        : `⚠️ Free trial-ul #${id} nu a fost găsit.`;
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    if (cmd === 'anulat' && tokens.length === 2 && /^\d+$/.test(tokens[1] ?? '') && this.deps.subscriptionRadarService) {
      const id = Number.parseInt(tokens[1]!, 10);
      const updated = await this.deps.subscriptionRadarService.cancelSubscription(id, message.fromJid);
      const reply = updated
        ? `✅ Abonamentul #${updated.id} (*${updated.merchantName}*) a fost marcat ca *ANULAT* (economie ${formatCentsRo(updated.annualizedCostCents, updated.currency)}/an).`
        : `⚠️ Abonamentul #${id} nu a fost găsit.`;
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    if (cmd === 'folosesc' && tokens.length === 2 && /^\d+$/.test(tokens[1] ?? '') && this.deps.subscriptionRadarService) {
      const id = Number.parseInt(tokens[1]!, 10);
      const updated = await this.deps.subscriptionRadarService.confirmSubscriptionUsed(id);
      const reply = updated
        ? `✅ Am confirmat că folosești activ *${updated.merchantName}* (#${updated.id}) și am scos marcajul de zombie.`
        : `⚠️ Abonamentul #${id} nu a fost găsit.`;
      await this.deps.messaging.sendText(message.fromJid, reply);
      return reply;
    }

    // Route ALL natural free-text WhatsApp messages directly to the AI Twin!
    if (this.deps.twinService) {
      const twinRes = await this.deps.twinService.handleMessage(
        message.fromJid,
        raw,
        message.timestamp,
      );
      await this.deps.messaging.sendText(message.fromJid, twinRes.reply);
      return twinRes.reply;
    }

    const fallback =
      '❓ Comandă nerecunoscută. Trimite *ajutor* pentru lista de comenzi disponibile (*1*, *platita*, *qr*, *status*, *ajutor*).';
    await this.deps.messaging.sendText(message.fromJid, fallback);
    return fallback;
  }

  private async handleManualTrialCommand(fromJid: string, rawText: string): Promise<string> {
    const parts = rawText.trim().split(/\s+/);
    const dateStr = parts[parts.length - 1] ?? '';
    const amountStr = parts[parts.length - 2] ?? '';
    const serviceName = parts.slice(1, parts.length - 2).join(' ').trim();

    if (!serviceName || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return '⚠️ Format: `/trial <serviciu> <suma_ron> <YYYY-MM-DD>` (ex: `/trial Adobe 149 2026-12-05`) sau scrie-mi natural în română.';
    }
    const amount = Number.parseFloat(amountStr.replace(',', '.'));
    if (Number.isNaN(amount) || amount <= 0) {
      return '⚠️ Suma trebuie să fie pozitivă (ex: `/trial Adobe 149 2026-12-05`).';
    }

    const res = await this.deps.freeTrialService!.registerFreeTrial({
      ownerJid: fromJid,
      serviceName,
      trialEndAt: new Date(`${dateStr}T10:00:00Z`),
      postTrialAmountCents: toBaniCents(amount),
      currency: 'RON',
      billingPeriod: 'MONTHLY',
      source: 'WHATSAPP_MANUAL',
      notifyOnRegister: false,
    });

    const report = this.deps.subscriptionRadarService
      ? await this.deps.subscriptionRadarService.getRadarReport(fromJid)
      : null;

    return [
      `✅ Free trial programat: *${res.trial.serviceName}* (#${res.trial.id})`,
      `• Expiră: *${dateStr}* | Cost după expirare: *${formatCentsRo(res.trial.postTrialAmountCents, res.trial.currency)}/lună*`,
      `• Alertă 48h programată pentru: *${res.trial.alert48hScheduledAt.toISOString().slice(0, 16).replace('T', ' ')} UTC*`,
      report ? `🏦 *Sold curent (Demo):* *${formatCentsRo(report.currentBalanceCents, report.balanceCurrency)}*` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async resolveTargetInvoiceId(
    fromJid: string,
    explicitId: number | null,
  ): Promise<number | null> {
    if (explicitId !== null && !Number.isNaN(explicitId) && explicitId > 0) {
      return explicitId;
    }
    return this.deps.actionContextRepo.getLatestInvoiceId(fromJid);
  }

  private async handleDraftDispute(
    fromJid: string,
    explicitId: number | null,
  ): Promise<string> {
    const invoiceId = await this.resolveTargetInvoiceId(fromJid, explicitId);
    if (!invoiceId) {
      return '⚠️ Nu am găsit nicio factură recentă în context. Specifică ID-ul facturii: *1 <id_factură>*.';
    }

    const invoice = await this.deps.invoiceRepo.findById(invoiceId);
    if (!invoice) {
      return `⚠️ Factura #${invoiceId} nu a fost găsită în baza de date.`;
    }

    let draft = await this.deps.disputeRepo.findByInvoiceId(invoiceId);
    if (!draft) {
      const providerConfig = await this.deps.providerRepo.findByCui(invoice.providerCui);
      const generated = buildDisputeDraft({
        invoice,
        flags: invoice.auditFlags,
        providerConfig,
        userFullName: this.deps.userFullName,
        includeWarnings: true,
      });

      if (!generated) {
        return `ℹ️ Factura #${invoice.id} (${invoice.providerName}, nr. ${invoice.invoiceNumber}) nu are nicio anomalie sau avertisment de contestat.`;
      }

      draft = await this.deps.disputeRepo.upsertReady(invoice.id, generated);
    }

    const gmailDraftId = await this.deps.gmailDraftClient.createGmailDraft({
      to: draft.recipientEmail,
      subject: draft.subject,
      body: draft.body,
    });

    await this.deps.disputeRepo.markSavedToGmail(invoice.id, gmailDraftId);

    return [
      `✅ Draftul de contestație pentru factura #${invoice.id} (${invoice.providerName}, nr. ${invoice.invoiceNumber}) a fost salvat în Gmail Drafts.`,
      `Destinatar: ${draft.recipientEmail}`,
      `Subiect: ${draft.subject}`,
      `Gmail Draft ID: \`${gmailDraftId}\``,
      'ℹ️ Emailul NU a fost trimis automat — verifică-l în Gmail Drafts și apasă Send manual.',
    ].join('\n');
  }

  private async handleMarkPaid(
    fromJid: string,
    explicitId: number | null,
  ): Promise<string> {
    const invoiceId = await this.resolveTargetInvoiceId(fromJid, explicitId);
    if (!invoiceId) {
      return '⚠️ Nu am găsit nicio factură recentă în context. Specifică ID-ul facturii: *platita <id_factură>*.';
    }

    if (this.deps.qrTrackingService) {
      const outcome = await this.deps.qrTrackingService.confirmPaymentForTarget(
        'INVOICE',
        invoiceId,
        fromJid,
        'WHATSAPP_COMMAND',
      );
      if (!outcome.found) {
        return `⚠️ Factura #${invoiceId} nu a fost găsită în baza de date.`;
      }
      return `✅ Factura #${invoiceId} (${outcome.payeeName}) a fost marcată ca *${outcome.paidStatus}* și reminderele de plată au fost oprite.`;
    }

    const updated = await this.deps.invoiceRepo.updatePaymentStatus(invoiceId, 'PAID_ON_TIME');
    if (!updated) {
      return `⚠️ Factura #${invoiceId} nu a fost găsită în baza de date.`;
    }

    return `✅ Factura #${updated.id} (${updated.providerName}, nr. ${updated.invoiceNumber}) a fost marcată ca *PLĂTITĂ LA TIMP* (PAID_ON_TIME).`;
  }

  private async handleSendQr(
    fromJid: string,
    explicitId: number | null,
  ): Promise<string> {
    if (!this.deps.qrTrackingService) {
      return '⚠️ Modulul de coduri QR monitorizate nu este activat.';
    }

    const invoiceId = await this.resolveTargetInvoiceId(fromJid, explicitId);
    if (!invoiceId) {
      return '⚠️ Nu am găsit nicio factură recentă în context. Specifică ID-ul: *qr <id_factură>*.';
    }

    try {
      const generated = await this.deps.qrTrackingService.getOrCreateForTarget(
        'INVOICE',
        invoiceId,
        fromJid,
      );
      await this.deps.qrTrackingService.sendQrToWhatsApp(generated);
      return '';
    } catch (err) {
      return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
