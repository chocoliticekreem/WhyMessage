export function classifyPrompt(
  text: string,
  contactNames: string[]
): string {
  return `You are a classifier for an iMessage assistant called WhyMessage.
Given a user's message, determine if they are:
1. "name-lookup" — asking about a specific person (mentioning a name, "who is X", "tell me about X")
2. "intent-match" — describing something they want to do and need the right person for (e.g., "dinner tonight", "who wants to go climbing", "need a hackathon teammate")

Known contacts: ${contactNames.join(", ")}

Respond with JSON only, no markdown fences:
{ "mode": "name-lookup" | "intent-match", "extractedName": string | null, "intent": string | null }

User message: "${text}"`;
}

export function profilePrompt(
  contactName: string,
  transcript: string,
  messageCount: number,
  timeSpan: string,
  groupContext?: string
): string {
  const groupSection = groupContext
    ? `\n\nShared group chats: ${groupContext}\nUse group membership as additional context for topics and shared interests, but prioritize what's in the DM conversation.\n`
    : "";
  return `You are analyzing an iMessage conversation to build a relationship profile.
Given the conversation below between the user and ${contactName}, extract:

1. frequency: "daily" | "weekly" | "monthly" | "rare" — based on message timestamps
2. common_topics: string[] — up to 8 recurring subjects. Be SPECIFIC ("bouldering at Vauxhall Wall" not "sports", "that Thai place on High St" not "food")
3. tone: string — 1-3 words describing the vibe (e.g., "warm and jokey", "deep and reflective", "chaotic energy")
4. key_moments: string[] — up to 5 specific shared experiences, events, plans, or milestones mentioned. Include approximate dates if visible.
5. summary: string — one sentence capturing the essence of this relationship. Make it feel human, not clinical.

Respond with JSON only, no markdown fences:
{ "frequency": string, "common_topics": string[], "tone": string, "key_moments": string[], "summary": string }

Do NOT invent information not present in the messages. If the conversation is sparse, say so honestly.

Conversation (${messageCount} messages, spanning ${timeSpan}):
${transcript}${groupSection}`;
}

export function intentMatchPrompt(
  intent: string,
  profileSummaries: string
): string {
  return `You are a relationship-aware matchmaker. The user wants to do something and you need to find the best people from their contacts.

User's intent: "${intent}"

Here are their relationship profiles:
${profileSummaries}

Select the top 3 best matches. For each, provide:
1. sender: the contact's sender ID (from the profiles)
2. name: the contact's display name
3. reason: 1-2 sentences explaining why this person is great for THIS specific intent. Reference real topics and moments from their relationship — no generic reasons.
4. suggested_message: a natural, casual opening message that references real shared context. It should feel like the user actually wrote it — no robot energy.

Respond with JSON only, no markdown fences:
{ "matches": [{ "sender": string, "name": string, "reason": string, "suggested_message": string }] }

If fewer than 3 contacts are relevant, return fewer. If none match, return:
{ "matches": [], "note": "reason why no one matched" }`;
}
