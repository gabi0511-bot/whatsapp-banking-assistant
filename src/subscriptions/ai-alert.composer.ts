import { GoogleGenAI } from '@google/genai';
import { formatBucharestDateRo } from '../audit/rules/reading.rule.js';
import {
  callGeminiWithModelFallback,
  DEFAULT_GEMINI_PRIMARY_MODEL,
} from '../config/gemini.models.js';
import { formatCentsRo } from '../extraction/schema.js';
import type {
  BillingPeriod,
  StoredFreeTrial,
  StoredPriceHike,
  StoredSubscription,
} from './types.js';

export interface PriceHikeAlertFacts {
  subscription: StoredSubscription;
  hike: StoredPriceHike;
  currentBalanceCents: bigint;
  balanceCurrency: string;
}

export interface TrialDetectedFacts {
  trial: StoredFreeTrial;
  annualizedCostCents: bigint;
  currentBalanceCents: bigint;
  balanceCurrency: string;
}

export interface Trial48hAlertFacts {
  trial: StoredFreeTrial;
  annualizedCostCents: bigint;
  currentBalanceCents: bigint;
  balanceCurrency: string;
  balanceAfterChargeCents: bigint;
}

export interface TrialAutoCancelledFacts {
  serviceName: string;
  postTrialAmountCents: bigint;
  currency: string;
  currentBalanceCents: bigint;
  balanceCurrency: string;
}

export interface AlertMessageComposer {
  composePriceHikeAlert(facts: PriceHikeAlertFacts): Promise<string>;
  composeTrialDetectedNotice(facts: TrialDetectedFacts): Promise<string>;
  composeTrial48hAlert(facts: Trial48hAlertFacts): Promise<string>;
  composeTrialAutoCancelledNotice(facts: TrialAutoCancelledFacts): Promise<string>;
}

export function periodLabelRo(period: BillingPeriod): string {
  switch (period) {
    case 'WEEKLY':
      return 'săptămână';
    case 'YEARLY':
      return 'an';
    default:
      return 'lună';
  }
}

export function computeAnnualizedCents(amountCents: bigint, period: BillingPeriod): bigint {
  switch (period) {
    case 'WEEKLY':
      return amountCents * 52n;
    case 'YEARLY':
      return amountCents;
    default:
      return amountCents * 12n;
  }
}

export function formatFallbackPriceHikeAlert(facts: PriceHikeAlertFacts): string {
  const { subscription, hike, currentBalanceCents, balanceCurrency } = facts;
  return [
    `📈 *Alertă scumpire silențioasă — ${subscription.merchantName}*`,
    `Abonamentul a crescut de la *${formatCentsRo(hike.previousAmountCents, hike.currency)}* la *${formatCentsRo(hike.newAmountCents, hike.currency)}* (*+${hike.deltaPct}%*).`,
    `• Diferență lunară: *+${formatCentsRo(hike.monthlyDeltaCents, hike.currency)}/lună*`,
    `• Impact anual extra: *+${formatCentsRo(hike.annualDeltaCents, hike.currency)}/an*`,
    `• Cost anual total acum: *${formatCentsRo(subscription.annualizedCostCents, subscription.currency)}/an*`,
    '',
    `🏦 *Sold curent (Demo):* *${formatCentsRo(currentBalanceCents, balanceCurrency)}*`,
    '',
    `Dacă l-ai anulat deja, scrie-mi natural (de ex. *"am anulat ${subscription.merchantName}"* sau *anulat ${subscription.id}*).`,
  ].join('\n');
}

export function formatFallbackTrialDetectedNotice(facts: TrialDetectedFacts): string {
  const { trial, annualizedCostCents, currentBalanceCents, balanceCurrency } = facts;
  const endRo = formatBucharestDateRo(trial.trialEndAt);
  const alertRo = formatBucharestDateRo(trial.alert48hScheduledAt);
  const cancelPart = trial.cancellationUrl ? `\n🔗 Link anulare: ${trial.cancellationUrl}` : '';

  return [
    `🆕 *Free Trial detectat — ${trial.serviceName}*`,
    `Expiră pe: *${endRo}*`,
    `Cost după expirare: *${formatCentsRo(trial.postTrialAmountCents, trial.currency)}/${periodLabelRo(trial.billingPeriod)}* (*${formatCentsRo(annualizedCostCents, trial.currency)}/an*)`,
    `⏰ Te voi anunța automat înainte de expirare (alertă 48h programată pe *${alertRo}*).${cancelPart}`,
    '',
    `🏦 *Sold curent (Demo):* *${formatCentsRo(currentBalanceCents, balanceCurrency)}*`,
    '',
    `Când îl dezactivezi, scrie-mi pur și simplu *"am anulat trial-ul la ${trial.serviceName}"*.`,
  ].join('\n');
}

