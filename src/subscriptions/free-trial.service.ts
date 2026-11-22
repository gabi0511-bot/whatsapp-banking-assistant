import { randomUUID } from 'node:crypto';
import type { DemoBalanceService } from '../cashflow/demo-balance.service.js';
import type { FreeTrialRepository } from '../db/repositories/free-trial.repo.js';
import type { MemoryRepository } from '../db/repositories/memory.repo.js';
import { formatCentsRo } from '../extraction/schema.js';
import type { MessagingAdapter } from '../messaging/adapter.interface.js';
import {
  computeAnnualizedCents,
  FallbackAlertComposer,
  type AlertMessageComposer,
} from './ai-alert.composer.js';
import { normalizeMerchantDescriptor } from './merchant.normalizer.js';
import type {
  BillingPeriod,
  FreeTrialSource,
  FreeTrialStatus,
  StoredFreeTrial,
} from './types.js';

const HOURS_48_MS = 48 * 3_600_000;

export interface FreeTrialServiceDeps {
  freeTrialRepo: FreeTrialRepository;
  memoryRepo: MemoryRepository;
  demoBalanceService: DemoBalanceService;
  messaging: MessagingAdapter;
  alertComposer?: AlertMessageComposer;
}

export interface RegisterFreeTrialInput {
  ownerJid: string;
  externalRef?: string;
  serviceName: string;
  trialStartAt?: Date | null;
  trialEndAt?: Date | null;
  trialDurationDays?: number | null;
  emailReceivedAt?: Date;
  postTrialAmountCents: bigint;
  currency?: string;
  billingPeriod?: BillingPeriod;
  cancellationUrl?: string | null;
  source: FreeTrialSource;
  rawExtractedJson?: Record<string, unknown>;
  now?: Date;
  notifyOnRegister?: boolean;
}

export interface RegisterFreeTrialResult {
  deduplicated: boolean;
  trial: StoredFreeTrial;
  confirmationMessage?: string;
}

export interface DispatchedTrialAlert {
  trial: StoredFreeTrial;
  message: string;
}

export function computeTrialEndAt(params: {
  explicitEndAt?: Date | null;
  trialDurationDays?: number | null;
  referenceStartAt: Date;
}): Date | null {
  if (params.explicitEndAt && !Number.isNaN(params.explicitEndAt.getTime())) {
    return params.explicitEndAt;
  }
  if (params.trialDurationDays && params.trialDurationDays > 0) {
    return new Date(params.referenceStartAt.getTime() + params.trialDurationDays * 86_400_000);
  }
  return null;
}

export function compute48hAlertSchedule(
  trialEndAt: Date,
  now: Date = new Date(),
): { status: FreeTrialStatus; alert48hScheduledAt: Date } {
  if (trialEndAt.getTime() <= now.getTime()) {
    return {
      status: 'EXPIRED',
      alert48hScheduledAt: new Date(trialEndAt.getTime() - HOURS_48_MS),
    };
  }

  const ideal48h = new Date(trialEndAt.getTime() - HOURS_48_MS);
  if (ideal48h.getTime() <= now.getTime()) {
    return {
      status: 'ACTIVE',
      alert48hScheduledAt: new Date(now.getTime()),
    };
  }

  return {
    status: 'ACTIVE',
    alert48hScheduledAt: ideal48h,
  };
}

export class FreeTrialService {
  private readonly composer: AlertMessageComposer;

  constructor(private readonly deps: FreeTrialServiceDeps) {
    this.composer = deps.alertComposer ?? new FallbackAlertComposer();
  }

  async registerFreeTrial(input: RegisterFreeTrialInput): Promise<RegisterFreeTrialResult> {
    const now = input.now ?? new Date();
    const referenceStart = input.trialStartAt ?? input.emailReceivedAt ?? now;
    const trialEndAt = computeTrialEndAt({
      explicitEndAt: input.trialEndAt,
      trialDurationDays: input.trialDurationDays,
      referenceStartAt: referenceStart,
    });

    if (!trialEndAt) {
      throw new Error('Cannot register free trial without trialEndAt or trialDurationDays');
    }

    const norm = normalizeMerchantDescriptor(input.serviceName);
    const currency = (input.currency ?? 'RON').toUpperCase();
    const billingPeriod: BillingPeriod = input.billingPeriod ?? 'MONTHLY';
    const externalRef = input.externalRef ?? `manual:${randomUUID()}`;

    const { status, alert48hScheduledAt } = compute48hAlertSchedule(trialEndAt, now);

    const { inserted, trial } = await this.deps.freeTrialRepo.insertIfNew({
      ownerJid: input.ownerJid,
      externalRef,
      serviceName: norm.displayName,
      normalizedService: norm.normalizedMerchant,
      trialStartAt: input.trialStartAt ?? input.emailReceivedAt ?? null,
      trialEndAt,
      postTrialAmountCents: input.postTrialAmountCents,
      currency,
      billingPeriod,
      cancellationUrl: input.cancellationUrl ?? null,
      source: input.source,
      status,
      alert48hScheduledAt,
      rawExtractedJson: input.rawExtractedJson ?? {},
    });

    if (!inserted) {
      return { deduplicated: true, trial };
    }

    await this.deps.memoryRepo.record({
      ownerJid: input.ownerJid,
      eventType: 'FREE_TRIAL_DETECTED',
      entityType: 'FREE_TRIAL',
      entityId: trial.id,
      summaryText: `Free trial înregistrat: ${trial.serviceName} — expiră pe ${trial.trialEndAt.toISOString().slice(0, 10)}, apoi ${formatCentsRo(trial.postTrialAmountCents, trial.currency)}/${trial.billingPeriod.toLowerCase()} (alertă 48h: ${trial.alert48hScheduledAt.toISOString()}).`,
      amountCents: trial.postTrialAmountCents,
      currency: trial.currency,
      metadata: {
        serviceName: trial.serviceName,
        trialEndAt: trial.trialEndAt.toISOString(),
        alert48hScheduledAt: trial.alert48hScheduledAt.toISOString(),
        status: trial.status,
      },
    });

    let confirmationMessage: string | undefined;
    if (input.notifyOnRegister !== false && trial.status === 'ACTIVE') {
      const balance = await this.deps.demoBalanceService.getBalance(input.ownerJid);
      const annualizedCostCents = computeAnnualizedCents(
        trial.postTrialAmountCents,
        trial.billingPeriod,
      );
      confirmationMessage = await this.composer.composeTrialDetectedNotice({
        trial,
        annualizedCostCents,
        currentBalanceCents: balance.balanceCents,
        balanceCurrency: balance.currency,
      });
      await this.deps.messaging.sendText(input.ownerJid, confirmationMessage);
    }

    return { deduplicated: false, trial, confirmationMessage };
  }

