import { GoogleGenAI } from '@google/genai';
import { Decimal } from 'decimal.js';
import { daysInMonth, getBucharestDateParts } from '../audit/rules/reading.rule.js';
import type { DemoBalanceService } from '../cashflow/demo-balance.service.js';
import {
  callGeminiWithModelFallback,
  DEFAULT_GEMINI_PRIMARY_MODEL,
} from '../config/gemini.models.js';
import type { InvoiceRepository } from '../db/repositories/invoice.repo.js';
import type {
  BetterMonthOutcome,
  MonthlyReviewRepository,
  StoredMonthlyReview,
} from '../db/repositories/monthly-review.repo.js';
import type { WhatsappPaymentRepository } from '../db/repositories/whatsapp-payment.repo.js';
import { formatCentsRo } from '../extraction/schema.js';
import type { MessagingAdapter } from '../messaging/adapter.interface.js';

export interface MonthBillSnapshot {
  name: string;
  amountCents: bigint;
  paymentStatus: string;
  dueDate: string | null;
  hasPenalty: boolean;
}

export interface MonthPaymentMetrics {
  yearMonth: string; // YYYY-MM
  totalBilledCents: bigint;
  totalPaidCents: bigint;
  billsCount: number;
  paidOnTimeCount: number;
  paidLateCount: number;
  unpaidOverdueCount: number;
  penaltiesCount: number;
  penaltiesTotalCents: bigint;
  onTimeRatePct: string | null;
  efficiencyScore: number | null;
  grade: string | null;
  items: MonthBillSnapshot[];
}

export interface MonthlyComparisonReport {
  ownerJid: string;
  currency: string;
  currentBalanceCents: bigint;
  currentMonth: MonthPaymentMetrics;
  previousMonth: MonthPaymentMetrics;
  spendingDeltaCents: bigint; // negative = spent less this month!
  savedVsPreviousMonthCents: bigint;
  annualizedSavingsPotentialCents: bigint;
  betterMonth: BetterMonthOutcome;
  recommendSavingsOrInvestment: boolean;
  availableMonthsWithData: string[];
}

export interface MonthlyReviewComposer {
  composeMonthlyReview(report: MonthlyComparisonReport): Promise<string>;
}

export interface MonthlyReviewServiceDeps {
  invoiceRepo: InvoiceRepository;
  whatsappPaymentRepo: WhatsappPaymentRepository;
  demoBalanceService: DemoBalanceService;
  monthlyReviewRepo: MonthlyReviewRepository;
  messaging: MessagingAdapter;
  composer?: MonthlyReviewComposer;
}

export function getPreviousYearMonth(yearMonth: string): string {
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number.parseInt(yStr ?? '2026', 10);
  const month = Number.parseInt(mStr ?? '1', 10);
  if (month === 1) {
    return `${year - 1}-12`;
  }
  return `${year}-${String(month - 1).padStart(2, '0')}`;
}

