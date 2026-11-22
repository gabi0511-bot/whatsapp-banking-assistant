import { normalizeDiacritics } from '../extraction/schema.js';
import type { SubscriptionCategory } from './types.js';

export interface NormalizedMerchant {
  normalizedMerchant: string;
  displayName: string;
  category: SubscriptionCategory;
}

interface KnownMerchantRule {
  pattern: RegExp;
  normalizedMerchant: string;
  displayName: string;
  category: SubscriptionCategory;
}

const KNOWN_MERCHANT_RULES: KnownMerchantRule[] = [
  // STREAMING
  { pattern: /\bnetflix\b/i, normalizedMerchant: 'netflix', displayName: 'Netflix', category: 'STREAMING' },
  { pattern: /\b(hbo\s*max|max\.com|\bmax\b.*stream)/i, normalizedMerchant: 'hbo_max', displayName: 'Max (HBO)', category: 'STREAMING' },
  { pattern: /\bdisney\s*\+?\s*(plus)?\b/i, normalizedMerchant: 'disney_plus', displayName: 'Disney+', category: 'STREAMING' },
  { pattern: /\byoutube\s*premium\b/i, normalizedMerchant: 'youtube_premium', displayName: 'YouTube Premium', category: 'STREAMING' },
  { pattern: /\bamazon\s*prime\b|\bprime\s*video\b/i, normalizedMerchant: 'amazon_prime', displayName: 'Amazon Prime', category: 'STREAMING' },
  { pattern: /\bvoyo\b/i, normalizedMerchant: 'voyo', displayName: 'Voyo', category: 'STREAMING' },
  { pattern: /\bskyshowtime\b/i, normalizedMerchant: 'skyshowtime', displayName: 'SkyShowtime', category: 'STREAMING' },
  { pattern: /\bapple\s*tv\b/i, normalizedMerchant: 'apple_tv', displayName: 'Apple TV+', category: 'STREAMING' },

  // MUSIC
  { pattern: /\bspotify\b/i, normalizedMerchant: 'spotify', displayName: 'Spotify', category: 'MUSIC' },
  { pattern: /\bapple\s*music\b/i, normalizedMerchant: 'apple_music', displayName: 'Apple Music', category: 'MUSIC' },
  { pattern: /\btidal\b/i, normalizedMerchant: 'tidal', displayName: 'Tidal', category: 'MUSIC' },
  { pattern: /\bdeezer\b/i, normalizedMerchant: 'deezer', displayName: 'Deezer', category: 'MUSIC' },

  // CLOUD
  { pattern: /\bicloud\b/i, normalizedMerchant: 'apple_icloud', displayName: 'Apple iCloud+', category: 'CLOUD' },
  { pattern: /\bgoogle\s*one\b|\bgoogle\s*storage\b/i, normalizedMerchant: 'google_one', displayName: 'Google One', category: 'CLOUD' },
  { pattern: /\bdropbox\b/i, normalizedMerchant: 'dropbox', displayName: 'Dropbox', category: 'CLOUD' },
  { pattern: /\bonedrive\b/i, normalizedMerchant: 'onedrive', displayName: 'OneDrive', category: 'CLOUD' },

  // SOFTWARE_AI
  { pattern: /\badobe\b/i, normalizedMerchant: 'adobe_cc', displayName: 'Adobe Creative Cloud', category: 'SOFTWARE_AI' },
  { pattern: /\bopenai\b|\bchatgpt\b/i, normalizedMerchant: 'chatgpt_plus', displayName: 'ChatGPT Plus', category: 'SOFTWARE_AI' },
  { pattern: /\banthropic\b|\bclaude\b/i, normalizedMerchant: 'claude_pro', displayName: 'Claude Pro', category: 'SOFTWARE_AI' },
  { pattern: /\bmicrosoft\s*365\b|\boffice\s*365\b/i, normalizedMerchant: 'microsoft_365', displayName: 'Microsoft 365', category: 'SOFTWARE_AI' },
  { pattern: /\bnotion\b/i, normalizedMerchant: 'notion', displayName: 'Notion', category: 'SOFTWARE_AI' },
  { pattern: /\bcanva\b/i, normalizedMerchant: 'canva', displayName: 'Canva Pro', category: 'SOFTWARE_AI' },
  { pattern: /\bgithub\b/i, normalizedMerchant: 'github', displayName: 'GitHub', category: 'SOFTWARE_AI' },
  { pattern: /\bcursor\b/i, normalizedMerchant: 'cursor', displayName: 'Cursor', category: 'SOFTWARE_AI' },
  { pattern: /\bfigma\b/i, normalizedMerchant: 'figma', displayName: 'Figma', category: 'SOFTWARE_AI' },
  { pattern: /\bgrammarly\b/i, normalizedMerchant: 'grammarly', displayName: 'Grammarly', category: 'SOFTWARE_AI' },
  { pattern: /\blinkedin\s*premium\b/i, normalizedMerchant: 'linkedin_premium', displayName: 'LinkedIn Premium', category: 'SOFTWARE_AI' },

  // FITNESS
  { pattern: /\bworld\s*class\b/i, normalizedMerchant: 'world_class', displayName: 'World Class', category: 'FITNESS' },
  { pattern: /\b7\s*card\b/i, normalizedMerchant: '7card', displayName: '7card', category: 'FITNESS' },
  { pattern: /\besx\b/i, normalizedMerchant: 'esx', displayName: 'ESX', category: 'FITNESS' },
  { pattern: /\bstay\s*fit\b/i, normalizedMerchant: 'stay_fit', displayName: 'Stay Fit', category: 'FITNESS' },
  { pattern: /\bsmart\s*fit\b/i, normalizedMerchant: 'smartfit', displayName: 'Smartfit', category: 'FITNESS' },

  // GAMING
  { pattern: /\bplaystation\b|\bps\s*plus\b/i, normalizedMerchant: 'playstation_plus', displayName: 'PlayStation Plus', category: 'GAMING' },
  { pattern: /\bxbox\b|\bgame\s*pass\b/i, normalizedMerchant: 'xbox_game_pass', displayName: 'Xbox Game Pass', category: 'GAMING' },
  { pattern: /\bnintendo\b/i, normalizedMerchant: 'nintendo_online', displayName: 'Nintendo Online', category: 'GAMING' },
  { pattern: /\bdiscord\b/i, normalizedMerchant: 'discord_nitro', displayName: 'Discord Nitro', category: 'GAMING' },

  // NEWS
  { pattern: /\bnew\s*york\s*times\b|\bnytimes\b/i, normalizedMerchant: 'nytimes', displayName: 'The New York Times', category: 'NEWS' },
  { pattern: /\bmedium\b/i, normalizedMerchant: 'medium', displayName: 'Medium', category: 'NEWS' },
  { pattern: /\bsubstack\b/i, normalizedMerchant: 'substack', displayName: 'Substack', category: 'NEWS' },
];

