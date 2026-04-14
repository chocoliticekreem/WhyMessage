export interface Contact {
  chatId: string;
  sender: string;
  displayName: string | null;
  lastMessageAt: Date | null;
}

export interface GroupMembership {
  sender: string;
  groupName: string;
  groupChatId: string;
  memberCount: number;
  lastActiveAt: Date | null;
}

export type Trend = "growing" | "stable" | "fading" | "new";

export interface ConversationStats {
  /** 0-1, what fraction of conversations were initiated by the user */
  initiationRatio: number;
  /** "deep" | "moderate" | "surface" based on avgWordsPerMessage */
  depth: "deep" | "moderate" | "surface";
  /** Message counts per week for the last 12 weeks (index 0 = oldest) */
  weeklyActivity: number[];
  /** Whether the relationship is growing, stable, or fading */
  trend: Trend;
}

export interface RelationshipProfile {
  contact: Contact;
  lastTexted: Date;
  messageCount: number;
  avgWordsPerMessage: number;
  stats: ConversationStats;
  frequency: "daily" | "weekly" | "monthly" | "rare";
  commonTopics: string[];
  tone: string;
  keyMoments: string[];
  summary: string;
  groups: GroupMembership[];
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
