import Anthropic from "@anthropic-ai/sdk";
import type {
  Contact,
  RelationshipProfile,
  IntentMatch,
} from "./types.js";
import {
  getCachedProfile,
  setCachedProfile,
  isStale,
  getAllProfiles,
} from "./cache.js";
import { profilePrompt, intentMatchPrompt } from "./prompts.js";

const MODEL = "claude-sonnet-4-20250514";

interface RawMessage {
  text: string;
  participant?: string;
  date?: string;
  isFromMe?: boolean;
}

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

export async function buildProfile(
  sdk: any,
  contact: Contact,
  anthropic: Anthropic
): Promise<RelationshipProfile> {
  const cached = getCachedProfile(contact.sender);
  if (cached && !isStale(cached)) return cached;

  // Photon SDK: getMessages({ participant, limit })
  const rawMessages: RawMessage[] = await sdk.getMessages({
    participant: contact.sender,
    limit: 500,
  });

  if (rawMessages.length === 0) {
    const empty: RelationshipProfile = {
      contact,
      lastTexted: contact.lastMessageAt ?? new Date(0),
      messageCount: 0,
      frequency: "rare",
      commonTopics: [],
      tone: "no messages",
      keyMoments: [],
      summary: "No conversation history found.",
      analyzedAt: new Date(),
    };
    setCachedProfile(contact.sender, empty);
    return empty;
  }

  const name = contact.displayName ?? contact.sender;
  const transcript = formatTranscript(rawMessages, name);
  const timeSpan = computeTimeSpan(rawMessages);

  const prompt = profilePrompt(name, transcript, rawMessages.length, timeSpan);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const parsed = JSON.parse(text);

  // Find the most recent message date
  const dates = rawMessages
    .filter((m) => m.date)
    .map((m) => new Date(m.date!).getTime());
  const lastTexted = dates.length > 0 ? new Date(Math.max(...dates)) : new Date();

  const profile: RelationshipProfile = {
    contact,
    lastTexted,
    messageCount: rawMessages.length,
    frequency: parsed.frequency,
    commonTopics: parsed.common_topics,
    tone: parsed.tone,
    keyMoments: parsed.key_moments,
    summary: parsed.summary,
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
      ].join("\n");
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
  const parsed = JSON.parse(text);

  if (!parsed.matches || parsed.matches.length === 0) return [];

  return parsed.matches.map(
    (m: {
      sender: string;
      name: string;
      reason: string;
      suggested_message: string;
    }) => {
      const profile = profiles.find((p) => p.contact.sender === m.sender);
      return {
        profile: profile ?? profiles[0],
        reason: m.reason,
        suggestedMessage: m.suggested_message,
      };
    }
  );
}

export async function buildAllProfiles(
  sdk: any,
  contacts: Contact[],
  anthropic: Anthropic
): Promise<void> {
  const BATCH = 5;
  console.log(
    `[whymessage] Building profiles for ${contacts.length} contacts...`
  );

  for (let i = 0; i < contacts.length; i += BATCH) {
    const batch = contacts.slice(i, i + BATCH);
    await Promise.all(
      batch.map((c) =>
        buildProfile(sdk, c, anthropic).catch((err) =>
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