export function getBucharestYearMonth(date: Date = new Date()): string {
  const p = getBucharestDateParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function isLastDayOfMonthBucharest(date: Date = new Date()): boolean {
  const p = getBucharestDateParts(date);
  return p.day === daysInMonth(p.year, p.month);
}

function getMonthEndIso(yearMonth: string): string {
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number.parseInt(yStr ?? '2026', 10);
  const month = Number.parseInt(mStr ?? '1', 10);
  const lastDay = daysInMonth(year, month);
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export function scoreToGradeRo(score: number): string {
  if (score >= 95) return 'A+ (Exemplar)';
  if (score >= 85) return 'A (Foarte bun)';
  if (score >= 75) return 'B (Bun)';
  if (score >= 60) return 'C (Acceptabil)';
  return 'D (Necesită atenție)';
}

export function computeMonthEfficiencyScore(params: {
  billsCount: number;
  paidOnTimeCount: number;
  paidLateCount: number;
  unpaidOverdueCount: number;
  penaltiesCount: number;
}): { score: number | null; grade: string | null } {
  if (params.billsCount === 0) {
    return { score: null, grade: null };
  }

  let score = 100;
  score -= params.paidLateCount * 15;
  score -= params.unpaidOverdueCount * 20;
  score -= params.penaltiesCount * 10;

  if (
    params.paidLateCount === 0 &&
    params.unpaidOverdueCount === 0 &&
    params.penaltiesCount === 0 &&
    params.paidOnTimeCount > 0
  ) {
    score = Math.min(100, score + 5);
  }

  score = Math.max(0, Math.min(100, score));
  return { score, grade: scoreToGradeRo(score) };
}

export function formatFallbackMonthlyReview(report: MonthlyComparisonReport): string {
  const cur = report.currentMonth;
  const prev = report.previousMonth;
  const curLabel = cur.yearMonth;
  const prevLabel = prev.yearMonth;

  const lines: string[] = [
    `Salut! 👋 M-am uitat peste plățile tale din *${curLabel}* față de *${prevLabel}* și uite cum stai:`,
    '',
    `✨ *Luna ${curLabel}:* ai achitat *${formatCentsRo(cur.totalPaidCents, report.currency)}* (${cur.billsCount} facturi/plăți, din care *${cur.paidOnTimeCount}* la timp, *${cur.paidLateCount}* întârziate, *${cur.penaltiesCount}* cu penalități).`,
    cur.efficiencyScore !== null
      ? `🏅 *Ratingul tău:* *${cur.efficiencyScore}/100 — ${cur.grade}*`
      : '🏅 *Rating:* încă nu sunt facturi înregistrate luna aceasta.',
    '',
    `📅 *Luna trecută (${prevLabel}):* ${
      prev.billsCount > 0
        ? `ai achitat *${formatCentsRo(prev.totalPaidCents, report.currency)}* (${prev.billsCount} facturi/plăți, rating *${prev.efficiencyScore}/100 — ${prev.grade}*).`
        : 'nu am încă facturi înregistrate în sistem, așa că luna aceasta este punctul tău de start!'
    }`,
    '',
  ];

  if (report.betterMonth === 'CURRENT') {
    lines.push(
      `👏 *Bravo!* Ai gestionat plățile mai eficient în *${curLabel}* — ai avut grijă de datele scadente și ai ținut lucrurile sub control!`,
    );
  } else if (report.betterMonth === 'PREVIOUS') {
    lines.push(
      `💛 *Sfat prietenos:* În *${prevLabel}* ai avut o disciplină puțin mai bună la scadențe față de *${curLabel}*, dar luna viitoare recuperăm ușor!`,
    );
  } else if (report.betterMonth === 'TIE') {
    lines.push(`🤝 *Super constant!* Eficiență egală între *${curLabel}* și *${prevLabel}*!`);
  } else {
    lines.push(`ℹ️ Încă nu avem suficiente facturi înregistrate pentru o comparație completă.`);
  }

  if (report.recommendSavingsOrInvestment && report.savedVsPreviousMonthCents > 0n) {
    lines.push(
      '',
      `💡 *Pont pentru economii / investiții:* Luna aceasta ai plătit cu *${formatCentsRo(report.savedVsPreviousMonthCents, report.currency)}* mai puțin decât în ${prevLabel}! Merită din plin să pui acești *${formatCentsRo(report.savedVsPreviousMonthCents, report.currency)}* direct în contul de economii sau într-o investiție — în ritmul ăsta poți strânge *${formatCentsRo(report.annualizedSavingsPotentialCents, report.currency)}/an*! 🚀`,
    );
  }

  lines.push('', `🏦 *Sold curent (Demo):* *${formatCentsRo(report.currentBalanceCents, report.currency)}*`);
  return lines.join('\n');
}

export class FallbackMonthlyReviewComposer implements MonthlyReviewComposer {
  async composeMonthlyReview(report: MonthlyComparisonReport): Promise<string> {
    return formatFallbackMonthlyReview(report);
  }
}

const MONTHLY_REVIEW_SYSTEM_PROMPT = `You are a warm, friendly, encouraging Romanian personal Financial AI Twin writing a custom WhatsApp monthly payment efficiency review.

RULES:
1. Write a completely natural, warm, friendly, human-sounding message in Romanian — like a supportive friend chatting on WhatsApp (NEVER robotic, NEVER rigid, NEVER a dry bullet dump of counters).
2. Compare the user's current month vs. previous month:
   - Clearly state their efficiency rating/grade (out of 100) and praise them genuinely if they were careful with due dates and avoided late penalties — or gently mention any specific bill that had a penalty/delay using the exact bill names provided.
   - Clearly say WHICH month they handled payments more efficiently and why. If previous_month has 0 bills, warmly note that this is the first month tracked in full and next month they'll get a full side-by-side comparison.
3. SAVINGS / INVESTMENT RECOMMENDATION: If saved_vs_previous_month > 0 (meaning they paid LESS this month than last month), enthusiastically recommend putting that EXACT saved difference into their savings account or investments (cont de economii / depozit / titluri de stat / ETF / investiții) and highlight the annualized potential!
4. Preserve EVERY EXACT number, currency, score, month label, and "Sold curent (Demo)" from the provided verified JSON without recalculating or changing any digit.
5. Keep it warm, conversational, concise, and super pleasant to read on WhatsApp: use SINGLE asterisks (*bold*) and 2–4 friendly emojis — NEVER use Markdown double asterisks (**bold**) or horizontal rules (---).`;

export class GeminiMonthlyReviewComposer implements MonthlyReviewComposer {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(apiKey: string, model = DEFAULT_GEMINI_PRIMARY_MODEL) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async composeMonthlyReview(report: MonthlyComparisonReport): Promise<string> {
    const fallback = formatFallbackMonthlyReview(report);
    const facts = {
      sold_curent_demo: formatCentsRo(report.currentBalanceCents, report.currency),
      current_month: {
        month: report.currentMonth.yearMonth,
        total_paid: formatCentsRo(report.currentMonth.totalPaidCents, report.currency),
        bills_count: report.currentMonth.billsCount,
        paid_on_time: report.currentMonth.paidOnTimeCount,
        paid_late: report.currentMonth.paidLateCount,
        unpaid_overdue: report.currentMonth.unpaidOverdueCount,
        penalties_count: report.currentMonth.penaltiesCount,
        penalties_total: formatCentsRo(report.currentMonth.penaltiesTotalCents, report.currency),
        on_time_rate_pct: report.currentMonth.onTimeRatePct,
        efficiency_score: report.currentMonth.efficiencyScore,
        grade: report.currentMonth.grade,
        bills: report.currentMonth.items.map((item) => ({
          name: item.name,
          amount: formatCentsRo(item.amountCents, report.currency),
          status: item.paymentStatus,
          due_date: item.dueDate,
          had_penalty: item.hasPenalty,
        })),
      },
      previous_month: {
        month: report.previousMonth.yearMonth,
        total_paid: formatCentsRo(report.previousMonth.totalPaidCents, report.currency),
        bills_count: report.previousMonth.billsCount,
        paid_on_time: report.previousMonth.paidOnTimeCount,
        paid_late: report.previousMonth.paidLateCount,
        unpaid_overdue: report.previousMonth.unpaidOverdueCount,
        penalties_count: report.previousMonth.penaltiesCount,
        penalties_total: formatCentsRo(report.previousMonth.penaltiesTotalCents, report.currency),
        on_time_rate_pct: report.previousMonth.onTimeRatePct,
        efficiency_score: report.previousMonth.efficiencyScore,
        grade: report.previousMonth.grade,
        bills: report.previousMonth.items.map((item) => ({
          name: item.name,
          amount: formatCentsRo(item.amountCents, report.currency),
          status: item.paymentStatus,
          due_date: item.dueDate,
          had_penalty: item.hasPenalty,
        })),
      },
      better_month: report.betterMonth,
      paid_less_than_previous_month: report.recommendSavingsOrInvestment,
      saved_vs_previous_month: formatCentsRo(report.savedVsPreviousMonthCents, report.currency),
      annualized_savings_potential: formatCentsRo(
        report.annualizedSavingsPotentialCents,
        report.currency,
      ),
      available_months_with_data: report.availableMonthsWithData,
    };

    try {
      const { result: response } = await callGeminiWithModelFallback({
        preferredModel: this.model,
        timeoutMs: 20_000,
        label: 'Monthly Review Composer',
        invoke: (model) =>
          this.ai.models.generateContent({
            model,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `Compose a warm, friendly, custom Romanian WhatsApp payment efficiency review using ONLY these verified metrics:\n\n${JSON.stringify(facts, null, 2)}`,
                  },
                ],
              },
            ],
            config: {
              systemInstruction: MONTHLY_REVIEW_SYSTEM_PROMPT,
              temperature: 0.65,
            },
          }),
      });

      const text = response.text?.trim();
      if (text && text.length > 30) {
        return text;
      }
      return fallback;
    } catch {
      return fallback;
    }
  }
}

