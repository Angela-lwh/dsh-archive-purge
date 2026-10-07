/**
 * Watch whether the Host releases loaded Sessions on its own.
 *
 * A Session the Host has loaded stays live for the Host's lifetime (the Session
 * store entry and its Agent are torn down together by a Cordis effect no plugin
 * can reach), which is what makes an archived-but-loaded Session undeletable. This
 * watcher answers the one open question: does an *idle* loaded Session ever go cold
 * by itself, or is a Host restart the only release?
 *
 * Read-only: it only calls `session/list`.
 *
 * Usage: node tools/watch-liveness.mjs [--minutes 5] [--interval 15000]
 */
import { readFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const port = Number(readOption('--port') ?? new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').port)
const home = readOption('--home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const minutes = Number(readOption('--minutes') ?? 5)
const interval = Number(readOption('--interval') ?? 15000)
const authority = `127.0.0.1:${String(port)}`
const cookie = mintCookie(authority, readSecret(home))

const until = Date.now() + minutes * 60 * 1000
let previous
while (Date.now() < until) {
  const live = await liveIds()
  const line = `${new Date().toISOString()} live=${String(live.length)}  ${live.map((id) => id.slice(8, 16)).join(',')}`
  const changed = previous !== undefined && previous !== line.split('  ')[1]
  console.log(`${changed ? 'CHANGE  ' : '        '}${line}`)
  previous = line.split('  ')[1]
  await sleep(interval)
}
process.exit(0)

/** The ids the Host currently reports as loaded. */
async function liveIds() {
  const payload = JSON.stringify({
    type: 'client-request',
    rpcId: randomUUID(),
    method: 'session/list',
    payload: { args: { _request: {} } },
  })
  const response = await post('/api/session/list', payload, cookie)
  return (response.result?.value?.items ?? []).filter((item) => item.agentAvailable).map((item) => item.sessionId)
}

/** One authenticated POST. */
function post(path, body, cookieHeader) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        host: authority,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        cookie: cookieHeader,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

/** The durable browser-session signing secret, decoded to raw bytes. */
function readSecret(dshHome) {
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

/** Await a fixed delay. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
