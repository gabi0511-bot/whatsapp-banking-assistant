import { Decimal } from 'decimal.js';
import type {
  AuditFlag,
  ExtractionConfidence,
  PaymentStatus,
  SourceFormat,
  ValidatedInvoice,
  ValidatedLineItem,
} from '../audit/types.js';
import {
  formatCentsRo,
  normalizeCui,
  normalizeUnit,
  type CanonicalInvoice,
} from './schema.js';

export function toBaniCents(amount: number | string | Decimal): bigint {
  const dec = amount instanceof Decimal ? amount : new Decimal(amount);
  const rounded = dec.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return BigInt(rounded.toFixed(0));
}

export function computeBillingDays(
  periodStart: string | null,
  periodEnd: string | null,
): number {
  if (!periodStart || !periodEnd) {
    return 30;
  }
  const startMs = Date.parse(`${periodStart}T00:00:00Z`);
  const endMs = Date.parse(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    return 30;
  }
  const diffDays = Math.round((endMs - startMs) / 86_400_000) + 1;
  return diffDays > 0 ? diffDays : 30;
}

export interface MathValidationInput {
  extracted: CanonicalInvoice;
  fileSha256: string;
  sourceFormat: SourceFormat;
  gmailMessageId?: string | null;
}

export function validateAndNormalizeInvoice(input: MathValidationInput): ValidatedInvoice {
  const { extracted, fileSha256, sourceFormat, gmailMessageId = null } = input;
  const validationFlags: AuditFlag[] = [];

  const totalAmountCents = toBaniCents(extracted.total_amount);
  const billingDays = computeBillingDays(
    extracted.billing_period_start,
    extracted.billing_period_end,
  );

  const lineItems: ValidatedLineItem[] = extracted.line_items.map((item) => {
    const qtyDec = new Decimal(item.quantity);
    const unitPriceDec = new Decimal(item.unit_price_net);
    const vatDec = new Decimal(item.vat_rate_pct);
    const lineTotalGrossCents = toBaniCents(item.line_total_gross);

    const isStorno =
      (qtyDec.isNegative() || lineTotalGrossCents < 0n) && item.line_type !== 'DISCOUNT';

    return {
      lineType: item.line_type,
      rawLabel: item.raw_label.trim(),
      quantity: qtyDec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
      unit: item.unit ? normalizeUnit(item.unit, item.line_type) : null,
      unitPriceNet: unitPriceDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6),
      vatRatePct: vatDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      lineTotalGrossCents,
      isStorno,
    };
  });

  // Sum line totals using exact integer cents (BIGINT).
  let sumLinesCents = 0n;
  let sumNetPlusVatCents = 0n;
  for (const item of lineItems) {
    sumLinesCents += item.lineTotalGrossCents;
    const netPlusVat = new Decimal(item.quantity)
      .mul(new Decimal(item.unitPriceNet))
      .mul(new Decimal(1).plus(new Decimal(item.vatRatePct).div(100)));
    sumNetPlusVatCents += toBaniCents(netPlusVat);
  }

  const diffDirect = sumLinesCents >= totalAmountCents
    ? sumLinesCents - totalAmountCents
    : totalAmountCents - sumLinesCents;

  const diffNetPlusVat = sumNetPlusVatCents >= totalAmountCents
    ? sumNetPlusVatCents - totalAmountCents
    : totalAmountCents - sumNetPlusVatCents;

  const bestDiff = diffDirect <= diffNetPlusVat ? diffDirect : diffNetPlusVat;
  const effectiveSumCents = diffDirect <= diffNetPlusVat ? sumLinesCents : sumNetPlusVatCents;

  let extractionConfidence: ExtractionConfidence = 'HIGH';
  if (bestDiff > 5n) {
    extractionConfidence = 'LOW';
    validationFlags.push({
      code: 'MATH_MISMATCH_LOW_CONFIDENCE',
      severity: 'WARNING',
      pillar: 'VALIDATION',
      message: `Diferență de verificare matematică: suma liniilor (${formatCentsRo(effectiveSumCents, extracted.currency)}) diferă de totalul facturii (${formatCentsRo(totalAmountCents, extracted.currency)}) cu ${formatCentsRo(bestDiff, extracted.currency)}. Încredere extragere: SCĂZUTĂ.`,
      metadata: {
        sumLinesCents: effectiveSumCents.toString(),
        totalAmountCents: totalAmountCents.toString(),
        diffCents: bestDiff.toString(),
      },
    });
  }

  let paymentStatus: PaymentStatus = 'UNPAID';
  if (totalAmountCents <= 0n) {
    paymentStatus = 'NO_PAYMENT_NEEDED';
    const explanation =
      totalAmountCents < 0n
        ? `Sold creditor (${formatCentsRo(totalAmountCents, extracted.currency)}): furnizorul îți datorează ${formatCentsRo(-totalAmountCents, extracted.currency)}. Nu este necesară nicio plată.`
        : `Total de plată 0,00 ${extracted.currency}. Nu este necesară nicio plată.`;
    validationFlags.push({
      code: 'CREDITOR_BALANCE',
      severity: 'INFO',
      pillar: 'VALIDATION',
      message: explanation,
      metadata: {
        totalAmountCents: totalAmountCents.toString(),
      },
    });
  }

  const mr = extracted.meter_reading;

  return {
    gmailMessageId,
    fileSha256,
    sourceFormat,
    providerCui: normalizeCui(extracted.provider_cui),
    providerName: extracted.provider_name.trim(),
    category: extracted.category,
    clientCode: extracted.client_code ? extracted.client_code.trim() : null,
    consumptionPointId: extracted.consumption_point_id.trim(),
    invoiceSeries: extracted.invoice_series ? extracted.invoice_series.trim() : null,
    invoiceNumber: extracted.invoice_number.trim(),
    issueDate: extracted.issue_date,
    dueDate: extracted.due_date,
    billingPeriodStart: extracted.billing_period_start,
    billingPeriodEnd: extracted.billing_period_end,
    billingDays,
    readingType: mr.reading_type,
    oldIndex:
      mr.old_index !== null
        ? new Decimal(mr.old_index).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3)
        : null,
    newIndex:
      mr.new_index !== null
        ? new Decimal(mr.new_index).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3)
        : null,
    consumptionValue:
      mr.consumption_value !== null
        ? new Decimal(mr.consumption_value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3)
        : null,
    consumptionUnit: mr.consumption_unit ? normalizeUnit(mr.consumption_unit) : null,
    selfReadingWindowStart: mr.self_reading_window_start,
    selfReadingWindowEnd: mr.self_reading_window_end,
    totalAmountCents,
    currency: extracted.currency.toUpperCase(),
    extractionConfidence,
    paymentStatus,
    validationFlags,
    lineItems,
    rawExtractedJson: extracted,
  };
}
