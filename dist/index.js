import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureAgentTurn, isContinuitySession, retrieveContext } from "./continuity.js";
const DEFAULT_MEMORY_DIR = join(homedir(), ".openclaw", "memory");
const DEFAULT_STORE = join(DEFAULT_MEMORY_DIR, "continuity-events.jsonl");
const DEFAULT_IDENTITIES = join(DEFAULT_MEMORY_DIR, "continuity-identities.json");
function readConfig(value) {
    return {
        agentId: typeof value.agentId === "string" ? value.agentId : "agent",
        storePath: typeof value.storePath === "string" ? value.storePath : DEFAULT_STORE,
        identitiesPath: typeof value.identitiesPath === "string" ? value.identitiesPath : DEFAULT_IDENTITIES,
        maxAgeHours: typeof value.maxAgeHours === "number" ? value.maxAgeHours : 72,
        maxEvents: typeof value.maxEvents === "number" ? value.maxEvents : 500,
        retrieveLimit: typeof value.retrieveLimit === "number" ? value.retrieveLimit : 6,
        surfaces: Array.isArray(value.surfaces)
            ? value.surfaces.filter((surface) => ["telegram", "minecraft", "email"].includes(String(surface)))
            : ["telegram", "minecraft"],
        emailSessions: value.emailSessions && typeof value.emailSessions === "object" && !Array.isArray(value.emailSessions)
            ? value.emailSessions
            : {},
    };
}
const memoryContinuityPlugin = definePluginEntry({
    id: "memory-continuity",
    name: "Memory Continuity",
    description: "Audience-aware episodic continuity across OpenClaw sessions and surfaces.",
    configSchema: {
        safeParse(value) {
            return { success: true, data: (value && typeof value === "object" ? value : {}) };
        },
        jsonSchema: { type: "object", additionalProperties: true },
    },
    register(api) {
        const config = readConfig(api.pluginConfig ?? {});
        api.on("before_prompt_build", async (event, hookCtx) => {
            const ev = event;
            const ctx = hookCtx;
            const sessionKey = ctx?.sessionKey ?? "";
            if (!isContinuitySession(config, sessionKey))
                return;
            const continuity = retrieveContext(config, sessionKey, ev.prompt ?? "", ctx?.senderId ?? "");
            return continuity ? { appendContext: continuity } : undefined;
        }, { priority: 80 });
        api.on("agent_end", async (event, hookCtx) => {
            const ev = event;
            const ctx = hookCtx;
            const sessionKey = ctx?.sessionKey ?? "";
            if (ev.success === false || !Array.isArray(ev.messages) || !isContinuitySession(config, sessionKey))
                return;
            captureAgentTurn(config, sessionKey, ev.messages, ctx?.senderId ?? "");
        }, { priority: 20 });
    },
});
export default memoryContinuityPlugin;
