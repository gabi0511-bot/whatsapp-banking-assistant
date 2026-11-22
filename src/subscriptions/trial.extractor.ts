import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { z } from 'zod';
import { makeBucharestDateTime } from '../audit/rules/reading.rule.js';
import {
  callGeminiWithModelFallback,
  DEFAULT_GEMINI_PRIMARY_MODEL,
} from '../config/gemini.models.js';
import { normalizeDiacritics } from '../extraction/schema.js';
import { BILLING_PERIODS, type BillingPeriod } from './types.js';

export interface GmailRadarEmail {
  messageId: string;
  subject: string;
  from: string;
  bodyText: string;
  extractedLinks: string[];
  receivedAt: Date;
}

export const EMAIL_RADAR_CLASSIFICATIONS = [
  'FREE_TRIAL_ACTIVATION',
  'SUBSCRIPTION_RECEIPT',
  'CANCELLATION_CONFIRMATION',
  'IRRELEVANT',
] as const;
export type EmailRadarClassification = (typeof EMAIL_RADAR_CLASSIFICATIONS)[number];

export const ExtractedEmailRadarSchema = z.object({
  classification: z.enum(EMAIL_RADAR_CLASSIFICATIONS),
  is_free_trial_activation: z.boolean(),
  service_name: z.string().nullable(),
  trial_end_iso: z.string().nullable(),
  trial_duration_days: z.number().int().positive().nullable(),
  post_trial_amount: z.number().nonnegative().nullable(),
  currency: z.string().nullable(),
  billing_period: z.enum(BILLING_PERIODS).nullable(),
  cancellation_url: z.string().nullable(),
  charged_date_iso: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type ExtractedEmailRadar = z.infer<typeof ExtractedEmailRadarSchema>;

export interface EmailTrialExtractor {
  analyzeEmail(email: GmailRadarEmail): Promise<ExtractedEmailRadar>;
}

const CANCELLATION_KEYWORDS = [
  'has been cancelled',
  'has been canceled',
  'subscription cancelled',
  'subscription canceled',
  'trial cancelled',
  'trial canceled',
  'a fost anulat',
  'abonament anulat',
  'abonamentul a fost anulat',
  'anulare confirmata',
  'dezactivat cu succes',
  'nu vei mai fi taxat',
  'you will not be charged',
] as const;

const STRONG_TRIAL_OR_BILLING_SIGNALS = [
  'free trial',
  'trial period',
  'trial ends',
  'trial started',
  'trial has started',
  'days free',
  'day free',
  'month free',
  'week free',
  'perioada de proba',
  'perioada gratuita',
  'zile gratuit',
  'zile gratis',
  'luna gratuita',
  'prima luna gratuita',
  'reinnoire automata',
  'auto-renew',
  'autorenew',
  'nu vei fi taxat',
  'vei fi taxat',
  'you will be charged',
  'will be billed',
  'subscription started',
  'abonament activat',
  'confirmare activare',
  'subscription receipt',
  'your receipt from',
  'monthly plan',
  'plan lunar',
  'abonament lunar',
  'recurring payment',
  'plata recurenta',
] as const;

const NOISE_SENDER_PATTERNS = [
  /notifications@github\.com/i,
  /noreply@github\.com/i,
  /security-noreply@google\.com/i,
  /no-reply@accounts\.google\.com/i,
];

export type EmailPreFilterKind = 'CANCELLATION' | 'CANDIDATE' | 'SKIP';

export function preFilterSubscriptionEmail(
  subject: string,
  bodyText: string,
  from = '',
): EmailPreFilterKind {
  const combined = normalizeDiacritics(`${subject} ${bodyText}`).toLowerCase();

  // Never misclassify developer notification/security emails as subscriptions unless explicit billing/trial text appears
  if (
    from &&
    NOISE_SENDER_PATTERNS.some((re) => re.test(from)) &&
    !/(free trial|perioada de proba|you will be charged|vei fi taxat|subscription receipt)/i.test(
      combined,
    )
  ) {
    return 'SKIP';
  }

  if (CANCELLATION_KEYWORDS.some((kw) => combined.includes(kw))) {
    return 'CANCELLATION';
  }

  if (STRONG_TRIAL_OR_BILLING_SIGNALS.some((kw) => combined.includes(kw))) {
    return 'CANDIDATE';
  }

  return 'SKIP';
}

export function extractLinksFromHtml(html: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href=["'](https?:\/\/[^"'\s>]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    if (match[1]) {
      links.push(match[1]);
    }
  }
  return Array.from(new Set(links));
}

export function pickLikelyCancellationUrl(links: string[]): string | null {
  const priority = links.find((u) =>
    /cancel|manage|billing|subscription|account|plan|dezactiv|anulare/i.test(u),
  );
  return priority ?? null;
}

const MONTH_MAP: Record<string, number> = {
  ianuarie: 1,
  ian: 1,
  january: 1,
  jan: 1,
  februarie: 2,
  feb: 2,
  february: 2,
  martie: 3,
  mar: 3,
  march: 3,
  aprilie: 4,
  apr: 4,
  april: 4,
  mai: 5,
  may: 5,
  iunie: 6,
  iun: 6,
  june: 6,
  jun: 6,
  iulie: 7,
  iul: 7,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  septembrie: 9,
  sept: 9,
  sep: 9,
  september: 9,
  octombrie: 10,
  oct: 10,
  october: 10,
  noiembrie: 11,
  nov: 11,
  november: 11,
  decembrie: 12,
  dec: 12,
  december: 12,
};

/**
 * Parses Romanian/English written expiration dates such as:
 * "Data expirării perioadei de probă: 23 noiembrie 2026, ora 18:00"
 * or "23 noiembrie 2026, ora 18.00" -> exact UTC ISO timestamp (Europe/Bucharest).
 */
export function parseWrittenTrialEndIso(text: string): string | null {
  const norm = normalizeDiacritics(text).toLowerCase();

  // Prefer dates near expiration keywords ("expir", "pana pe", "inainte de", "ends", "until", "on")
  const contextRegex =
    /(?:expir\w*|inainte de|pana pe|ends?\s*(?:on)?|until)[^.\n]{0,45}?(\d{1,2})\s+([a-z]+)\s+(20\d{2})(?:[^.\n]{0,20}?(?:ora\s*)?(\d{1,2})[:.](\d{2}))?/i;
  const match = norm.match(contextRegex);
  if (match?.[1] && match[2] && match[3]) {
    const month = MONTH_MAP[match[2]];
    if (month) {
      const day = Number.parseInt(match[1], 10);
      const year = Number.parseInt(match[3], 10);
      const hour = match[4] ? Number.parseInt(match[4], 10) : 10;
      const minute = match[5] ? Number.parseInt(match[5], 10) : 0;
      return makeBucharestDateTime(year, month, day, hour, minute).toISOString();
    }
  }

  return null;
}

const GEMINI_EMAIL_RADAR_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    classification: { type: Type.STRING, enum: [...EMAIL_RADAR_CLASSIFICATIONS] },
    is_free_trial_activation: { type: Type.BOOLEAN },
    service_name: { type: Type.STRING, nullable: true },
    trial_end_iso: { type: Type.STRING, nullable: true },
    trial_duration_days: { type: Type.INTEGER, nullable: true },
    post_trial_amount: { type: Type.NUMBER, nullable: true },
    currency: { type: Type.STRING, nullable: true },
    billing_period: { type: Type.STRING, enum: [...BILLING_PERIODS], nullable: true },
    cancellation_url: { type: Type.STRING, nullable: true },
    charged_date_iso: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
  },
  required: [
    'classification',
    'is_free_trial_activation',
    'service_name',
    'trial_end_iso',
    'trial_duration_days',
    'post_trial_amount',
    'currency',
    'billing_period',
    'cancellation_url',
    'charged_date_iso',
    'confidence',
  ],
};

