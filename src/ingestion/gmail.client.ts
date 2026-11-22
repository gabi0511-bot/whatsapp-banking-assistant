import { createHash } from 'node:crypto';
import { google, type gmail_v1 } from 'googleapis';
import { buildRfc2822RawEmail } from '../audit/rules/dispute.rule.js';
import type { ReceiptEmailCandidate } from '../payments/receipt.matcher.js';
import {
  extractLinksFromHtml,
  type GmailRadarEmail,
} from '../subscriptions/trial.extractor.js';

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  format: 'XML' | 'PDF';
  buffer: Buffer;
  sha256: string;
}

export interface FetchedInvoiceEmail {
  messageId: string;
  subject: string | null;
  from: string | null;
  attachments: EmailAttachment[];
}

export interface CreateDraftInput {
  to: string;
  subject: string;
  body: string;
}

export interface GmailDraftClient {
  createGmailDraft(input: CreateDraftInput): Promise<string>;
}

export interface GmailPollerClient extends GmailDraftClient {
  fetchMatchingInvoiceEmails(query: string, maxResults?: number): Promise<FetchedInvoiceEmail[]>;
  fetchRecentReceiptEmails?(query?: string, maxResults?: number): Promise<ReceiptEmailCandidate[]>;
  fetchTextEmailsByQuery?(query: string, maxResults?: number): Promise<GmailRadarEmail[]>;
}

export function computeSha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

interface RawAttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
  format: 'XML' | 'PDF';
}

function collectAttachmentRefs(
  part: gmail_v1.Schema$MessagePart | undefined,
  out: RawAttachmentRef[],
): void {
  if (!part) {
    return;
  }

  const filename = (part.filename ?? '').trim();
  const mimeType = (part.mimeType ?? '').toLowerCase();
  const attachmentId = part.body?.attachmentId;

  if (filename && attachmentId) {
    const lowerName = filename.toLowerCase();
    if (lowerName.endsWith('.xml') || mimeType.includes('xml')) {
      out.push({ filename, mimeType, attachmentId, format: 'XML' });
    } else if (lowerName.endsWith('.pdf') || mimeType === 'application/pdf') {
      out.push({ filename, mimeType, attachmentId, format: 'PDF' });
    }
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectAttachmentRefs(child, out);
    }
  }
}

function decodeBase64UrlToBuffer(data: string): Buffer {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function extractBodyTextAndLinks(part: gmail_v1.Schema$MessagePart | undefined): {
  text: string;
  links: string[];
} {
  if (!part) return { text: '', links: [] };
  const chunks: string[] = [];
  const links: string[] = [];
  const mime = (part.mimeType ?? '').toLowerCase();

  if (mime === 'text/plain' && part.body?.data) {
    const raw = decodeBase64UrlToBuffer(part.body.data).toString('utf8');
    chunks.push(raw);
    const plainUrls = raw.match(/https?:\/\/[^\s)>"']+/gi) ?? [];
    links.push(...plainUrls);
  } else if (mime === 'text/html' && part.body?.data) {
    const rawHtml = decodeBase64UrlToBuffer(part.body.data).toString('utf8');
    links.push(...extractLinksFromHtml(rawHtml));
    const stripped = rawHtml
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ');
    chunks.push(stripped);
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const sub = extractBodyTextAndLinks(child);
      if (sub.text) chunks.push(sub.text);
      if (sub.links.length > 0) links.push(...sub.links);
    }
  }

  return {
    text: chunks.join('\n').trim(),
    links: Array.from(new Set(links)),
  };
}

function extractBodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  return extractBodyTextAndLinks(part).text;
}

const DEFAULT_RECEIPT_QUERY =
  '("confirmare plata" OR "confirmare plată" OR "plata confirmata" OR "plată confirmată" OR "tranzactie reusita" OR "payment confirmation" OR "payment receipt") newer_than:7d';