export function normalizeMerchantDescriptor(
  rawDescriptor: string,
  explicitCategory?: SubscriptionCategory,
): NormalizedMerchant {
  const cleanedRaw = rawDescriptor.trim();
  const ascii = normalizeDiacritics(cleanedRaw);

  for (const rule of KNOWN_MERCHANT_RULES) {
    if (rule.pattern.test(ascii)) {
      return {
        normalizedMerchant: rule.normalizedMerchant,
        displayName: rule.displayName,
        category: explicitCategory && explicitCategory !== 'OTHER' ? explicitCategory : rule.category,
      };
    }
  }

  // Generic cleanup: remove asterisk codes (SPOTIFY*P231AB), URLs, legal suffixes, random digits
  let stripped = ascii
    .replace(/\*[A-Za-z0-9_-]+/g, ' ')
    .replace(/\.(com|ro|net|org|io|eu|co)\b/gi, ' ')
    .replace(/\b(bill|billing|payment|subscription|recurring|romania|srl|s\.r\.l\.|sa|s\.a\.|ab|inc|ltd|llc|gmbh|bv|ireland|europe)\b/gi, ' ')
    .replace(/[#/_-]+/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) {
    stripped = ascii.replace(/[^A-Za-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown';
  }

  const normalizedMerchant = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';

  const displayName = stripped
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  return {
    normalizedMerchant,
    displayName,
    category: explicitCategory ?? 'OTHER',
  };
}