  async dispatchDue48hAlerts(now: Date = new Date()): Promise<DispatchedTrialAlert[]> {
    const dueTrials = await this.deps.freeTrialRepo.findDueFor48hAlert(now);
    const dispatched: DispatchedTrialAlert[] = [];

    for (const trial of dueTrials) {
      if (trial.trialEndAt.getTime() <= now.getTime()) {
        await this.deps.freeTrialRepo.markExpired(trial.id);
        continue;
      }

      const balance = await this.deps.demoBalanceService.getBalance(trial.ownerJid);
      const annualizedCostCents = computeAnnualizedCents(
        trial.postTrialAmountCents,
        trial.billingPeriod,
      );
      const balanceAfterChargeCents =
        trial.currency === balance.currency
          ? balance.balanceCents - trial.postTrialAmountCents
          : balance.balanceCents;

      const message = await this.composer.composeTrial48hAlert({
        trial,
        annualizedCostCents,
        currentBalanceCents: balance.balanceCents,
        balanceCurrency: balance.currency,
        balanceAfterChargeCents,
      });

      await this.deps.messaging.sendText(trial.ownerJid, message);
      const updated = await this.deps.freeTrialRepo.markAlert48hSent(trial.id, now);

      await this.deps.memoryRepo.record({
        ownerJid: trial.ownerJid,
        eventType: 'FREE_TRIAL_48H_ALERT_SENT',
        entityType: 'FREE_TRIAL',
        entityId: trial.id,
        summaryText: `Alertă 48h trimisă pentru free trial-ul ${trial.serviceName} (expiră ${trial.trialEndAt.toISOString().slice(0, 10)}, taxare automată ${formatCentsRo(trial.postTrialAmountCents, trial.currency)}).`,
        amountCents: trial.postTrialAmountCents,
        currency: trial.currency,
        metadata: {
          trialEndAt: trial.trialEndAt.toISOString(),
          currentBalanceCents: balance.balanceCents.toString(),
        },
      });

      dispatched.push({
        trial: updated ?? trial,
        message,
      });
    }

    return dispatched;
  }

  async cancelTrial(trialId: number, ownerJid: string): Promise<StoredFreeTrial | null> {
    const cancelled = await this.deps.freeTrialRepo.markCancelled(trialId);
    if (!cancelled) return null;

    await this.deps.memoryRepo.record({
      ownerJid,
      eventType: 'FREE_TRIAL_CANCELLED',
      entityType: 'FREE_TRIAL',
      entityId: cancelled.id,
      summaryText: `Free trial anulat: ${cancelled.serviceName} (oprită alerta 48h și taxarea de ${formatCentsRo(cancelled.postTrialAmountCents, cancelled.currency)}).`,
      amountCents: cancelled.postTrialAmountCents,
      currency: cancelled.currency,
    });

    return cancelled;
  }

  async handleCancellationEmail(
    ownerJid: string,
    serviceName: string,
  ): Promise<StoredFreeTrial[]> {
    const norm = normalizeMerchantDescriptor(serviceName);
    const matching = await this.deps.freeTrialRepo.findActiveByService(
      ownerJid,
      norm.normalizedMerchant,
    );
    const cancelledList: StoredFreeTrial[] = [];

    for (const trial of matching) {
      const updated = await this.cancelTrial(trial.id, ownerJid);
      if (updated) {
        cancelledList.push(updated);
        const balance = await this.deps.demoBalanceService.getBalance(ownerJid);
        const msg = await this.composer.composeTrialAutoCancelledNotice({
          serviceName: updated.serviceName,
          postTrialAmountCents: updated.postTrialAmountCents,
          currency: updated.currency,
          currentBalanceCents: balance.balanceCents,
          balanceCurrency: balance.currency,
        });
        await this.deps.messaging.sendText(ownerJid, msg);
      }
    }

    return cancelledList;
  }
}
