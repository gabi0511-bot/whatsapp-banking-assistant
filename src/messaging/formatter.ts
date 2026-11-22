import { formatBucharestDateRo } from '../audit/rules/reading.rule.js';
import type { AuditFlag, StoredInvoice, StoredReminder } from '../audit/types.js';
import { formatCentsRo, formatIsoDateRo } from '../extraction/schema.js';
import { periodLabelRo } from '../subscriptions/ai-alert.composer.js';
import type { RadarReport } from '../subscriptions/types.js';

function severityIcon(flag: AuditFlag): string {
  switch (flag.severity) {
    case 'CRITICAL':
      return '🚨';
    case 'WARNING':
      return '⚠️';
    case 'INFO':
      return 'ℹ️';
  }
}

export function resolveStatusBadge(invoice: StoredInvoice): string {
  if (invoice.totalAmountCents <= 0n) {
    return 'ℹ️ SOLD CREDITOR / FĂRĂ PLATĂ';
  }
  const hasCritical = invoice.auditFlags.some((f) => f.severity === 'CRITICAL');
  if (hasCritical) {
    return '🚨 VERIFICĂ ÎNAINTE DE PLATĂ (Anomalie critică)';
  }
  const hasWarning = invoice.auditFlags.some((f) => f.severity === 'WARNING');
  if (hasWarning) {
    return '⚠️ ATENȚIE ÎNAINTE DE PLATĂ';
  }
  return '✅ OK DE PLATĂ';
}

export function formatInvoiceXRayAlert(invoice: StoredInvoice): string {
  const seriesPart = invoice.invoiceSeries ? `${invoice.invoiceSeries} ` : '';
  const formattedTotal = formatCentsRo(invoice.totalAmountCents);
  const dueDateRo = formatIsoDateRo(invoice.dueDate);
  const statusBadge = resolveStatusBadge(invoice);

  const auditLines =
    invoice.auditFlags.length > 0
      ? invoice.auditFlags.map((flag) => `• ${severityIcon(flag)} ${flag.message}`)
      : ['• ✅ Nicio anomalie detectată față de istoricul tău.'];

  return [
    `🔎 *Invoice X-Ray — ${invoice.providerName}*`,
    `Factură: ${seriesPart}${invoice.invoiceNumber} (ID #${invoice.id})`,
    `Sumă: *${formattedTotal} ${invoice.currency}*`,
    `Scadență: *${dueDateRo}*`,
    `Status: *${statusBadge}*`,
    '',
    '📋 *Rezultate audit:*',
    ...auditLines,
    '',
    '⚡ *Acțiuni:*',
    'Răspunde cu *1* — [Draft contestație] (salvează emailul în Gmail Drafts)',
    'Răspunde cu *platita* — Marchează factura ca plătită la timp',
  ].join('\n');
}

export function formatSelfReadingReminder(reminder: StoredReminder): string {
  const p = reminder.payload;
  return [
    `⏰ *Reminder autocitire — ${p.provider_name}*`,
    `Fereastra de transmitere: *${p.window_start}–${p.window_end} ale lunii*`,
    `Cod client: \`${p.client_code ?? 'N/A'}\``,
    `POD/CLC: \`${p.consumption_point_id}\``,
    `Ultimul index facturat: *${p.last_index ?? 'N/A'}*`,
  ].join('\n');
}

export function formatStatusReport(
  unpaidInvoices: StoredInvoice[],
  pendingReminders: StoredReminder[],
): string {
  const lines: string[] = ['📊 *Status Invoice X-Ray*', ''];

  if (unpaidInvoices.length === 0) {
    lines.push('✅ Nu ai facturi neplătite sau blocate pentru verificare.');
  } else {
    lines.push('*Facturi neplătite / în verificare:*');
    for (const inv of unpaidInvoices) {
      const flag = inv.paymentStatus === 'HOLD_BEFORE_PAYMENT' ? '🚨 HOLD' : '🕒 NEPLĂTITĂ';
      lines.push(
        `• #${inv.id} *${inv.providerName}* (${inv.invoiceNumber}) — ${formatCentsRo(inv.totalAmountCents, inv.currency)} | Scadență: ${formatIsoDateRo(inv.dueDate)} | ${flag}`,
      );
    }
  }

  lines.push('');

  if (pendingReminders.length === 0) {
    lines.push('⏰ Niciun reminder de autocitire programat.');
  } else {
    lines.push('*Remindere autocitire programate:*');
    for (const rem of pendingReminders) {
      lines.push(
        `• *${rem.payload.provider_name}* (${rem.payload.consumption_point_id}) — programat pentru *${formatBucharestDateRo(rem.triggerAt)}* (fereastră ${rem.payload.window_start}–${rem.payload.window_end})`,
      );
    }
  }

  return lines.join('\n');
}

