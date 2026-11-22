import { Type, type Schema } from '@google/genai';
import { z } from 'zod';

export const INVOICE_CATEGORIES = [
  'ELECTRICITY',
  'GAS',
  'TELECOM',
  'WATER',
  'OTHER',
] as const;
export type InvoiceCategory = (typeof INVOICE_CATEGORIES)[number];

export const READING_TYPES = [
  'SELF_READ',
  'OPERATOR_READ',
  'ESTIMATED',
  'REGULARIZATION',
  'N_A',
] as const;
export type ReadingType = (typeof READING_TYPES)[number];

export const LINE_TYPES = [
  'ACTIVE_ENERGY',
  'GAS_ENERGY',
  'DISTRIBUTION_TAX',
  'BASE_SUBSCRIPTION',
  'DISCOUNT',
  'PENALTY',
  'REGULARIZATION',
  'OTHER',
] as const;
export type LineType = (typeof LINE_TYPES)[number];

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected ISO date format YYYY-MM-DD');

export const MeterReadingSchema = z.object({
  reading_type: z.enum(READING_TYPES),
  old_index: z.number().nullable(),
  new_index: z.number().nullable(),
  consumption_value: z.number().nullable(),
  consumption_unit: z.string().nullable(),
  self_reading_window_start: z.number().int().min(1).max(31).nullable(),
  self_reading_window_end: z.number().int().min(1).max(31).nullable(),
});

export type MeterReading = z.infer<typeof MeterReadingSchema>;

export const CanonicalLineItemSchema = z.object({
  line_type: z.enum(LINE_TYPES),
  raw_label: z.string().min(1),
  quantity: z.number(),
  unit: z.string().nullable(),
  unit_price_net: z.number(),
  vat_rate_pct: z.number().min(0).max(100),
  line_total_gross: z.number(),
});

export type CanonicalLineItem = z.infer<typeof CanonicalLineItemSchema>;

export const CanonicalInvoiceSchema = z.object({
  provider_name: z.string().min(1),
  provider_cui: z.string().min(1).transform(normalizeCui),
  category: z.enum(INVOICE_CATEGORIES),
  client_code: z.string().nullable(),
  consumption_point_id: z.string().min(1),
  invoice_series: z.string().nullable(),
  invoice_number: z.string().min(1),
  issue_date: IsoDateSchema,
  due_date: IsoDateSchema,
  billing_period_start: IsoDateSchema.nullable(),
  billing_period_end: IsoDateSchema.nullable(),
  total_amount: z.number(),
  currency: z
    .string()
    .min(3)
    .max(3)
    .default('RON')
    .transform((v) => v.toUpperCase()),
  meter_reading: MeterReadingSchema,
  line_items: z.array(CanonicalLineItemSchema).min(1),
});

export type CanonicalInvoice = z.infer<typeof CanonicalInvoiceSchema>;

export const GEMINI_INVOICE_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    provider_name: { type: Type.STRING },
    provider_cui: { type: Type.STRING },
    category: { type: Type.STRING, enum: [...INVOICE_CATEGORIES] },
    client_code: { type: Type.STRING, nullable: true },
    consumption_point_id: { type: Type.STRING },
    invoice_series: { type: Type.STRING, nullable: true },
    invoice_number: { type: Type.STRING },
    issue_date: { type: Type.STRING },
    due_date: { type: Type.STRING },
    billing_period_start: { type: Type.STRING, nullable: true },
    billing_period_end: { type: Type.STRING, nullable: true },
    total_amount: { type: Type.NUMBER },
    currency: { type: Type.STRING },
    meter_reading: {
      type: Type.OBJECT,
      properties: {
        reading_type: { type: Type.STRING, enum: [...READING_TYPES] },
        old_index: { type: Type.NUMBER, nullable: true },
        new_index: { type: Type.NUMBER, nullable: true },
        consumption_value: { type: Type.NUMBER, nullable: true },
        consumption_unit: { type: Type.STRING, nullable: true },
        self_reading_window_start: { type: Type.INTEGER, nullable: true },
        self_reading_window_end: { type: Type.INTEGER, nullable: true },
      },
      required: [
        'reading_type',
        'old_index',
        'new_index',
        'consumption_value',
        'consumption_unit',
        'self_reading_window_start',
        'self_reading_window_end',
      ],
    },
    line_items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          line_type: { type: Type.STRING, enum: [...LINE_TYPES] },
          raw_label: { type: Type.STRING },
          quantity: { type: Type.NUMBER },
          unit: { type: Type.STRING, nullable: true },
          unit_price_net: { type: Type.NUMBER },
          vat_rate_pct: { type: Type.NUMBER },
          line_total_gross: { type: Type.NUMBER },
        },
        required: [
          'line_type',
          'raw_label',
          'quantity',
          'unit',
          'unit_price_net',
          'vat_rate_pct',
          'line_total_gross',
        ],
      },
    },
  },
  required: [
    'provider_name',
    'provider_cui',
    'category',
    'client_code',
    'consumption_point_id',
    'invoice_series',
    'invoice_number',
    'issue_date',
    'due_date',
    'billing_period_start',
    'billing_period_end',
    'total_amount',
    'currency',
    'meter_reading',
    'line_items',
  ],
};

export function normalizeCui(raw: string): string {
  return raw.replace(/[\s.-]+/g, '').toUpperCase();
}

export function normalizeDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[șş]/g, 's')
    .replace(/[ȘŞ]/g, 'S')
    .replace(/[țţ]/g, 't')
    .replace(/[ȚŢ]/g, 'T');
}

export function normalizeUnit(unit: string | null | undefined, lineType?: LineType): string {
  const cleaned = normalizeDiacritics((unit ?? '').trim().toLowerCase());
  if (!cleaned) {
    return lineType === 'BASE_SUBSCRIPTION' ? 'unit' : 'unit';
  }
  if (cleaned === 'kwh' || cleaned === 'kw/h' || cleaned === 'kwt') {
    return 'kWh';
  }
  if (cleaned === 'mwh' || cleaned === 'mw/h') {
    return 'MWh';
  }
  if (
    cleaned === 'mc' ||
    cleaned === 'm3' ||
    cleaned === 'm³' ||
    cleaned === 'mtq' ||
    cleaned === 'metri cubi' ||
    cleaned === 'm.c.'
  ) {
    return 'mc';
  }
  if (
    cleaned === 'luna' ||
    cleaned === 'luni' ||
    cleaned === 'buc' ||
    cleaned === 'bucata' ||
    cleaned === 'bucati' ||
    cleaned === 'unit' ||
    cleaned === 'mon' ||
    cleaned === 'month' ||
    cleaned === 'ea' ||
    cleaned === 'c62' ||
    cleaned === 'h87' ||
    cleaned === 'zi' ||
    cleaned === 'zile'
  ) {
    return 'unit';
  }
  return cleaned;
}

export function formatCentsRo(cents: bigint, currency?: string): string {
  const isNeg = cents < 0n;
  const abs = isNeg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const sign = isNeg ? '-' : '';
  const formatted = `${sign}${whole.toString()},${frac.toString().padStart(2, '0')}`;
  return currency ? `${formatted} ${currency}` : formatted;
}

export function formatIsoDateRo(isoDate: string): string {
  const parts = isoDate.split('-');
  if (parts.length !== 3) {
    return isoDate;
  }
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}