const EMAIL_RADAR_SYSTEM_PROMPT = `You are a high-precision email analyst for a Romanian personal finance assistant.
Analyze the email (sender, subject, body, received date, and extracted links) and classify it STRICTLY into one of 4 categories:

1. FREE_TRIAL_ACTIVATION: The user JUST activated/started a free trial or promotional free period that will auto-renew into a paid subscription (e.g., "Confirmare activare: Perioadă de probă gratuită – Adobe Creative Cloud", "Ai activat perioada de probă gratuită la Canva Pro", "Your 7-day trial has started", even if sent from a personal/demo email address for testing!). Set is_free_trial_activation=true.
   - Extract service_name: the ACTUAL subscribed service/product name mentioned in the email (e.g. "Adobe Creative Cloud", "Canva Pro", "Netflix", "YouTube Premium"), NOT the sender's personal name!
   - Extract trial_end_iso: exact UTC ISO-8601 timestamp (convert Romanian Europe/Bucharest dates/times like "23 noiembrie 2026, ora 18:00" accurately to ISO-8601, e.g. "2026-11-23T16:00:00Z") AND/OR trial_duration_days (integer).
   - Extract post_trial_amount: exact price after trial ends (convert "149,00 RON" -> 149.00).
   - Extract currency (RON, EUR, USD — map "lei" -> "RON").
   - Extract billing_period: WEEKLY, MONTHLY, or YEARLY.
   - Extract cancellation_url from the body or extracted links.

2. SUBSCRIPTION_RECEIPT: ONLY an actual PAID recurring subscription billing receipt/renewal (e.g. Netflix, Spotify, iCloud+, Adobe, Canva, ChatGPT Plus, World Class). NEVER classify utility/telecom bills (Hidroelectrica, Engie, E.ON, Digi, Orange), GitHub code/security/pull-request notifications, one-time e-commerce orders, or promotional newsletters as SUBSCRIPTION_RECEIPT!

3. CANCELLATION_CONFIRMATION: Confirmation that the user cancelled a subscription or free trial.

4. IRRELEVANT: Marketing promos ("Try Netflix free!"), GitHub notifications, security alerts, account verification emails, newsletters, bank OTPs, utility bills, one-time store purchases, or any email that is NOT an actual trial activation, recurring paid subscription receipt, or cancellation confirmation.

When in doubt, return IRRELEVANT with confidence 0.9 rather than inventing a fake subscription or trial.
Return strictly valid JSON matching the schema.`;

