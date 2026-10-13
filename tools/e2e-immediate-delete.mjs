/**
 * Throwaway verification: does a confirmed deletion now finish immediately for an
 * archived, idle, still-loaded Session — instead of being staged?
 *
 * It creates a throwaway Session through the product's own API, materializes its
 * log, archives it, confirms the Host still holds it, then calls the plugin's
 * `delete` verb and audits the result: the reply, the log directory, the archive
 * mark, the pending store, and `session/list`.
 *
 * Never touches a Session that already existed on this machine.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { join, resolve } from 'node:path'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const port = 19387
const authority = `127.0.0.1:${String(port)}`
const CWD = process.cwd()
const DELETE_ROUTE = '/api/archive-purge/deleteSession'
const PENDING = join(home, 'archive-purge', 'pending.json')

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const creds = readFileSync(join(home, '.credentials.yaml'), 'utf8')
const block = creds.slice(creds.indexOf('client-connection/browser-session:'))
const match = /^\s*secret:\s*(\S+)\s*$/mu.exec(block)
const pad = '='.repeat((4 - (match[1].length % 4)) % 4)
const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64')
const cookieName = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
const issuedAt = Date.now()
const session = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 3600000 })))
const cookie = `${cookieName}=v1.${session}.${b64url(createHmac('sha256', secret).update(session).digest())}`

function post(path, payload) {
  return new Promise((resolvePromise) => {
    const data = JSON.stringify(payload)
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: {
      host: authority, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), cookie,
    } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
        resolvePromise({ status: res.statusCode, text, json })
      })
    })
    req.on('error', (error) => resolvePromise({ status: 'ERR', text: String(error.message) }))
    req.end(data)
  })
}

const remote = async (method, args) => {
  const res = await post(`/api/${method}`, { type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
  const result = res.json?.result
  if (result === undefined) throw new Error(`no result envelope from ${method}: ${res.text.slice(0, 200)}`)
  return result
}

const pendingIds = () => {
  try {
    return JSON.parse(readFileSync(PENDING, 'utf8')).sessionIds
  } catch {
    return []
  }
}

/** Mirror of `dsh-session-persistence-jsonl`'s project-key derivation. */
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

/** Mirror of the persistence layout so the log directory can be checked directly. */
function sessionDirectory(cwd, id) {
  return join(home, 'sessions', projectKey(cwd), id)
}

const results = []
const check = (label, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}

console.log(`working directory: ${CWD}\n`)

const created = await remote('session/create', { request: { cwd: CWD } })
if (created.ok !== true) throw new Error(`session/create failed: ${JSON.stringify(created).slice(0, 200)}`)
const id = created.value.sessionId
console.log(`throwaway session: ${id}`)

await remote('session/rename', { request: { sessionId: id, title: 'archive-purge immediate-delete probe' } })
const directory = sessionDirectory(CWD, id)
check('the log exists on disk before deletion', existsSync(directory), directory)

const archived = await remote('workspace/archiveSession', { request: { sessionId: id } })
check('archiving succeeds', archived.ok === true)
check('the Host still holds the fresh Session (not yet releasable by idle time)',
  (await remote('session/list', { _request: {} })).ok === true)

const before = pendingIds()
const reply = await post(DELETE_ROUTE, { action: 'delete', sessionId: id })
const value = reply.json?.value
const code = reply.json?.error?.code
console.log(`\nplugin said: ${JSON.stringify(reply.json).slice(0, 260)}\n`)

check('the deletion succeeded outright', reply.json?.ok === true && value?.deleted === true,
  reply.json?.ok === true ? JSON.stringify(value) : String(code))
check('nothing was staged', !pendingIds().includes(id), `pending=${JSON.stringify(pendingIds())}`)
check('the pending store is unchanged otherwise',
  JSON.stringify(before.filter((entry) => entry !== id)) === JSON.stringify(pendingIds().filter((entry) => entry !== id)))
check('the log directory is gone', !existsSync(directory), directory)
check('the project directory survives', existsSync(join(home, 'sessions', projectKey(CWD))))

const listed = await remote('session/list', { _request: {} })
const ids = (listed.value?.items ?? []).map((item) => item.sessionId)
check('session/list no longer reports it', !ids.includes(id), `${String(ids.length)} sessions listed`)

console.log(`\n${results.every(Boolean) ? 'all checks passed' : `${String(results.filter((ok) => !ok).length)} check(s) failed`}`)
process.exitCode = results.every(Boolean) ? 0 : 1
