import "dotenv/config";
import OpenAI from "openai";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { IMessageClient } from "./sdk-types.js";
import type {
  Contact,
  GroupMembership,
  PendingAction,
  RelationshipProfile,
} from "./types.js";
import { loadCache, getCachedProfile, isStale, flushCache, getAllProfiles } from "./cache.js";
import { discoverContacts, findContactByName } from "./contacts.js";
import { buildGroupMap } from "./groups.js";
import { buildProfile, matchIntent, buildAllProfiles } from "./analyzer.js";
import { classify, findSendTarget } from "./router.js";
import { relativeTime } from "./utils.js";

// ── Response Formatters ──────────────────────────────────────────────

// ── Sparkline ────────────────────────────────────────────────────────

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

function sparkline(values: number[]): string {
  const max = Math.max(...values, 1);
  return values
    .map((v) => {
      const idx = Math.round((v / max) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx];
    })
    .join("");
}

function trendArrow(trend: string): string {
  switch (trend) {
    case "growing": return "↑";
    case "fading": return "↓";
    case "new": return "★";
    default: return "→";
  }
}

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

  // Stats line: depth + initiation + trend
  const initPct = Math.round(p.stats.initiationRatio * 100);
  const whoInitiates =
    initPct > 65
      ? "you reach out more"
      : initPct < 35
        ? "they reach out more"
        : "balanced";
  lines.push(
    `Depth: ${p.stats.depth} (avg ${p.avgWordsPerMessage} words/msg)`,
    `Dynamic: ${whoInitiates} (${initPct}% you)`,
    `Trend: ${trendArrow(p.stats.trend)} ${p.stats.trend}`
  );

  // Sparkline
  lines.push(`Activity: ${sparkline(p.stats.weeklyActivity)}  (12 weeks)`);

  if (p.keyMoments.length > 0) {
    lines.push(`Key moments: ${p.keyMoments.join("; ")}`);
  }

  if (p.groups.length > 0) {
    const groupNames = p.groups.map((g) => g.groupName).join(", ");
    lines.push(`Groups: ${groupNames}`);
  }

  lines.push("", p.summary);
  return lines.join("\n");
}

function formatMatches(
  matches: {
    profile: RelationshipProfile;
    reason: string;
    suggestedMessage: string;
  }[]
): string {
  if (matches.length === 0) {
    return "No one in your contacts seems like a strong match for this. Try being more specific?";
  }

  const lines = ["Here's who I'd reach out to:", ""];

  matches.forEach((m, i) => {
    const name = m.profile.contact.displayName ?? m.profile.contact.sender;
    const ago = relativeTime(m.profile.lastTexted);
    const trend = trendArrow(m.profile.stats.trend);
    lines.push(
      `${i + 1}. ${name} (${m.profile.frequency}, last ${ago}) ${trend}`,
      `   ${sparkline(m.profile.stats.weeklyActivity)}`,
      `   Why: ${m.reason}`,
      `   Message: "${m.suggestedMessage}"`,
      ""
    );
  });

  lines.push('Reply with a number to send, or "2: your custom message" to edit.');
  return lines.join("\n");
}

function formatCatchUp(profiles: RelationshipProfile[]): string {
  if (profiles.length === 0) {
    return "You're pretty caught up! No one's been out of touch for long.";
  }

  const lines = ["People you haven't talked to in a while:", ""];

  profiles.slice(0, 5).forEach((p, i) => {
    const name = p.contact.displayName ?? p.contact.sender;
    const ago = relativeTime(p.lastTexted);
    lines.push(
      `${i + 1}. ${name} — last texted ${ago}`,
      `   Topics: ${p.commonTopics.slice(0, 3).join(", ") || "—"}`,
      ""
    );
  });

  lines.push("Text a name to see their full profile.");
  return lines.join("\n");
}

// ── Rate Limiter ─────────────────────────────────────────────────────

const lastMessageTime = new Map<string, number>();
const RATE_LIMIT_MS = 1000;

function isRateLimited(sender: string): boolean {
  const last = lastMessageTime.get(sender) ?? 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) return true;
  lastMessageTime.set(sender, now);
  return false;
}

// ── Catch-Up Detection ───────────────────────────────────────────────

const CATCH_UP_PHRASES = [
  "catch up",
  "who haven't i talked to",
  "who should i reach out to",
  "who am i losing touch with",
  "neglected contacts",
  "stale contacts",
];

function isCatchUpQuery(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return CATCH_UP_PHRASES.some((p) => lower.includes(p));
}

// ── Edit-Before-Send Parser ──────────────────────────────────────────

