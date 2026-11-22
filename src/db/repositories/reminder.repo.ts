import type {
  ScheduledReminderDraft,
  SelfReadingReminderPayload,
  StoredReminder,
} from '../../audit/types.js';
import type { Queryable } from '../pool.js';

export interface ReminderRepository {
  create(
    invoiceId: number,
    recipientJid: string,
    draft: ScheduledReminderDraft,
    db?: Queryable,
  ): Promise<StoredReminder>;
  findDuePending(now?: Date, db?: Queryable): Promise<StoredReminder[]>;
  findAllPending(db?: Queryable): Promise<StoredReminder[]>;
  markSent(reminderId: number, sentAt?: Date, db?: Queryable): Promise<void>;
}

interface ReminderRow {
  id: string;
  invoice_id: string;
  recipient_jid: string;
  reminder_type: 'SELF_READING';
  trigger_at: Date;
  payload: SelfReadingReminderPayload;
  status: 'PENDING' | 'SENT' | 'CANCELLED';
  sent_at: Date | null;
  created_at: Date;
}

function mapRow(row: ReminderRow): StoredReminder {
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    recipientJid: row.recipient_jid,
    reminderType: row.reminder_type,
    triggerAt: new Date(row.trigger_at),
    payload: row.payload,
    status: row.status,
    sentAt: row.sent_at ? new Date(row.sent_at) : null,
    createdAt: new Date(row.created_at),
  };
}

export class PgReminderRepository implements ReminderRepository {
  constructor(private readonly pool: Queryable) {}

  async create(
    invoiceId: number,
    recipientJid: string,
    draft: ScheduledReminderDraft,
    db?: Queryable,
  ): Promise<StoredReminder> {
    const runner = db ?? this.pool;
    const res = await runner.query<ReminderRow>(
      `
      INSERT INTO scheduled_reminders (
        invoice_id, recipient_jid, reminder_type, trigger_at, payload, status
      ) VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING')
      RETURNING *
      `,
      [
        invoiceId,
        recipientJid,
        draft.reminderType,
        draft.triggerAt.toISOString(),
        JSON.stringify(draft.payload),
      ],
    );
    return mapRow(res.rows[0]!);
  }

  async findDuePending(now: Date = new Date(), db?: Queryable): Promise<StoredReminder[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<ReminderRow>(
      `
      SELECT * FROM scheduled_reminders
      WHERE status = 'PENDING' AND trigger_at <= $1
      ORDER BY trigger_at ASC
      `,
      [now.toISOString()],
    );
    return res.rows.map(mapRow);
  }

  async findAllPending(db?: Queryable): Promise<StoredReminder[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<ReminderRow>(
      `
      SELECT * FROM scheduled_reminders
      WHERE status = 'PENDING'
      ORDER BY trigger_at ASC
      `,
    );
    return res.rows.map(mapRow);
  }

  async markSent(reminderId: number, sentAt: Date = new Date(), db?: Queryable): Promise<void> {
    const runner = db ?? this.pool;
    await runner.query(
      `UPDATE scheduled_reminders SET status = 'SENT', sent_at = $2 WHERE id = $1`,
      [reminderId, sentAt.toISOString()],
    );
  }
}

export class InMemoryReminderRepository implements ReminderRepository {
  private nextId = 1;
  private readonly reminders: StoredReminder[] = [];

  async create(
    invoiceId: number,
    recipientJid: string,
    draft: ScheduledReminderDraft,
  ): Promise<StoredReminder> {
    const item: StoredReminder = {
      id: this.nextId++,
      invoiceId,
      recipientJid,
      reminderType: draft.reminderType,
      triggerAt: draft.triggerAt,
      payload: draft.payload,
      status: 'PENDING',
      sentAt: null,
      createdAt: new Date(),
    };
    this.reminders.push(item);
    return item;
  }

  async findDuePending(now: Date = new Date()): Promise<StoredReminder[]> {
    return this.reminders
      .filter((r) => r.status === 'PENDING' && r.triggerAt.getTime() <= now.getTime())
      .sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime());
  }

  async findAllPending(): Promise<StoredReminder[]> {
    return this.reminders
      .filter((r) => r.status === 'PENDING')
      .sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime());
  }

  async markSent(reminderId: number, sentAt: Date = new Date()): Promise<void> {
    const found = this.reminders.find((r) => r.id === reminderId);
    if (found) {
      found.status = 'SENT';
      found.sentAt = sentAt;
    }
  }
}
