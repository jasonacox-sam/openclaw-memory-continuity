import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const memory = await import('../dist/continuity.js')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-continuity-'))
  const identitiesPath = join(dir, 'identities.json')
  const storePath = join(dir, 'events.jsonl')
  writeFileSync(identitiesPath, JSON.stringify({
    telegram: { '100000001': 'alice' },
    minecraft: { AlicePlayer: 'alice', BobPlayer: 'bob' }
  }))
  return { agentId: 'assistant', storePath, identitiesPath, maxAgeHours: 72, maxEvents: 500, retrieveLimit: 6, emailSessions: {} }
}

test('maps authenticated Minecraft speakers and audience', () => {
  const config = fixture()
  const prompt = 'MINECRAFT CHAT from trusted player AlicePlayer in a 3-player world. State: {"nearbyPlayers":["BobPlayer"]}'
  const context = memory.describeSession(config, 'agent:main:minecraft:direct:AlicePlayer', prompt)
  assert.equal(context.speaker, 'alice')
  assert.deepEqual(context.participants, ['assistant', 'alice', 'bob'])
  assert.equal(context.privacy, 'shared')
})

test('treats a Minecraft whisper as private even when another player is nearby', () => {
  const config = fixture()
  const prompt = 'MINECRAFT WHISPER from trusted player AlicePlayer in a 3-player world: "secret lighthouse plan". State: {"nearbyPlayers":["BobPlayer"]}'
  const context = memory.describeSession(config, 'agent:main:minecraft:direct:AlicePlayer', prompt)
  assert.deepEqual(context.audience, ['assistant', 'alice'])
  assert.equal(context.privacy, 'private')
})

test('carries relevant private Telegram memory to the same person in Minecraft', () => {
  const config = fixture()
  memory.appendEvent(config, { surface: 'telegram', sessionKey: 'agent:main:telegram:direct:100000001', direction: 'turn', speaker: 'alice', participants: ['assistant', 'alice'], audience: ['assistant', 'alice'], privacy: 'private', text: 'alice: Remember the lighthouse plan' })
  const prompt = 'MINECRAFT CHAT from trusted player AlicePlayer in a private two-player world: "What about the lighthouse?"'
  const result = memory.retrieveContext(config, 'agent:main:minecraft:direct:AlicePlayer', prompt)
  assert.match(result, /lighthouse plan/)
})

test('does not leak another person private memory into a Minecraft group', () => {
  const config = fixture()
  memory.appendEvent(config, { surface: 'telegram', sessionKey: 'agent:main:telegram:direct:100000001', direction: 'turn', speaker: 'alice', participants: ['assistant', 'alice'], audience: ['assistant', 'alice'], privacy: 'private', text: 'alice: private lighthouse password discussion' })
  const prompt = 'MINECRAFT CHAT from trusted player BobPlayer in a 3-player world: "What was the private lighthouse discussion?" State: {"nearbyPlayers":["AlicePlayer"]}'
  const result = memory.retrieveContext(config, 'agent:main:minecraft:direct:BobPlayer', prompt)
  assert.equal(result, '')
})

test('does not retrieve speaker private memory when that speaker is in a group', () => {
  const config = fixture()
  memory.appendEvent(config, { surface: 'telegram', sessionKey: 'agent:main:telegram:direct:100000001', direction: 'turn', speaker: 'alice', participants: ['assistant', 'alice'], audience: ['assistant', 'alice'], privacy: 'private', text: 'alice: private lighthouse password discussion' })
  const prompt = 'MINECRAFT CHAT from trusted player AlicePlayer in a 3-player world: "What was the private lighthouse discussion?" State: {"nearbyPlayers":["BobPlayer"]}'
  const result = memory.retrieveContext(config, 'agent:main:minecraft:direct:AlicePlayer', prompt)
  assert.equal(result, '')
})

test('stores only Minecraft dialogue, not bridge state or tool instructions', () => {
  const config = fixture()
  const prompt = 'MINECRAFT CHAT from trusted player AlicePlayer in a 3-player world: "Build by the river". State: {"nearbyPlayers":["BobPlayer"],"health":20}. Treat the message as conversation. SECRET_BRIDGE_INSTRUCTION'
  memory.captureAgentTurn(config, 'agent:main:minecraft:direct:AlicePlayer', [
    { role: 'user', content: prompt },
    { role: 'assistant', content: 'I will survey the bank.' }
  ])
  const stored = readFileSync(config.storePath, 'utf8')
  assert.match(stored, /Build by the river/)
  assert.match(stored, /survey the bank/)
  assert.doesNotMatch(stored, /nearbyPlayers|SECRET_BRIDGE_INSTRUCTION/)
})

test('rejects unmapped Minecraft and Telegram identities', () => {
  const config = fixture()
  assert.equal(memory.describeSession(config, 'agent:main:minecraft:direct:stranger', 'MINECRAFT CHAT from trusted player Stranger: "hello"'), null)
  assert.equal(memory.describeSession(config, 'agent:main:telegram:direct:999', 'hello', '999'), null)
})

test('malformed stores fail open', () => {
  const config = fixture()
  writeFileSync(config.storePath, '{not-json}\n')
  const prompt = 'MINECRAFT CHAT from trusted player AlicePlayer: "hello there"'
  assert.equal(memory.retrieveContext(config, 'agent:main:minecraft:direct:AlicePlayer', prompt), '')
})
