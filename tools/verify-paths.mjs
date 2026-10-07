/**
 * Verify the Host half's fallback path derivation against every real session on
 * this machine, WITHOUT touching any session data.
 *
 * The plugin resolves a session directory from the persistence backend's own
 * `locate(meta)` when it is available, and otherwise re-implements the documented
 * layout. This script proves the re-implementation is exact: for every stored
 * session it reads only the compressed header line, derives the directory, and
 * compares it with where the log actually lives.
 *
 * Usage: node tools/verify-paths.mjs [sessionsRoot]
 */
import { createZstdDecompress } from 'node:zlib'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { once } from 'node:events'

const root = resolve(process.argv[2] ?? join(process.env.DSH_HOME ?? '', 'sessions'))
const LOG_FILE = /^session(?:\.[A-Za-z0-9]+)*\.jsonl\.zstd$/

/** Mirror of dsh-session-persistence-jsonl's `projectKey`. */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Mirror of dsh-session-persistence-jsonl's `encodeSegment`. */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Decompress just enough of the log to read its first line. */
async function readHeaderLine(path) {
  const source = createReadStream(path)
  const decoder = createZstdDecompress()
  source.pipe(decoder)
  let text = ''
  try {
    for await (const chunk of decoder) {
      text += chunk.toString('utf8')
      const newline = text.indexOf('\n')
      if (newline !== -1) return text.slice(0, newline)
      if (text.length > 1_000_000) break
    }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  } finally {
    source.destroy()
    decoder.destroy()
  }
  return text
}

/** Depth-first search for the first string value of `key`. */
function findKey(value, key) {
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKey(item, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const [name, item] of Object.entries(value)) {
    if (name === key && typeof item === 'string') return item
    const found = findKey(item, key)
    if (found !== undefined) return found
  }
  return undefined
}

let checked = 0
let mismatched = 0
let unreadable = 0
let samplePrinted = false

for (const projectEntry of readdirSync(root, { withFileTypes: true })) {
  if (!projectEntry.isDirectory()) continue
  const projectDir = join(root, projectEntry.name)
  for (const sessionEntry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!sessionEntry.isDirectory()) continue
    const actualDir = join(projectDir, sessionEntry.name)
    const logName = readdirSync(actualDir).find((name) => LOG_FILE.test(name))
    if (logName === undefined) {
      unreadable += 1
      continue
    }
    const line = await readHeaderLine(join(actualDir, logName))
    if (!samplePrinted) {
      samplePrinted = true
      console.log(`sample header line (${logName}):\n${String(line).slice(0, 600)}\n`)
    }
    if (typeof line !== 'string') {
      unreadable += 1
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      unreadable += 1
      continue
    }
    const cwd = findKey(parsed, 'cwd')
    const id = findKey(parsed, 'id') ?? sessionEntry.name
    if (cwd === undefined) {
      unreadable += 1
      continue
    }
    const derived = join(root, projectKey(cwd), encodeSegment(id))
    checked += 1
    if (resolve(derived) !== resolve(actualDir)) {
      mismatched += 1
      console.log(`MISMATCH\n  cwd       ${cwd}\n  derived   ${derived}\n  actual    ${actualDir}`)
    }
  }
}

console.log(`\nchecked=${checked} mismatched=${mismatched} unreadable=${unreadable}`)
if (statSync(root).isDirectory() !== true) process.exitCode = 1
process.exitCode = mismatched === 0 && checked > 0 ? 0 : 1
