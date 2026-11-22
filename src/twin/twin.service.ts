import { FunctionCallingConfigMode, GoogleGenAI, type Content } from '@google/genai';
import type { Logger } from 'pino';
import {
  callGeminiWithModelFallback,
  DEFAULT_GEMINI_PRIMARY_MODEL,
  isTransientOrQuotaGeminiError,
} from '../config/gemini.models.js';
import type { StoredMemoryEvent } from '../db/repositories/memory.repo.js';
import type {
  StoredTwinMessage,
  TwinChatRepository,
} from '../db/repositories/twin-chat.repo.js';
import { formatCentsRo, normalizeDiacritics } from '../extraction/schema.js';
import type { QrTrackingService } from '../payments/qr.tracking.service.js';
import {
  FinancialToolExecutor,
  TWIN_GEMINI_TOOL_DECLARATIONS,
  type ToolExecutionContext,
} from './financial.tools.js';
import type { FinancialGuardrail, TwinIntent } from './guardrail.js';
import type { FinancialMemoryService } from './memory.service.js';
import { getMixedRefusalSuffix, type TwinLanguage } from './refusal.templates.js';

export interface TwinGeneratorInput {
  userMessage: string;
  intent: TwinIntent;
  detectedLanguage: TwinLanguage;
  hasMixedOffTopic: boolean;
  recentHistory: StoredTwinMessage[];
  recentMemory: StoredMemoryEvent[];
  toolExecutor: FinancialToolExecutor;
  toolCtx: ToolExecutionContext;
}

export interface TwinGeneratorOutput {
  replyText: string;
  toolCallsUsed: string[];
}

export interface TwinGenerator {
  generate(input: TwinGeneratorInput): Promise<TwinGeneratorOutput>;
}

const TWIN_SYSTEM_PROMPT = `You are a warm, friendly, smart personal Financial AI Twin inside WhatsApp for a user in Romania.

CORE BEHAVIOR:
1. Talk like a helpful, supportive, approachable Romanian friend who really understands personal finance — NEVER robotic, NEVER cold, NEVER a rigid boilerplate template or raw database dump! Think carefully about the EXACT question the user asked and write a natural, warm, tailored answer in their language (default Romanian). For WhatsApp formatting, use SINGLE asterisks (*bold*) for emphasis and a few tasteful emojis — NEVER use Markdown double asterisks (**bold**) or horizontal rules (---).
2. ZERO HALLUCINATIONS: Every monetary amount, balance, invoice number, due date, QR scan timestamp, rating score, and payment status MUST come strictly from your database tools. Never invent numbers or facts.
3. ALWAYS call the relevant database tool(s) FRESH on EVERY turn before answering any question about bills, unpaid totals, paid history, subscriptions, free trials, monthly comparisons, ratings, QR codes, or WhatsApp payments. NEVER reuse numbers, ratings, or "no records for last month" claims from earlier messages in chat history — the database updates continuously!
4. If the database tool returns no record of a payment or bill, say so warmly and clearly.
5. STRICT DOMAIN BOUNDARY: Discuss ONLY the user's personal finances, bills/invoices, Invoice X-Ray audit findings, payments tracked on WhatsApp, payment QR codes, subscriptions, free trials, Demo Balance, monthly payment reviews, and reminders. If ANY part of the user's message asks about unrelated non-financial topics (recipes, code, jokes, weather, trivia, etc.), answer ONLY the financial part and politely refuse the non-financial part.
6. Format money in Romanian style (e.g. 245,80 RON) and dates cleanly (e.g. 25.04.2026). Keep replies clear, friendly, and easy to scan on WhatsApp.
7. INITIATING A PAYMENT: When the user says they want to pay a bill or asks you to pay a bill (e.g. "plătește factura de la Engie", "vreau să plătesc Hidroelectrica", "plătește toate facturile", "vreau să achit chiria"):
   - Call query_bills_and_payments with status="UNPAID" to locate the matching unpaid invoice(s) or WhatsApp payment(s).
   - Immediately call resend_payment_qr for each matching unpaid bill so the user receives the tracked payment QR PNG and clickable /pay/:token handoff link on WhatsApp right away.
   - NEVER call mark_payment_completed until the user explicitly confirms they HAVE ALREADY paid (e.g. "am plătit Engie", "am achitat factura").
   - Warn the user naturally if the bill has any Invoice X-Ray anomaly/penalty/HOLD_BEFORE_PAYMENT before paying.
8. SUBSCRIPTION ZOMBIE RADAR, FREE TRIALS & SOLD CURENT (DEMO):
   - NEVER force the user to type rigid /commands — understand their natural phrasing directly and call the right tools:
     - Questions about subscriptions OR free trials (e.g. "am vreun abonament activ?", "ce abonamente am?", "am vreun trial?", "cât dau pe an pe abonamente?") -> ALWAYS call get_subscriptions_radar (which returns BOTH active subscriptions AND active free trials + Sold curent (Demo)!). If the user asks about a fresh trial email they just received or asks to check Gmail, ALSO call scan_gmail_for_trials_and_subscriptions right away so you see the newest email immediately!
     - Always list the EXACT names, prices, expiration dates, and cancellation links of each subscription/trial returned by the tools — NEVER reply with only a bare count without naming them!
     - Saying they started a free trial (e.g. "mi-am făcut trial la Canva 14 zile, după e 55 lei") -> call schedule_free_trial_alert.
     - Saying they cancelled a trial/subscription or still actively use a subscription (e.g. "am anulat trial-ul la Adobe", "folosesc Spotify") -> call update_subscription_or_trial_status (using name or id).
     - Mentioning or asking about their Demo Balance / Safe-to-Spend -> call manage_demo_balance.
   - ALWAYS explicitly display "Sold curent (Demo): <exact amount from tool>" in EVERY answer about subscriptions, annual cost, price hikes, free trials, monthly reviews, or Safe-to-Spend.
9. MONTHLY EFFICIENCY COMPARISON, RATING & SAVINGS RECOMMENDATION:
   - Whenever the user asks for a monthly review, rating, comparison with last month, payment discipline feedback, or asks naturally things like "m-am descurcat bine luna asta?", "cum stau luna asta?", "ce pot îmbunătăți la plățile mele?" -> ALWAYS call get_monthly_efficiency_review freshly right now!
   - Write a super warm, friendly, encouraging, custom Romanian message (NEVER a dry list of database counters!):
     - Give them their exact efficiency rating (e.g. *90/100 — A (Foarte bun)* or *100/100 — A+ (Exemplar)*) and praise them genuinely for staying on top of due dates and avoiding penalties (or mention kindly any specific bill that had a penalty or delay, using the exact bill names returned by the tool).
     - Clearly explain which month was managed more efficiently (current vs. previous). If the previous month had no bills recorded yet, explain warmly that this is the first month tracked in full and next month you'll compare side-by-side!
     - If saved_vs_previous_month > 0 (they paid LESS this month than last month), enthusiastically suggest moving that EXACT saved difference into their savings account or investments (cont de economii / depozit / titluri de stat / ETF) and highlight the annualized potential!
     - Always include their Sold curent (Demo) clearly at the end.`;