export function formatFallbackTrial48hAlert(facts: Trial48hAlertFacts): string {
  const {
    trial,
    annualizedCostCents,
    currentBalanceCents,
    balanceCurrency,
    balanceAfterChargeCents,
  } = facts;
  const endRo = formatBucharestDateRo(trial.trialEndAt);
  const cancelLine = trial.cancellationUrl ? `\n🔗 Link anulare: ${trial.cancellationUrl}` : '';

  return [
    `⏰ *Atenție: Free Trial expiră în ~48h — ${trial.serviceName}*`,
    `Expiră pe: *${endRo}*`,
    `Taxare automată dacă nu dezactivezi: *${formatCentsRo(trial.postTrialAmountCents, trial.currency)}/${periodLabelRo(trial.billingPeriod)}* (*${formatCentsRo(annualizedCostCents, trial.currency)}/an*)${cancelLine}`,
    '',
    `🏦 *Sold curent (Demo):* *${formatCentsRo(currentBalanceCents, balanceCurrency)}*`,
    `📉 *Sold estimat după taxare:* *${formatCentsRo(balanceAfterChargeCents, balanceCurrency)}*`,
    '',
    `Dacă l-ai dezactivat deja, scrie-mi *"am anulat trial-ul la ${trial.serviceName}"* (sau *anulat trial ${trial.id}*).`,
  ].join('\n');
}

export function formatFallbackTrialAutoCancelledNotice(facts: TrialAutoCancelledFacts): string {
  return [
    `✅ *Anulare Free Trial detectată în Gmail — ${facts.serviceName}*`,
    `Am văzut confirmarea de anulare pe email și am oprit alerta pentru *${facts.serviceName}* (ai economisit ${formatCentsRo(facts.postTrialAmountCents, facts.currency)}).`,
    `🏦 *Sold curent (Demo):* *${formatCentsRo(facts.currentBalanceCents, facts.balanceCurrency)}*`,
  ].join('\n');
}

export class FallbackAlertComposer implements AlertMessageComposer {
  async composePriceHikeAlert(facts: PriceHikeAlertFacts): Promise<string> {
    return formatFallbackPriceHikeAlert(facts);
  }
  async composeTrialDetectedNotice(facts: TrialDetectedFacts): Promise<string> {
    return formatFallbackTrialDetectedNotice(facts);
  }
  async composeTrial48hAlert(facts: Trial48hAlertFacts): Promise<string> {
    return formatFallbackTrial48hAlert(facts);
  }
  async composeTrialAutoCancelledNotice(facts: TrialAutoCancelledFacts): Promise<string> {
    return formatFallbackTrialAutoCancelledNotice(facts);
  }
}

const COMPOSER_SYSTEM_PROMPT = `You are a friendly, proactive Romanian personal Financial AI Twin writing short, natural WhatsApp notifications.
RULES:
1. Write naturally and conversationally in Romanian — NEVER sound like a rigid template.
2. You MUST include EVERY EXACT number, currency, date, URL, and "Sold curent (Demo)" provided in the JSON facts without changing or recalculating a single digit.
3. Keep the message crisp, easy to scan on a phone (use light WhatsApp *bold* formatting and 1–2 relevant emojis).
4. Always remind the user they can reply naturally in Romanian (e.g. "am anulat trial-ul la ..." / "am anulat abonamentul ...") — do NOT force slash commands.`;

/**
 * AI-generated natural WhatsApp alert composer using gemini-3.8-flash.
 * Always grounds every number in exact deterministic BIGINT facts and falls back
 * cleanly to deterministic formatting if Gemini is temporarily unavailable.
 */
