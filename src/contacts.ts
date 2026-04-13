import type { Contact } from "./types.js";

export async function discoverContacts(sdk: any): Promise<Contact[]> {
  // listChats() returns ChatSummary with: chatId, name, kind, unreadCount
  // Filter to DMs only (kind !== 'group')
  const allChats = await sdk.listChats({
    sortBy: "recent",
    limit: 200,
  });

  const contacts: Contact[] = [];

  for (const chat of allChats) {
    // Skip group chats — we only want 1:1 conversations
    if (chat.kind === "group") continue;

    // Extract the participant identifier from chatId
    const sender = extractSender(chat.chatId);

    const contact: Contact = {
      chatId: chat.chatId,
      sender,
      displayName: chat.name ?? null,
      lastMessageAt: null,
    };

    // If no display name, try to get it from the most recent message
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

  // Sort by most recently active (we'll fill in lastMessageAt from messages)
  return contacts;
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
