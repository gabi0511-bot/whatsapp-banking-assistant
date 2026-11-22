import { Decimal } from 'decimal.js';
import { XMLParser } from 'fast-xml-parser';
import { ROMANIAN_PROVIDERS_SEED } from '../config/providers.seed.js';
import {
  CanonicalInvoiceSchema,
  normalizeCui,
  normalizeDiacritics,
  normalizeUnit,
  type CanonicalInvoice,
  type CanonicalLineItem,
  type InvoiceCategory,
  type LineType,
  type ReadingType,
} from '../extraction/schema.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (tagName) =>
    tagName === 'InvoiceLine' ||
    tagName === 'AllowanceCharge' ||
    tagName === 'Note' ||
    tagName === 'PartyTaxScheme' ||
    tagName === 'ContractDocumentReference' ||
    tagName === 'AdditionalItemProperty',
});

function asArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) {
    return [];
  }
  return Array.isArray(val) ? val : [val];
}

function textValue(node: unknown): string | null {
  if (node === null || node === undefined) {
    return null;
  }
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    const s = String(node).trim();
    return s.length > 0 ? s : null;
  }
  if (typeof node === 'object' && '#text' in node) {
    const inner = (node as Record<string, unknown>)['#text'];
    return textValue(inner);
  }
  return null;
}

function numericValue(node: unknown): Decimal | null {
  const txt = textValue(node);
  if (!txt) {
    return null;
  }
  try {
    return new Decimal(txt.replace(',', '.'));
  } catch {
    return null;
  }
}

export function isUblInvoiceXml(xmlContent: string): boolean {
  const trimmed = xmlContent.trim();
  if (!trimmed.startsWith('<')) {
    return false;
  }
  return /<(?:\w+:)?Invoice(?:\s|>)/i.test(trimmed);
}

export function classifyRomanianLineType(
  rawLabel: string,
  category: InvoiceCategory,
  isNegativeAllowance = false,
): LineType {
  if (isNegativeAllowance) {
    return 'DISCOUNT';
  }
  const norm = normalizeDiacritics(rawLabel).toLowerCase();

  if (
    norm.includes('penalit') ||
    norm.includes('doband') ||
    norm.includes('intarziere') ||
    norm.includes('majorar') ||
    norm.includes('reconectare')
  ) {
    return 'PENALTY';
  }

  if (
    norm.includes('reducere') ||
    norm.includes('discount') ||
    norm.includes('promot') ||
    norm.includes('bonus') ||
    norm.includes('voucher') ||
    norm.includes('rabat')
  ) {
    return 'DISCOUNT';
  }

  if (norm.includes('regulariz') || norm.includes('storno')) {
    return 'REGULARIZATION';
  }

  if (
    norm.includes('distribut') ||
    norm.includes('transport') ||
    norm.includes('serviciu sistem') ||
    norm.includes('cogenerare') ||
    norm.includes('certificate verzi') ||
    norm.includes('acciz') ||
    norm.includes('retea')
  ) {
    return 'DISTRIBUTION_TAX';
  }

  if (
    norm.includes('gaze naturale') ||
    norm.includes('gaz natural') ||
    norm.includes('consum gaze') ||
    (category === 'GAS' && (norm.includes('energie') || norm.includes('furnizare')))
  ) {
    return 'GAS_ENERGY';
  }

  if (
    norm.includes('energie activa') ||
    norm.includes('energie electrica') ||
    (category === 'ELECTRICITY' && norm.includes('furnizare'))
  ) {
    return 'ACTIVE_ENERGY';
  }

  if (
    norm.includes('abonament') ||
    norm.includes('pachet') ||
    norm.includes('internet') ||
    norm.includes('fibra') ||
    norm.includes('telefonie') ||
    norm.includes('tv ') ||
    norm.includes('televiziune')
  ) {
    return 'BASE_SUBSCRIPTION';
  }

  if (category === 'ELECTRICITY') {
    return 'ACTIVE_ENERGY';
  }
  if (category === 'GAS') {
    return 'GAS_ENERGY';
  }
  return 'OTHER';
}