export class GeminiAlertComposer implements AlertMessageComposer {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(apiKey: string, model = DEFAULT_GEMINI_PRIMARY_MODEL) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  private async composeWithAi(
    taskDescription: string,
    factsJson: Record<string, unknown>,
    fallbackText: string,
  ): Promise<string> {
    try {
      const { result: response } = await callGeminiWithModelFallback({
        preferredModel: this.model,
        timeoutMs: 18_000,
        label: 'Alert Composer',
        invoke: (model) =>
          this.ai.models.generateContent({
            model,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `${taskDescription}\n\nExact verified database facts (preserve all numbers, dates, URLs, and Sold curent (Demo) verbatim):\n${JSON.stringify(factsJson, null, 2)}`,
                  },
                ],
              },
            ],
            config: {
              systemInstruction: COMPOSER_SYSTEM_PROMPT,
              temperature: 0.55,
            },
          }),
      });

      const text = response.text?.trim();
      if (text && text.length > 20) {
        return text;
      }
      return fallbackText;
    } catch {
      return fallbackText;
    }
  }

  async composePriceHikeAlert(facts: PriceHikeAlertFacts): Promise<string> {
    const fallback = formatFallbackPriceHikeAlert(facts);
    return this.composeWithAi(
      'Write a short, helpful Romanian WhatsApp alert warning the user about a silent subscription price hike.',
      {
        merchant_name: facts.subscription.merchantName,
        subscription_id: facts.subscription.id,
        old_price: formatCentsRo(facts.hike.previousAmountCents, facts.hike.currency),
        new_price: formatCentsRo(facts.hike.newAmountCents, facts.hike.currency),
        increase_pct: `+${facts.hike.deltaPct}%`,
        monthly_delta: `+${formatCentsRo(facts.hike.monthlyDeltaCents, facts.hike.currency)}/lună`,
        annual_extra_cost: `+${formatCentsRo(facts.hike.annualDeltaCents, facts.hike.currency)}/an`,
        new_total_annual_cost: `${formatCentsRo(facts.subscription.annualizedCostCents, facts.subscription.currency)}/an`,
        sold_curent_demo: formatCentsRo(facts.currentBalanceCents, facts.balanceCurrency),
      },
      fallback,
    );
  }

  async composeTrialDetectedNotice(facts: TrialDetectedFacts): Promise<string> {
    const fallback = formatFallbackTrialDetectedNotice(facts);
    return this.composeWithAi(
      'Write a short, helpful Romanian WhatsApp message letting the user know you detected a new free trial in their Gmail and scheduled an automatic reminder 48 hours before expiration so they remember to cancel in time.',
      {
        service_name: facts.trial.serviceName,
        trial_id: facts.trial.id,
        expires_on: formatBucharestDateRo(facts.trial.trialEndAt),
        post_trial_charge: `${formatCentsRo(facts.trial.postTrialAmountCents, facts.trial.currency)}/${periodLabelRo(facts.trial.billingPeriod)}`,
        annualized_cost: `${formatCentsRo(facts.annualizedCostCents, facts.trial.currency)}/an`,
        reminder_48h_scheduled_for: formatBucharestDateRo(facts.trial.alert48hScheduledAt),
        cancellation_url: facts.trial.cancellationUrl,
        sold_curent_demo: formatCentsRo(facts.currentBalanceCents, facts.balanceCurrency),
      },
      fallback,
    );
  }

  async composeTrial48hAlert(facts: Trial48hAlertFacts): Promise<string> {
    const fallback = formatFallbackTrial48hAlert(facts);
    return this.composeWithAi(
      'Write an urgent yet friendly Romanian WhatsApp reminder warning the user that their free trial expires in about 48 hours and advising them to cancel now if they do not want to be charged automatically.',
      {
        service_name: facts.trial.serviceName,
        trial_id: facts.trial.id,
        expires_on: formatBucharestDateRo(facts.trial.trialEndAt),
        auto_charge_amount: `${formatCentsRo(facts.trial.postTrialAmountCents, facts.trial.currency)}/${periodLabelRo(facts.trial.billingPeriod)}`,
        annualized_cost: `${formatCentsRo(facts.annualizedCostCents, facts.trial.currency)}/an`,
        cancellation_url: facts.trial.cancellationUrl,
        sold_curent_demo: formatCentsRo(facts.currentBalanceCents, facts.balanceCurrency),
        estimated_balance_after_charge: formatCentsRo(
          facts.balanceAfterChargeCents,
          facts.balanceCurrency,
        ),
      },
      fallback,
    );
  }

  async composeTrialAutoCancelledNotice(facts: TrialAutoCancelledFacts): Promise<string> {
    const fallback = formatFallbackTrialAutoCancelledNotice(facts);
    return this.composeWithAi(
      'Write a brief, reassuring Romanian WhatsApp message confirming that you spotted their cancellation email in Gmail and stopped the upcoming trial reminder.',
      {
        service_name: facts.serviceName,
        saved_charge: formatCentsRo(facts.postTrialAmountCents, facts.currency),
        sold_curent_demo: formatCentsRo(facts.currentBalanceCents, facts.balanceCurrency),
      },
      fallback,
    );
  }
}
