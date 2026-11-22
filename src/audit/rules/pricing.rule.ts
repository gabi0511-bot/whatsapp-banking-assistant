import { Decimal } from 'decimal.js';
import {
  formatCentsRo,
  normalizeDiacritics,
  normalizeUnit,
  type InvoiceCategory,
  type LineType,
  type ReadingType,
} from '../../extraction/schema.js';
import type {
  AuditFlag,
  ProviderConfig,
  StoredInvoice,
  ValidatedInvoice,
  ValidatedLineItem,
} from '../types.js';

const COMPARABLE_PRICE_LINE_TYPES = new Set<LineType>([
  'ACTIVE_ENERGY',
  'GAS_ENERGY',
  'DISTRIBUTION_TAX',
  'BASE_SUBSCRIPTION',
]);

const PRIMARY_CONTRACTUAL_LINE_TYPES: Record<InvoiceCategory, Set<LineType>> = {
  ELECTRICITY: new Set<LineType>(['ACTIVE_ENERGY']),
  GAS: new Set<LineType>(['GAS_ENERGY']),
  TELECOM: new Set<LineType>(['BASE_SUBSCRIPTION']),
  WATER: new Set<LineType>(['ACTIVE_ENERGY', 'BASE_SUBSCRIPTION']),
  OTHER: new Set<LineType>(['ACTIVE_ENERGY', 'GAS_ENERGY', 'BASE_SUBSCRIPTION']),
};

const PENALTY_KEYWORDS = [
  'penalit',
  'dobanzi de intarziere',
  'dobanda intarziere',
  'taxa reconectare',
  'cheltuieli notificare',
  'majorari intarziere',
] as const;

interface GroupedPrice {
  lineType: LineType;
  normalizedUnit: string;
  weightedUnitPriceNet: Decimal;
  totalQuantity: Decimal;
  sampleLabel: string;
}

function groupUnitPrices(lineItems: ValidatedLineItem[]): Map<string, GroupedPrice> {
  const buckets = new Map<
    string,
    {
      lineType: LineType;
      normalizedUnit: string;
      weightedSum: Decimal;
      totalQty: Decimal;
      priceSum: Decimal;
      count: number;
      sampleLabel: string;
    }
  >();

  for (const item of lineItems) {
    if (item.isStorno) {
      continue;
    }
    if (!COMPARABLE_PRICE_LINE_TYPES.has(item.lineType)) {
      continue;
    }
    const price = new Decimal(item.unitPriceNet);
    if (price.lte(0)) {
      continue;
    }
    const qty = new Decimal(item.quantity).abs();
    const normUnit = normalizeUnit(item.unit, item.lineType);
    const key = `${item.lineType}::${normUnit}`;

    const existing = buckets.get(key);
    if (existing) {
      existing.weightedSum = existing.weightedSum.plus(price.mul(qty));
      existing.totalQty = existing.totalQty.plus(qty);
      existing.priceSum = existing.priceSum.plus(price);
      existing.count += 1;
    } else {
      buckets.set(key, {
        lineType: item.lineType,
        normalizedUnit: normUnit,
        weightedSum: price.mul(qty),
        totalQty: qty,
        priceSum: price,
        count: 1,
        sampleLabel: item.rawLabel,
      });
    }
  }

  const result = new Map<string, GroupedPrice>();
  for (const [key, b] of buckets.entries()) {
    const weightedUnitPriceNet = b.totalQty.gt(0)
      ? b.weightedSum.div(b.totalQty)
      : b.priceSum.div(b.count);

    result.set(key, {
      lineType: b.lineType,
      normalizedUnit: b.normalizedUnit,
      weightedUnitPriceNet,
      totalQuantity: b.totalQty,
      sampleLabel: b.sampleLabel,
    });
  }

  return result;
}

function sumAbsoluteDiscountCents(lineItems: ValidatedLineItem[]): bigint {
  let sum = 0n;
  for (const item of lineItems) {
    if (item.lineType === 'DISCOUNT') {
      const abs = item.lineTotalGrossCents < 0n ? -item.lineTotalGrossCents : item.lineTotalGrossCents;
      sum += abs;
    }
  }
  return sum;
}

function lineTypeLabelRo(lineType: LineType): string {
  switch (lineType) {
    case 'ACTIVE_ENERGY':
      return 'Energie activă';
    case 'GAS_ENERGY':
      return 'Gaze naturale';
    case 'DISTRIBUTION_TAX':
      return 'Tarif distribuție';
    case 'BASE_SUBSCRIPTION':
      return 'Abonament de bază';
    default:
      return lineType;
  }
}

export interface PricingRuleInput {
  invoice: ValidatedInvoice;
  effectiveReadingType: ReadingType;
  previousInvoice: StoredInvoice | null;
  recentRealInvoices: StoredInvoice[];
  recentEstimatedInvoices: StoredInvoice[];
  providerConfig: ProviderConfig | null;
}

