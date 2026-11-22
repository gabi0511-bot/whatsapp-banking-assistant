import type {
  CanonicalInvoice,
  InvoiceCategory,
  LineType,
  ReadingType,
} from '../extraction/schema.js';

export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type AuditFlagCode =
  | 'CREDITOR_BALANCE'
  | 'MATH_MISMATCH_LOW_CONFIDENCE'
  | 'ESTIMATED_READING'
  | 'INDEX_OVERLAP_ANOMALY'
  | 'SUSPECTED_REPEATED_ESTIMATE'
  | 'UNIT_PRICE_INCREASE'
  | 'CONTRACTUAL_RATE_BREACH'
  | 'PROMO_EXPIRED'
  | 'LATE_FEE_DETECTED'
  | 'CONSUMPTION_SPIKE'
  | 'REGULARIZATION_ANOMALY';

export interface AuditFlag {
  code: AuditFlagCode;
  severity: AuditSeverity;
  pillar: 'VALIDATION' | 'READING' | 'PRICING' | 'DISPUTE';
  message: string;
  metadata?: Record<string, unknown>;
}

export type SourceFormat = 'PDF' | 'XML';
export type ExtractionConfidence = 'HIGH' | 'LOW';
export type PaymentStatus =
  | 'UNPAID'
  | 'PAID_ON_TIME'
  | 'PAID_LATE'
  | 'NO_PAYMENT_NEEDED'
  | 'HOLD_BEFORE_PAYMENT';

export interface ProviderConfig {
  id: number;
  providerCui: string;
  providerName: string;
  category: InvoiceCategory;
  disputeEmail: string | null;
  selfReadingWindowStart: number | null;
  selfReadingWindowEnd: number | null;
  contractualUnitPriceNet: string | null;
  unitPriceAlertThresholdPct: string;
}

export interface ValidatedLineItem {
  lineType: LineType;
  rawLabel: string;
  quantity: string;
  unit: string | null;
  unitPriceNet: string;
  vatRatePct: string;
  lineTotalGrossCents: bigint;
  isStorno: boolean;
}

export interface ValidatedInvoice {
  gmailMessageId: string | null;
  fileSha256: string;
  sourceFormat: SourceFormat;
  providerCui: string;
  providerName: string;
  category: InvoiceCategory;
  clientCode: string | null;
  consumptionPointId: string;
  invoiceSeries: string | null;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  billingDays: number;
  readingType: ReadingType;
  oldIndex: string | null;
  newIndex: string | null;
  consumptionValue: string | null;
  consumptionUnit: string | null;
  selfReadingWindowStart: number | null;
  selfReadingWindowEnd: number | null;
  totalAmountCents: bigint;
  currency: string;
  extractionConfidence: ExtractionConfidence;
  paymentStatus: PaymentStatus;
  validationFlags: AuditFlag[];
  lineItems: ValidatedLineItem[];
  rawExtractedJson: CanonicalInvoice;
}

export interface StoredLineItem extends ValidatedLineItem {
  id: number;
  invoiceId: number;
}

export interface StoredInvoice {
  id: number;
  gmailMessageId: string | null;
  fileSha256: string;
  sourceFormat: SourceFormat;
  providerCui: string;
  providerName: string;
  category: InvoiceCategory;
  clientCode: string | null;
  consumptionPointId: string;
  invoiceSeries: string | null;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  billingDays: number;
  readingType: ReadingType;
  oldIndex: string | null;
  newIndex: string | null;
  consumptionValue: string | null;
  consumptionUnit: string | null;
  selfReadingWindowStart: number | null;
  selfReadingWindowEnd: number | null;
  totalAmountCents: bigint;
  currency: string;
  extractionConfidence: ExtractionConfidence;
  paymentStatus: PaymentStatus;
  auditFlags: AuditFlag[];
  rawExtractedJson: CanonicalInvoice;
  lineItems: StoredLineItem[];
  createdAt: Date;
}

export interface SelfReadingReminderPayload {
  provider_name: string;
  client_code: string | null;
  consumption_point_id: string;
  last_index: string | null;
  window_start: number;
  window_end: number;
}

export interface ScheduledReminderDraft {
  reminderType: 'SELF_READING';
  triggerAt: Date;
  payload: SelfReadingReminderPayload;
}

export interface StoredReminder {
  id: number;
  invoiceId: number;
  recipientJid: string;
  reminderType: 'SELF_READING';
  triggerAt: Date;
  payload: SelfReadingReminderPayload;
  status: 'PENDING' | 'SENT' | 'CANCELLED';
  sentAt: Date | null;
  createdAt: Date;
}

export interface DisputeDraftContent {
  recipientEmail: string;
  subject: string;
  body: string;
  anomalySummary: AuditFlag[];
}

export interface StoredDisputeDraft extends DisputeDraftContent {
  id: number;
  invoiceId: number;
  gmailDraftId: string | null;
  status: 'READY' | 'SAVED_TO_GMAIL';
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditContext {
  invoice: ValidatedInvoice;
  rawText?: string;
  previousInvoice: StoredInvoice | null;
  recentRealInvoices: StoredInvoice[];
  recentEstimatedInvoices: StoredInvoice[];
  providerConfig: ProviderConfig | null;
  userFullName: string;
  now?: Date;
}

export interface AuditResult {
  readingType: ReadingType;
  paymentStatus: PaymentStatus;
  flags: AuditFlag[];
  scheduledReminder: ScheduledReminderDraft | null;
  disputeDraft: DisputeDraftContent | null;
}
