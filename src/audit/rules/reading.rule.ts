import { Decimal } from 'decimal.js';
import {
  normalizeDiacritics,
  type InvoiceCategory,
  type ReadingType,
} from '../../extraction/schema.js';
import type {
  AuditFlag,
  ProviderConfig,
  ScheduledReminderDraft,
  StoredInvoice,
  ValidatedInvoice,
} from '../types.js';

const UTILITY_CATEGORIES = new Set<InvoiceCategory>(['ELECTRICITY', 'GAS', 'WATER']);

const ESTIMATED_KEYWORDS = [
  'estimat',
  'estimare',
  'conventie de consum',
  'consum estimat',
  'citire estimata',
  'index estimat',
] as const;

export interface ReadingRuleInput {
  invoice: ValidatedInvoice;
  rawText?: string;
  previousInvoice: StoredInvoice | null;
  providerConfig: ProviderConfig | null;
  now?: Date;
}

export interface ReadingRuleOutput {
  effectiveReadingType: ReadingType;
  flags: AuditFlag[];
  scheduledReminder: ScheduledReminderDraft | null;
}

interface BucharestDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function getBucharestDateParts(date: Date): BucharestDateParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const val = parts.find((p) => p.type === type)?.value ?? '0';
    return Number.parseInt(val, 10);
  };

  const rawHour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: get('minute'),
    second: get('second'),
  };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Converts a Europe/Bucharest wall-clock date/time into the exact UTC Date instant,
 * handling EET (UTC+2) and EEST (UTC+3) transitions accurately.
 */
export function makeBucharestDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = targetAsUtc;

  for (let i = 0; i < 2; i++) {
    const local = getBucharestDateParts(new Date(guess));
    const localAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
      0,
    );
    const diff = targetAsUtc - localAsUtc;
    guess += diff;
    if (diff === 0) {
      break;
    }
  }

  return new Date(guess);
}

export function computeSelfReadingTriggerAt(
  windowStart: number,
  windowEnd: number,
  now: Date = new Date(),
): Date {
  const localNow = getBucharestDateParts(now);
  const currentMonthMaxDay = daysInMonth(localNow.year, localNow.month);
  const clampedStart = Math.min(Math.max(1, windowStart), currentMonthMaxDay);
  const clampedEnd = Math.min(Math.max(clampedStart, windowEnd), currentMonthMaxDay);

  if (localNow.day < clampedStart) {
    return makeBucharestDateTime(localNow.year, localNow.month, clampedStart, 9, 0);
  }

  if (localNow.day >= clampedStart && localNow.day <= clampedEnd) {
    return new Date(now.getTime() + 60_000);
  }

  const nextMonth = localNow.month === 12 ? 1 : localNow.month + 1;
  const nextYear = localNow.month === 12 ? localNow.year + 1 : localNow.year;
  const nextMonthMaxDay = daysInMonth(nextYear, nextMonth);
  const clampedNextStart = Math.min(Math.max(1, windowStart), nextMonthMaxDay);

  return makeBucharestDateTime(nextYear, nextMonth, clampedNextStart, 9, 0);
}

export function formatBucharestDateRo(date: Date): string {
  const p = getBucharestDateParts(date);
  return `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}.${p.year}`;
}

export function detectEstimatedKeyword(rawText: string | undefined): string | null {
  if (!rawText) {
    return null;
  }
  const normalized = normalizeDiacritics(rawText).toLowerCase();
  for (const kw of ESTIMATED_KEYWORDS) {
    if (normalized.includes(kw)) {
      return kw;
    }
  }
  return null;
}

