import type { Logger } from 'pino';
import type { FreeTrialRepository } from '../db/repositories/free-trial.repo.js';
import type { SubscriptionChargeRepository } from '../db/repositories/subscription-charge.repo.js';
import { toBaniCents } from '../extraction/math.validator.js';
import type { GmailPollerClient } from '../ingestion/gmail.client.js';
import type { FreeTrialService } from './free-trial.service.js';
import type { RecurrenceEngine } from './recurrence.engine.js';
import type { EmailTrialExtractor, GmailRadarEmail } from './trial.extractor.js';

export interface GmailRadarServiceDeps {
  gmailClient: GmailPollerClient;
  extractor: EmailTrialExtractor;
  freeTrialService: FreeTrialService;
  recurrenceEngine: RecurrenceEngine;
  freeTrialRepo?: FreeTrialRepository;
  chargeRepo?: SubscriptionChargeRepository;
  ownerJid: string;
  freeTrialQuery: string;
  subscriptionReceiptQuery: string;
  logger?: Logger;
}

export interface GmailRadarScanSummary {
  scannedEmails: number;
  detectedTrials: number;
  detectedReceipts: number;
  autoCancelledTrials: number;
  priceHikesDetected: number;
}

export class GmailRadarService {
  private readonly ignoredMessageIds = new Set<string>();

  constructor(private readonly deps: GmailRadarServiceDeps) {}

  async scanGmailOnce(now: Date = new Date()): Promise<GmailRadarScanSummary> {
    const summary: GmailRadarScanSummary = {
      scannedEmails: 0,
      detectedTrials: 0,
      detectedReceipts: 0,
      autoCancelledTrials: 0,
      priceHikesDetected: 0,
    };

    if (!this.deps.gmailClient.fetchTextEmailsByQuery) {
      return summary;
    }

    const [trialEmails, receiptEmails] = await Promise.all([
      this.deps.gmailClient.fetchTextEmailsByQuery(this.deps.freeTrialQuery, 15),
      this.deps.gmailClient.fetchTextEmailsByQuery(this.deps.subscriptionReceiptQuery, 15),
    ]);

    const uniqueById = new Map<string, GmailRadarEmail>();
    for (const email of [...trialEmails, ...receiptEmails]) {
      if (!uniqueById.has(email.messageId)) {
        uniqueById.set(email.messageId, email);
      }
    }

    for (const email of uniqueById.values()) {
      if (this.ignoredMessageIds.has(email.messageId)) {
        continue;
      }

      const externalRef = `gmail:${email.messageId}`;
      if (this.deps.freeTrialRepo) {
        const existingTrial = await this.deps.freeTrialRepo.findByExternalRef(externalRef);
        if (existingTrial) {
          this.ignoredMessageIds.add(email.messageId);
          continue;
        }
      }
      if (this.deps.chargeRepo) {
        const existingCharge = await this.deps.chargeRepo.findByExternalRef(externalRef);
        if (existingCharge) {
          this.ignoredMessageIds.add(email.messageId);
          continue;
        }
      }

      const result = await this.processEmail(email, now);
      summary.scannedEmails += 1;
      summary.detectedTrials += result.detectedTrial ? 1 : 0;
      summary.detectedReceipts += result.detectedReceipt ? 1 : 0;
      summary.autoCancelledTrials += result.autoCancelledCount;
      summary.priceHikesDetected += result.priceHikeDetected ? 1 : 0;

      if (!result.detectedTrial && !result.detectedReceipt && result.autoCancelledCount === 0) {
        this.ignoredMessageIds.add(email.messageId);
      }

      // Gentle pacing to avoid Gemini RPM burst rate limits
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return summary;
  }

  async processEmail(
    email: GmailRadarEmail,
    now: Date = new Date(),
  ): Promise<{
    detectedTrial: boolean;
    detectedReceipt: boolean;
    autoCancelledCount: number;
    priceHikeDetected: boolean;
  }> {
    const extracted = await this.deps.extractor.analyzeEmail(email);

    if (extracted.classification === 'IRRELEVANT' || extracted.confidence < 0.65) {
      return {
        detectedTrial: false,
        detectedReceipt: false,
        autoCancelledCount: 0,
        priceHikeDetected: false,
      };
    }

    if (extracted.classification === 'CANCELLATION_CONFIRMATION' && extracted.service_name) {
      const cancelled = await this.deps.freeTrialService.handleCancellationEmail(
        this.deps.ownerJid,
        extracted.service_name,
      );
      return {
        detectedTrial: false,
        detectedReceipt: false,
        autoCancelledCount: cancelled.length,
        priceHikeDetected: false,
      };
    }

    if (
      (extracted.classification === 'FREE_TRIAL_ACTIVATION' ||
        extracted.is_free_trial_activation) &&
      extracted.service_name
    ) {
      const postAmountCents =
        extracted.post_trial_amount && extracted.post_trial_amount > 0
          ? toBaniCents(extracted.post_trial_amount)
          : 100n; // Minimal fallback only if email omitted exact post-trial price

      const explicitEnd = extracted.trial_end_iso ? new Date(extracted.trial_end_iso) : null;
      const durationDays =
        explicitEnd && !Number.isNaN(explicitEnd.getTime())
          ? extracted.trial_duration_days
          : (extracted.trial_duration_days ?? 7);

      const reg = await this.deps.freeTrialService.registerFreeTrial({
        ownerJid: this.deps.ownerJid,
        externalRef: `gmail:${email.messageId}`,
        serviceName: extracted.service_name,
        trialStartAt: email.receivedAt,
        trialEndAt: explicitEnd,
        trialDurationDays: durationDays,
        emailReceivedAt: email.receivedAt,
        postTrialAmountCents: postAmountCents,
        currency: extracted.currency ?? 'RON',
        billingPeriod: extracted.billing_period ?? 'MONTHLY',
        cancellationUrl: extracted.cancellation_url,
        source: 'GMAIL_EMAIL',
        rawExtractedJson: extracted as unknown as Record<string, unknown>,
        now,
        notifyOnRegister: true,
      });

      this.deps.logger?.info(
        {
          messageId: email.messageId,
          serviceName: reg.trial.serviceName,
          deduplicated: reg.deduplicated,
          alert48hScheduledAt: reg.trial.alert48hScheduledAt.toISOString(),
        },
        'Processed Gmail free-trial email.',
      );

      return {
        detectedTrial: !reg.deduplicated,
        detectedReceipt: false,
        autoCancelledCount: 0,
        priceHikeDetected: false,
      };
    }

    if (
      extracted.classification === 'SUBSCRIPTION_RECEIPT' &&
      extracted.service_name &&
      extracted.post_trial_amount &&
      extracted.post_trial_amount > 0
    ) {
      const res = await this.deps.recurrenceEngine.ingestChargeEvent({
        ownerJid: this.deps.ownerJid,
        externalRef: `gmail:${email.messageId}`,
        merchantName: extracted.service_name,
        amountCents: toBaniCents(extracted.post_trial_amount),
        currency: extracted.currency ?? 'RON',
        chargedDate: extracted.charged_date_iso ?? email.receivedAt.toISOString().slice(0, 10),
        isExplicitRecurring: true,
        source: 'GMAIL_RECEIPT',
        rawSnippet: email.subject.slice(0, 200),
      });

      return {
        detectedTrial: false,
        detectedReceipt: !res.deduplicated,
        autoCancelledCount: 0,
        priceHikeDetected: res.priceHikeAlert !== null,
      };
    }

    return {
      detectedTrial: false,
      detectedReceipt: false,
      autoCancelledCount: 0,
      priceHikeDetected: false,
    };
  }
}
