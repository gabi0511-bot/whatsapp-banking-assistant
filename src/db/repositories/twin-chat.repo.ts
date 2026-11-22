import type { Queryable } from '../pool.js';

export type TwinChatRole = 'USER' | 'ASSISTANT';

export interface StoredTwinMessage {
  id: number;
  ownerJid: string;
  role: TwinChatRole;
  content: string;
  classifiedIntent: string;
  wasBlocked: boolean;
  toolCallsUsed: string[];
  createdAt: Date;
}

export interface AppendTwinMessageInput {
  ownerJid: string;
  role: TwinChatRole;
  content: string;
  classifiedIntent: string;
  wasBlocked: boolean;
  toolCallsUsed?: string[];
}

export interface TwinChatRepository {
  append(input: AppendTwinMessageInput, db?: Queryable): Promise<StoredTwinMessage>;
  findRecentAllowed(
    ownerJid: string,
    limit?: number,
    db?: Queryable,
  ): Promise<StoredTwinMessage[]>;
  findRecentAll(ownerJid: string, limit?: number, db?: Queryable): Promise<StoredTwinMessage[]>;
}

interface TwinMessageRow {
  id: string;
  owner_jid: string;
  role: TwinChatRole;
  content: string;
  classified_intent: string;
  was_blocked: boolean;
  tool_calls_used: string[];
  created_at: Date;
}

function mapRow(row: TwinMessageRow): StoredTwinMessage {
  return {
    id: Number(row.id),
    ownerJid: row.owner_jid,
    role: row.role,
    content: row.content,
    classifiedIntent: row.classified_intent,
    wasBlocked: row.was_blocked,
    toolCallsUsed: Array.isArray(row.tool_calls_used) ? row.tool_calls_used : [],
    createdAt: new Date(row.created_at),
  };
}

export class PgTwinChatRepository implements TwinChatRepository {
  constructor(private readonly pool: Queryable) {}

  async append(input: AppendTwinMessageInput, db?: Queryable): Promise<StoredTwinMessage> {
    const runner = db ?? this.pool;
    const res = await runner.query<TwinMessageRow>(
      `
      INSERT INTO twin_conversation_messages (
        owner_jid, role, content, classified_intent, was_blocked, tool_calls_used
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
      `,
      [
        input.ownerJid,
        input.role,
        input.content,
        input.classifiedIntent,
        input.wasBlocked,
        JSON.stringify(input.toolCallsUsed ?? []),
      ],
    );
    return mapRow(res.rows[0]!);
  }

  async findRecentAllowed(
    ownerJid: string,
    limit = 10,
    db?: Queryable,
  ): Promise<StoredTwinMessage[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<TwinMessageRow>(
      `
      SELECT * FROM (
        SELECT * FROM twin_conversation_messages
        WHERE owner_jid = $1 AND was_blocked = FALSE
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      ) sub
      ORDER BY created_at ASC, id ASC
      `,
      [ownerJid, limit],
    );
    return res.rows.map(mapRow);
  }

  async findRecentAll(
    ownerJid: string,
    limit = 20,
    db?: Queryable,
  ): Promise<StoredTwinMessage[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<TwinMessageRow>(
      `
      SELECT * FROM twin_conversation_messages
      WHERE owner_jid = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      `,
      [ownerJid, limit],
    );
    return res.rows.map(mapRow);
  }
}

export class InMemoryTwinChatRepository implements TwinChatRepository {
  private nextId = 1;
  private readonly messages: StoredTwinMessage[] = [];

  async append(input: AppendTwinMessageInput): Promise<StoredTwinMessage> {
    const msg: StoredTwinMessage = {
      id: this.nextId++,
      ownerJid: input.ownerJid,
      role: input.role,
      content: input.content,
      classifiedIntent: input.classifiedIntent,
      wasBlocked: input.wasBlocked,
      toolCallsUsed: input.toolCallsUsed ?? [],
      createdAt: new Date(),
    };
    this.messages.push(msg);
    return msg;
  }

  async findRecentAllowed(ownerJid: string, limit = 10): Promise<StoredTwinMessage[]> {
    return this.messages
      .filter((m) => m.ownerJid === ownerJid && !m.wasBlocked)
      .slice(-limit);
  }

  async findRecentAll(ownerJid: string, limit = 20): Promise<StoredTwinMessage[]> {
    return this.messages
      .filter((m) => m.ownerJid === ownerJid)
      .slice(-limit)
      .reverse();
  }
}
