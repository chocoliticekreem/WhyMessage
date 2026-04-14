import Anthropic from "@anthropic-ai/sdk";
import type {
  Contact,
  ConversationStats,
  GroupMembership,
  RelationshipProfile,
  IntentMatch,
  Trend,
} from "./types.js";
import type { IMessageClient, RawMessage } from "./sdk-types.js";
import {
  getCachedProfile,
  setCachedProfile,
  isStale,
  getAllProfiles,
} from "./cache.js";
import { profilePrompt, intentMatchPrompt } from "./prompts.js";
import { relativeTime, safeParseJSON } from "./utils.js";
import { formatGroupContext } from "./groups.js";

const MODEL = "claude-sonnet-4-20250514";

function formatTranscript(
  messages: RawMessage[],
  contactName: string
): string {
  return messages
    .map((m) => {
      const date = m.date
        ? new Date(m.date).toLocaleDateString("en-GB", {
            month: "short",
            day: "numeric",
          })
        : "";
      const time = m.date
        ? new Date(m.date).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      const sender = m.isFromMe ? "You" : contactName;
      return `[${date} ${time}] ${sender}: ${m.text}`;
    })
    .filter((line) => line.includes(": ") && !line.endsWith(": "))
    .join("\n");
}

function computeTimeSpan(messages: RawMessage[]): string {
  const dates = messages
    .filter((m) => m.date)
    .map((m) => new Date(m.date!).getTime());
  if (dates.length < 2) return "1 message";
  const first = Math.min(...dates);
  const last = Math.max(...dates);
  const days = Math.round((last - first) / (1000 * 60 * 60 * 24));
  if (days < 7) return `${days} days`;
  if (days < 30) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

function avgWordsPerMessage(messages: RawMessage[]): number {
  if (messages.length === 0) return 0;
  const totalWords = messages.reduce(
    (sum, m) => sum + (m.text?.split(/\s+/).length ?? 0),
    0
  );
  return Math.round(totalWords / messages.length);
}

// ── Conversation Stats (no LLM, pure computation) ────────────────────

function computeStats(
  messages: RawMessage[],
  avgWords: number
): ConversationStats {
  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Initiation ratio: count conversation starts by the user
  // A "start" = first message after a 4+ hour gap
  const GAP_MS = 4 * 60 * 60 * 1000;
  let userStarts = 0;
  let totalStarts = 0;
  const sorted = messages
    .filter((m) => m.date)
    .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime());

  for (let i = 0; i < sorted.length; i++) {
    const prev = i > 0 ? new Date(sorted[i - 1].date!).getTime() : 0;
    const curr = new Date(sorted[i].date!).getTime();
    if (i === 0 || curr - prev > GAP_MS) {
      totalStarts++;
      if (sorted[i].isFromMe) userStarts++;
    }
  }
  const initiationRatio =
    totalStarts > 0 ? Math.round((userStarts / totalStarts) * 100) / 100 : 0.5;

  // Depth
  const depth: ConversationStats["depth"] =
    avgWords >= 25 ? "deep" : avgWords >= 10 ? "moderate" : "surface";

  // Weekly activity for last 12 weeks
  const weeklyActivity: number[] = new Array(12).fill(0);
  for (const m of sorted) {
    const ts = new Date(m.date!).getTime();
    const weeksAgo = Math.floor((now - ts) / WEEK_MS);
    const idx = 11 - weeksAgo; // 0 = oldest, 11 = this week
    if (idx >= 0 && idx < 12) weeklyActivity[idx]++;
  }

  // Trend: compare first half vs second half of the 12 weeks
  const firstHalf = weeklyActivity.slice(0, 6).reduce((a, b) => a + b, 0);
  const secondHalf = weeklyActivity.slice(6).reduce((a, b) => a + b, 0);
  const total = firstHalf + secondHalf;

  let trend: Trend;
  if (total === 0) {
    trend = "fading";
  } else if (firstHalf === 0 && secondHalf > 0) {
    trend = "new";
  } else if (secondHalf > firstHalf * 1.5) {
    trend = "growing";
  } else if (secondHalf < firstHalf * 0.5) {
    trend = "fading";
  } else {
    trend = "stable";
  }

  return { initiationRatio, depth, weeklyActivity, trend };
}

interface ProfileLLMResponse {
  frequency: string;
  common_topics: string[];
  tone: string;
  key_moments: string[];
  summary: string;
}

interface MatchLLMResponse {
  matches?: {
    sender: string;
    name: string;
    reason: string;
    suggested_message: string;
  }[];
  note?: string;
}

