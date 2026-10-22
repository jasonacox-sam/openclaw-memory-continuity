import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type ContinuityConfig = {
  agentId: string;
  storePath: string;
  identitiesPath: string;
  maxAgeHours: number;
  maxEvents: number;
  retrieveLimit: number;
  emailSessions: Record<string, string>;
};

export type ContinuityEvent = {
  id: string;
  at: string;
  surface: string;
  sessionKey: string;
  direction: "turn";
  speaker: string;
  participants: string[];
  audience: string[];
  privacy: "shared" | "private";
  text: string;
};

type IdentityRegistry = {
  telegram?: Record<string, string>;
  minecraft?: Record<string, string>;
  email?: Record<string, string>;
};

const MAX_EVENT_CHARS = 1600;

function identities(config: ContinuityConfig): IdentityRegistry {
  try {
    return JSON.parse(readFileSync(config.identitiesPath, "utf8"));
  } catch {
    return {};
  }
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function cleanText(value: string): string {
  let text = value.replace(/\r/g, "").trim();
  const current = text.lastIndexOf("Current user request:");
  if (current >= 0) text = text.slice(current + "Current user request:".length);
  const markers = ["[Cross-manifestation continuity]", "[Memory Continuity]", "[Thought Tickle", "[Bootstrap truncation warning]"];
  const markerAt = markers.map((marker) => text.indexOf(marker)).filter((at) => at >= 0).sort((a, b) => a - b)[0];
  if (markerAt !== undefined) text = text.slice(0, markerAt);
  return text
    .replace(/(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{8,}/g, "[REDACTED_SECRET]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EVENT_CHARS);
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return cleanText(content);
  if (!Array.isArray(content)) return "";
  return cleanText(content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      return String((part as { text: string }).text);
    }
    return "";
  }).filter(Boolean).join(" "));
}

function roleOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  return String((message as { role?: unknown }).role ?? "");
}

