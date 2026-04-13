import type { Contact } from "./types.js";

// The Photon SDK provides listChats() which returns ChatSummary objects.
// We use this instead of a getContacts() method (which doesn't exist).

export async function discoverContacts(sdk: any): Promise<Contact[]> {
  const chats = await sdk.listChats({
    type: "dm",
    sortBy: "recent",
    limit: 200,
  });

  const contacts: Contact[] = [];

  for (const chat of chats) {
    const contact: Contact = {
      chatId: chat.chatId,
      sender: extractSender(chat.chatId),
      displayName: chat.displayName ?? null,
      lastMessageAt: chat.lastMessageAt
        ? new Date(chat.lastMessageAt)
        : null,
    };

    // Fallback: if no displayName, pull from most recent message
    if (!contact.displayName) {
      const msgs = await sdk.getMessages({
        chatId: chat.chatId,
        limit: 1,
        excludeOwnMessages: true,
      });
      if (msgs.length > 0 && msgs[0].senderName) {
        contact.displayName = msgs[0].senderName;
      }
    }

    contacts.push(contact);
  }

  return contacts.sort(
    (a, b) =>
      (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0)
  );
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
  // Parse "iMessage;-;+1234567890" or "iMessage;-;user@example.com"
  const parts = chatId.split(";");
  return parts[parts.length - 1] ?? chatId;
}
