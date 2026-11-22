import type { DemoBalanceRepository } from '../db/repositories/demo-balance.repo.js';
import type { DemoBalanceRecord } from '../subscriptions/types.js';

export class DemoBalanceService {
  constructor(private readonly repo: DemoBalanceRepository) {}

  async getBalance(ownerJid: string): Promise<DemoBalanceRecord> {
    return this.repo.get(ownerJid);
  }

  async setBalance(
    ownerJid: string,
    balanceCents: bigint,
    currency = 'RON',
  ): Promise<DemoBalanceRecord> {
    return this.repo.set(ownerJid, balanceCents, currency);
  }
}
