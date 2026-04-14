export interface RawMessage {
  text: string;
  participant?: string;
  date?: string;
  isFromMe?: boolean;
}

export interface ChatSummary {
  readonly chatId: string;
  readonly displayName: string | null;
  readonly lastMessageAt: Date | null;
  readonly isGroup: boolean;
  readonly unreadCount: number;
}

export interface IMessageClient {
  listChats(opts?: {
    sortBy?: "recent" | "name";
    limit?: number;
  }): Promise<ChatSummary[]>;
  getMessages(opts: {
    participant: string;
    limit?: number;
  }): Promise<RawMessage[]>;
  send(recipient: string, text: string): Promise<void>;
  startWatching(handlers: {
    onDirectMessage: (msg: {
      text?: string;
      participant?: string;
      chatId?: string;
    }) => Promise<void>;
    onError: (err: unknown) => void;
  }): Promise<void>;
}
