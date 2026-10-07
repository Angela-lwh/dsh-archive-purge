/**
 * End-to-end exercise of the REAL destructive path against the running Host.
 *
 * Every Session that already exists on this machine is user data, and a Session
 * created through `session/create` is always live — so the plugin's own (correct)
 * live guard refuses it. This script therefore manufactures a genuinely *stored*
 * Session that is not live, out of a legitimate template:
 *
 *   1. take the log DSH itself wrote for the throwaway Session, decompress it, and
 *      rewrite only the header's `id` field, leaving `cwd` and every event alone;
 *   2. write it under the new identity in the same project directory;
 *   3. validate it with DSH's own APIs before trusting it — `session/list` must
 *      report it, and `session/rename` must accept it as writable (a mismatch
 *      between the rewritten header and its event stream fails here);
 *   4. archive it, then ask the plugin to delete it;
 *   5. prove from the outside that the directory is gone and that the archive mark,
 *      the Session list, the Workspace membership, and every pre-existing Session
 *      are all left correct.
 *
 * Anything that goes wrong aborts before deletion, and the `finally` block removes
 * the manufactured Session and restores the archive set.
 *
 * Usage: node tools/e2e-forged-delete.mjs --template <sessionId> [--port 19387]
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const home = readOption('--home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const port = Number(readOption('--port') ?? new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').port)
const authority = `127.0.0.1:${String(port)}`
const DELETE_ROUTE = '/api/archive-purge/deleteSession'
const SESSIONS_ROOT = join(home, 'sessions')
const WORKSPACE_STORE = join(home, 'storages', 'workspace.json')
const templateId = readOption('--template')
if (templateId === undefined) throw new Error('--template <sessionId> is required (an ordinary, already materialized Session)')

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}

const cookie = mintCookie(authority, await readSecret(home))
const archiveSetBefore = readArchiveSet()
const templateDir = findSessionDir(templateId)
if (templateDir === undefined) throw new Error(`template Session ${templateId} has no stored directory`)
const cwd = headerOf(templateDir).cwd
const forgedId = `session-${randomUUID()}`
let forgedDir
let armed = false
/** The deferred-purge store the plugin stages into. */
const PENDING_FILE = join(home, 'archive-purge', 'pending.json')

console.log(`template : ${templateId}  (${cwd})`)
console.log(`forged id: ${forgedId}\n`)

try {
  // ---- 1. manufacture a stored Session from a legitimate log ---------------------

  const logName = readdirSync(templateDir).find((name) => /^session(?:\.[A-Za-z0-9]+)*\.jsonl\.zstd$/u.test(name))
  if (logName === undefined) throw new Error(`template ${templateId} has no compressed log generation`)
  const plain = zstdDecompressSync(readFileSync(join(templateDir, logName))).toString('utf8')
  const newline = plain.indexOf('\n')
  if (newline === -1) throw new Error('template log has no header line')
  const header = JSON.parse(plain.slice(0, newline))
  if (header.id !== templateId) throw new Error(`template header id ${String(header.id)} does not match ${templateId}`)
  const rewritten = `${JSON.stringify({ ...header, id: forgedId })}${plain.slice(newline)}`

  forgedDir = join(SESSIONS_ROOT, projectKey(cwd), encodeSegment(forgedId))
  mkdirSync(forgedDir, { recursive: true })
  writeFileSync(join(forgedDir, logName), zstdCompressSync(Buffer.from(rewritten, 'utf8')))
  check('a stored log now exists under the new identity', existsSync(join(forgedDir, logName)), forgedDir)

  // ---- 2. let DSH validate it before anything destructive ------------------------

  const staged = argv.includes('--staged')
  // `session/list` reads the stored header through the persistence layer — the same
  // read `stat()` performs, and the only one this plugin's deletion path needs.
  // In the plain mode a rename is deliberately NOT issued: opening a stored Session
  // for write is what makes it live in the Host, which the plugin would then refuse
  // (the first run of this script demonstrated exactly that). In the staged mode the
  // rename IS the point — it produces the loaded-but-idle state the user hit.
  const listed = await remote('session/list', { _request: {} })
  const known = (listed.value?.items ?? []).find((item) => item.sessionId === forgedId)
  if (known === undefined) throw new Error('DSH does not list the manufactured Session; aborting before any deletion')
  check('DSH lists the manufactured Session', true, `cwd=${String(known.cwd)}`)
  check('it is reported as stored, not live', known.agentAvailable === false && known.running === false)
  if (staged) {
    const renamed = await remote('session/rename', { request: { sessionId: forgedId, title: 'dsh-archive-purge staged probe' } })
    if (renamed.ok !== true) throw new Error(`DSH refused to open the manufactured log: ${JSON.stringify(renamed)}`)
    const live = await remote('session/list', { _request: {} })
    const now = (live.value?.items ?? []).find((item) => item.sessionId === forgedId)
    check('the rename made it loaded, exactly like a Session the user just opened', now?.agentAvailable === true)
  } else {
    check('no rename was issued, so it stays cold', true)
  }

  // ---- 3. archive it, then hand it to the plugin -------------------------------

  const archived = await remote('workspace/archiveSession', { request: { sessionId: forgedId } })
  armed = archived.ok === true
  check('workspace/archiveSession succeeds', armed && archived.value.archivedSessionIds.includes(forgedId))
  check('the durable archive set contains it', readArchiveSet().includes(forgedId))

  const response = await sendJson(DELETE_ROUTE, { sessionId: forgedId })
  if (staged) {
    check('a loaded Session is staged instead of refused', response.body?.error?.code === 'archive-purge/session-deferred',
      String(response.body?.error?.code))
    check('the log is left alone until the next start', existsSync(forgedDir))
    check('the archive mark stays, as the authorization and the cancel switch', readArchiveSet().includes(forgedId))
    check('the deferred store records it', readPending().includes(forgedId), PENDING_FILE)
    check('the template Session is untouched', existsSync(templateDir))
  } else {
    check('the plugin deleted it', response.body?.ok === true && response.body.value?.deleted === true, JSON.stringify(response.body).slice(0, 220))
    check('it reported this exact directory', response.body?.value?.directory === forgedDir, String(response.body?.value?.directory))
    check('the log directory is gone', !existsSync(forgedDir))

    const after = readArchiveSet()
    check('the archive mark was cleared', !after.includes(forgedId))
    check('the Workspace membership was pruned', !membership().includes(forgedId))

    const relisted = await remote('session/list', { _request: {} })
    check('DSH no longer lists it', !(relisted.value?.items ?? []).some((item) => item.sessionId === forgedId))
    check('the template Session is untouched', existsSync(templateDir))
  }

  const store = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
  // The staged mode deliberately leaves the forged id archived (that mark is the
  // authorization the next start re-checks); the plain mode must leave the set exactly
  // as it found it.
  const expected = staged ? [...archiveSetBefore, forgedId].sort() : archiveSetBefore
  check('the archive set holds exactly what it should',
    JSON.stringify([...store.global.archivedSessionIds].sort()) === JSON.stringify(expected),
    JSON.stringify(store.global.archivedSessionIds))
} finally {
  // ---- cleanup: never leave the manufactured Session or its archive mark --------
  if (existsSync(forgedDir ?? '')) {
    rmSync(forgedDir, { recursive: true, force: true })
    console.log('cleanup: removed the manufactured Session directory')
  }
  if (armed || readArchiveSet().includes(forgedId)) {
    await remote('workspace/unarchiveSession', { request: { sessionId: forgedId } })
    console.log('cleanup: cleared the manufactured archive mark')
  }
  if (readPending().includes(forgedId)) {
    writeFileSync(PENDING_FILE, `${JSON.stringify({ version: 1, sessionIds: readPending().filter((id) => id !== forgedId) }, null, 2)}\n`, 'utf8')
    console.log('cleanup: removed the manufactured deferred-purge entry')
  }
}

