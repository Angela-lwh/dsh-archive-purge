/**
 * End-to-end exercise of the deletion route against the RUNNING Host.
 *
 * It never touches a Session that already exists on this machine:
 *
 *   1. creates one throwaway Session through the product's own Remote API, in the
 *      throwaway project directory that already exists, and materializes its log
 *      by renaming it;
 *   2. archives it through the product's own archive API;
 *   3. asks the plugin to delete it and then proves, from the outside, that the
 *      log directory, the archive mark, the Workspace membership, and the Session
 *      list all agree it is gone;
 *   4. separately proves the protective refusals on real data — an archived
 *      subagent Session must be refused, and that check is reversible
 *      (archive → refuse → unarchive).
 *
 * A Session created through `session/create` is live in the Host process
 * (`agents.ensureSession` always returns a live ordinary Agent), and the plugin
 * deliberately refuses live Sessions, so step 3 may legitimately report
 * `archive-purge/session-live`. When that happens nothing is deleted and the
 * throwaway Session is left archived — hidden by the default sidebar filter, and a
 * ready-made target for a click after the next Host restart.
 *
 * Usage: node tools/e2e-delete.mjs [--port 19387] [--wait-seconds 60]
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const home = readOption('--home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const port = Number(readOption('--port') ?? new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').port)
const waitSeconds = Number(readOption('--wait-seconds') ?? 60)
const authority = `127.0.0.1:${String(port)}`
const DELETE_ROUTE = '/api/archive-purge/deleteSession'
/**
 * Project directory the throwaway Session is created in. Defaults to the directory this
 * script runs from, so it lands in an already-registered Workspace whose project
 * directory survives the deletion; override with DSH_ARCHIVE_PURGE_CWD.
 */
const CWD = process.env.DSH_ARCHIVE_PURGE_CWD ?? process.cwd()
const SESSIONS_ROOT = join(home, 'sessions')
const WORKSPACE_STORE = join(home, 'storages', 'workspace.json')

let failures = 0
/** Whether step 3 deleted the throwaway Session. */
let deleted = false
const results = []
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  results.push(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
  console.log(results.at(-1))
}

const secret = await readSecret(home)
const cookie = mintCookie(authority, secret)
const before = readWorkspaceStore()
console.log(`workspace: ${String(before.archivedSessionIds.length)} archived, ${String(Object.keys(before.workspaces).length)} registered\n`)

// ---- 1. create a throwaway Session and give it a materialized log --------------

const created = await remote('session/create', { request: { cwd: CWD } })
check('session/create returns an id', created.ok === true && typeof created.value?.sessionId === 'string', JSON.stringify(created).slice(0, 160))
if (!created.ok) finish()
const sessionId = created.value.sessionId
console.log(`\nthrowaway session: ${sessionId}`)

const renamed = await remote('session/rename', { request: { sessionId, title: 'dsh-archive-purge end-to-end probe' } })
check('session/rename materializes the log', renamed.ok === true, JSON.stringify(renamed).slice(0, 160))

const directory = sessionDirectory(CWD, sessionId)
check('the log directory exists on disk', existsSync(directory), directory)

// ---- 2. archive it through the product's own API -------------------------------

const archived = await remote('workspace/archiveSession', { request: { sessionId } })
check('workspace/archiveSession succeeds', archived.ok === true, JSON.stringify(archived).slice(0, 160))
const listedAfterArchive = readWorkspaceStore()
check('the durable archive set now contains it', listedAfterArchive.archivedSessionIds.includes(sessionId))

// ---- 3. the plugin's own refusal while the Session is live ---------------------

let firstProbe = await probeDelete(sessionId)
console.log(`plugin said: ${JSON.stringify(firstProbe.body).slice(0, 200)}`)

if (firstProbe.body?.ok !== true) {
  // Wait out the Host's hold, in case it releases an unretained Session.
  const until = Date.now() + waitSeconds * 1000
  while (firstProbe.body?.ok !== true && Date.now() < until) {
    await sleep(5000)
    firstProbe = await probeDelete(sessionId)
    console.log(`  … still ${String(firstProbe.body?.error?.code ?? 'ok')}`)
  }
}

