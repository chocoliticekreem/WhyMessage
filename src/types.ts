export interface Contact {
  chatId: string;
  sender: string;
  displayName: string | null;
  lastMessageAt: Date | null;
}

export interface RelationshipProfile {
  contact: Contact;
  lastTexted: Date;
  messageCount: number;
  frequency: "daily" | "weekly" | "monthly" | "rare";
  commonTopics: string[];
  tone: string;
  keyMoments: string[];
  summary: string;
  analyzedAt: Date;
}

export interface IntentMatch {
  profile: RelationshipProfile;
  reason: string;
  suggestedMessage: string;
}

export type Mode = "name-lookup" | "intent-match" | "send-action";

export interface Classification {
  mode: Mode;
  query: string;
  extractedName?: string;
  intent?: string;
}

export interface PendingAction {
  matches: IntentMatch[];
  expiresAt: Date;
}
