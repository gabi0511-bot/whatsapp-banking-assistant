import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type proto,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import qrcode from 'qrcode-terminal';
import type {
  IncomingMessage,
  IncomingMessageHandler,
  MessagingAdapter,
} from './adapter.interface.js';

export interface BaileysAdapterConfig {
  authDir: string;
  logger: Logger;
  ownerJid?: string;
}

function normalizeJidBase(jid: string | null | undefined): string {
  if (!jid) return '';
  return jid.replace(/:\d+(?=@)/, '').trim().toLowerCase();
}

export function extractTextFromWAMessage(
  message: proto.IMessage | null | undefined,
): string {
  if (!message) {
    return '';
  }

  if (message.conversation) {
    return message.conversation;
  }
  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }
  if (message.ephemeralMessage?.message) {
    return extractTextFromWAMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return extractTextFromWAMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return extractTextFromWAMessage(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return extractTextFromWAMessage(message.viewOnceMessageV2Extension.message);
  }
  if (message.deviceSentMessage?.message) {
    return extractTextFromWAMessage(message.deviceSentMessage.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return extractTextFromWAMessage(message.documentWithCaptionMessage.message);
  }
  if (message.editedMessage?.message) {
    return extractTextFromWAMessage(message.editedMessage.message);
  }

  return '';
}

export class BaileysWhatsAppAdapter implements MessagingAdapter {
  private socket: WASocket | null = null;
  private readonly handlers: IncomingMessageHandler[] = [];
  private isShuttingDown = false;
  private readonly sentMessageIds = new Set<string>();
  private readonly sentMessageStore = new Map<string, proto.IMessage>();
  private readonly recentSentTexts = new Map<string, number>();

  constructor(private readonly config: BaileysAdapterConfig) {}

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  private isRecentBotEcho(text: string): boolean {
    const now = Date.now();
    for (const [key, expiresAt] of this.recentSentTexts.entries()) {
      if (expiresAt <= now) {
        this.recentSentTexts.delete(key);
      }
    }
    const expiresAt = this.recentSentTexts.get(text);
    if (expiresAt && expiresAt > now) {
      this.recentSentTexts.delete(text);
      return true;
    }
    return false;
  }

  private recordOutgoingText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.recentSentTexts.set(trimmed, Date.now() + 20_000);
  }

  private isAuthorizedOwnerJid(remoteJid: string, sock: WASocket): boolean {
    if (!this.config.ownerJid) {
      return true;
    }
    const normRemote = normalizeJidBase(remoteJid);
    const normConfigured = normalizeJidBase(this.config.ownerJid);
    if (normRemote === normConfigured) {
      return true;
    }

    const normSelfId = normalizeJidBase(sock.user?.id);
    const normSelfLid = normalizeJidBase(
      (sock.user as { lid?: string } | undefined)?.lid,
    );

    if (normSelfLid && normRemote === normSelfLid) {
      return true;
    }
    if (normSelfId && normRemote === normSelfId) {
      return true;
    }
    return false;
  }

  async connect(): Promise<void> {
    this.isShuttingDown = false;
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const baileysLogger = this.config.logger.child({ module: 'baileys' }) as unknown as Parameters<
      typeof makeWASocket
    >[0]['logger'];

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      fireInitQueries: false,
      getMessage: async (key) => {
        if (!key.id) return undefined;
        return this.sentMessageStore.get(key.id);
      },
    });

    this.socket = sock;

    sock.ev.on('creds.update', () => {
      void saveCreds();
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.config.logger.info('Scan this QR code in WhatsApp (Linked Devices) to connect:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        const selfId = normalizeJidBase(sock.user?.id);
        const selfLid = normalizeJidBase((sock.user as { lid?: string } | undefined)?.lid);
        const configuredOwner = normalizeJidBase(this.config.ownerJid);

        this.config.logger.info(
          { selfId, selfLid, configuredOwnerJid: configuredOwner || null },
          'WhatsApp Web Multi-Device connection established.',
        );

        if (configuredOwner && selfId && configuredOwner !== selfId) {
          this.config.logger.warn(
            { selfId, configuredOwnerJid: configuredOwner },
            'OWNER_WHATSAPP_JID differs from connected WhatsApp account; self-chat messages are still accepted via selfId/selfLid.',
          );
        }
      }

      if (connection === 'close') {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        const shouldReconnect =
          !this.isShuttingDown && statusCode !== DisconnectReason.loggedOut;

        this.config.logger.warn(
          { statusCode, shouldReconnect },
          'WhatsApp connection closed.',
        );

        if (shouldReconnect) {
          setTimeout(() => {
            void this.connect();
          }, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        return;
      }

      for (const msg of messages) {
        const msgId = msg.key.id;
        if (msgId && this.sentMessageIds.has(msgId)) {
          this.sentMessageIds.delete(msgId);
          continue;
        }

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) {
          continue;
        }

        if (!this.isAuthorizedOwnerJid(remoteJid, sock)) {
          this.config.logger.debug(
            { remoteJid, configuredOwnerJid: this.config.ownerJid },
            'Ignoring WhatsApp message from non-owner JID.',
          );
          continue;
        }

        const trimmed = extractTextFromWAMessage(msg.message).trim();
        if (!trimmed) {
          this.config.logger.debug(
            {
              remoteJid,
              msgId,
              stubType: msg.messageStubType ?? null,
              messageKeys: msg.message ? Object.keys(msg.message) : [],
            },
            'Skipping WhatsApp message with no extractable text.',
          );
          continue;
        }

        if (this.isRecentBotEcho(trimmed)) {
          continue;
        }

        const normSelfId = normalizeJidBase(sock.user?.id);
        const normSelfLid = normalizeJidBase(
          (sock.user as { lid?: string } | undefined)?.lid,
        );
        const normRemote = normalizeJidBase(remoteJid);
        const canonicalOwnerJid =
          normRemote === normSelfLid && normSelfId
            ? normSelfId
            : normRemote === normSelfId && normSelfId
              ? normSelfId
              : (this.config.ownerJid ?? remoteJid);

        this.config.logger.info(
          { remoteJid, canonicalOwnerJid, textPreview: trimmed.slice(0, 80) },
          'Incoming WhatsApp message routed to command router / AI Twin.',
        );

        const transportJid = this.resolveTransportJid(canonicalOwnerJid);
        void sock.sendPresenceUpdate('composing', transportJid).catch(() => {});

        const incoming: IncomingMessage = {
          fromJid: canonicalOwnerJid,
          text: trimmed,
          timestamp: new Date(
            msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
          ),
        };

        for (const handler of this.handlers) {
          try {
            await handler(incoming);
          } catch (err) {
            this.config.logger.error(
              { err, fromJid: canonicalOwnerJid },
              'Failed handling WhatsApp command / AI Twin message',
            );
            try {
              await this.sendText(
                canonicalOwnerJid,
                '⚠️ A apărut o eroare temporară la procesarea mesajului tău. Te rog încearcă din nou în câteva secunde.',
              );
            } catch {
              // Ignore secondary send error
            }
          } finally {
            void sock.sendPresenceUpdate('paused', transportJid).catch(() => {});
          }
        }
      }
    });
  }

  private resolveTransportJid(toJid: string): string {
    if (!this.socket) return toJid;
    const normTarget = normalizeJidBase(toJid);
    const normSelfId = normalizeJidBase(this.socket.user?.id);
    const normSelfLid = normalizeJidBase(
      (this.socket.user as { lid?: string } | undefined)?.lid,
    );

    if (normSelfLid && normSelfId && normTarget === normSelfId) {
      return normSelfLid;
    }
    return toJid;
  }

  async sendText(toJid: string, text: string): Promise<void> {
    if (!this.socket) {
      throw new Error('WhatsApp socket is not connected');
    }
    const transportJid = this.resolveTransportJid(toJid);
    this.recordOutgoingText(text);
    const sent = await this.socket.sendMessage(transportJid, { text });
    if (sent?.key.id) {
      this.trackSentId(sent.key.id, sent.message ?? { conversation: text });
    }
  }

  async sendImage(toJid: string, imageBuffer: Buffer, caption?: string): Promise<void> {
    if (!this.socket) {
      throw new Error('WhatsApp socket is not connected');
    }
    const transportJid = this.resolveTransportJid(toJid);
    if (caption) {
      this.recordOutgoingText(caption);
    }
    const sent = await this.socket.sendMessage(transportJid, {
      image: imageBuffer,
      caption,
    });
    if (sent?.key.id) {
      this.trackSentId(sent.key.id, sent.message ?? undefined);
    }
  }

  private trackSentId(id: string, message?: proto.IMessage): void {
    this.sentMessageIds.add(id);
    if (message) {
      this.sentMessageStore.set(id, message);
      if (this.sentMessageStore.size > 500) {
        const firstKey = this.sentMessageStore.keys().next().value;
        if (firstKey) {
          this.sentMessageStore.delete(firstKey);
        }
      }
    }
    if (this.sentMessageIds.size > 500) {
      const first = this.sentMessageIds.values().next().value;
      if (first) {
        this.sentMessageIds.delete(first);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
  }
}
