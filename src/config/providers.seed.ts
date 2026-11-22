import type { InvoiceCategory } from '../extraction/schema.js';

export interface ProviderSeedEntry {
  providerCui: string;
  providerName: string;
  category: InvoiceCategory;
  disputeEmail: string;
  selfReadingWindowStart: number | null;
  selfReadingWindowEnd: number | null;
  contractualUnitPriceNet: string | null;
  unitPriceAlertThresholdPct: string;
}

export const ROMANIAN_PROVIDERS_SEED: readonly ProviderSeedEntry[] = [
  {
    providerCui: 'RO13267213',
    providerName: 'Hidroelectrica',
    category: 'ELECTRICITY',
    disputeEmail: 'clienti@hidroelectrica.ro',
    selfReadingWindowStart: 24,
    selfReadingWindowEnd: 28,
    contractualUnitPriceNet: null,
    unitPriceAlertThresholdPct: '2.00',
  },
  {
    providerCui: 'RO22043010',
    providerName: 'E.ON Energie Romania',
    category: 'GAS',
    disputeEmail: 'serviciiclienti@eon-romania.ro',
    selfReadingWindowStart: 18,
    selfReadingWindowEnd: 25,
    contractualUnitPriceNet: null,
    unitPriceAlertThresholdPct: '2.00',
  },
  {
    providerCui: 'RO13093222',
    providerName: 'Engie Romania',
    category: 'GAS',
    disputeEmail: 'contact@engie.ro',
    selfReadingWindowStart: 20,
    selfReadingWindowEnd: 25,
    contractualUnitPriceNet: null,
    unitPriceAlertThresholdPct: '2.00',
  },
  {
    providerCui: 'RO14399840',
    providerName: 'PPC Energie',
    category: 'ELECTRICITY',
    disputeEmail: 'contact-energie@ppcgroup.com',
    selfReadingWindowStart: 20,
    selfReadingWindowEnd: 26,
    contractualUnitPriceNet: null,
    unitPriceAlertThresholdPct: '2.00',
  },
  {
    providerCui: 'RO28909028',
    providerName: 'Electrica Furnizare',
    category: 'ELECTRICITY',
    disputeEmail: 'clienti@electricafurnizare.ro',
    selfReadingWindowStart: 20,
    selfReadingWindowEnd: 25,
    contractualUnitPriceNet: null,
    unitPriceAlertThresholdPct: '2.00',
  },
  {
    providerCui: 'RO5888716',
    providerName: 'Digi Romania',
    category: 'TELECOM',
    disputeEmail: 'clienti@digi.ro',
    selfReadingWindowStart: null,
    selfReadingWindowEnd: null,
    contractualUnitPriceNet: null,
    unitPriceAlertThresholdPct: '0.50',
  },
  {
    providerCui: 'RO9010105',
    providerName: 'Orange Romania',
    category: 'TELECOM',
    disputeEmail: 'serviciul.clienti@orange.ro',
    selfReadingWindowStart: null,
    selfReadingWindowEnd: null,
    contractualUnitPriceNet: null,
    unitPriceAlertThresholdPct: '0.50',
  },
  {
    providerCui: 'RO8971726',
    providerName: 'Vodafone Romania',
    category: 'TELECOM',
    disputeEmail: 'relatiiclienti@vodafone.ro',
    selfReadingWindowStart: null,
    selfReadingWindowEnd: null,
    contractualUnitPriceNet: null,
    unitPriceAlertThresholdPct: '0.50',
  },
] as const;
