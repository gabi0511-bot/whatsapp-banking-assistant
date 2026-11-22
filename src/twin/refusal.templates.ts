import { normalizeDiacritics } from '../extraction/schema.js';

export type TwinLanguage = 'ro' | 'en';

export const REFUSAL_RO =
  'Sunt AI Twin-ul tău financiar și pot discuta exclusiv despre situația ta financiară, facturile din Invoice X-Ray, plățile înregistrate pe WhatsApp, codurile QR și statusul plăților. Nu pot răspunde la alte subiecte. Întreabă-mă, de exemplu, cât ai de plată luna aceasta, ce facturi sunt neachitate sau dacă ai accesat un cod QR.';

export const REFUSAL_EN =
  'I am your financial AI Twin and can strictly only discuss your financial status, Invoice X-Ray bills, payments tracked on WhatsApp, payment QR codes, and payment reminders. I cannot chat about other topics.';

export const MIXED_REFUSAL_SUFFIX_RO =
  'Notă: Am răspuns strict la partea financiară — nu pot răspunde la solicitările care nu țin de situația ta financiară, facturi sau plăți.';

export const MIXED_REFUSAL_SUFFIX_EN =
  'Note: I only answered the financial part — I cannot answer requests outside your financial status, bills, or payments.';

export function getFixedRefusal(lang: TwinLanguage): string {
  return lang === 'en' ? REFUSAL_EN : REFUSAL_RO;
}

export function getMixedRefusalSuffix(lang: TwinLanguage): string {
  return lang === 'en' ? MIXED_REFUSAL_SUFFIX_EN : MIXED_REFUSAL_SUFFIX_RO;
}

const ENGLISH_HINTS = [
  'what',
  'how much',
  'tell me',
  'ignore',
  'pretend',
  'act as',
  'write a',
  'weather',
  'recipe',
  'joke',
  'story',
  'my bills',
  'unpaid',
  'invoice',
  'payment',
  'system prompt',
  'movies',
  'code',
];

const ROMANIAN_HINTS = [
  'factura',
  'facturi',
  'plata',
  'plati',
  'platit',
  'achitat',
  'chirie',
  'chiria',
  'cat ',
  'care este',
  'zi-mi',
  'spune-mi',
  'scrie-mi',
  'da-mi',
  'arata-mi',
  'explica-mi',
  'ignora',
  'prefa-te',
  'vremea',
  'reteta',
  'gluma',
  'meciul',
  'luna asta',
  'tine minte',
  'situatia',
];

export function detectMessageLanguage(text: string): TwinLanguage {
  const norm = normalizeDiacritics(text).toLowerCase();
  if (/[ăâîșțĂÂÎȘȚ]/.test(text)) {
    return 'ro';
  }
  let roScore = 0;
  let enScore = 0;
  for (const h of ROMANIAN_HINTS) {
    if (norm.includes(h)) roScore += 1;
  }
  for (const h of ENGLISH_HINTS) {
    if (norm.includes(h)) enScore += 1;
  }
  return enScore > roScore ? 'en' : 'ro';
}