if (firstProbe.body?.ok === true) {
  deleted = true
  check('the plugin deleted it', firstProbe.body.value?.deleted === true, JSON.stringify(firstProbe.body.value))
  check('the log directory is gone', !existsSync(directory), directory)
  check('the project directory survives', existsSync(join(SESSIONS_ROOT, projectKey(CWD))))

  const after = readWorkspaceStore()
  check('the archive mark was cleared', !after.archivedSessionIds.includes(sessionId))
  check('the Workspace membership was pruned', !membershipOf(after).includes(sessionId), `members=${String(membershipOf(after).length)}`)

  const listed = await remote('session/list', { _request: {} })
  const ids = (listed.value?.items ?? []).map((item) => item.sessionId)
  check('session/list no longer reports it', !ids.includes(sessionId), `${String(ids.length)} sessions listed`)
} else {
  // The loaded case ends in one of two correct refusals. The happy path — the
  // plugin releases an archived idle Session and deletes it outright — is covered
  // end to end by `e2e-immediate-delete.mjs`; what is asserted here is that when
  // the plugin does *not* delete, it says so and stages or refuses instead of
  // pretending. `session-live` never appears: that code means work in progress,
  // which this Session never has.
  const code = firstProbe.body?.error?.code
  const deferred = code === 'archive-purge/session-deferred'
  check('a Session the Host would not release is staged or refused, never deleted',
    deferred || code === 'archive-purge/session-loaded', String(code))
  check('the log directory is untouched', existsSync(directory))
  check('it stays archived (hidden by the default filter)', readWorkspaceStore().archivedSessionIds.includes(sessionId))
  if (deferred) {
    check('the staged purge names it in the pending store', readPending().includes(sessionId),
      `pending=${JSON.stringify(readPending())}`)
    // The retry that replaces a Host restart is honest about a Session it still
    // cannot release: the entry stays staged instead of being deleted or dropped.
    const retried = await probeDelete(sessionId, { action: 'retryPending' })
    const report = retried.body?.value
    check('the on-demand pass reports the Session as still staged',
      retried.body?.ok === true && report?.deleted === 0 && report?.remaining?.includes(sessionId),
      JSON.stringify(report ?? retried.body).slice(0, 200))
    check('the retry left the store untouched', readPending().includes(sessionId))
  }
}

// ---- 4. a protective refusal on REAL pre-existing data, fully reversible -------

const catalog = await remote('session/list', { _request: {} })
const catalogItems = catalog.value?.items ?? []
const listedIds = new Set(catalogItems.map((item) => item.sessionId))
// Only a child whose parent still exists is the guarded case: a subagent Session whose
// parent is gone is a leftover the plugin now deletes, and this script never deletes a
// Session it did not create.
const subagent = catalogItems.find((item) => item.origin === 'subagent' && item.agentAvailable === false
  && item.parentSessionId !== undefined && listedIds.has(item.parentSessionId))
if (subagent === undefined) {
  console.log('\nno cold subagent Session to test the subagent guard; skipped')
} else {
  console.log(`\nsubagent session for the guard test: ${subagent.sessionId}`)
  const armed = await remote('workspace/archiveSession', { request: { sessionId: subagent.sessionId } })
  check('archiving the subagent Session succeeds', armed.ok === true, JSON.stringify(armed).slice(0, 140))
  const refused = await probeDelete(subagent.sessionId)
  check('an archived subagent Session is refused', refused.body?.error?.code === 'archive-purge/subagent', String(refused.body?.error?.code))
  const disarmed = await remote('workspace/unarchiveSession', { request: { sessionId: subagent.sessionId } })
  check('it is restored to unarchived', disarmed.ok === true && !(disarmed.value?.archivedSessionIds ?? []).includes(subagent.sessionId))
}

// ---- 5. the pre-existing Sessions are untouched --------------------------------