export async function buildProfile(
  sdk: IMessageClient,
  contact: Contact,
  anthropic: Anthropic,
  groups?: GroupMembership[]
): Promise<RelationshipProfile> {
  const cached = getCachedProfile(contact.sender);
  if (cached && !isStale(cached)) return cached;

  const rawMessages: RawMessage[] = await sdk.getMessages({
    participant: contact.sender,
    limit: 500,
  });

  if (rawMessages.length === 0) {
    const empty: RelationshipProfile = {
      contact,
      lastTexted: contact.lastMessageAt ?? new Date(0),
      messageCount: 0,
      avgWordsPerMessage: 0,
      stats: { initiationRatio: 0.5, depth: "surface", weeklyActivity: new Array(12).fill(0), trend: "fading" },
      frequency: "rare",
      commonTopics: [],
      tone: "no messages",
      keyMoments: [],
      summary: "No conversation history found.",
      groups: groups ?? [],
      analyzedAt: new Date(),
    };
    setCachedProfile(contact.sender, empty);
    return empty;
  }

  const name = contact.displayName ?? contact.sender;
  const transcript = formatTranscript(rawMessages, name);
  const timeSpan = computeTimeSpan(rawMessages);
  const avgWords = avgWordsPerMessage(rawMessages);
  const stats = computeStats(rawMessages, avgWords);

  const groupCtx = groups ? formatGroupContext(groups) : undefined;
  const prompt = profilePrompt(
    name,
    transcript,
    rawMessages.length,
    timeSpan,
    groupCtx
  );

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const parsed = safeParseJSON<ProfileLLMResponse>(text);

  if (!parsed) {
    console.error(
      `[whymessage] Failed to parse profile for ${name}, raw: ${text.slice(0, 200)}`
    );
    const fallback: RelationshipProfile = {
      contact,
      lastTexted: new Date(),
      messageCount: rawMessages.length,
      avgWordsPerMessage: avgWords,
      stats,
      frequency: "rare",
      commonTopics: [],
      tone: "unknown",
      keyMoments: [],
      summary: "Profile analysis failed — try again later.",
      groups: groups ?? [],
      analyzedAt: new Date(),
    };
    setCachedProfile(contact.sender, fallback);
    return fallback;
  }

  const dates = rawMessages
    .filter((m) => m.date)
    .map((m) => new Date(m.date!).getTime());
  const lastTexted =
    dates.length > 0 ? new Date(Math.max(...dates)) : new Date();

  const profile: RelationshipProfile = {
    contact,
    lastTexted,
    messageCount: rawMessages.length,
    avgWordsPerMessage: avgWords,
    stats,
    frequency: parsed.frequency as RelationshipProfile["frequency"],
    commonTopics: parsed.common_topics,
    tone: parsed.tone,
    keyMoments: parsed.key_moments,
    summary: parsed.summary,
    groups: groups ?? [],
    analyzedAt: new Date(),
  };

  setCachedProfile(contact.sender, profile);
  return profile;
}

export async function matchIntent(
  intent: string,
  anthropic: Anthropic
): Promise<IntentMatch[]> {
  const profiles = getAllProfiles().filter((p) => p.messageCount > 0);
  if (profiles.length === 0) return [];

  const summaries = profiles
    .map((p) => {
      const name = p.contact.displayName ?? p.contact.sender;
      const ago = relativeTime(p.lastTexted);
      return [
        `--- ${name} (sender: ${p.contact.sender})`,
        `Last texted: ${ago}`,
        `Frequency: ${p.frequency}`,
        `Topics: ${p.commonTopics.join(", ")}`,
        `Tone: ${p.tone}`,
        `Key moments: ${p.keyMoments.join("; ")}`,
        `Summary: ${p.summary}`,
        p.groups.length > 0
          ? `Shared groups: ${formatGroupContext(p.groups)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const prompt = intentMatchPrompt(intent, summaries);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const parsed = safeParseJSON<MatchLLMResponse>(text);

  if (!parsed?.matches || parsed.matches.length === 0) return [];

  return parsed.matches
    .map((m) => {
      const profile = profiles.find((p) => p.contact.sender === m.sender);
      if (!profile) return null;
      return {
        profile,
        reason: m.reason,
        suggestedMessage: m.suggested_message,
      };
    })
    .filter((m): m is IntentMatch => m !== null);
}

export async function buildAllProfiles(
  sdk: IMessageClient,
  contacts: Contact[],
  anthropic: Anthropic,
  groupMap?: Map<string, GroupMembership[]>
): Promise<void> {
  const BATCH = 5;
  console.log(
    `[whymessage] Building profiles for ${contacts.length} contacts...`
  );

  for (let i = 0; i < contacts.length; i += BATCH) {
    const batch = contacts.slice(i, i + BATCH);
    await Promise.all(
      batch.map((c) =>
        buildProfile(sdk, c, anthropic, groupMap?.get(c.sender)).catch((err) =>
          console.error(
            `[whymessage] Failed to profile ${c.displayName}: ${err}`
          )
        )
      )
    );
    console.log(
      `[whymessage] Profiled ${Math.min(i + BATCH, contacts.length)}/${contacts.length}`
    );
  }

  console.log("[whymessage] All profiles built.");
}