function inferCategory(providerCui: string, providerName: string, lineLabels: string[]): InvoiceCategory {
  const seed = ROMANIAN_PROVIDERS_SEED.find((p) => p.providerCui === providerCui);
  if (seed) {
    return seed.category;
  }

  const combined = normalizeDiacritics(`${providerName} ${lineLabels.join(' ')}`).toLowerCase();
  if (combined.includes('gaze') || combined.includes('gaz natural') || combined.includes('engie')) {
    return 'GAS';
  }
  if (
    combined.includes('energie electrica') ||
    combined.includes('energie activa') ||
    combined.includes('electrica') ||
    combined.includes('hidroelectrica') ||
    combined.includes('ppc')
  ) {
    return 'ELECTRICITY';
  }
  if (
    combined.includes('telecom') ||
    combined.includes('digi') ||
    combined.includes('orange') ||
    combined.includes('vodafone') ||
    combined.includes('abonament') ||
    combined.includes('fibra') ||
    combined.includes('internet')
  ) {
    return 'TELECOM';
  }
  if (combined.includes('apa nova') || combined.includes('canalizare') || combined.includes('apa potabila')) {
    return 'WATER';
  }
  return 'OTHER';
}

function extractNotePattern(notes: string[], pattern: RegExp): string | null {
  for (const note of notes) {
    const match = note.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function splitSeriesAndNumber(rawId: string): { series: string | null; number: string } {
  const trimmed = rawId.trim();
  const match = trimmed.match(/^([A-Za-z]{1,10})[\s\-/]+(\d+[A-Za-z0-9\-]*)$/);
  if (match?.[1] && match[2]) {
    return { series: match[1], number: match[2] };
  }
  return { series: null, number: trimmed };
}

export function parseUblInvoiceXml(xmlContent: string): CanonicalInvoice {
  if (!isUblInvoiceXml(xmlContent)) {
    throw new Error('XML document is not a valid UBL 2.1 <Invoice>');
  }

  const parsed = xmlParser.parse(xmlContent) as Record<string, unknown>;
  const inv = parsed.Invoice as Record<string, unknown> | undefined;
  if (!inv || typeof inv !== 'object') {
    throw new Error('Missing root <Invoice> element in UBL XML');
  }

  const supplierParty = (inv.AccountingSupplierParty as Record<string, unknown> | undefined)?.Party as
    | Record<string, unknown>
    | undefined;

  const partyLegalEntity = supplierParty?.PartyLegalEntity as Record<string, unknown> | undefined;
  const partyNameObj = supplierParty?.PartyName as Record<string, unknown> | undefined;
  const taxSchemes = asArray(
    supplierParty?.PartyTaxScheme as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );

  const providerName =
    textValue(partyLegalEntity?.RegistrationName) ??
    textValue(partyNameObj?.Name) ??
    'Furnizor Necunoscut';

  const rawCui =
    textValue(taxSchemes[0]?.CompanyID) ??
    textValue(partyLegalEntity?.CompanyID) ??
    'RO00000000';
  const providerCui = normalizeCui(rawCui);

  const rawInvoiceId = textValue(inv.ID) ?? 'UNKNOWN';
  const { series: invoiceSeries, number: invoiceNumber } = splitSeriesAndNumber(rawInvoiceId);

  const issueDate = textValue(inv.IssueDate);
  if (!issueDate) {
    throw new Error('UBL XML missing required <IssueDate>');
  }
  const dueDate = textValue(inv.DueDate) ?? issueDate;
  const currency = (textValue(inv.DocumentCurrencyCode) ?? 'RON').toUpperCase();

  const invoicePeriod = inv.InvoicePeriod as Record<string, unknown> | undefined;
  const billingPeriodStart = textValue(invoicePeriod?.StartDate);
  const billingPeriodEnd = textValue(invoicePeriod?.EndDate);

  const notes = asArray(inv.Note as unknown[])
    .map((n) => textValue(n))
    .filter((n): n is string => n !== null);

  const contractRefs = asArray(
    inv.ContractDocumentReference as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const buyerReference = textValue(inv.BuyerReference);
  const contractId = textValue(contractRefs[0]?.ID);

  const podFromNotes = extractNotePattern(notes, /\b(?:POD|CLC|NLC)\s*[:#-]?\s*([A-Z0-9_-]{4,})\b/i);
  const clientCodeFromNotes = extractNotePattern(
    notes,
    /\bcod\s*client\s*[:#-]?\s*([A-Z0-9_-]{3,})\b/i,
  );

  const clientCode = clientCodeFromNotes ?? buyerReference ?? contractId ?? null;
  const consumptionPointId =
    podFromNotes ?? contractId ?? buyerReference ?? `${providerCui}-DEFAULT`;

  const rawLines = asArray(
    inv.InvoiceLine as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const rawAllowances = asArray(
    inv.AllowanceCharge as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );

  const initialLabels = rawLines.map((l) => {
    const itemObj = l.Item as Record<string, unknown> | undefined;
    return textValue(itemObj?.Name) ?? textValue(itemObj?.Description) ?? '';
  });

  const category = inferCategory(providerCui, providerName, initialLabels);

  const lineItems: CanonicalLineItem[] = [];

  for (const line of rawLines) {
    const itemObj = line.Item as Record<string, unknown> | undefined;
    const priceObj = line.Price as Record<string, unknown> | undefined;
    const taxObj = itemObj?.ClassifiedTaxCategory as Record<string, unknown> | undefined;

    const rawLabel =
      textValue(itemObj?.Name) ?? textValue(itemObj?.Description) ?? 'Poziție factură';

    const qtyNode = line.InvoicedQuantity as Record<string, unknown> | string | undefined;
    const qty = numericValue(qtyNode) ?? new Decimal(1);
    const rawUnitCode =
      typeof qtyNode === 'object' && qtyNode !== null
        ? textValue((qtyNode as Record<string, unknown>)['@_unitCode'])
        : null;

    const lineNetAmount = numericValue(line.LineExtensionAmount);
    const priceAmount =
      numericValue(priceObj?.PriceAmount) ??
      (lineNetAmount && !qty.isZero() ? lineNetAmount.div(qty).abs() : new Decimal(0));

    const vatPct = numericValue(taxObj?.Percent) ?? new Decimal(19);
    const vatMultiplier = new Decimal(1).plus(vatPct.div(100));

    const netBase = lineNetAmount ?? priceAmount.mul(qty);
    const grossTotal = netBase.mul(vatMultiplier).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const lineType = classifyRomanianLineType(rawLabel, category, false);

    lineItems.push({
      line_type: lineType,
      raw_label: rawLabel,
      quantity: qty.toNumber(),
      unit: rawUnitCode ? normalizeUnit(rawUnitCode, lineType) : null,
      unit_price_net: priceAmount.toNumber(),
      vat_rate_pct: vatPct.toNumber(),
      line_total_gross: grossTotal.toNumber(),
    });
  }

  for (const ac of rawAllowances) {
    const chargeIndicatorRaw = (textValue(ac.ChargeIndicator) ?? 'false').toLowerCase();
    const isCharge = chargeIndicatorRaw === 'true';
    const reason =
      textValue(ac.AllowanceChargeReason) ??
      (isCharge ? 'Taxă / Penalitate suplimentară' : 'Reducere comercială');
    const amount = numericValue(ac.Amount) ?? new Decimal(0);
    const taxCat = ac.TaxCategory as Record<string, unknown> | undefined;
    const vatPct = numericValue(taxCat?.Percent) ?? new Decimal(19);
    const vatMultiplier = new Decimal(1).plus(vatPct.div(100));

    const signedNet = isCharge ? amount.abs() : amount.abs().neg();
    const signedGross = signedNet.mul(vatMultiplier).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const lineType: LineType = isCharge
      ? classifyRomanianLineType(reason, category, false) === 'PENALTY'
        ? 'PENALTY'
        : 'OTHER'
      : 'DISCOUNT';

    lineItems.push({
      line_type: lineType,
      raw_label: reason,
      quantity: 1,
      unit: 'unit',
      unit_price_net: signedNet.toNumber(),
      vat_rate_pct: vatPct.toNumber(),
      line_total_gross: signedGross.toNumber(),
    });
  }

  const legalTotal = inv.LegalMonetaryTotal as Record<string, unknown> | undefined;
  const payableAmount =
    numericValue(legalTotal?.PayableAmount) ??
    numericValue(legalTotal?.TaxInclusiveAmount) ??
    lineItems.reduce((acc, item) => acc.plus(item.line_total_gross), new Decimal(0));

  // Derive meter reading info from notes & energy lines when available.
  const combinedNotes = normalizeDiacritics(notes.join(' ')).toLowerCase();
  let readingType: ReadingType = category === 'TELECOM' ? 'N_A' : 'SELF_READ';
  if (combinedNotes.includes('estimat') || combinedNotes.includes('conventie de consum')) {
    readingType = 'ESTIMATED';
  } else if (combinedNotes.includes('regulariz')) {
    readingType = 'REGULARIZATION';
  } else if (combinedNotes.includes('citire operator') || combinedNotes.includes('operator distribu')) {
    readingType = 'OPERATOR_READ';
  } else if (combinedNotes.includes('autocitir') || combinedNotes.includes('index transmis')) {
    readingType = 'SELF_READ';
  }

  const oldIndexStr = extractNotePattern(notes, /index\s*(?:vechi|anterior)\s*[:=-]?\s*(\d+(?:[.,]\d+)?)/i);
  const newIndexStr = extractNotePattern(notes, /index\s*(?:nou|curent)\s*[:=-]?\s*(\d+(?:[.,]\d+)?)/i);

  const energyLines = lineItems.filter(
    (l) => l.line_type === 'ACTIVE_ENERGY' || l.line_type === 'GAS_ENERGY',
  );
  const consumptionValue =
    energyLines.length > 0
      ? energyLines.reduce((acc, l) => acc.plus(l.quantity), new Decimal(0)).toNumber()
      : null;
  const consumptionUnit = energyLines[0]?.unit ?? null;

  const windowMatch = notes
    .join(' ')
    .match(/autocitir\w*[^\d]{0,30}(\d{1,2})\s*[-–]\s*(\d{1,2})/i);
  const selfReadingWindowStart = windowMatch?.[1] ? Number.parseInt(windowMatch[1], 10) : null;
  const selfReadingWindowEnd = windowMatch?.[2] ? Number.parseInt(windowMatch[2], 10) : null;

  const candidate: CanonicalInvoice = {
    provider_name: providerName,
    provider_cui: providerCui,
    category,
    client_code: clientCode,
    consumption_point_id: consumptionPointId,
    invoice_series: invoiceSeries,
    invoice_number: invoiceNumber,
    issue_date: issueDate,
    due_date: dueDate,
    billing_period_start: billingPeriodStart,
    billing_period_end: billingPeriodEnd,
    total_amount: payableAmount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
    currency,
    meter_reading: {
      reading_type: readingType,
      old_index: oldIndexStr ? Number.parseFloat(oldIndexStr.replace(',', '.')) : null,
      new_index: newIndexStr ? Number.parseFloat(newIndexStr.replace(',', '.')) : null,
      consumption_value: consumptionValue,
      consumption_unit: consumptionUnit,
      self_reading_window_start: selfReadingWindowStart,
      self_reading_window_end: selfReadingWindowEnd,
    },
    line_items: lineItems,
  };

  return CanonicalInvoiceSchema.parse(candidate);
}