export function formatHelpMessage(): string {
  return [
    '🤖 *Invoice X-Ray & AI Twin Financiar — Cum poți vorbi cu mine:*',
    'Nu ai nevoie de comenzi fixe — scrie-mi natural exact cum îți vine, de exemplu:',
    '• *"La ce mai am de plată?"* / *"Plătește factura de la Engie"*',
    '• *"Am vreun trial activ?"* / *"Verifică Gmail-ul dacă am vreun free trial"*',
    '• *"Cât dau pe an pe abonamente?"* / *"Ce abonamente zombie am?"*',
    '• *"Am activat trial la Adobe, expiră pe 5 decembrie și apoi e 149 lei/lună"*',
    '• *"Am anulat trial-ul la Adobe"* / *"Folosesc Spotify, nu e zombie"*',
    '• *"Am 2400 lei în cont"* / *"Câți bani mai am după facturi și abonamente?"*',
    '',
    '⚡ *Scurtături rapide (opționale):* `1` (draft contestație), `platita`, `qr`, `status`, `/abonamente`, `/trials`.',
  ].join('\n');
}

export function formatSubscriptionRadarReport(report: RadarReport): string {
  const lines: string[] = [
    '📡 *Radar Abonamente „Zombie” & Free Trials*',
    '',
    `🏦 *Sold curent (Demo):* *${formatCentsRo(report.currentBalanceCents, report.balanceCurrency)}*`,
    '',
    `💸 *Total abonamente active (${report.activeSubscriptions.length}):*`,
    `• Cost lunar: *${formatCentsRo(report.totalMonthlyCents, report.balanceCurrency)}/lună*`,
    `• Cost anual cumulat (\`sumă × 12\`): *${formatCentsRo(report.totalAnnualCents, report.balanceCurrency)}/an*`,
  ];

  if (report.activeSubscriptions.length > 0) {
    lines.push('', '📋 *Lista abonamentelor (grupate pe categorii):*');
    for (const sub of report.activeSubscriptions) {
      const tags: string[] = [];
      if (sub.previousAmountCents !== null && sub.currentAmountCents > sub.previousAmountCents) {
        const diff = sub.currentAmountCents - sub.previousAmountCents;
        tags.push(`📈 +${formatCentsRo(diff, sub.currency)} față de luna trecută`);
      }
      if (sub.status === 'ZOMBIE_SUSPECTED') {
        tags.push('🧟 Posibil zombie');
      }
      const tagStr = tags.length > 0 ? ` [${tags.join(' | ')}]` : '';
      lines.push(
        `• [${sub.category}] #${sub.id} *${sub.merchantName}* — ${formatCentsRo(sub.currentAmountCents, sub.currency)}/${periodLabelRo(sub.billingPeriod)} (${formatCentsRo(sub.annualizedCostCents, sub.currency)}/an)${tagStr}`,
      );
    }
  } else {
    lines.push('', '📋 Nu există încă abonamente recurente înregistrate.');
  }

  if (report.zombieSubscriptions.length > 0) {
    lines.push(
      '',
      `🧟 *Posibile abonamente „zombie” (${report.zombieSubscriptions.length} — economie potențială ${formatCentsRo(report.potentialZombieAnnualSavingsCents, report.balanceCurrency)}/an):*`,
    );
    for (const z of report.zombieSubscriptions) {
      lines.push(
        `• #${z.id} *${z.merchantName}*: ${z.zombieReason ?? 'Neconfirmat'} — *${formatCentsRo(z.annualizedCostCents, z.currency)}/an*`,
      );
    }
    lines.push('  _(Scrie-mi natural „folosesc <nume>” sau „am anulat <nume>”)_');
  }

  if (report.activeFreeTrials.length > 0) {
    lines.push('', `⏳ *Free Trials active (${report.activeFreeTrials.length}):*`);
    for (const t of report.activeFreeTrials) {
      lines.push(
        `• #${t.id} *${t.serviceName}* — expiră pe *${formatBucharestDateRo(t.trialEndAt)}* → ${formatCentsRo(t.postTrialAmountCents, t.currency)}/${periodLabelRo(t.billingPeriod)} (alertă 48h: ${formatBucharestDateRo(t.alert48hScheduledAt)})`,
      );
    }
  }

  return lines.join('\n');
}

export function formatActiveTrialsReport(report: RadarReport): string {
  const lines: string[] = [
    '⏳ *Free Trials Active & Alerte 48h*',
    `🏦 *Sold curent (Demo):* *${formatCentsRo(report.currentBalanceCents, report.balanceCurrency)}*`,
    '',
  ];

  if (report.activeFreeTrials.length === 0) {
    lines.push('✅ Nu ai niciun free trial activ monitorizat în acest moment.');
    return lines.join('\n');
  }

  for (const t of report.activeFreeTrials) {
    const cancelPart = t.cancellationUrl ? ` | 🔗 ${t.cancellationUrl}` : '';
    lines.push(
      `• #${t.id} *${t.serviceName}* — expiră pe *${formatBucharestDateRo(t.trialEndAt)}* → *${formatCentsRo(t.postTrialAmountCents, t.currency)}/${periodLabelRo(t.billingPeriod)}* | Alertă 48h: *${formatBucharestDateRo(t.alert48hScheduledAt)}* (${t.status})${cancelPart}`,
    );
  }

  return lines.join('\n');
}
