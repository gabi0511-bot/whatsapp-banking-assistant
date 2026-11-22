import { describe, expect, it } from 'vitest';
import { normalizeMerchantDescriptor } from '../src/subscriptions/merchant.normalizer.js';

describe('merchant.normalizer', () => {
  it('normalizes messy billing descriptors to canonical merchant keys, display names, and categories', () => {
    expect(normalizeMerchantDescriptor('SPOTIFY*P231AB')).toEqual({
      normalizedMerchant: 'spotify',
      displayName: 'Spotify',
      category: 'MUSIC',
    });
    expect(normalizeMerchantDescriptor('Spotify AB')).toEqual({
      normalizedMerchant: 'spotify',
      displayName: 'Spotify',
      category: 'MUSIC',
    });
    expect(normalizeMerchantDescriptor('NETFLIX.COM*88392')).toEqual({
      normalizedMerchant: 'netflix',
      displayName: 'Netflix',
      category: 'STREAMING',
    });
    expect(normalizeMerchantDescriptor('APPLE.COM/BILL ICLOUD')).toEqual({
      normalizedMerchant: 'apple_icloud',
      displayName: 'Apple iCloud+',
      category: 'CLOUD',
    });
    expect(normalizeMerchantDescriptor('GOOGLE *YOUTUBE PREMIUM')).toEqual({
      normalizedMerchant: 'youtube_premium',
      displayName: 'YouTube Premium',
      category: 'STREAMING',
    });
    expect(normalizeMerchantDescriptor('ADOBE *CREATIVE CLOUD')).toEqual({
      normalizedMerchant: 'adobe_cc',
      displayName: 'Adobe Creative Cloud',
      category: 'SOFTWARE_AI',
    });
    expect(normalizeMerchantDescriptor('WORLD CLASS ROMANIA SRL')).toEqual({
      normalizedMerchant: 'world_class',
      displayName: 'World Class',
      category: 'FITNESS',
    });
    expect(normalizeMerchantDescriptor('OPENAI *CHATGPT PLUS')).toEqual({
      normalizedMerchant: 'chatgpt_plus',
      displayName: 'ChatGPT Plus',
      category: 'SOFTWARE_AI',
    });
  });

  it('cleans unknown merchants safely without colliding on random reference codes', () => {
    const a = normalizeMerchantDescriptor('ACME APP*99281 SRL');
    const b = normalizeMerchantDescriptor('ACME APP*11022');
    expect(a.normalizedMerchant).toBe(b.normalizedMerchant);
    expect(a.category).toBe('OTHER');
  });
});