function buildAlternatingContents(
  recentHistory: StoredTwinMessage[],
  userMessage: string,
): Content[] {
  const contents: Content[] = [];
  for (const turn of recentHistory) {
    const role = turn.role === 'USER' ? 'user' : 'model';
    const text = turn.content.trim();
    if (!text) continue;

    const prev = contents[contents.length - 1];
    if (prev && prev.role === role && prev.parts) {
      prev.parts.push({ text });
    } else if (contents.length > 0 || role === 'user') {
      contents.push({ role, parts: [{ text }] });
    }
  }

  const last = contents[contents.length - 1];
  if (last && last.role === 'user' && last.parts) {
    last.parts.push({ text: userMessage });
  } else {
    contents.push({ role: 'user', parts: [{ text: userMessage }] });
  }
  return contents;
}

export class GeminiTwinGenerator implements TwinGenerator {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly logger?: Logger;

  constructor(apiKey: string, model = DEFAULT_GEMINI_PRIMARY_MODEL, logger?: Logger) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
    this.logger = logger;
  }

  async generate(input: TwinGeneratorInput): Promise<TwinGeneratorOutput> {
    const memorySnapshot =
      input.recentMemory.length > 0
        ? input.recentMemory
            .slice(0, 12)
            .map((e) => `- [${e.createdAt.toISOString().slice(0, 16)}] (${e.eventType}) ${e.summaryText}`)
            .join('\n')
        : '(Niciun eveniment financiar recent în memorie.)';

    const systemInstruction = [
      TWIN_SYSTEM_PROMPT,
      '',
      `Detected language: ${input.detectedLanguage}. Classified intent: ${input.intent}.`,
      input.hasMixedOffTopic
        ? 'WARNING: The user message contains an off-topic part! Answer ONLY the financial part and explicitly refuse the off-topic part.'
        : '',
      '',
      'Compact recent financial memory snapshot (use tools for exact current totals & details):',
      memorySnapshot,
    ]
      .filter(Boolean)
      .join('\n');

    const contents = buildAlternatingContents(input.recentHistory, input.userMessage);

    const toolCallsUsed: string[] = [];

    for (let round = 0; round < 6; round++) {
      const { result: response } = await callGeminiWithModelFallback({
        preferredModel: this.model,
        timeoutMs: 22_000,
        label: 'AI Twin Generator',
        logger: this.logger,
        invoke: (model) =>
          this.ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              temperature: 0.45,
              tools: [{ functionDeclarations: TWIN_GEMINI_TOOL_DECLARATIONS }],
              toolConfig: {
                functionCallingConfig: {
                  mode:
                    round === 0
                      ? FunctionCallingConfigMode.ANY
                      : FunctionCallingConfigMode.AUTO,
                },
              },
            },
          }),
      });

      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const modelContent = response.candidates?.[0]?.content;
        if (modelContent) {
          contents.push(modelContent);
        }

        const responseParts: Array<{
          functionResponse: { name: string; response: Record<string, unknown> };
        }> = [];

        for (const call of functionCalls) {
          const toolName = call.name ?? '';
          toolCallsUsed.push(toolName);
          const result = await input.toolExecutor.execute(
            toolName,
            (call.args ?? {}) as Record<string, unknown>,
            input.toolCtx,
          );
          responseParts.push({
            functionResponse: {
              name: toolName,
              response: result,
            },
          });
        }

        contents.push({
          role: 'user',
          parts: responseParts,
        });
        continue;
      }

      const text = response.text?.trim();
      if (text) {
        return { replyText: text, toolCallsUsed };
      }
      break;
    }

    return {
      replyText:
        input.detectedLanguage === 'en'
          ? 'I checked your financial records, but could not generate a complete answer. Please rephrase your financial question.'
          : 'Am verificat datele tale financiare, dar nu am putut formula un răspuns complet. Te rog reformulează întrebarea financiară.',
      toolCallsUsed,
    };
  }
}

