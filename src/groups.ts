import type { GroupMembership } from "./types.js";
import type { IMessageClient, ChatSummary } from "./sdk-types.js";

/**
 * Scan group chats and map each contact sender to the groups they share
 * with the user. No LLM calls — just metadata from listChats.
 */
export async function buildGroupMap(
  sdk: IMessageClient,
  allChats: ChatSummary[]
): Promise<Map<string, GroupMembership[]>> {
  const map = new Map<string, GroupMembership[]>();

  const groupChats = allChats.filter((c) => c.isGroup);

  for (const group of groupChats) {
    const groupName = group.displayName ?? group.chatId;

    // Get recent messages to discover members
    const msgs = await sdk.getMessages({
      participant: group.chatId,
      limit: 100,
    });

    // Collect unique senders (excluding self)
    const members = new Set<string>();
    for (const msg of msgs) {
      if (msg.isFromMe) continue;
      if (msg.participant) members.add(msg.participant);
    }

    const membership: Omit<GroupMembership, "sender"> = {
      groupName,
      groupChatId: group.chatId,
      memberCount: members.size + 1, // +1 for self
      lastActiveAt: group.lastMessageAt ?? null,
    };

    // Map each member to this group
    for (const sender of members) {
      const existing = map.get(sender) ?? [];
      existing.push({ ...membership, sender });
      map.set(sender, existing);
    }
  }

  return map;
}

/**
 * Format group memberships as a string for the LLM profile prompt.
 */
export function formatGroupContext(groups: GroupMembership[]): string {
  if (groups.length === 0) return "";

  return groups
    .map((g) => {
      const active = g.lastActiveAt
        ? `last active ${g.lastActiveAt.toLocaleDateString("en-GB", { month: "short", day: "numeric" })}`
        : "inactive";
      return `"${g.groupName}" (${g.memberCount} members, ${active})`;
    })
    .join(", ");
}
