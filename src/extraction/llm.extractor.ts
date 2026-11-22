import { GoogleGenAI } from '@google/genai';
import {
  callGeminiWithModelFallback,
  DEFAULT_GEMINI_PRIMARY_MODEL,
} from '../config/gemini.models.js';
import {
  CanonicalInvoiceSchema,
  GEMINI_INVOICE_RESPONSE_SCHEMA,
  type CanonicalInvoice,
} from './schema.js';

export interface InvoiceExtractor {
  extractFromText(filteredInvoiceText: string): Promise<CanonicalInvoice>;
}

export const ROMANIAN_INVOICE_SYSTEM_PROMPT = `You are a strict structured data extractor for Romanian utility (electricity, natural gas, water) and telecom invoices.

CRITICAL EXTRACTION RULES:
1. Extract ONLY factual values present in the invoice text. Do NOT compute deltas, audit anomalies, or speculate.
2. Romanian number formatting:
   - In Romanian invoices, dot (.) is a thousands separator and comma (,) is the decimal separator (e.g. "1.234,56" -> 1234.56; "1.200 kWh" -> 1200, NEVER 1.2; "0,283820" -> 0.28382).
   - Output all numbers in standard JSON decimal format with a dot decimal separator.
3. Dates:
   - Convert all Romanian dates ("25.03.2026" or "25/03/2026") to strict ISO format "YYYY-MM-DD".
4. Line items separation:
   - Separate EVERY individual billing line item cleanly.
   - NEVER merge BASE_SUBSCRIPTION and DISCOUNT into a single line. Keep discounts as separate line items with line_type="DISCOUNT" and negative line_total_gross (e.g. -20.00).
   - Keep late payment fees/interest as line_type="PENALTY".
   - Preserve negative quantities and negative line_total_gross values on storno / regularization lines — NEVER flip their sign.
5. Consumption point & CUI:
   - Normalize provider_cui without spaces (e.g. "RO13267213").
   - Set consumption_point_id to POD (electricity), CLC/NLC (gas), or contract/client/phone identifier (telecom).
6. Meter reading & self-reading window:
   - Set reading_type to SELF_READ, OPERATOR_READ, ESTIMATED, REGULARIZATION, or N_A (for telecom).
   - If the invoice prints a self-reading transmission window (e.g. "perioada transmitere index autocitit: 24-28" or "între 18 și 25 ale lunii"), extract self_reading_window_start=24 and self_reading_window_end=28; otherwise null.
   - Normalize consumption_unit to "kWh", "mc", or "MWh" when applicable.
7. Output strictly valid JSON adhering to the provided schema.`;

export class GeminiInvoiceExtractor implements InvoiceExtractor {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(apiKey: string, model = DEFAULT_GEMINI_PRIMARY_MODEL) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async extractFromText(filteredInvoiceText: string): Promise<CanonicalInvoice> {
    const { result: response } = await callGeminiWithModelFallback({
      preferredModel: this.model,
      timeoutMs: 25_000,
      label: 'Invoice Extractor',
      invoke: (model) =>
        this.ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Extract the canonical structured invoice data from the following Romanian invoice text:\n\n${filteredInvoiceText}`,
                },
              ],
            },
          ],
          config: {
            systemInstruction: ROMANIAN_INVOICE_SYSTEM_PROMPT,
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_INVOICE_RESPONSE_SCHEMA,
          },
        }),
    });

    const rawText = response?.text?.trim();
    if (!rawText) {
      throw new Error('Gemini returned an empty response during invoice extraction');
    }

    const cleanedJson = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(cleanedJson);
    } catch (err) {
      throw new Error(
        `Gemini returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return CanonicalInvoiceSchema.parse(parsedJson);
  }
}
