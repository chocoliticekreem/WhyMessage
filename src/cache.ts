import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RelationshipProfile } from "./types.js";

const CACHE_DIR = path.join(os.homedir(), ".whymessage");
const CACHE_PATH = path.join(CACHE_DIR, "cache.json");
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

let profiles = new Map<string, RelationshipProfile>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export function loadCache(): Map<string, RelationshipProfile> {
  if (!fs.existsSync(CACHE_PATH)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    return profiles;
  }
  const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  for (const [key, val] of Object.entries(raw)) {
    const p = val as RelationshipProfile;
    p.lastTexted = new Date(p.lastTexted);
    p.analyzedAt = new Date(p.analyzedAt);
    if (p.contact.lastMessageAt) {
      p.contact.lastMessageAt = new Date(p.contact.lastMessageAt);
    }
    profiles.set(key, p);
  }
  return profiles;
}

function scheduleSave(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    const obj: Record<string, RelationshipProfile> = {};
    for (const [k, v] of profiles) obj[k] = v;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2));
    writeTimer = null;
  }, 2000);
}

export function getCachedProfile(
  sender: string
): RelationshipProfile | null {
  return profiles.get(sender) ?? null;
}

export function setCachedProfile(
  sender: string,
  profile: RelationshipProfile
): void {
  profiles.set(sender, profile);
  scheduleSave();
}

export function isStale(profile: RelationshipProfile): boolean {
  return Date.now() - profile.analyzedAt.getTime() > STALE_MS;
}

export function getAllProfiles(): RelationshipProfile[] {
  return [...profiles.values()];
}