export class GeminiEmailTrialExtractor implements EmailTrialExtractor {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(apiKey: string, model = DEFAULT_GEMINI_PRIMARY_MODEL) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async analyzeEmail(email: GmailRadarEmail): Promise<ExtractedEmailRadar> {
    const pre = preFilterSubscriptionEmail(email.subject, email.bodyText, email.from);
    if (pre === 'SKIP') {
      return {
        classification: 'IRRELEVANT',
        is_free_trial_activation: false,
        service_name: null,
        trial_end_iso: null,
        trial_duration_days: null,
        post_trial_amount: null,
        currency: null,
        billing_period: null,
        cancellation_url: null,
        charged_date_iso: null,
        confidence: 1,
      };
    }

    const relevantLinks = email.extractedLinks.slice(0, 15).join('\n');
    const promptText = [
      `ReceivedAt (ISO): ${email.receivedAt.toISOString()}`,
      `From: ${email.from}`,
      `Subject: ${email.subject}`,
      '',
      'Body:',
      email.bodyText.slice(0, 6000),
      relevantLinks ? `\nExtracted Links:\n${relevantLinks}` : '',
    ].join('\n');

    let response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>> | undefined;
    try {
      const called = await callGeminiWithModelFallback({
        preferredModel: this.model,
        timeoutMs: 20_000,
        label: 'Gmail Trial Extractor',
        invoke: (model) =>
          this.ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            config: {
              systemInstruction: EMAIL_RADAR_SYSTEM_PROMPT,
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema: GEMINI_EMAIL_RADAR_SCHEMA,
            },
          }),
      });
      response = called.result;
    } catch {
      return new RuleBasedEmailTrialExtractor().analyzeEmail(email);
    }

    const raw = response?.text?.trim();
    if (!raw) {
      return new RuleBasedEmailTrialExtractor().analyzeEmail(email);
    }

    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = ExtractedEmailRadarSchema.parse(JSON.parse(cleaned));
      if (!parsed.cancellation_url && email.extractedLinks.length > 0) {
        parsed.cancellation_url = pickLikelyCancellationUrl(email.extractedLinks);
      }
      if (parsed.is_free_trial_activation && !parsed.trial_end_iso) {
        parsed.trial_end_iso = parseWrittenTrialEndIso(`${email.subject}\n${email.bodyText}`);
      }
      return parsed;
    } catch {
      return new RuleBasedEmailTrialExtractor().analyzeEmail(email);
    }
  }
}

/**
 * Deterministic extractor for offline tests, CLI simulator, and strict fallback during Gemini outages.
 */
