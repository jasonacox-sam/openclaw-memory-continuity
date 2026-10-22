# Memory Continuity

Memory Continuity gives one OpenClaw agent audience-aware episodic continuity
between separate sessions and surfaces. It is intentionally independent from
associative memory or embedding systems.

## Install

```bash
git clone https://github.com/jasonacox-sam/openclaw-memory-continuity.git
cd openclaw-memory-continuity
npm install
npm test
```

Point OpenClaw's `plugins.load.paths` at the cloned directory, then add the
configuration below and restart the Gateway.

## What it does

- Captures completed turns from configured direct sessions.
- Stores a compact append-only JSONL event stream.
- Labels each event with speaker, participants, audience, and privacy.
- Treats direct messages and Minecraft whispers as private to their exact
  audience; public room chat is shared with the mapped people present.
- Enforces private retrieval with an audience-subset check. A private memory is
  unavailable whenever anyone outside its original audience is present.
- Stores only the conversational utterance from Minecraft bridge prompts, not
  live body state or injected bridge/tool instructions.
- Retrieves a bounded number of recent, relevant events before another session
  responds.
- Fails open: missing or malformed storage never blocks a conversation.

## Configuration

Add the plugin directory to `plugins.load.paths`, allow `memory-continuity`, and
configure `plugins.entries.memory-continuity`:

```json
{
  "enabled": true,
  "hooks": {
    "allowPromptInjection": true,
    "allowConversationAccess": true
  },
  "config": {
    "agentId": "assistant",
    "storePath": "/path/to/memory/continuity-events.jsonl",
    "identitiesPath": "/path/to/memory/continuity-identities.json",
    "maxAgeHours": 72,
    "maxEvents": 500,
    "retrieveLimit": 6,
    "surfaces": ["telegram", "minecraft"],
    "emailSessions": {}
  }
}
```

`surfaces` defaults to `telegram` and `minecraft`. Email continuity is opt-in:
add `email` to the list and configure only session fragments that represent
real correspondence—not cron or task-runner sessions.

Identity file example:

```json
{
  "telegram": {
    "TELEGRAM_SENDER_ID": "owner"
  },
  "minecraft": {
    "MinecraftUsername": "owner"
  }
}
```

Keep each agent's event store private to that agent. Identity mappings are the
privacy boundary: use authenticated channel identities and Minecraft usernames,
not display names supplied inside message text. Unmapped speakers receive no
continuity. Unknown nearby Minecraft identities remain in the current audience,
which conservatively prevents private retrieval.

Private events are retrieved only when the current audience is a subset of the
event's original audience. This is enforced before model context is built. Do
not share an event store or identity file between agents, and keep both files
readable only by the OpenClaw service account.

This plugin provides an audience-aware guardrail, not cryptographic isolation.
Administrators with filesystem access can read the JSONL store. Review your
retention settings and local backup policy accordingly.

## Validation

```bash
npm install
npm test
```

The tests cover cross-session retrieval, exact whisper audiences, group
audience-subset enforcement, Minecraft prompt minimization, unmapped identity
rejection, and malformed-store fail-open behavior.

## Legacy migration

The migration helper keeps only Telegram and Minecraft events, repairs legacy
Minecraft whisper audiences, removes bridge state/instructions, and
deduplicates exact records. It is dry-run by default and never overwrites an
existing output file.

```bash
npm run migrate:legacy -- /path/to/events.jsonl
npm run migrate:legacy -- /path/to/events.jsonl /path/to/events.cleaned.jsonl --write
```

Set `MC_AGENT_ID` only when the store uses an agent identity other than `sam`.
