import { describe, expect, it } from 'vitest';
import { DemoBalanceService } from '../src/cashflow/demo-balance.service.js';
import { InMemoryDemoBalanceRepository } from '../src/db/repositories/demo-balance.repo.js';
import { InMemoryFreeTrialRepository } from '../src/db/repositories/free-trial.repo.js';
import { InMemoryMemoryRepository } from '../src/db/repositories/memory.repo.js';
import { InMemoryPriceHikeRepository } from '../src/db/repositories/price-hike.repo.js';
import { InMemorySubscriptionChargeRepository } from '../src/db/repositories/subscription-charge.repo.js';
import { InMemorySubscriptionRepository } from '../src/db/repositories/subscription.repo.js';
import type { MessagingAdapter } from '../src/messaging/adapter.interface.js';
import { FreeTrialService, compute48hAlertSchedule } from '../src/subscriptions/free-trial.service.js';
import { GmailRadarService } from '../src/subscriptions/gmail-radar.service.js';
import { RecurrenceEngine } from '../src/subscriptions/recurrence.engine.js';
import {
  RuleBasedEmailTrialExtractor,
  preFilterSubscriptionEmail,
} from '../src/subscriptions/trial.extractor.js';

class CaptureMessaging implements MessagingAdapter {
  public readonly sent: Array<{ toJid: string; text: string }> = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onMessage(): void {}
  async sendText(toJid: string, text: string): Promise<void> {
    this.sent.push({ toJid, text });
  }
}

