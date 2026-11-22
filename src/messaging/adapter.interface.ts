export interface IncomingMessage {
  fromJid: string;
  text: string;
  timestamp: Date;
}

export type IncomingMessageHandler = (message: IncomingMessage) => Promise<void>;

export interface MessagingAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendText(toJid: string, text: string): Promise<void>;
  sendImage?(toJid: string, imageBuffer: Buffer, caption?: string): Promise<void>;
  onMessage(handler: IncomingMessageHandler): void;
}
