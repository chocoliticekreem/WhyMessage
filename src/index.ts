import Anthropic from "@anthropic-ai/sdk";
// @ts-expect-error — Photon SDK types not published yet
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type {
  Contact,
  PendingAction,
  RelationshipProfile,
} from "./types.js";
import { loadCache, getCachedProfile, isStale } from "./cache.js";
import { discoverContacts, findContactByName } from "./contacts.js";
import { buildProfile, matchIntent, buildAllProfiles } from "./analyzer.js";
import { classify, findSendTarget } from "./router.js";

// ── Response Formatters ──────────────────────────────────────────────

function formatProfile(p: RelationshipProfile): string {
  const name = p.contact.displayName ?? p.contact.sender;
  const ago = relativeTime(p.lastTexted);
  const date = p.lastTexted.toLocaleDateString("en-GB", {
    month: "short",
    day: "numeric",
  });

  const lines = [
    name,
    "",
    `Last texted: ${ago} (${date})`,
    `Frequency: ${p.frequency}`,
    `Topics: ${p.commonTopics.join(", ") || "none yet"}`,
    `Vibe: ${p.tone}`,
  ];

  if (p.keyMoments.length > 0) {
    lines.push(`Key moments: ${p.keyMoments.join("; ")}`);
  }

  lines.push("", p.summary);
  return lines.join("\n");
}

function formatMatches(
  matches: { profile: RelationshipProfile; reason: string; suggestedMessage: string }[]
): string {
  if (matches.length === 0) {
    return "No one in your contacts seems like a strong match for this. Try being more specific?";
  }

  const lines = ["Here's who I'd reach out to:", ""];

  matches.forEach((m, i) => {
    const name = m.profile.contact.displayName ?? m.profile.contact.sender;
    const ago = relativeTime(m.profile.lastTexted);
    lines.push(
      `${i + 1}. ${name} (${m.profile.frequency}, last ${ago})`,
      `   Why: ${m.reason}`,
      `   Message: "${m.suggestedMessage}"`,
      ""
    );
  });

  lines.push('Reply with a name or number to send the message.');
  return lines.join("\n");
}

function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[whymessage] ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey });

  const sdk = new IMessageSDK({
    watcher: {
      pollInterval: 3000,
      unreadOnly: true,
      excludeOwnMessages: true,
    },
  });

  console.log("[whymessage] Loading cache...");
  loadCache();

  console.log("[whymessage] Discovering contacts...");
  const contacts: Contact[] = await discoverContacts(sdk);
  console.log(`[whymessage] Found ${contacts.length} contacts`);

  // Pending actions: keyed by the sender's chatId
  const pendingActions = new Map<string, PendingAction>();

  // Build all profiles in background (cold start)
  buildAllProfiles(sdk, contacts, anthropic).catch((err) =>
    console.error("[whymessage] Background profile build failed:", err)
  );

  // Background refresh: every 30 min, re-analyze 10 most recent stale contacts
  setInterval(() => {
    const staleContacts = contacts
      .filter((c) => {
        const cached = getCachedProfile(c.sender);
        return !cached || isStale(cached);
      })
      .slice(0, 10);

    if (staleContacts.length > 0) {
      console.log(
        `[whymessage] Refreshing ${staleContacts.length} stale profiles...`
      );
      buildAllProfiles(sdk, staleContacts, anthropic).catch(() => {});
    }
  }, 30 * 60 * 1000);

  console.log("[whymessage] Watching for messages...");

  await sdk.startWatching({
    onNewMessage: async (msg: any) => {
      // Skip group chats and empty messages
      if (msg.isGroupChat) return;
      if (!msg.text?.trim()) return;

      const text = msg.text.trim();
      const senderChat = msg.chatId;

      console.log(`[whymessage] Received: "${text}" from ${senderChat}`);

      try {
        const pending = pendingActions.get(senderChat) ?? null;
        const result = await classify(text, contacts, pending, anthropic);

        // ── Send Action (follow-up after intent match) ───────────
        if (result.mode === "send-action" && pending) {
          const target = findSendTarget(text, pending.matches);
          if (target) {
            await sdk.send(
              target.profile.contact.chatId,
              target.suggestedMessage
            );
            const name =
              target.profile.contact.displayName ??
              target.profile.contact.sender;
            await sdk.send(
              senderChat,
              `Sent to ${name}: "${target.suggestedMessage}"`
            );
            pendingActions.delete(senderChat);
            return;
          }
        }

        // ── Name Lookup ──────────────────────────────────────────
        if (result.mode === "name-lookup" && result.extractedName) {
          const matched = findContactByName(contacts, result.extractedName);

          if (matched.length === 0) {
            await sdk.send(
              senderChat,
              `I don't have a contact named "${result.extractedName}". Try their full name?`
            );
            return;
          }

          if (matched.length > 1) {
            const names = matched
              .map((c) => c.displayName ?? c.sender)
              .join(", ");
            await sdk.send(
              senderChat,
              `Multiple matches: ${names}. Which one?`
            );
            return;
          }

          const profile = await buildProfile(
            sdk,
            matched[0],
            anthropic
          );
          await sdk.send(senderChat, formatProfile(profile));
          return;
        }

        // ── Intent Match ─────────────────────────────────────────
        if (result.mode === "intent-match" && result.intent) {
          const matches = await matchIntent(result.intent, anthropic);
          await sdk.send(senderChat, formatMatches(matches));

          if (matches.length > 0) {
            pendingActions.set(senderChat, {
              matches,
              expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            });
          }
          return;
        }

        // Fallback
        await sdk.send(
          senderChat,
          "Send me a friend's name for their profile, or tell me what you need someone for."
        );
      } catch (err) {
        console.error("[whymessage] Error:", err);
        await sdk.send(
          senderChat,
          "Something went wrong. Try again?"
        );
      }
    },
  });
}

main().catch((err) => {
  console.error("[whymessage] Fatal:", err);
  process.exit(1);
});