describe('FreeTrialService & Gmail Trial Pre-Filter / 48h Scheduler', () => {
  it('pre-filters Romanian & English free-trial emails, identifies cancellations, and skips unrelated emails', () => {
    expect(
      preFilterSubscriptionEmail(
        'Perioadă de probă gratuită Adobe Creative Cloud',
        'Ai activat 14 zile gratuit cu reînnoire automată 149 RON/lună.',
      ),
    ).toBe('CANDIDATE');

    expect(
      preFilterSubscriptionEmail(
        'Your Canva Pro free trial has started',
        'Auto-renew after 7 days at 55 RON/month.',
      ),
    ).toBe('CANDIDATE');

    expect(
      preFilterSubscriptionEmail(
        'Your Adobe Creative Cloud trial has been cancelled',
        'Abonamentul a fost anulat cu succes.',
      ),
    ).toBe('CANCELLATION');

    expect(
      preFilterSubscriptionEmail(
        'Întâlnire echipă luni la 10:00',
        'Ne vedem în sala de conferințe pentru prezentare.',
      ),
    ).toBe('SKIP');

    expect(
      preFilterSubscriptionEmail(
        '[org/repo] New pull request #42',
        'Welcome to GitHub Actions workflow run summary.',
        'GitHub <notifications@github.com>',
      ),
    ).toBe('SKIP');
  });

  it('parses Romanian written expiration date ("23 noiembrie 2026, ora 18.00") from personal demo trial email accurately', async () => {
    const extractor = new RuleBasedEmailTrialExtractor();
    const extracted = await extractor.analyzeEmail({
      messageId: 'demo-adobe-ro-1',
      subject: 'Confirmare activare: Perioadă de probă gratuită (Free Trial) – Adobe Creative Cloud',
      from: 'Mihnea Hodos <mihneahodos@gmail.com>',
      bodyText: [
        'Bună ziua,',
        'Îți confirmăm că ai activat cu succes o perioadă de probă gratuită (free trial) pentru abonamentul Adobe Creative Cloud All Apps.',
        'Detaliile abonamentului tău:',
        '- Serviciu: Adobe Creative Cloud',
        '- Data activării: 22 noiembrie 2026',
        '- Data expirării perioadei de probă: 23 noiembrie 2026, ora 18.00',
        '- Cost după expirare (reînnoire automată): 149,00 RON / lună',
        'Poți gestiona sau anula oricând abonamentul de aici: https://account.adobe.com/plans',
      ].join('\n'),
      extractedLinks: ['https://account.adobe.com/plans'],
      receivedAt: new Date('2026-11-22T00:22:00Z'),
    });

    expect(extracted.classification).toBe('FREE_TRIAL_ACTIVATION');
    expect(extracted.is_free_trial_activation).toBe(true);
    expect(extracted.service_name).toBe('Adobe Creative Cloud');
    expect(extracted.post_trial_amount).toBe(149);
    expect(extracted.currency).toBe('RON');
    expect(extracted.cancellation_url).toBe('https://account.adobe.com/plans');
    // 23 Nov 2026 18:00 Europe/Bucharest (EET UTC+2) = 2026-11-23T16:00:00.000Z
    expect(extracted.trial_end_iso).toBe('2026-11-23T16:00:00.000Z');
  });

  it('computes exact 48h pre-expiry alert, immediate alert when <48h remain, and EXPIRED when past end date', () => {
    const now = new Date('2026-11-22T10:00:00Z');

    // > 48h remaining: ends Dec 5 10:00 -> alert Dec 3 10:00
    const far = compute48hAlertSchedule(new Date('2026-12-05T10:00:00Z'), now);
    expect(far.status).toBe('ACTIVE');
    expect(far.alert48hScheduledAt.toISOString()).toBe('2026-12-03T10:00:00.000Z');

    // 20h remaining (< 48h): clamp alert to now so it fires immediately
    const soon = compute48hAlertSchedule(new Date('2026-11-23T06:00:00Z'), now);
    expect(soon.status).toBe('ACTIVE');
    expect(soon.alert48hScheduledAt.toISOString()).toBe(now.toISOString());

    // Already expired -> EXPIRED
    const expired = compute48hAlertSchedule(new Date('2026-11-21T10:00:00Z'), now);
    expect(expired.status).toBe('EXPIRED');
  });

  it('extracts duration-based trial from Gmail, dispatches 48h WhatsApp alert with Sold curent (Demo) once, and auto-cancels on cancellation email', async () => {
    const ownerJid = '40712345678@s.whatsapp.net';
    const demoBalanceRepo = new InMemoryDemoBalanceRepository();
    const demoBalanceService = new DemoBalanceService(demoBalanceRepo);
    await demoBalanceService.setBalance(ownerJid, 240_000n, 'RON'); // 2400.00 RON

    const freeTrialRepo = new InMemoryFreeTrialRepository();
    const memoryRepo = new InMemoryMemoryRepository();
    const subscriptionRepo = new InMemorySubscriptionRepository();
    const chargeRepo = new InMemorySubscriptionChargeRepository();
    const priceHikeRepo = new InMemoryPriceHikeRepository();
    const messaging = new CaptureMessaging();

    const freeTrialService = new FreeTrialService({
      freeTrialRepo,
      memoryRepo,
      demoBalanceService,
      messaging,
    });

    const recurrenceEngine = new RecurrenceEngine({
      subscriptionRepo,
      chargeRepo,
      priceHikeRepo,
      memoryRepo,
      demoBalanceService,
      messaging,
    });

    const gmailRadar = new GmailRadarService({
      gmailClient: {
        fetchMatchingInvoiceEmails: async () => [],
        createGmailDraft: async () => 'draft-1',
      },
      extractor: new RuleBasedEmailTrialExtractor(),
      freeTrialService,
      recurrenceEngine,
      ownerJid,
      freeTrialQuery: '',
      subscriptionReceiptQuery: '',
    });

    const emailReceivedAt = new Date('2026-11-21T10:00:00Z');
    const scan1 = await gmailRadar.processEmail(
      {
        messageId: 'gmail-trial-adobe-1',
        subject: 'Perioadă de probă gratuită Adobe Creative Cloud — 14 zile',
        from: 'Adobe <mail@adobe.com>',
        bodyText:
          'Bun venit! Perioada de probă gratuită de 14 zile a început. Reînnoire automată 149,00 RON/lună. Anulează oricând la https://account.adobe.com/plans',
        extractedLinks: ['https://account.adobe.com/plans'],
        receivedAt: emailReceivedAt,
      },
      emailReceivedAt,
    );

    expect(scan1.detectedTrial).toBe(true);
    const active = await freeTrialRepo.findActiveByOwner(ownerJid);
    expect(active).toHaveLength(1);
    const trial = active[0]!;
    expect(trial.serviceName).toBe('Adobe Creative Cloud');
    expect(trial.postTrialAmountCents).toBe(14_900n);
    expect(trial.trialEndAt.toISOString()).toBe('2026-12-05T10:00:00.000Z');
    expect(trial.alert48hScheduledAt.toISOString()).toBe('2026-12-03T10:00:00.000Z');

    // Before T-48h -> no 48h alert yet
    const tooEarly = await freeTrialService.dispatchDue48hAlerts(
      new Date('2026-12-02T10:00:00Z'),
    );
    expect(tooEarly).toHaveLength(0);

    // At T-48h -> dispatches 48h WhatsApp alert with Sold curent (Demo) and estimated balance after charge (2400 - 149 = 2251 RON)
    const due = await freeTrialService.dispatchDue48hAlerts(
      new Date('2026-12-03T10:05:00Z'),
    );
    expect(due).toHaveLength(1);
    expect(due[0]?.message).toContain('Adobe Creative Cloud');
    expect(due[0]?.message).toContain('149,00 RON');
    expect(due[0]?.message).toContain('2400,00 RON');
    expect(due[0]?.message).toContain('2251,00 RON');
    expect(due[0]?.message).toContain('Sold curent (Demo)');
    expect(due[0]?.message).toContain('https://account.adobe.com/plans');

    // Repeated cron run -> idempotent (0 duplicate alerts)
    const repeat = await freeTrialService.dispatchDue48hAlerts(
      new Date('2026-12-03T10:15:00Z'),
    );
    expect(repeat).toHaveLength(0);

    // Cancellation email arrives -> auto-cancels the trial
    const cancelScan = await gmailRadar.processEmail(
      {
        messageId: 'gmail-cancel-adobe-2',
        subject: 'Adobe Creative Cloud subscription has been cancelled',
        from: 'Adobe <mail@adobe.com>',
        bodyText: 'Your Adobe Creative Cloud free trial has been cancelled. You will not be charged.',
        extractedLinks: [],
        receivedAt: new Date('2026-12-03T12:00:00Z'),
      },
      new Date('2026-12-03T12:00:00Z'),
    );

    expect(cancelScan.autoCancelledCount).toBe(1);
    expect((await freeTrialRepo.findById(trial.id))?.status).toBe('CANCELLED');
  });
});