export class MonthlyReviewService {
  private readonly composer: MonthlyReviewComposer;

  constructor(private readonly deps: MonthlyReviewServiceDeps) {
    this.composer = deps.composer ?? new FallbackMonthlyReviewComposer();
  }

  async buildComparisonReport(
    ownerJid: string,
    targetYearMonth?: string,
    now: Date = new Date(),
  ): Promise<MonthlyComparisonReport> {
    const currentYM = targetYearMonth ?? getBucharestYearMonth(now);
    const previousYM = getPreviousYearMonth(currentYM);

    const [balance, allInvoices, allWaPayments] = await Promise.all([
      this.deps.demoBalanceService.getBalance(ownerJid),
      this.deps.invoiceRepo.findAll(),
      this.deps.whatsappPaymentRepo.findByOwner(ownerJid),
    ]);

    const computeForMonth = (ym: string): MonthPaymentMetrics => {
      const monthEndIso = getMonthEndIso(ym);
      const monthInvoices = allInvoices.filter(
        (inv) => inv.currency === balance.currency && inv.issueDate.startsWith(ym),
      );
      const monthWa = allWaPayments.filter((p) => {
        if (p.currency !== balance.currency || p.paymentStatus === 'CANCELLED') return false;
        const refDate = p.dueDate ?? p.createdAt.toISOString().slice(0, 10);
        return refDate.startsWith(ym);
      });

      let totalBilledCents = 0n;
      let totalPaidCents = 0n;
      let paidOnTimeCount = 0;
      let paidLateCount = 0;
      let unpaidOverdueCount = 0;
      let penaltiesCount = 0;
      let penaltiesTotalCents = 0n;
      const items: MonthBillSnapshot[] = [];

      for (const inv of monthInvoices) {
        if (inv.totalAmountCents > 0n) {
          totalBilledCents += inv.totalAmountCents;
        }
        if (inv.paymentStatus === 'PAID_ON_TIME') {
          paidOnTimeCount += 1;
          if (inv.totalAmountCents > 0n) totalPaidCents += inv.totalAmountCents;
        } else if (inv.paymentStatus === 'PAID_LATE') {
          paidLateCount += 1;
          if (inv.totalAmountCents > 0n) totalPaidCents += inv.totalAmountCents;
        } else if (
          (inv.paymentStatus === 'UNPAID' || inv.paymentStatus === 'HOLD_BEFORE_PAYMENT') &&
          inv.dueDate <= monthEndIso
        ) {
          unpaidOverdueCount += 1;
        }

        const penaltyLines = inv.lineItems.filter((l) => !l.isStorno && l.lineType === 'PENALTY');
        const hasPenaltyFlag = inv.auditFlags.some((f) => f.code === 'LATE_FEE_DETECTED');
        const hasPenalty = penaltyLines.length > 0 || hasPenaltyFlag;
        if (hasPenalty) {
          penaltiesCount += 1;
          for (const pl of penaltyLines) {
            penaltiesTotalCents +=
              pl.lineTotalGrossCents < 0n ? -pl.lineTotalGrossCents : pl.lineTotalGrossCents;
          }
        }

        items.push({
          name: inv.providerName,
          amountCents: inv.totalAmountCents,
          paymentStatus: inv.paymentStatus,
          dueDate: inv.dueDate,
          hasPenalty,
        });
      }

      for (const p of monthWa) {
        totalBilledCents += p.amountCents;
        if (p.paymentStatus === 'PAID_ON_TIME') {
          paidOnTimeCount += 1;
          totalPaidCents += p.amountCents;
        } else if (p.paymentStatus === 'PAID_LATE') {
          paidLateCount += 1;
          totalPaidCents += p.amountCents;
        } else if (p.paymentStatus === 'UNPAID' && p.dueDate && p.dueDate <= monthEndIso) {
          unpaidOverdueCount += 1;
        }

        items.push({
          name: p.title,
          amountCents: p.amountCents,
          paymentStatus: p.paymentStatus,
          dueDate: p.dueDate,
          hasPenalty: false,
        });
      }

      const billsCount = monthInvoices.length + monthWa.length;
      const onTimeRatePct =
        billsCount > 0
          ? new Decimal(paidOnTimeCount).div(billsCount).mul(100).toDecimalPlaces(1).toFixed(1)
          : null;

      const { score, grade } = computeMonthEfficiencyScore({
        billsCount,
        paidOnTimeCount,
        paidLateCount,
        unpaidOverdueCount,
        penaltiesCount,
      });

      return {
        yearMonth: ym,
        totalBilledCents,
        totalPaidCents,
        billsCount,
        paidOnTimeCount,
        paidLateCount,
        unpaidOverdueCount,
        penaltiesCount,
        penaltiesTotalCents,
        onTimeRatePct,
        efficiencyScore: score,
        grade,
        items,
      };
    };

    const currentMonth = computeForMonth(currentYM);
    const previousMonth = computeForMonth(previousYM);

    const monthSet = new Set<string>();
    for (const inv of allInvoices) {
      if (inv.currency === balance.currency && inv.issueDate.length >= 7) {
        monthSet.add(inv.issueDate.slice(0, 7));
      }
    }
    for (const p of allWaPayments) {
      if (p.currency === balance.currency && p.paymentStatus !== 'CANCELLED') {
        const ref = p.dueDate ?? p.createdAt.toISOString().slice(0, 10);
        if (ref.length >= 7) monthSet.add(ref.slice(0, 7));
      }
    }
    const availableMonthsWithData = Array.from(monthSet).sort().reverse();

    const spendingDeltaCents = currentMonth.totalPaidCents - previousMonth.totalPaidCents;
    const savedVsPreviousMonthCents =
      previousMonth.totalPaidCents > 0n && spendingDeltaCents < 0n
        ? -spendingDeltaCents
        : 0n;
    const annualizedSavingsPotentialCents = savedVsPreviousMonthCents * 12n;

    let betterMonth: BetterMonthOutcome = 'INSUFFICIENT_DATA';
    if (currentMonth.efficiencyScore !== null && previousMonth.efficiencyScore !== null) {
      if (currentMonth.efficiencyScore > previousMonth.efficiencyScore) {
        betterMonth = 'CURRENT';
      } else if (currentMonth.efficiencyScore < previousMonth.efficiencyScore) {
        betterMonth = 'PREVIOUS';
      } else if (currentMonth.penaltiesCount < previousMonth.penaltiesCount) {
        betterMonth = 'CURRENT';
      } else if (currentMonth.penaltiesCount > previousMonth.penaltiesCount) {
        betterMonth = 'PREVIOUS';
      } else if (currentMonth.totalPaidCents < previousMonth.totalPaidCents) {
        betterMonth = 'CURRENT';
      } else if (currentMonth.totalPaidCents > previousMonth.totalPaidCents) {
        betterMonth = 'PREVIOUS';
      } else {
        betterMonth = 'TIE';
      }
    } else if (currentMonth.efficiencyScore !== null) {
      betterMonth = 'CURRENT';
    } else if (previousMonth.efficiencyScore !== null) {
      betterMonth = 'PREVIOUS';
    }

    return {
      ownerJid,
      currency: balance.currency,
      currentBalanceCents: balance.balanceCents,
      currentMonth,
      previousMonth,
      spendingDeltaCents,
      savedVsPreviousMonthCents,
      annualizedSavingsPotentialCents,
      betterMonth,
      recommendSavingsOrInvestment: savedVsPreviousMonthCents > 0n,
      availableMonthsWithData,
    };
  }

