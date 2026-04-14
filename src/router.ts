import Anthropic from "@anthropic-ai/sdk";
import type {
  Contact,
  Classification,
  PendingAction,
  IntentMatch,
} from "./types.js";
import { findContactByName } from "./contacts.js";
import { classifyPrompt } from "./prompts.js";
import { safeParseJSON } from "./utils.js";

const LOOKUP_PREFIXES = [
  "tell me about",
  "who is",
  "what about",
  "update on",
  "profile for",
  "who's",
];

export async function classify(
  text: string,
  contacts: Contact[],
  pending: PendingAction | null,
  anthropic: Anthropic
): Promise<Classification> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Pass 1: Check if this is a follow-up send action
  if (pending && pending.expiresAt > new Date()) {
    const match = findSendTarget(lower, pending.matches);
    if (match) {
      return { mode: "send-action", query: trimmed, extractedName: lower };
    }
  }

  // Pass 2: Trigger phrases -> name lookup
  for (const prefix of LOOKUP_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const name = trimmed.slice(prefix.length).trim();
      if (name.length > 0) {
        return { mode: "name-lookup", query: trimmed, extractedName: name };
      }
    }
  }

  // Pass 3: Exact contact name match (single or two words, no other content)
  const words = trimmed.split(/\s+/);
  if (words.length <= 3) {
    const nameMatches = findContactByName(contacts, trimmed);
    if (nameMatches.length > 0) {
      return {
        mode: "name-lookup",
        query: trimmed,
        extractedName: trimmed,
      };
    }
  }

  // Pass 4: No contact name found anywhere -> intent match
  const anyNameMatch = contacts.some((c) =>
    c.displayName ? lower.includes(c.displayName.toLowerCase()) : false
  );
  if (!anyNameMatch) {
    return { mode: "intent-match", query: trimmed, intent: trimmed };
  }

  // Pass 5: Ambiguous (has a name + other words) -> LLM classifier
  return classifyWithLLM(trimmed, contacts, anthropic);
}

async function classifyWithLLM(
  text: string,
  contacts: Contact[],
  anthropic: Anthropic
): Promise<Classification> {
  const names = contacts
    .filter((c) => c.displayName)
    .map((c) => c.displayName as string);

  const prompt = classifyPrompt(text, names);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 150,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "{}";
  const parsed = safeParseJSON<{
    mode?: string;
    extractedName?: string;
    intent?: string;
  }>(raw);

  if (!parsed) {
    return { mode: "intent-match", query: text, intent: text };
  }

  return {
    mode: parsed.mode === "name-lookup" ? "name-lookup" : "intent-match",
    query: text,
    extractedName: parsed.extractedName ?? undefined,
    intent: parsed.intent ?? undefined,
  };
}

export function findSendTarget(
  input: string,
  matches: IntentMatch[]
): IntentMatch | null {
  const lower = input.toLowerCase().trim();

  // Match by number first: "1", "2", "3"
  const num = parseInt(lower, 10);
  if (num >= 1 && num <= matches.length) {
    return matches[num - 1];
  }

  // Match by name: require exact full-name or exact first-name match
  for (const m of matches) {
    const fullName = m.profile.contact.displayName?.toLowerCase();
    if (!fullName) continue;
    if (lower === fullName) return m;
    const firstName = fullName.split(/\s+/)[0];
    if (firstName && lower === firstName) return m;
  }

  return null;
}
