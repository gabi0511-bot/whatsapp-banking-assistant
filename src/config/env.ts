import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const DEFAULT_GMAIL_SEARCH_QUERY =
  'has:attachment (filename:pdf OR filename:xml) (factura OR factură OR invoice OR hidroelectrica OR eon OR engie OR ppc OR electrica OR digi OR orange OR vodafone) newer_than:14d';

const DEFAULT_GMAIL_FREE_TRIAL_QUERY =
  '("free trial" OR "perioada de proba" OR "perioadă de probă" OR "perioada gratuita" OR "perioadă gratuită" OR "reinnoire automata" OR "reînnoire automată" OR "auto-renew" OR "trial ends" OR "trial period" OR "nu vei fi taxat" OR "vei fi taxat" OR "you will be charged" OR "prima luna gratuita" OR "zile gratuit" OR "days free" OR "abonament anulat" OR "has been cancelled" OR "trial has started") -from:notifications@github.com newer_than:14d';

const DEFAULT_GMAIL_SUBSCRIPTION_RECEIPT_QUERY =
  '(("receipt" OR "chitanta" OR "chitanță" OR "billing" OR "plata recurenta" OR "reînnoire" OR "reinnoire" OR "monthly plan" OR "plan lunar") ("netflix" OR "spotify" OR "icloud" OR "google one" OR "youtube premium" OR "disney" OR "adobe" OR "openai" OR "chatgpt" OR "claude" OR "canva" OR "world class" OR "hbo" OR "skyshowtime" OR "voyo" OR "microsoft 365" OR "dropbox" OR "notion")) -from:notifications@github.com newer_than:30d';

const BooleanFlagSchema = z
  .union([z.boolean(), z.string()])
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    const norm = val.trim().toLowerCase();
    return norm === 'true' || norm === '1' || norm === 'yes';
  });

const OptionalTrimmedString = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GMAIL_CLIENT_ID: z.string().min(1, 'GMAIL_CLIENT_ID is required'),
  GMAIL_CLIENT_SECRET: z.string().min(1, 'GMAIL_CLIENT_SECRET is required'),
  GMAIL_REFRESH_TOKEN: z.string().min(1, 'GMAIL_REFRESH_TOKEN is required'),
  GMAIL_SEARCH_QUERY: z.string().default(DEFAULT_GMAIL_SEARCH_QUERY),
  USER_FULL_NAME: z.string().min(1).default('Utilizator Invoice X-Ray'),
  OWNER_WHATSAPP_JID: z
    .string()
    .min(1, 'OWNER_WHATSAPP_JID is required (e.g. 40712345678@s.whatsapp.net)'),
  CRON_GMAIL_POLL: z.string().default('*/15 * * * *'),
  CRON_REMINDER_DISPATCH: z.string().default('*/15 * * * *'),
  CRON_PAYMENT_REMINDERS: z.string().default('*/15 * * * *'),
  GMAIL_FREE_TRIAL_QUERY: z.string().default(DEFAULT_GMAIL_FREE_TRIAL_QUERY),
  GMAIL_SUBSCRIPTION_RECEIPT_QUERY: z.string().default(DEFAULT_GMAIL_SUBSCRIPTION_RECEIPT_QUERY),
  CRON_SUBSCRIPTION_GMAIL_POLL: z.string().default('*/2 * * * *'),
  CRON_FREE_TRIAL_ALERTS: z.string().default('*/2 * * * *'),
  CRON_MONTHLY_REVIEW: z.string().default('0 20 28-31 * *'),
  ZOMBIE_MICRO_THRESHOLD_RON: z.coerce.number().positive().default(100),
  ZOMBIE_MIN_UNCONFIRMED_CHARGES: z.coerce.number().int().min(1).default(3),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:3080')
    .transform((u) => u.replace(/\/+$/, '')),
  TRACKING_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3080),
  AUTO_SEND_PAYMENT_QR: BooleanFlagSchema.default(true),
  QR_UNACCESSED_REMINDER_HOURS: z.coerce.number().positive().default(24),
  QR_ABANDONED_REMINDER_MINUTES: z.coerce.number().positive().default(120),
  OWNER_REVOLUT_TAG: OptionalTrimmedString,
  BAILEYS_AUTH_DIR: z.string().default('.baileys_auth'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

export const PartialEnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_SEARCH_QUERY: z.string().default(DEFAULT_GMAIL_SEARCH_QUERY),
  USER_FULL_NAME: z.string().default('Ion Popescu'),
  OWNER_WHATSAPP_JID: z.string().default('40712345678@s.whatsapp.net'),
  CRON_GMAIL_POLL: z.string().default('*/15 * * * *'),
  CRON_REMINDER_DISPATCH: z.string().default('*/15 * * * *'),
  CRON_PAYMENT_REMINDERS: z.string().default('*/15 * * * *'),
  GMAIL_FREE_TRIAL_QUERY: z.string().default(DEFAULT_GMAIL_FREE_TRIAL_QUERY),
  GMAIL_SUBSCRIPTION_RECEIPT_QUERY: z.string().default(DEFAULT_GMAIL_SUBSCRIPTION_RECEIPT_QUERY),
  CRON_SUBSCRIPTION_GMAIL_POLL: z.string().default('*/2 * * * *'),
  CRON_FREE_TRIAL_ALERTS: z.string().default('*/2 * * * *'),
  CRON_MONTHLY_REVIEW: z.string().default('0 20 28-31 * *'),
  ZOMBIE_MICRO_THRESHOLD_RON: z.coerce.number().positive().default(100),
  ZOMBIE_MIN_UNCONFIRMED_CHARGES: z.coerce.number().int().min(1).default(3),
  PUBLIC_BASE_URL: z
    .string()
    .default('http://localhost:3080')
    .transform((u) => u.replace(/\/+$/, '')),
  TRACKING_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3080),
  AUTO_SEND_PAYMENT_QR: BooleanFlagSchema.default(true),
  QR_UNACCESSED_REMINDER_HOURS: z.coerce.number().positive().default(24),
  QR_ABANDONED_REMINDER_MINUTES: z.coerce.number().positive().default(120),
  OWNER_REVOLUT_TAG: OptionalTrimmedString,
  BAILEYS_AUTH_DIR: z.string().default('.baileys_auth'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type PartialAppEnv = z.infer<typeof PartialEnvSchema>;

export function loadPartialEnv(
  source: Record<string, string | undefined> = process.env,
): PartialAppEnv {
  return PartialEnvSchema.parse(source);
}