function parseEditCommand(text: string): { index: number; message: string } | null {
  const match = text.match(/^(\d+)\s*:\s*(.+)$/s);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  const message = match[2].trim();
  if (index < 1 || message.length === 0) return null;
  return { index, message };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[whymessage] OPENAI_API_KEY not set. Create a .env file or export the variable.");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey });
  const sdk = new IMessageSDK() as unknown as IMessageClient;

  console.log("[whymessage] Loading cache...");
  loadCache();

  console.log("[whymessage] Discovering contacts...");
  const { contacts, allChats } = await discoverContacts(sdk);
  console.log(`[whymessage] Found ${contacts.length} contacts`);

  console.log("[whymessage] Scanning group chats...");
  const groupMap: Map<string, GroupMembership[]> = await buildGroupMap(sdk, allChats);
  const groupCount = allChats.filter((c) => c.isGroup).length;
  console.log(`[whymessage] Mapped ${groupCount} group chats to contacts`);

  const pendingActions = new Map<string, PendingAction>();

  // Build profiles for recently active contacts only (last 90 days, cap 50)
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const uncachedContacts = contacts
    .filter((c) => c.lastMessageAt && c.lastMessageAt > cutoff)
    .filter((c) => { const p = getCachedProfile(c.sender); return !p || isStale(p); })
    .slice(0, 50);

  if (uncachedContacts.length === 0) {
    console.log("[whymessage] All profiles up to date, skipping build");
  } else {
    console.log(`[whymessage] Profiling ${uncachedContacts.length} uncached contacts`);
    buildAllProfiles(sdk, uncachedContacts, openai, groupMap).catch((err) =>
      console.error("[whymessage] Background profile build failed:", err)
    );
  }

  // Background refresh: every 30 min, re-analyze stale profiles
  const refreshInterval = setInterval(() => {
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
      buildAllProfiles(sdk, staleContacts, openai, groupMap).catch((err) =>
        console.error("[whymessage] Background refresh failed:", err)
      );
    }
  }, 30 * 60 * 1000);

  // Cleanup expired pending actions every 5 min
  const cleanupInterval = setInterval(() => {
    const now = new Date();
    for (const [sender, action] of pendingActions) {
      if (action.expiresAt < now) {
        pendingActions.delete(sender);
      }
    }
  }, 5 * 60 * 1000);

  // Graceful shutdown
  function shutdown(): void {
    console.log("\n[whymessage] Shutting down...");
    clearInterval(refreshInterval);
    clearInterval(cleanupInterval);
    flushCache();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[whymessage] Watching for messages...");

  await sdk.startWatching({
    onDirectMessage: async (msg: { text?: string; participant?: string; chatId?: string }) => {
      if (!msg.text?.trim()) return;

      const text = msg.text.trim();
      const sender = msg.participant ?? msg.chatId ?? "";

      if (isRateLimited(sender)) return;

      console.log(`[whymessage] Received: "${text}" from ${sender}`);

      try {
        // ── Catch-Up Mode ──────────────────────────────────────
        if (isCatchUpQuery(text)) {
          const allProfiles = getAllProfiles()
            .filter((p) => p.messageCount > 0)
            .sort((a, b) => a.lastTexted.getTime() - b.lastTexted.getTime());
          await sdk.send(sender, formatCatchUp(allProfiles));
          return;
        }

        const pending = pendingActions.get(sender) ?? null;

        // ── Edit-Before-Send (e.g., "2: hey wanna grab thai?") ─
        if (pending && pending.expiresAt > new Date()) {
          const edit = parseEditCommand(text);
          if (edit && edit.index <= pending.matches.length) {
            const target = pending.matches[edit.index - 1];
            await sdk.send(target.profile.contact.sender, edit.message);
            const name =
              target.profile.contact.displayName ??
              target.profile.contact.sender;
            await sdk.send(sender, `Sent to ${name}: "${edit.message}"`);
            pendingActions.delete(sender);
            return;
          }
        }

        const result = await classify(text, contacts, pending, openai);

        // ── Send Action (follow-up after intent match) ───────────
        if (result.mode === "send-action" && pending) {
          const target = findSendTarget(text, pending.matches);
          if (target) {
            await sdk.send(
              target.profile.contact.sender,
              target.suggestedMessage
            );
            const name =
              target.profile.contact.displayName ??
              target.profile.contact.sender;
            await sdk.send(
              sender,
              `Sent to ${name}: "${target.suggestedMessage}"`
            );
            pendingActions.delete(sender);
            return;
          }
        }

        // ── Name Lookup ──────────────────────────────────────────
        if (result.mode === "name-lookup" && result.extractedName) {
          const matched = findContactByName(
            contacts,
            result.extractedName
          );

          if (matched.length === 0) {
            await sdk.send(
              sender,
              `I don't have a contact named "${result.extractedName}". Try their full name?`
            );
            return;
          }

          if (matched.length > 1) {
            const names = matched
              .map((c) => c.displayName ?? c.sender)
              .join(", ");
            await sdk.send(sender, `Multiple matches: ${names}. Which one?`);
            return;
          }

          const profile = await buildProfile(sdk, matched[0], openai, groupMap.get(matched[0].sender));
          await sdk.send(sender, formatProfile(profile));
          return;
        }

        // ── Intent Match ─────────────────────────────────────────
        if (result.mode === "intent-match" && result.intent) {
          const matches = await matchIntent(result.intent, openai);
          await sdk.send(sender, formatMatches(matches));

          if (matches.length > 0) {
            pendingActions.set(sender, {
              matches,
              expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            });
          }
          return;
        }

        // Fallback
        await sdk.send(
          sender,
          "Send me a friend's name for their profile, or tell me what you need someone for."
        );
      } catch (err) {
        console.error("[whymessage] Error:", err);
        try {
          await sdk.send(sender, "Something went wrong. Try again?");
        } catch (sendErr) {
          console.error("[whymessage] Failed to send error reply:", sendErr);
        }
      }
    },
    onError: (err: unknown) => {
      console.error("[whymessage] Watcher error:", err);
    },
  });
}

main().catch((err) => {
  console.error("[whymessage] Fatal:", err);
  process.exit(1);
});
