import { beforeEach, describe, expect, it } from 'vitest';
import {
  callGeminiWithModelFallback,
  DEFAULT_GEMINI_MODEL_CHAIN,
  resetGeminiModelCooldowns,
} from '../src/config/gemini.models.js';

describe('Gemini multi-model fallback & cooldown rotation', () => {
  beforeEach(() => {
    resetGeminiModelCooldowns();
  });

  it('rotates immediately to the next healthy Gemini model when the primary returns 429 or 503', async () => {
    const tried: string[] = [];
    const { result, modelUsed } = await callGeminiWithModelFallback({
      preferredModel: 'gemini-3.8-flash',
      invoke: async (model) => {
        tried.push(model);
        if (model === 'gemini-3.8-flash') {
          const err = new Error('You exceeded your current quota') as Error & { status?: number };
          err.status = 429;
          throw err;
        }
        if (model === DEFAULT_GEMINI_MODEL_CHAIN[0]) {
          const err = new Error('503 UNAVAILABLE high demand') as Error & { status?: number };
          err.status = 503;
          throw err;
        }
        return `ok-from-${model}`;
      },
    });

    expect(tried[0]).toBe('gemini-3.8-flash');
    expect(tried[1]).toBe(DEFAULT_GEMINI_MODEL_CHAIN[0]);
    expect(modelUsed).toBe(DEFAULT_GEMINI_MODEL_CHAIN[1]);
    expect(result).toBe(`ok-from-${DEFAULT_GEMINI_MODEL_CHAIN[1]}`);

    // Subsequent call skips the cooled-down 429/503 models immediately!
    const triedSecond: string[] = [];
    const second = await callGeminiWithModelFallback({
      preferredModel: 'gemini-3.8-flash',
      invoke: async (model) => {
        triedSecond.push(model);
        return `fast-${model}`;
      },
    });
    expect(triedSecond).toEqual([DEFAULT_GEMINI_MODEL_CHAIN[1]]);
    expect(second.modelUsed).toBe(DEFAULT_GEMINI_MODEL_CHAIN[1]);
  });
});