  async generateCustomReviewMessage(
    ownerJid: string,
    targetYearMonth?: string,
    now: Date = new Date(),
  ): Promise<{ report: MonthlyComparisonReport; message: string }> {
    const report = await this.buildComparisonReport(ownerJid, targetYearMonth, now);
    const message = await this.composer.composeMonthlyReview(report);
    return { report, message };
  }

  /**
   * Called by the end-of-month cron job: sends the custom AI monthly review
   * strictly ONCE on the last calendar day of the month (Europe/Bucharest).
   */
  async dispatchEndOfMonthReviewIfDue(
    ownerJid: string,
    now: Date = new Date(),
    opts?: { force?: boolean },
  ): Promise<{ sent: boolean; review?: StoredMonthlyReview; message?: string }> {
    if (!opts?.force && !isLastDayOfMonthBucharest(now)) {
      return { sent: false };
    }

    const reviewMonth = getBucharestYearMonth(now);
    const existing = await this.deps.monthlyReviewRepo.findByMonth(ownerJid, reviewMonth);
    if (existing) {
      return { sent: false, review: existing };
    }

    const { report, message } = await this.generateCustomReviewMessage(ownerJid, reviewMonth, now);

    // Skip sending an empty review on months with zero data in both months unless forced
    if (
      !opts?.force &&
      report.currentMonth.billsCount === 0 &&
      report.previousMonth.billsCount === 0
    ) {
      return { sent: false };
    }

    await this.deps.messaging.sendText(ownerJid, message);

    const { review } = await this.deps.monthlyReviewRepo.insertIfNew({
      ownerJid,
      reviewMonth: report.currentMonth.yearMonth,
      previousMonth: report.previousMonth.yearMonth,
      currentPaidCents: report.currentMonth.totalPaidCents,
      previousPaidCents: report.previousMonth.totalPaidCents,
      savedCents: report.savedVsPreviousMonthCents,
      currentScore: report.currentMonth.efficiencyScore,
      previousScore: report.previousMonth.efficiencyScore,
      currentGrade: report.currentMonth.grade,
      betterMonth: report.betterMonth,
      metricsJson: {
        currentPaidCents: report.currentMonth.totalPaidCents.toString(),
        previousPaidCents: report.previousMonth.totalPaidCents.toString(),
        savedCents: report.savedVsPreviousMonthCents.toString(),
        currentScore: report.currentMonth.efficiencyScore,
        previousScore: report.previousMonth.efficiencyScore,
        betterMonth: report.betterMonth,
      },
      generatedMessage: message,
      sentAt: now,
    });

    return { sent: true, review, message };
  }
}
