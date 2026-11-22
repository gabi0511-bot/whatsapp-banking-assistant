import type { Logger } from 'pino';

/**
 * Ordered pool of verified Gemini Flash models.
 * When one model experiences a 429 quota limit or 503 high-demand spike,
 * callers immediately rotate to the next healthy model instead of failing
 * or dropping into rigid non-AI fallback templates.
 */
export const DEFAULT_GEMINI_MODEL_CHAIN = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
] as const;

export const DEFAULT_GEMINI_PRIMARY_MODEL: string = DEFAULT_GEMINI_MODEL_CHAIN[0];

const modelCooldownUntil = new Map<string, number>();

export function resetGeminiModelCooldowns(): void {
  modelCooldownUntil.clear();
}

export function isQuotaGeminiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  if (status === 429) return true;
  const msg = String((err as { message?: string }).message ?? '');
  return /\b(429|RESOURCE_EXHAUSTED|quota|rate[- ]limit)\b/i.test(msg);
}

export function isTransientOrQuotaGeminiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (isQuotaGeminiError(err)) return true;
  const status = (err as { status?: number }).status;
  if (status === 503 || status === 500 || status === 504 || status === 404) return true;
  const name = String((err as { name?: string }).name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const msg = String((err as { message?: string }).message ?? '');
  return /\b(503|500|504|404|UNAVAILABLE|high demand|timed out|timeout|no longer available)\b/i.test(
    msg,
  );
}

export function buildGeminiModelCandidates(preferredModel?: string): string[] {
  const ordered: string[] = [];
  if (preferredModel) {
    ordered.push(preferredModel);
  }
  for (const m of DEFAULT_GEMINI_MODEL_CHAIN) {
    if (!ordered.includes(m)) {
      ordered.push(m);
    }
  }

  const now = Date.now();
  const ready = ordered.filter((m) => (modelCooldownUntil.get(m) ?? 0) <= now);
  return ready.length > 0 ? ready : ordered;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${timeoutMs}ms`);
          err.name = 'TimeoutError';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function callGeminiWithModelFallback<T>(params: {
  preferredModel?: string;
  timeoutMs?: number;
  label?: string;
  logger?: Logger;
  invoke: (model: string) => Promise<T>;
}): Promise<{ result: T; modelUsed: string }> {
  const candidates = buildGeminiModelCandidates(params.preferredModel);
  const timeoutMs = params.timeoutMs ?? 20_000;
  const label = params.label ?? 'Gemini API';

  let lastErr: unknown;

  for (let idx = 0; idx < candidates.length; idx++) {
    const model = candidates[idx]!;
    try {
      const result = await withTimeout(params.invoke(model), timeoutMs, `${label} (${model})`);
      modelCooldownUntil.delete(model);
      return { result, modelUsed: model };
    } catch (err) {
      lastErr = err;
      if (!isTransientOrQuotaGeminiError(err)) {
        throw err;
      }

      const cooldownMs = isQuotaGeminiError(err) ? 5 * 60_000 : 45_000;
      modelCooldownUntil.set(model, Date.now() + cooldownMs);

      params.logger?.warn(
        {
          failedModel: model,
          nextModel: candidates[idx + 1] ?? null,
          cooldownSec: Math.round(cooldownMs / 1000),
          status: (err as { status?: number }).status,
        },
        `${label} model unavailable/rate-limited; rotating to next Gemini Flash model.`,
      );

      if (idx < candidates.length - 1 && !isQuotaGeminiError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  throw lastErr;
}
