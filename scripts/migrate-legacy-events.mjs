#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const write = args.includes('--write')
const positional = args.filter((arg) => arg !== '--write')

if (positional.length < 1 || positional.length > 2) {
  console.error('Usage: node scripts/migrate-legacy-events.mjs <input.jsonl> [output.jsonl] [--write]')
  process.exit(2)
}

const inputPath = resolve(positional[0])
const outputPath = resolve(positional[1] ?? `${inputPath}.migrated`)
const agentId = process.env.MC_AGENT_ID || 'sam'
const maxChars = 1600

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

function compact(value) {
  return String(value ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function splitReply(text) {
  const marker = ` ${agentId}: `
  const at = text.lastIndexOf(marker)
  if (at < 0) return { user: text, reply: '' }
  return { user: text.slice(0, at), reply: text.slice(at + marker.length) }
}

function migrateMinecraft(event) {
  const source = String(event.text ?? '')
  const kind = source.match(/MINECRAFT (CHAT|WHISPER|PUBLIC RELAY)\b/i)?.[1]?.toUpperCase()
  const utterance = source.match(/MINECRAFT (?:CHAT|WHISPER|PUBLIC RELAY)[\s\S]*?:\s*"([\s\S]*?)"(?:\.|\sSam's live body state:|$)/i)?.[1]
  if (!kind || !utterance) return null

  const { reply } = splitReply(source)
  const speaker = String(event.speaker ?? '').trim()
  if (!speaker) return null
  const isWhisper = kind === 'WHISPER'
  const audience = isWhisper ? uniq([agentId, speaker]) : uniq(event.audience ?? event.participants ?? [agentId, speaker])
  const text = compact(`${speaker}: ${utterance}${reply ? `\n${agentId}: ${reply}` : ''}`)

  return {
    ...event,
    participants: audience,
    audience,
    privacy: isWhisper ? 'private' : 'shared',
    text
  }
}

function migrateTelegram(event) {
  const speaker = String(event.speaker ?? '').trim()
  if (!speaker) return null
  const source = String(event.text ?? '')
  const { user: originalUser, reply } = splitReply(source)
  let user = originalUser.replace(new RegExp(`^${speaker}:\\s*`, 'i'), '')
  const current = user.lastIndexOf('Current user request:')
  if (current >= 0) user = user.slice(current + 'Current user request:'.length)
  user = user
    .replace(/^Conversation info[^`]*```[\s\S]*?```\s*/i, '')
    .replace(/^System:\s*\[[^\]]+\]\s*/i, '')
    .replace(/\[Memory Continuity\][\s\S]*$/i, '')
    .trim()
  if (!user) return null
  const audience = uniq([agentId, speaker])
  return {
    ...event,
    participants: audience,
    audience,
    privacy: 'private',
    text: compact(`${speaker}: ${user}${reply ? `\n${agentId}: ${reply}` : ''}`)
  }
}

function migrate(event) {
  if (!event || typeof event !== 'object') return null
  if (event.surface === 'minecraft') return migrateMinecraft(event)
  if (event.surface === 'telegram') return migrateTelegram(event)
  return null
}

const lines = readFileSync(inputPath, 'utf8').split('\n').filter(Boolean)
const stats = { input: lines.length, output: 0, droppedInvalid: 0, droppedSurface: 0, droppedDuplicate: 0 }
const seen = new Set()
const migrated = []

for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    stats.droppedInvalid += 1
    continue
  }
  if (!['telegram', 'minecraft'].includes(event.surface)) {
    stats.droppedSurface += 1
    continue
  }
  const next = migrate(event)
  if (!next?.text) {
    stats.droppedInvalid += 1
    continue
  }
  const key = JSON.stringify([next.surface, next.speaker, next.audience, next.text])
  if (seen.has(key)) {
    stats.droppedDuplicate += 1
    continue
  }
  seen.add(key)
  migrated.push(next)
}

stats.output = migrated.length
const output = `${migrated.map((event) => JSON.stringify(event)).join('\n')}\n`
const report = {
  mode: write ? 'write' : 'dry-run',
  inputPath,
  inputBytes: statSync(inputPath).size,
  outputPath,
  projectedOutputBytes: Buffer.byteLength(output),
  ...stats
}

if (write) {
  if (existsSync(outputPath)) {
    console.error(`Refusing to overwrite existing output: ${outputPath}`)
    process.exit(1)
  }
  writeFileSync(outputPath, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

console.log(JSON.stringify(report, null, 2))