export interface GoogleGmailClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class GoogleGmailClient implements GmailPollerClient {
  private readonly gmail: gmail_v1.Gmail;

  constructor(config: GoogleGmailClientConfig) {
    const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    auth.setCredentials({ refresh_token: config.refreshToken });
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async fetchMatchingInvoiceEmails(
    query: string,
    maxResults = 25,
  ): Promise<FetchedInvoiceEmail[]> {
    const listRes = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = listRes.data.messages ?? [];
    const results: FetchedInvoiceEmail[] = [];

    for (const msgRef of messages) {
      if (!msgRef.id) {
        continue;
      }
      const msgRes = await this.gmail.users.messages.get({
        userId: 'me',
        id: msgRef.id,
        format: 'full',
      });

      const payload = msgRes.data.payload;
      const headers = payload?.headers ?? [];
      const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? null;
      const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? null;

      const refs: RawAttachmentRef[] = [];
      collectAttachmentRefs(payload, refs);

      if (refs.length === 0) {
        continue;
      }

      const attachments: EmailAttachment[] = [];
      for (const ref of refs) {
        const attRes = await this.gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: msgRef.id,
          id: ref.attachmentId,
        });
        const rawData = attRes.data.data;
        if (!rawData) {
          continue;
        }
        const buffer = decodeBase64UrlToBuffer(rawData);
        attachments.push({
          filename: ref.filename,
          mimeType: ref.mimeType,
          format: ref.format,
          buffer,
          sha256: computeSha256Hex(buffer),
        });
      }

      if (attachments.length > 0) {
        results.push({
          messageId: msgRef.id,
          subject,
          from,
          attachments,
        });
      }
    }

    return results;
  }

  async fetchRecentReceiptEmails(
    query: string = DEFAULT_RECEIPT_QUERY,
    maxResults = 15,
  ): Promise<ReceiptEmailCandidate[]> {
    const listRes = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = listRes.data.messages ?? [];
    const results: ReceiptEmailCandidate[] = [];

    for (const msgRef of messages) {
      if (!msgRef.id) continue;
      const msgRes = await this.gmail.users.messages.get({
        userId: 'me',
        id: msgRef.id,
        format: 'full',
      });

      const payload = msgRes.data.payload;
      const headers = payload?.headers ?? [];
      const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '';
      const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
      const bodyText = extractBodyText(payload) || (msgRes.data.snippet ?? '');
      const internalDateMs = msgRes.data.internalDate
        ? Number.parseInt(msgRes.data.internalDate, 10)
        : Date.now();

      results.push({
        messageId: msgRef.id,
        subject,
        from,
        bodyText,
        receivedAt: new Date(internalDateMs),
      });
    }

    return results;
  }

  async fetchTextEmailsByQuery(
    query: string,
    maxResults = 20,
  ): Promise<GmailRadarEmail[]> {
    const listRes = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = listRes.data.messages ?? [];
    const results: GmailRadarEmail[] = [];

    for (const msgRef of messages) {
      if (!msgRef.id) continue;
      const msgRes = await this.gmail.users.messages.get({
        userId: 'me',
        id: msgRef.id,
        format: 'full',
      });

      const payload = msgRes.data.payload;
      const headers = payload?.headers ?? [];
      const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '';
      const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
      const { text, links } = extractBodyTextAndLinks(payload);
      const bodyText = text || (msgRes.data.snippet ?? '');
      const internalDateMs = msgRes.data.internalDate
        ? Number.parseInt(msgRes.data.internalDate, 10)
        : Date.now();

      results.push({
        messageId: msgRef.id,
        subject,
        from,
        bodyText,
        extractedLinks: links,
        receivedAt: new Date(internalDateMs),
      });
    }

    return results;
  }

  async createGmailDraft(input: CreateDraftInput): Promise<string> {
    const raw = buildRfc2822RawEmail(input);
    const res = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    });
    if (!res.data.id) {
      throw new Error('Gmail API returned empty draft id');
    }
    return res.data.id;
  }
}