/**
 * Deterministic, DB-grounded TwinGenerator used in offline tests & simulator mode
 * when running without external Gemini API calls. Executes the exact same
 * FinancialToolExecutor tools against PostgreSQL / In-Memory repositories.
 */
export class DeterministicTwinGenerator implements TwinGenerator {
  async generate(input: TwinGeneratorInput): Promise<TwinGeneratorOutput> {
    const norm = normalizeDiacritics(input.userMessage).toLowerCase();
    const toolCallsUsed: string[] = [];

    // 0. Subscription Radar / Free Trials / Manage Subscription or Trial (deterministic offline fallback)
    if (input.intent === 'FREE_TRIAL_QUERY') {
      if (/\b(verifica|scaneaza|uita-te|cauta).*(gmail|email|mail)\b/i.test(norm)) {
        toolCallsUsed.push('scan_gmail_for_trials_and_subscriptions');
        const res = await input.toolExecutor.execute(
          'scan_gmail_for_trials_and_subscriptions',
          {},
          input.toolCtx,
        );
        return {
          toolCallsUsed,
          replyText: `🔎 Am scanat Gmail (${String(res.scanned_emails ?? 0)} emailuri): ${String(res.newly_detected_trials ?? 0)} trial-uri noi, ${String(res.newly_detected_receipts ?? 0)} chitanțe abonament, ${String(res.auto_cancelled_trials ?? 0)} anulări.\n🏦 Sold curent (Demo): *${String(res.sold_curent_demo ?? '0,00 RON')}*`,
        };
      }
      toolCallsUsed.push('get_active_free_trials');
      const res = (await input.toolExecutor.execute(
        'get_active_free_trials',
        {},
        input.toolCtx,
      )) as {
        sold_curent_demo: string;
        free_trials: Array<{
          id: number;
          service_name: string;
          trial_end_at: string;
          post_trial_amount_formatted: string;
          alert_48h_scheduled_at: string;
        }>;
      };
      const lines = [
        `⏳ *Free Trials active (${res.free_trials?.length ?? 0}):*`,
        `🏦 *Sold curent (Demo):* *${res.sold_curent_demo ?? '0,00 RON'}*`,
      ];
      for (const t of res.free_trials ?? []) {
        lines.push(
          `• #${t.id} *${t.service_name}* — expiră ${t.trial_end_at.slice(0, 10)} → ${t.post_trial_amount_formatted} (alertă 48h: ${t.alert_48h_scheduled_at.slice(0, 10)})`,
        );
      }
      return { toolCallsUsed, replyText: lines.join('\n') };
    }

    if (input.intent === 'SUBSCRIPTION_RADAR_QUERY') {
      toolCallsUsed.push('get_subscriptions_radar');
      const res = (await input.toolExecutor.execute(
        'get_subscriptions_radar',
        {},
        input.toolCtx,
      )) as {
        sold_curent_demo: string;
        active_subscriptions_count: number;
        total_monthly_formatted: string;
        total_annual_formatted: string;
        zombie_count: number;
        subscriptions: Array<{
          id: number;
          merchant_name: string;
          category: string;
          current_amount_formatted: string;
          annualized_cost_formatted: string;
          status: string;
        }>;
        active_free_trials: Array<{
          id: number;
          service_name: string;
          trial_end_at: string;
          post_trial_amount_formatted: string;
        }>;
      };
      const lines = [
        `📡 *Abonamente active (${res.active_subscriptions_count ?? 0}) & Free Trials (${res.active_free_trials?.length ?? 0}):*`,
        `• Lunar: *${res.total_monthly_formatted ?? '0,00 RON'}* | Anual (\`sumă × 12\`): *${res.total_annual_formatted ?? '0,00 RON'}*`,
      ];
      for (const s of res.subscriptions ?? []) {
        lines.push(
          `• [${s.category}] *${s.merchant_name}* — ${s.current_amount_formatted}/lună (${s.annualized_cost_formatted}/an)${s.status === 'ZOMBIE_SUSPECTED' ? ' 🧟' : ''}`,
        );
      }
      for (const t of res.active_free_trials ?? []) {
        lines.push(
          `• [FREE TRIAL] *${t.service_name}* — expiră ${t.trial_end_at.slice(0, 10)}, apoi ${t.post_trial_amount_formatted}/lună`,
        );
      }
      lines.push(`🏦 *Sold curent (Demo):* *${res.sold_curent_demo ?? '0,00 RON'}*`);
      return {
        toolCallsUsed,
        replyText: lines.join('\n'),
      };
    }

    if (input.intent === 'MANAGE_SUBSCRIPTION_OR_TRIAL') {
      const isTrial = /\btrial\b/i.test(norm);
      const isConfirmUsed = /\b(folosesc|nu e zombie|nu este zombie)\b/i.test(norm);
      const idMatch = norm.match(/\b(\d+)\b/);
      const knownBrands = ['adobe', 'canva', 'netflix', 'spotify', 'icloud', 'disney', 'youtube', 'world class'];
      const brand = knownBrands.find((b) => norm.includes(b));

      toolCallsUsed.push('update_subscription_or_trial_status');
      const res = await input.toolExecutor.execute(
        'update_subscription_or_trial_status',
        {
          target: isTrial ? 'FREE_TRIAL' : 'SUBSCRIPTION',
          id: idMatch?.[1] ? Number.parseInt(idMatch[1], 10) : undefined,
          name: brand,
          action: isConfirmUsed ? 'CONFIRM_USED' : 'CANCEL',
        },
        input.toolCtx,
      );
      if (res.ok) {
        return {
          toolCallsUsed,
          replyText: `✅ Actualizat *${String(res.service_name ?? res.merchant_name)}* → status *${String(res.status)}*.\n🏦 Sold curent (Demo): *${String(res.sold_curent_demo ?? '0,00 RON')}*`,
        };
      }
    }

    // 1. Log WhatsApp payment
    if (input.intent === 'LOG_WHATSAPP_PAYMENT') {
      const amountMatch = norm.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:ron|lei|eur)/i);
      const amount = amountMatch?.[1]
        ? Number.parseFloat(amountMatch[1].replace(',', '.'))
        : 0;
      const alreadyPaid = /\b(am platit|am achitat)\b/i.test(norm);
      const isRent = /\bchiri\w*\b/i.test(norm);
      const title = isRent
        ? 'Chirie'
        : /\bintretinere\b/i.test(norm)
          ? 'Întreținere'
          : 'Plată WhatsApp';
      const payeeName = isRent ? 'Proprietar Chirie' : title;
      const dueDayMatch = norm.match(/\b(?:pe|pana pe)\s+(\d{1,2})\b/i);
      let dueDate: string | undefined;
      if (dueDayMatch?.[1]) {
        const day = Number.parseInt(dueDayMatch[1], 10);
        const now = input.toolCtx.now ?? new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        dueDate = `${year}-${month}-${String(Math.min(28, Math.max(1, day))).padStart(2, '0')}`;
      }