export function evaluateReadingRule(input: ReadingRuleInput): ReadingRuleOutput {
  const { invoice, rawText, previousInvoice, providerConfig, now = new Date() } = input;

  if (!UTILITY_CATEGORIES.has(invoice.category)) {
    return {
      effectiveReadingType: invoice.readingType,
      flags: [],
      scheduledReminder: null,
    };
  }

  const flags: AuditFlag[] = [];
  let effectiveReadingType: ReadingType = invoice.readingType;

  // Step 1 & Step 2: Semantic ESTIMATED check + raw-text keyword cross-check.
  const matchedKeyword = detectEstimatedKeyword(rawText);
  let isEstimated = invoice.readingType === 'ESTIMATED';

  if (matchedKeyword && invoice.readingType !== 'REGULARIZATION') {
    effectiveReadingType = 'ESTIMATED';
    isEstimated = true;
  }

  let estimatedFlag: AuditFlag | null = null;
  if (isEstimated) {
    const reasonDetail = matchedKeyword
      ? `detectat prin cuvânt-cheie "${matchedKeyword}" în textul facturii`
      : 'tip citire extras: ESTIMATED';
    estimatedFlag = {
      code: 'ESTIMATED_READING',
      severity: 'WARNING',
      pillar: 'READING',
      message: `Factură bazată pe consum ESTIMAT (${reasonDetail}).`,
      metadata: {
        matchedKeyword,
        originalReadingType: invoice.readingType,
      },
    };
    flags.push(estimatedFlag);
  }

  // Step 3a: Index continuity / overlap check.
  const hasStornoLines = invoice.lineItems.some((item) => item.isStorno);
  const isValidStornoRegularization =
    effectiveReadingType === 'REGULARIZATION' && hasStornoLines;

  if (
    previousInvoice &&
    invoice.oldIndex !== null &&
    previousInvoice.newIndex !== null &&
    !isValidStornoRegularization
  ) {
    const currOld = new Decimal(invoice.oldIndex);
    const prevNew = new Decimal(previousInvoice.newIndex);
    if (currOld.lt(prevNew)) {
      const overlap = prevNew.minus(currOld);
      const unitLabel = invoice.consumptionUnit ?? 'unități';
      flags.push({
        code: 'INDEX_OVERLAP_ANOMALY',
        severity: 'CRITICAL',
        pillar: 'READING',
        message: `Suprapunere de index (dublă facturare): indexul vechi (${currOld.toFixed()}) este mai mic decât indexul nou de pe factura anterioară nr. ${previousInvoice.invoiceNumber} (${prevNew.toFixed()}) — ${overlap.toFixed()} ${unitLabel} facturați de două ori.`,
        metadata: {
          previousInvoiceNumber: previousInvoice.invoiceNumber,
          previousNewIndex: prevNew.toFixed(3),
          currentOldIndex: currOld.toFixed(3),
          overlap: overlap.toFixed(3),
          unit: unitLabel,
        },
      });
    }
  }

  // Step 3b: Repeated round estimate heuristic.
  let repeatedEstimateFlag: AuditFlag | null = null;
  if (
    effectiveReadingType !== 'OPERATOR_READ' &&
    previousInvoice &&
    invoice.consumptionValue !== null &&
    previousInvoice.consumptionValue !== null
  ) {
    const currVal = new Decimal(invoice.consumptionValue);
    const prevVal = new Decimal(previousInvoice.consumptionValue);
    if (
      currVal.gt(0) &&
      currVal.eq(prevVal) &&
      currVal.mod(50).isZero()
    ) {
      const unitLabel = invoice.consumptionUnit ?? 'unități';
      repeatedEstimateFlag = {
        code: 'SUSPECTED_REPEATED_ESTIMATE',
        severity: 'WARNING',
        pillar: 'READING',
        message: `Consum rotund identic repetat (${currVal.toFixed()} ${unitLabel}, identic cu factura anterioară nr. ${previousInvoice.invoiceNumber}) — probabil estimare repetată din convenția de consum.`,
        metadata: {
          consumptionValue: currVal.toFixed(3),
          previousInvoiceNumber: previousInvoice.invoiceNumber,
          unit: unitLabel,
        },
      };
      flags.push(repeatedEstimateFlag);
    }
  }

  // Step 4: Automatic self-reading reminder scheduling.
  let scheduledReminder: ScheduledReminderDraft | null = null;
  if (estimatedFlag || repeatedEstimateFlag) {
    const windowStart =
      invoice.selfReadingWindowStart ?? providerConfig?.selfReadingWindowStart ?? null;
    const windowEnd =
      invoice.selfReadingWindowEnd ?? providerConfig?.selfReadingWindowEnd ?? null;

    if (windowStart !== null && windowEnd !== null) {
      const triggerAt = computeSelfReadingTriggerAt(windowStart, windowEnd, now);
      const triggerDateRo = formatBucharestDateRo(triggerAt);
      scheduledReminder = {
        reminderType: 'SELF_READING',
        triggerAt,
        payload: {
          provider_name: invoice.providerName,
          client_code: invoice.clientCode,
          consumption_point_id: invoice.consumptionPointId,
          last_index: invoice.newIndex ?? previousInvoice?.newIndex ?? null,
          window_start: windowStart,
          window_end: windowEnd,
        },
      };

      const targetFlag = estimatedFlag ?? repeatedEstimateFlag;
      if (targetFlag) {
        targetFlag.message += ` Reminder autocitire programat pentru ${triggerDateRo} (fereastră ${windowStart}–${windowEnd} ale lunii).`;
        targetFlag.metadata = {
          ...(targetFlag.metadata ?? {}),
          reminderTriggerAt: triggerAt.toISOString(),
          reminderDateRo: triggerDateRo,
          windowStart,
          windowEnd,
        };
      }
    }
  }

  return {
    effectiveReadingType,
    flags,
    scheduledReminder,
  };
}