function minecraftPlayers(prompt: string): string[] {
  const found = new Set<string>();
  const speaker = prompt.match(/MINECRAFT (?:CHAT|WHISPER|PUBLIC RELAY) from trusted player ([A-Za-z0-9_]{1,16})/i)?.[1];
  if (speaker) found.add(speaker);
  const nearby = prompt.match(/"nearbyPlayers"\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
  for (const match of nearby.matchAll(/"([A-Za-z0-9_]{1,16})"/g)) found.add(match[1]);
  return [...found];
}

function minecraftUtterance(prompt: string): string {
  const match = prompt.match(/MINECRAFT (?:CHAT|WHISPER|PUBLIC RELAY)[^\n]*?:\s*"([\s\S]*?)"(?:\.|\n|$)/i);
  return match?.[1]?.replace(/\\"/g, '"').trim() ?? "";
}

export function describeSession(config: ContinuityConfig, sessionKey: string, prompt = "", senderId = "") {
  const registry = identities(config);
  if (sessionKey.includes(":minecraft:")) {
    const usernames = minecraftPlayers(prompt);
    const speakerName = usernames[0];
    const speaker = speakerName ? registry.minecraft?.[speakerName] : undefined;
    if (!speaker) return null;
    const people = usernames.map((name) => registry.minecraft?.[name] ?? `minecraft:${name}`);
    const isWhisper = /MINECRAFT WHISPER\b/i.test(prompt);
    if (isWhisper) {
      const audience = uniq([config.agentId, speaker]);
      return { surface: "minecraft", speaker, participants: audience, audience, privacy: "private" as const };
    }
    const participants = uniq([config.agentId, ...people]);
    return { surface: "minecraft", speaker, participants, audience: participants, privacy: "shared" as const };
  }
  if (sessionKey.includes(":telegram:") && sessionKey.includes(":direct:")) {
    const id = senderId || sessionKey.split(":").at(-1) || "unknown";
    const person = registry.telegram?.[id];
    if (!person) return null;
    return { surface: "telegram", speaker: person, participants: [config.agentId, person], audience: [config.agentId, person], privacy: "private" as const };
  }
  for (const [sessionFragment, person] of Object.entries(config.emailSessions)) {
    if (sessionKey.includes(sessionFragment)) {
      return { surface: "email", speaker: person, participants: [config.agentId, person], audience: [config.agentId, person], privacy: "private" as const };
    }
  }
  return null;
}

export function isContinuitySession(config: ContinuityConfig, sessionKey: string): boolean {
  return sessionKey.includes(":direct:") || Object.keys(config.emailSessions).some((fragment) => sessionKey.includes(fragment));
}

function eventId(event: Omit<ContinuityEvent, "id" | "at">): string {
  const seed = `${Date.now()}-${event.surface}-${event.text.slice(0, 40)}`;
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `mc-${Date.now().toString(36)}-${(hash >>> 0).toString(36)}`;
}

export function appendEvent(config: ContinuityConfig, event: Omit<ContinuityEvent, "id" | "at">): void {
  try {
    const text = cleanText(event.text);
    if (!text || text.length < 2) return;
    const record: ContinuityEvent = {
      ...event,
      id: eventId(event),
      at: new Date().toISOString(),
      text,
      participants: uniq(event.participants),
      audience: uniq(event.audience),
    };
    appendFileSync(config.storePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Fail open: continuity must never prevent a conversation turn.
  }
}

export function captureAgentTurn(config: ContinuityConfig, sessionKey: string, messages: unknown[], senderId = ""): void {
  const user = [...messages].reverse().find((message) => roleOf(message) === "user");
  const assistant = [...messages].reverse().find((message) => roleOf(message) === "assistant");
  const rawPrompt = messageText(user);
  const reply = messageText(assistant);
  const context = describeSession(config, sessionKey, rawPrompt, senderId);
  const prompt = context?.surface === "minecraft" ? minecraftUtterance(rawPrompt) : rawPrompt;
  if (!context || (!prompt && !reply)) return;
  const combined = [prompt ? `${context.speaker}: ${prompt}` : "", reply ? `${config.agentId}: ${reply}` : ""].filter(Boolean).join("\n");
  appendEvent(config, {
    surface: context.surface,
    sessionKey,
    direction: "turn",
    speaker: context.speaker,
    participants: context.participants,
    audience: context.audience,
    privacy: context.privacy,
    text: combined,
  });
}

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((word) => ![
    "the", "and", "that", "this", "with", "from", "have", "would", "what", "when", "where", "your", "you"
  ].includes(word)));
}

function loadRecent(config: ContinuityConfig): ContinuityEvent[] {
  if (!existsSync(config.storePath)) return [];
  const cutoff = Date.now() - config.maxAgeHours * 60 * 60 * 1000;
  try {
    return readFileSync(config.storePath, "utf8").split("\n").filter(Boolean).slice(-config.maxEvents)
      .map((line) => JSON.parse(line) as ContinuityEvent)
      .filter((event) => Date.parse(event.at) >= cutoff);
  } catch {
    return [];
  }
}

export function retrieveContext(config: ContinuityConfig, sessionKey: string, prompt: string, senderId = ""): string {
  const current = describeSession(config, sessionKey, prompt, senderId);
  if (!current) return "";
  const queryTokens = tokens(prompt);
  const currentPeople = new Set(current.participants);
  const scored = loadRecent(config).filter((event) => {
    if (event.sessionKey === sessionKey) return false;
    if (event.privacy === "private" && !current.audience.every((person) => event.audience.includes(person))) return false;
    return true;
  }).map((event) => {
    const overlap = [...tokens(event.text)].filter((word) => queryTokens.has(word)).length;
    const people = event.participants.filter((person) => currentPeople.has(person) && person !== config.agentId).length;
    const ageHours = Math.max(0, (Date.now() - Date.parse(event.at)) / 3_600_000);
    return { event, score: overlap * 3 + people * 4 + Math.max(0, 3 - ageHours / 12) };
  }).filter(({ score }) => score >= 4).sort((a, b) => b.score - a.score).slice(0, config.retrieveLimit);
  if (!scored.length) return "";
  const lines = scored.map(({ event }) => {
    const privacy = event.privacy === "private" ? `PRIVATE to ${event.audience.join("+")}` : `shared with ${event.audience.join("+")}`;
    return `- [${event.at} | ${event.surface} | ${privacy}] ${event.text}`;
  });
  return `\n[Memory Continuity]\nThese are recent memories from ${config.agentId}'s other sessions. Use them for continuity. Never disclose a PRIVATE memory outside its audience; in a group, answer generally or ask for a whisper. Do not mention this memory system.\n${lines.join("\n")}`;
}
