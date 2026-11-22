import { formatCentsRo, formatIsoDateRo } from '../../extraction/schema.js';
import type {
  AuditFlag,
  DisputeDraftContent,
  ProviderConfig,
  StoredInvoice,
  ValidatedInvoice,
} from '../types.js';

export type DisputeInvoiceSource = Pick<
  ValidatedInvoice | StoredInvoice,
  | 'providerName'
  | 'providerCui'
  | 'clientCode'
  | 'consumptionPointId'
  | 'invoiceSeries'
  | 'invoiceNumber'
  | 'issueDate'
  | 'dueDate'
  | 'totalAmountCents'
  | 'currency'
>;

export interface BuildDisputeDraftInput {
  invoice: DisputeInvoiceSource;
  flags: AuditFlag[];
  providerConfig: ProviderConfig | null;
  userFullName: string;
  includeWarnings?: boolean;
}

export function buildDisputeDraft(input: BuildDisputeDraftInput): DisputeDraftContent | null {
  const { invoice, flags, providerConfig, userFullName, includeWarnings = false } = input;

  const criticalFlags = flags.filter((f) => f.severity === 'CRITICAL');
  const warningFlags = flags.filter((f) => f.severity === 'WARNING');

  const relevantFlags = includeWarnings
    ? [...criticalFlags, ...warningFlags]
    : criticalFlags.length > 0
      ? [...criticalFlags, ...warningFlags]
      : [];

  if (relevantFlags.length === 0) {
    return null;
  }

  const recipientEmail = providerConfig?.disputeEmail ?? 'relatii.clienti@furnizor.ro';
  const seriesPrefix = invoice.invoiceSeries ? `seria ${invoice.invoiceSeries} ` : '';
  const clientCodeDisplay = invoice.clientCode ?? 'N/A';

  const subject = `Sesizare / Contestație factură ${seriesPrefix}nr. ${invoice.invoiceNumber} – Cod client ${clientCodeDisplay}`;

  const issueDateRo = formatIsoDateRo(invoice.issueDate);
  const dueDateRo = formatIsoDateRo(invoice.dueDate);
  const formattedTotal = formatCentsRo(invoice.totalAmountCents, invoice.currency);

  const bulletLines = relevantFlags.map((flag) => formatDisputeBullet(flag));

  const body = [
    'Bună ziua,',
    '',
    `Subsemnatul/a ${userFullName}, titular al contractului aferent Codului de client ${clientCodeDisplay} și locului de consum / identificatorului POD/CLC ${invoice.consumptionPointId}, vă transmit prezenta sesizare cu privire la factura ${seriesPrefix}nr. ${invoice.invoiceNumber}, emisă la data de ${issueDateRo}, cu scadența la ${dueDateRo}, în valoare totală de ${formattedTotal}.`,
    '',
    'Motivul sesizării:',
    ...bulletLines.map((line) => `- ${line}`),
    '',
    'Vă solicit verificarea urgentă a aspectelor semnalate mai sus, recalcularea facturii și, după caz, emiterea unei facturi de stornare / corectare, precum și comunicarea în scris a unui număr de înregistrare al sesizării și a modului de soluționare.',
    '',
    'Până la clarificarea și remedierea acestor neconcordanțe, vă rog să suspendați orice măsuri de penalizare sau deconectare aferente facturii contestate.',
    '',
    'Cu stimă,',
    userFullName,
  ].join('\n');

  return {
    recipientEmail,
    subject,
    body,
    anomalySummary: relevantFlags,
  };
}

function formatDisputeBullet(flag: AuditFlag): string {
  const meta = flag.metadata ?? {};
  switch (flag.code) {
    case 'INDEX_OVERLAP_ANOMALY':
      return `Suprapunere de index (dublă facturare): indexul vechi facturat (${String(meta.currentOldIndex ?? '')}) este inferior indexului nou de pe factura anterioară nr. ${String(meta.previousInvoiceNumber ?? '')} (${String(meta.previousNewIndex ?? '')}), rezultând ${String(meta.overlap ?? '')} ${String(meta.unit ?? 'unități')} facturați de două ori.`;
    case 'CONTRACTUAL_RATE_BREACH':
      return `Tarif unitar net peste valoarea contractuală: s-a facturat ${String(meta.currentPriceNet ?? '')} RON/${String(meta.unit ?? '')} față de tariful contractual de ${String(meta.contractualPriceNet ?? '')} RON/${String(meta.unit ?? '')} (+${String(meta.breachPct ?? '')}%).`;
    case 'UNIT_PRICE_INCREASE':
      return `Majorare neanunțată a tarifului unitar net: tariful a crescut de la ${String(meta.previousPriceNet ?? '')} la ${String(meta.currentPriceNet ?? '')} RON/${String(meta.unit ?? '')} (+${String(meta.deltaPct ?? '')}% față de factura anterioară nr. ${String(meta.previousInvoiceNumber ?? 'anterioară')}).`;
    case 'CONSUMPTION_SPIKE':
      return `Anomalie majoră de consum: media zilnică facturată este de ${String(meta.currentDailyAvg ?? '')} ${String(meta.unit ?? '')}/zi (+${String(meta.spikePct ?? '')}% față de media istorică de ${String(meta.baselineDailyAvg ?? '')} ${String(meta.unit ?? '')}/zi).`;
    case 'REGULARIZATION_ANOMALY':
      return flag.message;
    case 'LATE_FEE_DETECTED':
      return flag.message;
    case 'PROMO_EXPIRED':
      return flag.message;
    case 'ESTIMATED_READING':
      return flag.message;
    default:
      return flag.message;
  }
}

/**
 * Builds a strict RFC 2822 UTF-8 email with RFC 2047 UTF-8 Base64 Subject encoding,
 * returned as Gmail API URL-safe Base64 string.
 */
export function buildRfc2822RawEmail(params: {
  to: string;
  subject: string;
  body: string;
}): string {
  const encodedSubject = `=?utf-8?B?${Buffer.from(params.subject, 'utf8').toString('base64')}?=`;
  const normalizedBody = params.body.replace(/\r?\n/g, '\r\n');

  const mimeMessage = [
    `To: ${params.to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizedBody,
  ].join('\r\n');

  return Buffer.from(mimeMessage, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