console.log(`\n${failures === 0 ? 'forged e2e: all checks passed' : `forged e2e: ${String(failures)} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)

/** The stored directory of a Session id, searched the way the backend does. */
function findSessionDir(id) {
  for (const project of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const candidate = join(SESSIONS_ROOT, project.name, encodeSegment(id))
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** The header object of a stored Session directory. */
function headerOf(directory) {
  const logName = readdirSync(directory).find((name) => /^session(?:\.[A-Za-z0-9]+)*\.jsonl\.zstd$/u.test(name))
  if (logName === undefined) throw new Error(`no compressed log in ${directory}`)
  const plain = zstdDecompressSync(readFileSync(join(directory, logName))).toString('utf8')
  return JSON.parse(plain.slice(0, plain.indexOf('\n')))
}

/** The durable archive set. */
function readArchiveSet() {
  const parsed = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
  return Array.isArray(parsed.global?.archivedSessionIds) ? parsed.global.archivedSessionIds : []
}

/** The ids currently staged for the next Host start. */function readPending() {
  try {
    const parsed = JSON.parse(readFileSync(PENDING_FILE, 'utf8'))
    return Array.isArray(parsed.sessionIds) ? parsed.sessionIds : []
  } catch {
    return []
  }
}

/** Every Session id the Workspaces account for. */
function membership() {
  const parsed = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
  return Object.values(parsed.tables?.workspaces ?? {}).flatMap((record) => (Array.isArray(record.sessionIds) ? record.sessionIds : []))
}

/** Mirror of dsh-session-persistence-jsonl's `projectKey`. */
function projectKey(value) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}

/** Mirror of dsh-session-persistence-jsonl's `encodeSegment`. */
function encodeSegment(raw) {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)) out += character
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** One Remote call: `POST /api/<namespace>/<method>` with `{args:{<param>:value}}`. */
async function remote(method, args) {
  const response = await sendJson(`/api/${method}`, { type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
  const result = response.json?.result
  if (result === undefined) throw new Error(`no result envelope from ${method}: ${response.text.slice(0, 200)}`)
  return result
}

/** POST a JSON body to the authenticated carrier. */
function sendJson(path, body) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        host: authority,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        cookie,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
        resolve({ status: response.statusCode, text, json, body: json?.result ?? json })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

/** The durable browser-session signing secret, decoded to raw bytes. */
async function readSecret(dshHome) {
  const text = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8')
  const block = text.slice(text.indexOf('client-connection/browser-session:'))
  const match = /^\s*secret:\s*(\S+)\s*$/mu.exec(block)
  if (match === null) throw new Error('no browser-session secret in the credential file')
  const encoded = match[1]
  const padding = '='.repeat((4 - (encoded.length % 4)) % 4)
  return Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

/** Build the exact cookie `BrowserAuth` issues, one hour long. */
function mintCookie(forAuthority, secretBytes) {
  const name = `dsh-auth-${base64url(createHash('sha256').update(forAuthority).digest())}`
  const issuedAt = Date.now()
  const body = base64url(Buffer.from(JSON.stringify({
    version: 1,
    authority: forAuthority,
    issuedAt,
    expiresAt: issuedAt + 60 * 60 * 1000,
  }), 'utf8'))
  return `${name}=v1.${body}.${base64url(createHmac('sha256', secretBytes).update(body).digest())}`
}

/** base64url without padding, matching the Host's own encoder. */
function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Read one `--flag value` argument. */
function readOption(flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}
