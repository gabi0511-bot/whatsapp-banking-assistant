import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { normalizeDiacritics } from '../extraction/schema.js';

const RELEVANT_PAGE_SIGNALS = [
  'kwh',
  'mwh',
  'mc',
  'm3',
  'index',
  'estimat',
  'citire',
  'autocitire',
  'tarif',
  'pret',
  'tva',
  'scaden',
  'pod',
  'clc',
  'abonament',
  'reducere',
  'discount',
  'penalit',
  'regulariz',
  'total de plata',
  'cod client',
] as const;

export interface ParsedPdfResult {
  pageCount: number;
  keptPageNumbers: number[];
  filteredText: string;
  fullRawText: string;
}

export function cleanPdfPageText(raw: string): string {
  return raw
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isRelevantInvoicePage(pageText: string): boolean {
  const normalized = normalizeDiacritics(pageText).toLowerCase();
  return RELEVANT_PAGE_SIGNALS.some((signal) => {
    if (signal === 'mc' || signal === 'm3' || signal === 'pod' || signal === 'clc' || signal === 'tva') {
      return new RegExp(`\\b${signal}\\b`, 'i').test(normalized);
    }
    return normalized.includes(signal);
  });
}

export function filterRelevantPages(pages: string[]): ParsedPdfResult {
  const cleanedPages = pages.map(cleanPdfPageText);
  const keptPageNumbers: number[] = [];
  const keptTexts: string[] = [];

  cleanedPages.forEach((pageText, index) => {
    if (pageText.length === 0) {
      return;
    }
    if (isRelevantInvoicePage(pageText)) {
      keptPageNumbers.push(index + 1);
      keptTexts.push(`--- PAGE ${index + 1} ---\n${pageText}`);
    }
  });

  // Fallback: if no page matched signals, keep all non-empty pages so we never send empty text to LLM.
  const effectiveFiltered =
    keptTexts.length > 0
      ? keptTexts.join('\n\n')
      : cleanedPages
          .map((t, idx) => (t ? `--- PAGE ${idx + 1} ---\n${t}` : ''))
          .filter(Boolean)
          .join('\n\n');

  const fullRawText = cleanedPages.filter(Boolean).join('\n\n');

  return {
    pageCount: pages.length,
    keptPageNumbers:
      keptPageNumbers.length > 0
        ? keptPageNumbers
        : cleanedPages.map((_, idx) => idx + 1),
    filteredText: effectiveFiltered,
    fullRawText,
  };
}

export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<ParsedPdfResult> {
  const data = new Uint8Array(buffer);
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  });

  const pdfDoc = await loadingTask.promise;
  const pages: string[] = [];

  try {
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      let currentLine = '';
      const lines: string[] = [];

      for (const item of textContent.items) {
        if (!('str' in item)) {
          continue;
        }
        const chunk = item.str;
        currentLine += chunk;
        if ('hasEOL' in item && item.hasEOL) {
          lines.push(currentLine);
          currentLine = '';
        } else if (chunk.length > 0 && !chunk.endsWith(' ')) {
          currentLine += ' ';
        }
      }
      if (currentLine.trim().length > 0) {
        lines.push(currentLine);
      }
      pages.push(lines.join('\n'));
    }
  } finally {
    await pdfDoc.destroy();
  }

  return filterRelevantPages(pages);
}