      if (amount > 0) {
        toolCallsUsed.push('log_whatsapp_payment');
        const logged = await input.toolExecutor.execute(
          'log_whatsapp_payment',
          {
            title,
            payee_name: payeeName,
            amount_ron: amount,
            category: isRent ? 'RENT' : 'OTHER',
            due_date: dueDate,
            already_paid: alreadyPaid,
            generate_qr: !alreadyPaid,
          },
          input.toolCtx,
        );
        return {
          toolCallsUsed,
          replyText: `✅ Am înregistrat plata *${String(logged.title)}* (${String(logged.amount_formatted)})${logged.due_date ? `, scadență ${String(logged.due_date)}` : ''}, status: *${String(logged.payment_status)}*.`,
        };
      }
    }

    // 2. Mark payment completed
    if (input.intent === 'MARK_AS_PAID') {
      toolCallsUsed.push('query_bills_and_payments');
      const queried = (await input.toolExecutor.execute(
        'query_bills_and_payments',
        { status: 'UNPAID' },
        input.toolCtx,
      )) as {
        invoices: Array<{ id: number; provider_name: string; amount_formatted: string }>;
        whatsapp_payments: Array<{ id: number; title: string; payee_name: string; amount_formatted: string }>;
      };

      const matchedInv = queried.invoices.find((inv) =>
        norm.includes(normalizeDiacritics(inv.provider_name).toLowerCase().split(/\s+/)[0] ?? ''),
      );
      if (matchedInv) {
        toolCallsUsed.push('mark_payment_completed');
        const res = await input.toolExecutor.execute(
          'mark_payment_completed',
          { target_type: 'INVOICE', id: matchedInv.id },
          input.toolCtx,
        );
        return {
          toolCallsUsed,
          replyText: `✅ Am marcat factura *${String(res.payee_name)}* (#${matchedInv.id}, ${String(res.amount_formatted)}) ca *${String(res.payment_status)}* și am oprit reminderele.`,
        };
      }

      const matchedWa = queried.whatsapp_payments.find(
        (p) =>
          norm.includes(normalizeDiacritics(p.title).toLowerCase()) ||
          norm.includes(normalizeDiacritics(p.payee_name).toLowerCase().split(/\s+/)[0] ?? ''),
      );
      if (matchedWa) {
        toolCallsUsed.push('mark_payment_completed');
        const res = await input.toolExecutor.execute(
          'mark_payment_completed',
          { target_type: 'WHATSAPP_PAYMENT', id: matchedWa.id },
          input.toolCtx,
        );
        return {
          toolCallsUsed,
          replyText: `✅ Am marcat plata *${matchedWa.title}* (${String(res.amount_formatted)}) ca *${String(res.payment_status)}* și am oprit reminderele.`,
        };
      }
    }

    // 3. Initiate payment / send QR when user asks to pay a bill ("plateste factura de la engie", "vreau sa platesc ...")
    const wantsToPayNow =
      /\b(plateste|vreau sa platesc|sa platesc|achita|vreau sa achit|trimite qr|retrimite qr|da-?mi qr|cod qr pentru|pay bill|pay invoice)\b/i.test(
        norm,
      ) && !/\b(am platit|am achitat|am accesat|am scanat)\b/i.test(norm);

    if (wantsToPayNow) {
      toolCallsUsed.push('query_bills_and_payments');
      const queried = (await input.toolExecutor.execute(
        'query_bills_and_payments',
        { status: 'UNPAID' },
        input.toolCtx,
      )) as {
        invoices: Array<{
          id: number;
          provider_name: string;
          amount_formatted: string;
          due_date: string;
          payment_status: string;
          audit_flags: Array<{ severity: string; message: string }>;
        }>;
        whatsapp_payments: Array<{
          id: number;
          title: string;
          payee_name: string;
          amount_formatted: string;
          due_date: string | null;
        }>;
      };

      const payAll = /\b(toate|orice|all)\b/i.test(norm);

      const matchedInvoices = payAll
        ? queried.invoices
        : queried.invoices.filter((inv) => {
            const words = normalizeDiacritics(inv.provider_name)
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter((w) => w.length >= 3 && !['srl', 'romania', 'energie', 'furnizare'].includes(w));
            return words.some((w) => norm.includes(w));
          });

      const matchedWa = payAll
        ? queried.whatsapp_payments
        : queried.whatsapp_payments.filter((p) => {
            const words = normalizeDiacritics(`${p.title} ${p.payee_name}`)
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter((w) => w.length >= 3);
            return words.some((w) => norm.includes(w));
          });

      const targets: Array<{
        target_type: 'INVOICE' | 'WHATSAPP_PAYMENT';
        id: number;
        label: string;
        amount: string;
        due: string | null;
        warning?: string;
      }> = [
        ...matchedInvoices.map((inv) => ({
          target_type: 'INVOICE' as const,
          id: inv.id,
          label: inv.provider_name,
          amount: inv.amount_formatted,
          due: inv.due_date,
          warning:
            inv.payment_status === 'HOLD_BEFORE_PAYMENT'
              ? '⚠️ Atenție: această factură are anomalii critice Invoice X-Ray!'
              : inv.audit_flags.length > 0
                ? `⚠️ Mențiuni audit: ${inv.audit_flags.map((f) => f.message).join(' ')}`
                : undefined,
        })),
        ...matchedWa.map((p) => ({
          target_type: 'WHATSAPP_PAYMENT' as const,
          id: p.id,
          label: `${p.title} (${p.payee_name})`,
          amount: p.amount_formatted,
          due: p.due_date,
        })),
      ];

      if (targets.length === 0) {
        if (queried.invoices.length === 0 && queried.whatsapp_payments.length === 0) {
          return {
            toolCallsUsed,
            replyText: '✅ Nu ai nicio factură sau plată neachitată în evidență în acest moment.',
          };
        }
        const available = [
          ...queried.invoices.map((i) => `• *${i.provider_name}* (#${i.id}) — ${i.amount_formatted}`),
          ...queried.whatsapp_payments.map((p) => `• *${p.title}* (#${p.id}) — ${p.amount_formatted}`),
        ].join('\n');
        return {
          toolCallsUsed,
          replyText: `Nu am identificat exact ce factură dorești să plătești. Facturile/plățile neachitate disponibile sunt:\n${available}\n\nScrie-mi, de exemplu: *"plătește factura de la ${queried.invoices[0]?.provider_name ?? queried.whatsapp_payments[0]?.title}"*.`,
        };
      }

      const replyLines: string[] = ['💳 *Am pregătit codul QR și linkul de plată:*'];
      for (const t of targets) {
        toolCallsUsed.push('resend_payment_qr');
        const qrRes = await input.toolExecutor.execute(
          'resend_payment_qr',
          { target_type: t.target_type, id: t.id },
          input.toolCtx,
        );
        replyLines.push(
          `• *${t.label}* — *${t.amount}*${t.due ? ` (scadență ${t.due})` : ''}`,
          `  Link plată: ${String(qrRes.tracking_url ?? '')}`,
        );
        if (t.warning) {
          replyLines.push(`  ${t.warning}`);
        }
      }
      replyLines.push(
        '',
        'Scanează codul QR primit mai jos (sau apasă direct pe link), iar după efectuarea plății confirmă din pagină sau scrie-mi *"am plătit <furnizor>"*.',
      );
      return {
        toolCallsUsed,
        replyText: replyLines.join('\n'),
      };
    }

    // 4. QR & Payment tracking status
    if (input.intent === 'QR_AND_PAYMENT_STATUS') {
      toolCallsUsed.push('get_qr_and_payment_tracking');
      const tracked = (await input.toolExecutor.execute(
        'get_qr_and_payment_tracking',
        {},
        input.toolCtx,
      )) as {
        tracked_payment_links: Array<{
          payee_name: string;
          amount_formatted: string;
          status: string;
          qr_was_accessed: boolean;
          first_accessed_at: string | null;
          access_count: number;
          completed_at: string | null;
        }>;
      };

      const filtered = tracked.tracked_payment_links.filter((l) => {
        const firstWord = normalizeDiacritics(l.payee_name).toLowerCase().split(/\s+/)[0] ?? '';
        return firstWord.length >= 3 && norm.includes(firstWord);
      });
      const list = filtered.length > 0 ? filtered : tracked.tracked_payment_links;

      if (list.length === 0) {
        return {
          toolCallsUsed,
          replyText: 'Nu există încă niciun cod QR de plată generat în istoricul tău.',
        };
      }

      const lines = list.map((l) => {
        const accessInfo = l.qr_was_accessed
          ? `accesat (${l.access_count}x, prima dată la ${l.first_accessed_at})`
          : 'NEACCESAT încă';
        return `• *${l.payee_name}* (${l.amount_formatted}) — status: *${l.status}* | QR: ${accessInfo}`;
      });
      return {
        toolCallsUsed,
        replyText: `📲 *Status coduri QR monitorizate:*\n${lines.join('\n')}`,
      };
    }

    // 4b. Monthly efficiency comparison & rating (offline fallback only — live WhatsApp uses Gemini)
    if (
      /\b(compara\w*|rating|eficient\w*|bilant\w*|raport\s+lunar|economi\w*|investit\w*)\b/i.test(
        norm,
      )
    ) {
      toolCallsUsed.push('get_monthly_efficiency_review');
      const review = (await input.toolExecutor.execute(
        'get_monthly_efficiency_review',
        {},
        input.toolCtx,
      )) as {
        error?: string;
        sold_curent_demo?: string;
        better_month?: string;
        recommend_savings_or_investment?: boolean;
        saved_vs_previous_month?: string;
        annualized_savings_potential?: string;
        current_month?: {
          month: string;
          total_paid: string;
          bills_count: number;
          paid_on_time: number;
          paid_late: number;
          penalties_count: number;
          efficiency_score: number | null;
          grade: string | null;
        };
        previous_month?: {
          month: string;
          total_paid: string;
          bills_count: number;
          efficiency_score: number | null;
          grade: string | null;
        };
      };

      if (!review.error && review.current_month && review.previous_month) {
        const cur = review.current_month;
        const prev = review.previous_month;
        const lines = [
          `Salut! 👋 M-am uitat peste plățile tale din *${cur.month}* față de *${prev.month}* și uite cum stai:`,
          '',
          `✨ *Luna ${cur.month}:* ai achitat *${cur.total_paid}* (${cur.bills_count} facturi/plăți, *${cur.paid_on_time}* la timp, *${cur.paid_late}* întârziate, *${cur.penalties_count}* cu penalități).`,
          cur.efficiency_score !== null
            ? `🏅 *Ratingul tău:* *${cur.efficiency_score}/100 — ${cur.grade}*`
            : '🏅 *Rating:* încă nu sunt facturi înregistrate luna aceasta.',
          '',
          `📅 *Luna ${prev.month}:* ${
            prev.bills_count > 0
              ? `ai achitat *${prev.total_paid}* (${prev.bills_count} facturi/plăți, rating *${prev.efficiency_score}/100 — ${prev.grade}*).`
              : 'nu am încă facturi înregistrate în sistem, așa că luna aceasta este punctul tău de start!'
          }`,
        ];
        if (review.recommend_savings_or_investment && review.saved_vs_previous_month) {
          lines.push(
            '',
            `💡 *Pont economii / investiții:* Ai plătit cu *${review.saved_vs_previous_month}* mai puțin decât luna trecută! Merită să muți diferența în contul de economii sau investiții (*${review.annualized_savings_potential}/an* în ritmul ăsta). 🚀`,
          );
        }
        lines.push('', `🏦 *Sold curent (Demo):* *${review.sold_curent_demo ?? '0,00 RON'}*`);
        return { toolCallsUsed, replyText: lines.join('\n') };
      }
    }

    // 5. Financial status / Bill query / History (default grounded summary)
    toolCallsUsed.push('get_financial_status_summary', 'query_bills_and_payments');
    const summary = (await input.toolExecutor.execute(
      'get_financial_status_summary',
      { period: 'ALL_TIME' },
      input.toolCtx,
    )) as {
      total_unpaid_formatted_ron: string;
      total_paid_formatted_ron: string;
      unpaid_invoices_count: number;
      unpaid_whatsapp_payments_count: number;
      held_anomaly_count: number;
      overdue_count: number;
    };

    const details = (await input.toolExecutor.execute(
      'query_bills_and_payments',
      { status: 'UNPAID' },
      input.toolCtx,
    )) as {
      invoices: Array<{
        id: number;
        provider_name: string;
        amount_formatted: string;
        due_date: string;
        payment_status: string;
      }>;
      whatsapp_payments: Array<{
        id: number;
        title: string;
        payee_name: string;
        amount_formatted: string;
        due_date: string | null;
      }>;
    };

    const lines: string[] = [
      '💼 *Situația ta financiară (din baza de date):*',
      `• Total neachitat: *${summary.total_unpaid_formatted_ron}* (${summary.unpaid_invoices_count} facturi + ${summary.unpaid_whatsapp_payments_count} plăți WhatsApp)`,
      `• Total achitat: *${summary.total_paid_formatted_ron}*`,
      `• Facturi blocate (anomalii critice): *${summary.held_anomaly_count}* | Restante: *${summary.overdue_count}*`,
    ];

    if (details.invoices.length > 0) {
      lines.push('', '*Facturi neplătite:*');
      for (const inv of details.invoices) {
        lines.push(
          `• #${inv.id} *${inv.provider_name}* — ${inv.amount_formatted} (scadență ${inv.due_date}, ${inv.payment_status})`,
        );
      }
    }

    if (details.whatsapp_payments.length > 0) {
      lines.push('', '*Plăți WhatsApp neachitate:*');
      for (const p of details.whatsapp_payments) {
        lines.push(
          `• #${p.id} *${p.title}* (${p.payee_name}) — ${p.amount_formatted}${p.due_date ? ` (scadență ${p.due_date})` : ''}`,
        );
      }
    }

    if (details.invoices.length === 0 && details.whatsapp_payments.length === 0) {
      lines.push('', '✅ Nu mai ai nicio factură sau plată neachitată.');
    }

    return {
      toolCallsUsed,
      replyText: lines.join('\n'),
    };
  }
}

