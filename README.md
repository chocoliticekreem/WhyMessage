# WhyMessage

**Your relationship CRM. Text a friend's name to see relationship profile. Text a need to find the right person.**

## Demo

[![WhyMessage Demo](https://img.shields.io/badge/Watch-Demo-red?logo=youtube)](https://youtube.com/shorts/NMugy7ytUBg?feature=share)

WhyMessage is an iMessage-native relationship intelligence agent built with the [Photon SDK](https://github.com/photon-hq/imessage-kit). It reads your real conversation history to build relationship profiles and uses them to match you with the right person for anything.

## The Problem

You want to grab dinner but can't think of who to text. You know someone in your contacts who'd be down to go to the movies together, but you can't remember who. You haven't talked to a friend in months and texting them out of the blue feels weird.

Your brain can recall maybe 5 people in the moment. Your iMessage history knows 200+.

## How It Works

Two modes, one agent. Just text it.

### Mode 1: Name Lookup
Text a friend's name and get your relationship profile:

```
You: Vandit

WhyMessage:
Vandit Kumar

Last texted: 3d ago (Apr 10)
Frequency: weekly
Topics: bouldering, ML papers, that one ramen place
Vibe: warm and jokey
Depth: moderate (avg 18 words/msg)
Dynamic: balanced (48% you)
Trend: ↑ growing
Activity: ▁▃▅▇▅▃▁▁▃▅▇█  (12 weeks)
Key moments: Stanford TreeHack '25 teammates; Kyoto trip May '25; started climbing together Oct '24
Groups: Climbing Crew, Photon Residency

Your go-to for nerdy deep dives and spontaneous food runs.
```

### Mode 2: Intent Match
Text what you want to do. Get the top 3 people and a suggested opener:

```
You: dinner tonight, somewhere chill

WhyMessage:
Here's who I'd reach out to:

1. Vandit Kumar (weekly, last 3d ago) ↑
   ▁▃▅▇▅▃▁▁▃▅▇█
   Why: You two talk about food constantly — he mentioned wanting to try the new Thai place last week
   Message: "vandit have you been to that thai place yet? free tonight?"

2. Daniel Tian (monthly, last 5d ago) →
   ▃▃▂▁▁▁▂▃▃▂▃▃
   Why: He texted about being bored on break 3 days ago and you've done spontaneous dinners before
   Message: "yo dan you mentioned being bored.. dinner tonight? somewhere chill"

3. Hugo Song (weekly, last 2d ago) ↑
   ▁▁▂▃▃▅▅▃▅▆▇█
   Why: You caught up with him last week and he mentioned wanting to hang more outside events
   Message: "hugo! wanna grab food tonight? been meaning to hang outside uni stuff"

Reply with a number to send, or "2: your custom message" to edit.
```

Reply "Vandit" or "1" and it sends the suggested message. Or reply "2: yo dan, thai food tonight?" to edit before sending.

## Setup

### Prerequisites
- **macOS only** — Photon SDK reads your local Messages database
- **Full Disk Access** — System Settings → Privacy & Security → Full Disk Access → add your terminal (Terminal, Warp, iTerm, VS Code, Cursor)

### Install
```bash
cd WhyMessage
npm install
```

### Configure
Create a `.env` file:
```
ANTHROPIC_API_KEY=sk-ant-...
```

### Run
```bash
npm run dev
```

The agent will:
1. Discover your iMessage contacts via Photon SDK
2. Build relationship profiles from your conversation history (cached after first run)
3. Watch for incoming DMs and respond

Text the agent from another device or ask a friend to text you to test it.

## Architecture

```
src/
  index.ts      → Entry point, watcher loop, response formatting
  router.ts     → Intent detection (heuristic-first, LLM fallback)
  analyzer.ts   → LLM-powered profile building + intent matching
  contacts.ts   → Contact discovery via listChats()
  groups.ts     → Group chat scanning + per-contact group mapping
  cache.ts      → JSON file cache at ~/.whymessage/cache.json
  prompts.ts    → All LLM prompt templates
  utils.ts      → Shared helpers (relativeTime, safeParseJSON)
  sdk-types.ts  → Typed interface for Photon SDK
  types.ts      → Shared TypeScript interfaces
```

**Classification strategy:** Heuristic rules handle the common cases (exact name match, trigger phrases like "tell me about X", no-name-found = intent). LLM classifier only fires for ambiguous inputs (name + other words). This keeps response time fast.

**Caching:** Profiles are cached to `~/.whymessage/cache.json` and refreshed after 24 hours. Cold start builds all profiles in batches of 5. Background refresh runs every 30 minutes.

## Stack

- TypeScript + Node.js
- [Photon SDK](https://github.com/photon-hq/imessage-kit) — iMessage read/write
- [Claude API](https://docs.anthropic.com) — conversation analysis + matching
- Zero UI — everything happens in iMessage

## Why This Exists

Your contacts app is dead data. Your message history is alive — full of context about who you are to each other, what you've done together, what you care about. WhyMessage is the first agent that turns those conversations into actionable relationship intelligence, right where the conversations happen.

Built for the Photon residency.
