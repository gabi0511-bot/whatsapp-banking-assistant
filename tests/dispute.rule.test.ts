import { describe, expect, it } from 'vitest';
import {
  buildDisputeDraft,
  buildRfc2822RawEmail,
} from '../src/audit/rules/dispute.rule.js';
import type { AuditFlag, ProviderConfig } from '../src/audit/types.js';

const sampleInvoice = {
  providerName: 'Hidroelectrica',
  providerCui: 'RO13267213',
  clientCode: '80045192',
  consumptionPointId: 'RO001E123456789',
  invoiceSeries: 'HID',
  invoiceNumber: '20260301199',
  issueDate: '2026-04-05',
  dueDate: '2026-04-25',
  totalAmountCents: 52601n,
  currency: 'RON',
};

const sampleProvider: ProviderConfig = {
  id: 1,
  providerCui: 'RO13267213',
  providerName: 'Hidroelectrica',
  category: 'ELECTRICITY',
  disputeEmail: 'clienti@hidroelectrica.ro',
  selfReadingWindowStart: 24,
  selfReadingWindowEnd: 28,
  contractualUnitPriceNet: null,
  unitPriceAlertThresholdPct: '2.00',
};

describe('dispute.rule (Pillar 3)', () => {
  it('returns null on auto-trigger when only WARNING flags exist, but builds draft when includeWarnings=true', () => {
    const warningFlags: AuditFlag[] = [
      {
        code: 'UNIT_PRICE_INCREASE',
        severity: 'WARNING',
        pillar: 'PRICING',
        message: 'Creștere tarif unitar net +30%',
        metadata: {
          previousPriceNet: '0.283820',
          currentPriceNet: '0.369000',
          unit: 'kWh',
          deltaPct: '30.01',
          previousInvoiceNumber: '20260100451',
        },
      },
    ];

    const autoDraft = buildDisputeDraft({
      invoice: sampleInvoice,
      flags: warningFlags,
      providerConfig: sampleProvider,
      userFullName: 'Ion Popescu',
      includeWarnings: false,
    });
    expect(autoDraft).toBeNull();

    const manualDraft = buildDisputeDraft({
      invoice: sampleInvoice,
      flags: warningFlags,
      providerConfig: sampleProvider,
      userFullName: 'Ion Popescu',
      includeWarnings: true,
    });
    expect(manualDraft).not.toBeNull();
    expect(manualDraft?.recipientEmail).toBe('clienti@hidroelectrica.ro');
    expect(manualDraft?.body).toContain('0.283820');
    expect(manualDraft?.body).toContain('0.369000');
  });

  it('builds a deterministic Romanian dispute email containing exact client code, invoice number, POD/CLC, and anomaly bullets', () => {
    const flags: AuditFlag[] = [
      {
        code: 'INDEX_OVERLAP_ANOMALY',
        severity: 'CRITICAL',
        pillar: 'READING',
        message: 'Suprapunere index',
        metadata: {
          previousInvoiceNumber: '20260100451',
          previousNewIndex: '14250.000',
          currentOldIndex: '14000.000',
          overlap: '250.000',
          unit: 'kWh',
        },
      },
      {
        code: 'CONSUMPTION_SPIKE',
        severity: 'CRITICAL',
        pillar: 'PRICING',
        message: 'Creștere anormală consum',
        metadata: {
          currentDailyAvg: '16.1290',
          baselineDailyAvg: '7.0968',
          spikePct: '127.27',
          unit: 'kWh',
        },
      },
    ];

    const draft = buildDisputeDraft({
      invoice: sampleInvoice,
      flags,
      providerConfig: sampleProvider,
      userFullName: 'Ion Popescu',
    });

    expect(draft).not.toBeNull();
    expect(draft?.recipientEmail).toBe('clienti@hidroelectrica.ro');
    expect(draft?.subject).toBe(
      'Sesizare / Contestație factură seria HID nr. 20260301199 – Cod client 80045192',
    );
    expect(draft?.body).toContain('Bună ziua,');
    expect(draft?.body).toContain('80045192');
    expect(draft?.body).toContain('RO001E123456789');
    expect(draft?.body).toContain('20260301199');
    expect(draft?.body).toContain('05.04.2026');
    expect(draft?.body).toContain('25.04.2026');
    expect(draft?.body).toContain('526,01 RON');
    expect(draft?.body).toContain('250.000 kWh');
    expect(draft?.body).toContain('număr de înregistrare al sesizării');
    expect(draft?.body).toContain('Ion Popescu');
  });

  it('encodes RFC 2822 UTF-8 MIME email with RFC 2047 UTF-8 Base64 Subject and URL-safe Base64 output', () => {
    const subject = 'Sesizare / Contestație factură seria HID nr. 20260301199 – Cod client 80045192';
    const raw = buildRfc2822RawEmail({
      to: 'clienti@hidroelectrica.ro',
      subject,
      body: 'Bună ziua,\nSolicit recalculare pentru contestație.\nCu stimă,\nIon Popescu',
    });

    // URL-safe base64 must not contain +, /, or trailing =
    expect(raw).not.toMatch(/[+/=]/);

    // Decode back and verify headers + UTF-8 Romanian diacritics
    const decoded = Buffer.from(
      raw.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');

    expect(decoded).toContain('To: clienti@hidroelectrica.ro\r\n');
    expect(decoded).toContain('MIME-Version: 1.0\r\n');
    expect(decoded).toContain('Content-Type: text/plain; charset=utf-8\r\n');
    expect(decoded).toContain(
      `Subject: =?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=\r\n`,
    );
    expect(decoded).toContain('Bună ziua,\r\nSolicit recalculare pentru contestație.');
  });
});