export function evaluatePricingRule(input: PricingRuleInput): AuditFlag[] {
  const {
    invoice,
    effectiveReadingType,
    previousInvoice,
    recentRealInvoices,
    recentEstimatedInvoices,
    providerConfig,
  } = input;

  const flags: AuditFlag[] = [];

  // ---------------------------------------------------------------------------
  // Check 1: Net Unit Price Comparison + Contractual Rate Breach
  // ---------------------------------------------------------------------------
  const currentPrices = groupUnitPrices(invoice.lineItems);
  const previousPrices = previousInvoice
    ? groupUnitPrices(previousInvoice.lineItems)
    : new Map<string, GroupedPrice>();

  const defaultThreshold = invoice.category === 'TELECOM' ? new Decimal('0.50') : new Decimal('2.00');
  const thresholdPct = providerConfig
    ? new Decimal(providerConfig.unitPriceAlertThresholdPct)
    : defaultThreshold;

  const contractualPrice = providerConfig?.contractualUnitPriceNet
    ? new Decimal(providerConfig.contractualUnitPriceNet)
    : null;
  const primaryTypes = PRIMARY_CONTRACTUAL_LINE_TYPES[invoice.category];

  for (const [key, curr] of currentPrices.entries()) {
    const prev = previousPrices.get(key);
    const deltaPct = prev
      ? curr.weightedUnitPriceNet.minus(prev.weightedUnitPriceNet).div(prev.weightedUnitPriceNet).mul(100)
      : null;

    const exceedsContractual =
      contractualPrice !== null &&
      contractualPrice.gt(0) &&
      primaryTypes.has(curr.lineType) &&
      curr.weightedUnitPriceNet.gt(contractualPrice.mul('1.005'));

    if (exceedsContractual && contractualPrice !== null) {
      const breachPct = curr.weightedUnitPriceNet
        .minus(contractualPrice)
        .div(contractualPrice)
        .mul(100);
      const prevDetail =
        prev && deltaPct !== null
          ? ` (și +${deltaPct.toDecimalPlaces(2).toFixed(2)}% față de factura anterioară: ${prev.weightedUnitPriceNet.toDecimalPlaces(6).toFixed(6)} ${invoice.currency}/${curr.normalizedUnit})`
          : '';
      flags.push({
        code: 'CONTRACTUAL_RATE_BREACH',
        severity: 'CRITICAL',
        pillar: 'PRICING',
        message: `Depășire tarif contractual la ${lineTypeLabelRo(curr.lineType)}: facturat ${curr.weightedUnitPriceNet.toDecimalPlaces(6).toFixed(6)} ${invoice.currency}/${curr.normalizedUnit} față de tariful contractual ${contractualPrice.toDecimalPlaces(6).toFixed(6)} ${invoice.currency}/${curr.normalizedUnit} (+${breachPct.toDecimalPlaces(2).toFixed(2)}%)${prevDetail}.`,
        metadata: {
          lineType: curr.lineType,
          unit: curr.normalizedUnit,
          currentPriceNet: curr.weightedUnitPriceNet.toDecimalPlaces(6).toFixed(6),
          contractualPriceNet: contractualPrice.toDecimalPlaces(6).toFixed(6),
          breachPct: breachPct.toDecimalPlaces(2).toFixed(2),
          previousPriceNet: prev?.weightedUnitPriceNet.toDecimalPlaces(6).toFixed(6) ?? null,
          deltaPct: deltaPct?.toDecimalPlaces(2).toFixed(2) ?? null,
        },
      });
    } else if (prev && deltaPct !== null && deltaPct.gt(thresholdPct)) {
      flags.push({
        code: 'UNIT_PRICE_INCREASE',
        severity: 'WARNING',
        pillar: 'PRICING',
        message: `Creștere tarif unitar net la ${lineTypeLabelRo(curr.lineType)}: de la ${prev.weightedUnitPriceNet.toDecimalPlaces(6).toFixed(6)} la ${curr.weightedUnitPriceNet.toDecimalPlaces(6).toFixed(6)} ${invoice.currency}/${curr.normalizedUnit} (+${deltaPct.toDecimalPlaces(2).toFixed(2)}%, prag alertă ${thresholdPct.toFixed(2)}%).`,
        metadata: {
          lineType: curr.lineType,
          unit: curr.normalizedUnit,
          previousPriceNet: prev.weightedUnitPriceNet.toDecimalPlaces(6).toFixed(6),
          currentPriceNet: curr.weightedUnitPriceNet.toDecimalPlaces(6).toFixed(6),
          deltaPct: deltaPct.toDecimalPlaces(2).toFixed(2),
          thresholdPct: thresholdPct.toFixed(2),
          previousInvoiceNumber: previousInvoice?.invoiceNumber ?? null,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Check 2: Expired Promotion / Discount Detection
  // ---------------------------------------------------------------------------
  if (previousInvoice) {
    const prevDiscountCents = sumAbsoluteDiscountCents(previousInvoice.lineItems);
    const currDiscountCents = sumAbsoluteDiscountCents(invoice.lineItems);

    if (
      prevDiscountCents > 0n &&
      (currDiscountCents === 0n || currDiscountCents * 100n < prevDiscountCents * 80n)
    ) {
      const monthlyLossCents = prevDiscountCents - currDiscountCents;
      const annualImpactCents = monthlyLossCents * 12n;

      flags.push({
        code: 'PROMO_EXPIRED',
        severity: 'WARNING',
        pillar: 'PRICING',
        message: `Reducere / promoție expirată sau diminuată: discount anterior ${formatCentsRo(prevDiscountCents, invoice.currency)} → discount curent ${formatCentsRo(currDiscountCents, invoice.currency)} (cost suplimentar ${formatCentsRo(monthlyLossCents, invoice.currency)}/lună, respectiv ${formatCentsRo(annualImpactCents, invoice.currency)}/an).`,
        metadata: {
          previousDiscountCents: prevDiscountCents.toString(),
          currentDiscountCents: currDiscountCents.toString(),
          monthlyLossCents: monthlyLossCents.toString(),
          annualImpactCents: annualImpactCents.toString(),
          previousInvoiceNumber: previousInvoice.invoiceNumber,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Check 3: Late Payment Penalties & Hidden Fees
  // ---------------------------------------------------------------------------
  const penaltyLines = invoice.lineItems.filter((item) => {
    if (item.isStorno) {
      return false;
    }
    if (item.lineType === 'PENALTY') {
      return true;
    }
    const normalizedLabel = normalizeDiacritics(item.rawLabel).toLowerCase();
    return PENALTY_KEYWORDS.some((kw) => normalizedLabel.includes(kw));
  });

  if (penaltyLines.length > 0) {
    const totalPenaltyCents = penaltyLines.reduce(
      (acc, item) => acc + (item.lineTotalGrossCents < 0n ? -item.lineTotalGrossCents : item.lineTotalGrossCents),
      0n,
    );
    const isErroneousPenalty = previousInvoice?.paymentStatus === 'PAID_ON_TIME';
    const labels = penaltyLines.map((l) => l.rawLabel).join('; ');

    flags.push({
      code: 'LATE_FEE_DETECTED',
      severity: isErroneousPenalty ? 'CRITICAL' : 'WARNING',
      pillar: 'PRICING',
      message: isErroneousPenalty
        ? `Penalitate de întârziere ERONATĂ (${formatCentsRo(totalPenaltyCents, invoice.currency)} — "${labels}"): factura anterioară nr. ${previousInvoice?.invoiceNumber} a fost marcată ca PLĂTITĂ LA TIMP.`
        : `Penalitate / taxă suplimentară detectată pe factură: ${formatCentsRo(totalPenaltyCents, invoice.currency)} ("${labels}").`,
      metadata: {
        totalPenaltyCents: totalPenaltyCents.toString(),
        isErroneousPenalty,
        previousPaymentStatus: previousInvoice?.paymentStatus ?? null,
        labels: penaltyLines.map((l) => l.rawLabel),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Check 4: Daily Normalized Consumption Spike
  // ---------------------------------------------------------------------------
  const baselineCandidates =
    recentRealInvoices.filter(
      (inv) => inv.consumptionValue !== null && new Decimal(inv.consumptionValue).gt(0),
    );
  if (
    baselineCandidates.length === 0 &&
    previousInvoice &&
    previousInvoice.consumptionValue !== null &&
    new Decimal(previousInvoice.consumptionValue).gt(0)
  ) {
    baselineCandidates.push(previousInvoice);
  }

  let baselineDailyAvg: Decimal | null = null;
  if (baselineCandidates.length > 0) {
    const sumDaily = baselineCandidates.reduce((acc, inv) => {
      return acc.plus(new Decimal(inv.consumptionValue!).div(inv.billingDays));
    }, new Decimal(0));
    baselineDailyAvg = sumDaily.div(baselineCandidates.length);
  }

  let currentDailyAvg: Decimal | null = null;
  let spikePct: Decimal | null = null;

  if (
    invoice.consumptionValue !== null &&
    new Decimal(invoice.consumptionValue).gt(0) &&
    invoice.totalAmountCents > 0n &&
    baselineDailyAvg !== null &&
    baselineDailyAvg.gt(0)
  ) {
    currentDailyAvg = new Decimal(invoice.consumptionValue).div(invoice.billingDays);
    spikePct = currentDailyAvg.minus(baselineDailyAvg).div(baselineDailyAvg).mul(100);
    const unitLabel = invoice.consumptionUnit ?? 'unități';

    if (spikePct.gte(80)) {
      flags.push({
        code: 'CONSUMPTION_SPIKE',
        severity: 'CRITICAL',
        pillar: 'PRICING',
        message: `Creștere anormală a consumului zilnic (+${spikePct.toDecimalPlaces(1).toFixed(1)}%): ${currentDailyAvg.toDecimalPlaces(2).toFixed(2)} ${unitLabel}/zi (${invoice.consumptionValue} ${unitLabel} în ${invoice.billingDays} zile) față de media istorică ${baselineDailyAvg.toDecimalPlaces(2).toFixed(2)} ${unitLabel}/zi.`,
        metadata: {
          currentDailyAvg: currentDailyAvg.toDecimalPlaces(4).toFixed(4),
          baselineDailyAvg: baselineDailyAvg.toDecimalPlaces(4).toFixed(4),
          spikePct: spikePct.toDecimalPlaces(2).toFixed(2),
          billingDays: invoice.billingDays,
          unit: unitLabel,
        },
      });
    } else if (spikePct.gte(35)) {
      flags.push({
        code: 'CONSUMPTION_SPIKE',
        severity: 'WARNING',
        pillar: 'PRICING',
        message: `Consum zilnic ridicat (+${spikePct.toDecimalPlaces(1).toFixed(1)}%): ${currentDailyAvg.toDecimalPlaces(2).toFixed(2)} ${unitLabel}/zi față de media istorică ${baselineDailyAvg.toDecimalPlaces(2).toFixed(2)} ${unitLabel}/zi.`,
        metadata: {
          currentDailyAvg: currentDailyAvg.toDecimalPlaces(4).toFixed(4),
          baselineDailyAvg: baselineDailyAvg.toDecimalPlaces(4).toFixed(4),
          spikePct: spikePct.toDecimalPlaces(2).toFixed(2),
          billingDays: invoice.billingDays,
          unit: unitLabel,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Check 5: Broken Regularization Check
  // ---------------------------------------------------------------------------
  const stornoLines = invoice.lineItems.filter((item) => item.isStorno);
  const isRegularizationContext =
    effectiveReadingType === 'REGULARIZATION' || stornoLines.length > 0;

  if (isRegularizationContext) {
    const primaryStornoLines = stornoLines.filter(
      (item) =>
        item.lineType === 'ACTIVE_ENERGY' ||
        item.lineType === 'GAS_ENERGY' ||
        item.lineType === 'REGULARIZATION',
    );
    const effectiveStornoLines = primaryStornoLines.length > 0 ? primaryStornoLines : stornoLines;

    const stornedQty = effectiveStornoLines.reduce(
      (acc, item) => acc.plus(new Decimal(item.quantity).abs()),
      new Decimal(0),
    );

    const priorEstimatedQty = recentEstimatedInvoices.reduce((acc, inv) => {
      if (inv.consumptionValue !== null && new Decimal(inv.consumptionValue).gt(0)) {
        return acc.plus(new Decimal(inv.consumptionValue));
      }
      return acc;
    }, new Decimal(0));

    const missingStornoCredit =
      priorEstimatedQty.gt(0) && stornedQty.lt(priorEstimatedQty.mul('0.90'));
    const netSpikeAnomaly = spikePct !== null && spikePct.gte(80);

    if (missingStornoCredit || netSpikeAnomaly) {
      const unitLabel = invoice.consumptionUnit ?? 'unități';
      const reasons: string[] = [];
      if (missingStornoCredit) {
        reasons.push(
          `cantitate stornată insuficientă (${stornedQty.toDecimalPlaces(2).toFixed(2)} ${unitLabel} stornat față de ${priorEstimatedQty.toDecimalPlaces(2).toFixed(2)} ${unitLabel} facturat anterior pe estimări)`,
        );
      }
      if (netSpikeAnomaly && spikePct !== null) {
        reasons.push(
          `regularizarea produce un consum net cu +${spikePct.toDecimalPlaces(1).toFixed(1)}% peste media istorică`,
        );
      }

      flags.push({
        code: 'REGULARIZATION_ANOMALY',
        severity: 'CRITICAL',
        pillar: 'PRICING',
        message: `Anomalie de regularizare: ${reasons.join('; ')}.`,
        metadata: {
          stornedQty: stornedQty.toDecimalPlaces(3).toFixed(3),
          priorEstimatedQty: priorEstimatedQty.toDecimalPlaces(3).toFixed(3),
          missingStornoCredit,
          netSpikeAnomaly,
          spikePct: spikePct?.toDecimalPlaces(2).toFixed(2) ?? null,
          unit: unitLabel,
        },
      });
    }
  }

  return flags;
}