export class RuleBasedEmailTrialExtractor implements EmailTrialExtractor {
  async analyzeEmail(email: GmailRadarEmail): Promise<ExtractedEmailRadar> {
    const pre = preFilterSubscriptionEmail(email.subject, email.bodyText, email.from);
    const combined = `${email.subject}\n${email.bodyText}`;
    const norm = normalizeDiacritics(combined).toLowerCase();

    if (pre === 'SKIP') {
      return {
        classification: 'IRRELEVANT',
        is_free_trial_activation: false,
        service_name: null,
        trial_end_iso: null,
        trial_duration_days: null,
        post_trial_amount: null,
        currency: null,
        billing_period: null,
        cancellation_url: null,
        charged_date_iso: null,
        confidence: 0.95,
      };
    }

    const serviceName = inferServiceNameFromEmail(email.subject, email.bodyText);
    const cancelUrl =
      pickLikelyCancellationUrl(email.extractedLinks) ??
      extractFirstUrlFromText(combined);

    if (pre === 'CANCELLATION') {
      return {
        classification: 'CANCELLATION_CONFIRMATION',
        is_free_trial_activation: false,
        service_name: serviceName,
        trial_end_iso: null,
        trial_duration_days: null,
        post_trial_amount: null,
        currency: null,
        billing_period: null,
        cancellation_url: cancelUrl,
        charged_date_iso: null,
        confidence: 0.9,
      };
    }

    const isTrial =
      /\b(free trial|perioada de proba|perioada gratuita|trial ends|trial period|trial has started|days free|zile gratuit|zile gratis|nu vei fi taxat|prima luna gratuita|confirmare activare)\b/i.test(
        norm,
      );

    const amountMatch = combined.match(
      /(\d+(?:[.,]\d{1,2})?)\s*(RON|LEI|EUR|USD|€|\$)/i,
    );
    const amount = amountMatch?.[1]
      ? Number.parseFloat(amountMatch[1].replace(',', '.'))
      : null;
    const rawCur = (amountMatch?.[2] ?? 'RON').toUpperCase();
    const currency =
      rawCur === 'LEI' ? 'RON' : rawCur === '€' ? 'EUR' : rawCur === '$' ? 'USD' : rawCur;

    let billingPeriod: BillingPeriod = 'MONTHLY';
    if (/\b(year|yearly|annual|anual|\/an|pe an)\b/i.test(norm)) {
      billingPeriod = 'YEARLY';
    } else if (/\b(week|weekly|saptaman)\b/i.test(norm)) {
      billingPeriod = 'WEEKLY';
    }

    const durationMatch = norm.match(/\b(\d{1,2})\s*(?:-?\s*)?(?:days?|zile)\b/i);
    const durationDays = durationMatch?.[1] ? Number.parseInt(durationMatch[1], 10) : null;

    let trialEndIso = parseWrittenTrialEndIso(combined);
    if (!trialEndIso) {
      const isoDateMatch = combined.match(/\b(20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)\b/);
      if (isoDateMatch?.[1]) {
        trialEndIso = isoDateMatch[1].includes('T')
          ? isoDateMatch[1]
          : `${isoDateMatch[1]}T10:00:00Z`;
      } else {
        const roDateMatch = combined.match(/\b(\d{2})\.(\d{2})\.(20\d{2})\b/);
        if (roDateMatch?.[1] && roDateMatch[2] && roDateMatch[3]) {
          trialEndIso = `${roDateMatch[3]}-${roDateMatch[2]}-${roDateMatch[1]}T10:00:00Z`;
        }
      }
    }

    if (isTrial && serviceName) {
      return {
        classification: 'FREE_TRIAL_ACTIVATION',
        is_free_trial_activation: true,
        service_name: serviceName,
        trial_end_iso: trialEndIso,
        trial_duration_days: durationDays,
        post_trial_amount: amount,
        currency,
        billing_period: billingPeriod,
        cancellation_url: cancelUrl,
        charged_date_iso: null,
        confidence: 0.9,
      };
    }

    // Strict check: only classify as SUBSCRIPTION_RECEIPT if a known subscription brand + explicit amount + billing signal exist
    const hasReceiptSignal =
      /\b(receipt|chitanta|plata recurenta|reinnoire|monthly plan|plan lunar|subscription)\b/i.test(
        norm,
      );
    if (hasReceiptSignal && serviceName && amount && amount > 0) {
      return {
        classification: 'SUBSCRIPTION_RECEIPT',
        is_free_trial_activation: false,
        service_name: serviceName,
        trial_end_iso: null,
        trial_duration_days: null,
        post_trial_amount: amount,
        currency,
        billing_period: billingPeriod,
        cancellation_url: cancelUrl,
        charged_date_iso: email.receivedAt.toISOString().slice(0, 10),
        confidence: 0.85,
      };
    }

    return {
      classification: 'IRRELEVANT',
      is_free_trial_activation: false,
      service_name: null,
      trial_end_iso: null,
      trial_duration_days: null,
      post_trial_amount: null,
      currency: null,
      billing_period: null,
      cancellation_url: null,
      charged_date_iso: null,
      confidence: 0.9,
    };
  }
}

function extractFirstUrlFromText(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s)>"']+/i);
  return m?.[0] ?? null;
}

function inferServiceNameFromEmail(subject: string, body: string): string | null {
  const explicitField = body.match(/serviciu\s*:\s*([^\n\r]+)/i);
  if (explicitField?.[1]?.trim()) {
    return explicitField[1].trim();
  }

  const knownBrands = [
    'Adobe Creative Cloud',
    'Adobe',
    'Canva Pro',
    'Canva',
    'Netflix',
    'Spotify',
    'YouTube Premium',
    'Disney+',
    'Apple iCloud+',
    'Google One',
    'ChatGPT Plus',
    'OpenAI',
    'Claude Pro',
    'Microsoft 365',
    'Notion',
    'Dropbox',
    'World Class',
    'Figma',
    'Cursor',
    'Amazon Prime',
    'Voyo',
    'SkyShowtime',
    'HBO Max',
  ];
  const combined = `${subject}\n${body}`;
  for (const brand of knownBrands) {
    if (combined.toLowerCase().includes(brand.toLowerCase())) {
      return brand;
    }
  }
  return null;
}