export interface TwinServiceDeps {
  guardrail: FinancialGuardrail;
  generator: TwinGenerator;
  toolExecutor: FinancialToolExecutor;
  memoryService: FinancialMemoryService;
  twinChatRepo: TwinChatRepository;
  qrTrackingService: QrTrackingService;
  logger?: Logger;
}

export interface TwinHandleResult {
  reply: string;
  wasBlocked: boolean;
  intent: TwinIntent;
  layerBlocked: 1 | 2 | null;
  toolCallsUsed: string[];
  sentQrCount: number;
}

export class TwinService {
  constructor(private readonly deps: TwinServiceDeps) {}

  async handleMessage(
    ownerJid: string,
    text: string,
    now: Date = new Date(),
  ): Promise<TwinHandleResult> {
    // Layers 1 + 2: Hard domain guardrail
    const decision = await this.deps.guardrail.evaluate(text);
    this.deps.logger?.info(
      {
        ownerJid,
        allowed: decision.allowed,
        intent: decision.intent,
        confidence: decision.confidence,
        layerBlocked: decision.layerBlocked,
      },
      'AI Twin guardrail evaluated incoming message.',
    );

    if (!decision.allowed) {
      const refusal = decision.refusalMessage!;
      await this.deps.twinChatRepo.append({
        ownerJid,
        role: 'USER',
        content: text,
        classifiedIntent: decision.intent,
        wasBlocked: true,
      });
      await this.deps.twinChatRepo.append({
        ownerJid,
        role: 'ASSISTANT',
        content: refusal,
        classifiedIntent: decision.intent,
        wasBlocked: true,
      });

      return {
        reply: refusal,
        wasBlocked: true,
        intent: decision.intent,
        layerBlocked: decision.layerBlocked,
        toolCallsUsed: [],
        sentQrCount: 0,
      };
    }

    // Layer 3: Tool-grounded Financial Twin Generator
    const [recentHistory, recentMemory] = await Promise.all([
      this.deps.twinChatRepo.findRecentAllowed(ownerJid, 10),
      this.deps.memoryService.getRecentTimeline(ownerJid, { limit: 15 }),
    ]);

    const toolCtx: ToolExecutionContext = {
      ownerJid,
      sourceMessageText: text,
      now,
      queuedQrSends: [],
    };

    const generatorInput: TwinGeneratorInput = {
      userMessage: text,
      intent: decision.intent,
      detectedLanguage: decision.detectedLanguage,
      hasMixedOffTopic: decision.hasMixedOffTopic,
      recentHistory,
      recentMemory,
      toolExecutor: this.deps.toolExecutor,
      toolCtx,
    };

    let generated: TwinGeneratorOutput;
    try {
      generated = await this.deps.generator.generate(generatorInput);
      this.deps.logger?.info(
        { ownerJid, intent: decision.intent, toolCallsUsed: generated.toolCallsUsed },
        'AI Twin generated response via primary LLM generator.',
      );
    } catch (err) {
      this.deps.logger?.warn(
        { err, ownerJid, intent: decision.intent },
        'Primary Gemini AI Twin generator failed; falling back to DB-grounded generator.',
      );
      if (isTransientOrQuotaGeminiError(err)) {
        const fallbackGen = new DeterministicTwinGenerator();
        generated = await fallbackGen.generate(generatorInput);
      } else {
        throw err;
      }
    }

    let finalReply = generated.replyText.trim();
    if (decision.hasMixedOffTopic) {
      const normReply = normalizeDiacritics(finalReply).toLowerCase();
      const alreadyRefusesOffTopic =
        normReply.includes('nu pot raspunde') ||
        normReply.includes('cannot answer') ||
        normReply.includes('exclusiv');
      if (!alreadyRefusesOffTopic) {
        finalReply = `${finalReply}\n\n${getMixedRefusalSuffix(decision.detectedLanguage)}`;
      }
    }

    await this.deps.twinChatRepo.append({
      ownerJid,
      role: 'USER',
      content: text,
      classifiedIntent: decision.intent,
      wasBlocked: false,
      toolCallsUsed: [],
    });
    await this.deps.twinChatRepo.append({
      ownerJid,
      role: 'ASSISTANT',
      content: finalReply,
      classifiedIntent: decision.intent,
      wasBlocked: false,
      toolCallsUsed: generated.toolCallsUsed,
    });

    for (const qr of toolCtx.queuedQrSends) {
      await this.deps.qrTrackingService.sendQrToWhatsApp(qr);
    }

    return {
      reply: finalReply,
      wasBlocked: false,
      intent: decision.intent,
      layerBlocked: null,
      toolCallsUsed: generated.toolCallsUsed,
      sentQrCount: toolCtx.queuedQrSends.length,
    };
  }
}

export { formatCentsRo };