const finalStore = readWorkspaceStore()
const beforeIds = new Set(Object.keys(before.workspaces))
const afterIds = new Set(Object.keys(finalStore.workspaces))
check('no Workspace registration was added or removed', beforeIds.size === afterIds.size, `${String(beforeIds.size)} -> ${String(afterIds.size)}`)
// This run adds at most one archived id of its own, and removes it only when the
// Host had already released it. Everything that was archived before is still
// archived: nothing here touches a Session it did not create.
const added = finalStore.archivedSessionIds.filter((id) => !before.archivedSessionIds.includes(id))
check('the archived set is back to what this run did not touch',
  before.archivedSessionIds.every((id) => finalStore.archivedSessionIds.includes(id)) && added.length <= 1,
  `before=${String(before.archivedSessionIds.length)} after=${String(finalStore.archivedSessionIds.length)} added=${JSON.stringify(added)}`)

finish()

/** Report and exit. */
function finish() {
  console.log(`\n${failures === 0 ? 'e2e: all checks passed' : `e2e: ${String(failures)} check(s) failed`}`)
  if (!deletedNow()) {
    console.log('\nnote: the throwaway Session above is archived, staged, and still on disk.')
    console.log('      it is removed by the next Host start, or on demand from the row menu')
    console.log('      ("Finish pending deletions") once the Host has released that Session.')
  }
  process.exitCode = failures === 0 ? 0 : 1
  process.exit()
}

/** Whether step 3 deleted the throwaway Session (set by the caller scope). */
function deletedNow() {
  return deleted
}

/** Read the durable workspace domain: archive set, pin set, and membership. */
function readWorkspaceStore() {
  const parsed = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
  const global = parsed.global ?? {}
  const workspaces = {}
  for (const [id, record] of Object.entries(parsed.tables?.workspaces ?? {})) workspaces[id] = record
  return {
    archivedSessionIds: Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [],
    pinnedSessionIds: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : [],
    workspaces,
  }
}

/** Every Session id any Workspace still accounts for. */
function membershipOf(store) {
  return Object.values(store.workspaces).flatMap((record) => (Array.isArray(record.sessionIds) ? record.sessionIds : []))
}

/** The stored directory of one Session, mirroring the persistence backend's layout. */
function sessionDirectory(cwd, id) {
  return join(SESSIONS_ROOT, projectKey(cwd), encodeSegment(id))
}

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

/** Call the plugin's own route. */
/**
 * One call on the plugin's route. The body is the caller's, so the same helper
 * drives `delete` (the default verb) and the `retryPending` pass.
 * @param sessionId - target Session, or undefined for a verb that takes none.
 * @param extra - additional body fields, such as `action`.
 * @returns the parsed response.
 */
function probeDelete(sessionId, extra = {}) {
  return sendJson(DELETE_ROUTE, { ...(sessionId === undefined ? {} : { sessionId }), ...extra })
}

/** The Session ids the plugin has staged for a purge it could not complete. */
function readPending() {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'archive-purge', 'pending.json'), 'utf8'))
    return Array.isArray(parsed?.sessionIds) ? parsed.sessionIds : []
  } catch {
    return []
  }
}

/** One Remote call: `POST /api/<namespace>/<method>` with `{args:{<param>:value}}`. */
async function remote(method, args) {
  const response = await sendJson(`/api/${method}`, {
    type: 'client-request',
    rpcId: randomUUID(),
    method,
    payload: { args },
  })
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
  if (match === null) throw new Error('no client-connection/browser-session secret in the credential file')
  const encoded = match[1]
  const padding = '='.repeat((4 - (encoded.length % 4)) % 4)
  const bytes = Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  if (bytes.byteLength !== 32) throw new Error(`unexpected browser-session secret length ${String(bytes.byteLength)}`)
  return bytes
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
  const signature = base64url(createHmac('sha256', secretBytes).update(body).digest())
  return `${name}=v1.${body}.${signature}`
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

/** Await a fixed delay. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
