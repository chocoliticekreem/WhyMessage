import type { Contact } from "./types.js";
import type { IMessageClient, ChatSummary } from "./sdk-types.js";

export interface DiscoverResult {
  contacts: Contact[];
  allChats: ChatSummary[];
}

export async function discoverContacts(
  sdk: IMessageClient
): Promise<DiscoverResult> {
  const allChats = await sdk.listChats({
    sortBy: "recent",
    limit: 200,
  });

  const contacts: Contact[] = [];

  for (const chat of allChats) {
    if (chat.isGroup) continue;

    const sender = extractSender(chat.chatId);

    const contact: Contact = {
      chatId: chat.chatId,
      sender,
      displayName: chat.displayName ?? null,
      lastMessageAt: chat.lastMessageAt ?? null,
    };

    if (!contact.displayName) {
      const msgs = await sdk.getMessages({
        participant: sender,
        limit: 1,
      });
      if (msgs.length > 0 && msgs[0].participant) {
        contact.displayName = msgs[0].participant;
      }
    }

    contacts.push(contact);
  }

  return { contacts, allChats };
}

export function findContactByName(
  contacts: Contact[],
  name: string
): Contact[] {
  const lower = name.toLowerCase().trim();
  return contacts.filter((c) =>
    c.displayName?.toLowerCase().includes(lower)
  );
}

function extractSender(chatId: string): string {
  const parts = chatId.split(";");
  return parts[parts.length - 1] ?? chatId;
}
