/**
 * End-to-end probe of the running Host's deletion route.
 *
 * This is the only check that covers the whole chain at once: the Host/Origin
 * trust fence, the signed browser-session cookie, the exact Fetch route
 * registration, the handler, and the JSON contract the browser half parses.
 * Nothing here is destructive — every request either lacks authority or targets a
 * Session the Host must refuse (live, or not archived).
 *
 * The cookie is minted exactly as `BrowserAuth` does: name
 * `dsh-auth-<base64url(sha256(authority))>`, value `v1.<body>.<hmac>`, payload
 * `{ version, authority, issuedAt, expiresAt }`, signed with the durable
 * `client-connection/browser-session` secret from `$DSH_HOME/.credentials.yaml`.
 *
 * Usage: node tools/test-route.mjs [--port 19387] [--home <dsh home>]
 */
import { readFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const home = readOption('--home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const port = Number(readOption('--port') ?? new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').port)
const authority = `127.0.0.1:${String(port)}`
const ROUTE = '/api/archive-purge/deleteSession'
/**
 * Any id that is not archived: the archive mark is checked before existence is probed, so
 * a synthetic id exercises the same refusal a real unarchived Session would.
 */
const UNARCHIVED_SESSION = 'session-00000003-0000-4000-8000-000000000000'

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`)
}

const secret = await readSecret(home)
const token = readOption('--token')
// A launch token is the only input the Host exchanges for its own cookie, so when
// one is supplied the probe authenticates exactly as the browser page did.
const cookie = token === undefined ? mintCookie(authority, secret) : await exchangeToken(token)
if (token !== undefined) console.log('using a cookie minted by the Host itself\n')

// ---- authority -----------------------------------------------------------------

const anonymous = await send({ withCookie: false })
check('no cookie -> 401', anonymous.status, 401)

const spoofed = await send({ withCookie: true, host: 'evil.example' })
check('valid cookie but foreign Host -> 403', spoofed.status, 403)

const crossSite = await send({ withCookie: true, extraHeaders: { 'sec-fetch-site': 'cross-site' } })
check('valid cookie but cross-site fetch -> 403', crossSite.status, 403)

// ---- the handler ---------------------------------------------------------------

const cold = await send({ withCookie: true, body: { sessionId: UNARCHIVED_SESSION } })
check('cold unarchived session -> 200', cold.status, 200)
check('  refusal code', cold.json?.error?.code, 'archive-purge/not-archived')

const live = await send({ withCookie: true, body: { sessionId: process.env.DSH_SESSION_ID ?? '' } })
check('the caller\'s own running session -> session-running', live.json?.error?.code, 'archive-purge/session-running')

const notArchived = await send({ withCookie: true, body: { sessionId: UNARCHIVED_SESSION } })
check('a cold unarchived session is refused', notArchived.json?.error?.code, 'archive-purge/not-archived')

const blank = await send({ withCookie: true, body: { sessionId: '  ' } })
check('blank sessionId -> 400 bad-request', blank.status, 400)
check('  refusal code', blank.json?.error?.code, 'archive-purge/bad-request')

const notJson = await send({ withCookie: true, raw: 'not json', contentType: 'application/json' })
check('non-JSON body -> 400 bad-request', notJson.json?.error?.code, 'archive-purge/bad-request')

console.log(failures === 0 ? '\nroute: all checks passed' : `\nroute: ${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1

/** Exchange a launch token for the Host's own browser-session cookie. */
async function exchangeToken(launchToken) {
  const response = await get(`/?token=${encodeURIComponent(launchToken)}`)
  if (response.status !== 303) throw new Error(`token exchange returned ${String(response.status)}; expected 303`)
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') throw new Error('token exchange returned no Set-Cookie header')
  return value.split(';', 1)[0]
}

/** One GET against the loopback carrier. */
function get(path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: authority } }, (response) => {
      response.resume()
      response.on('end', () => {
        resolve({ status: response.statusCode, headers: response.headers })
      })
    })
    request.on('error', reject)
    request.end()
  })
}

/** The durable browser-session signing secret, decoded to raw bytes. */
async function readSecret(dshHome) {
  const text = await readFile(join(dshHome, '.credentials.yaml'), 'utf8')
  const block = text.slice(text.indexOf('client-connection/browser-session:'))
  const match = /^\s*secret:\s*(\S+)\s*$/mu.exec(block)
  if (match === null) throw new Error('no client-connection/browser-session secret in the credential file')
  const encoded = match[1]
  const padding = '='.repeat((4 - (encoded.length % 4)) % 4)
  const bytes = Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  if (bytes.byteLength !== 32) throw new Error(`unexpected browser-session secret length ${String(bytes.byteLength)}`)
  return bytes
}

/** Build the exact cookie `BrowserAuth.authorizeIndex` would have issued. */
function mintCookie(forAuthority, secretBytes, lifetimeMs = 60 * 60 * 1000) {
  const name = `dsh-auth-${base64url(createHash('sha256').update(forAuthority).digest())}`
  const issuedAt = Date.now()
  const body = base64url(Buffer.from(JSON.stringify({
    version: 1,
    authority: forAuthority,
    issuedAt,
    expiresAt: issuedAt + lifetimeMs,
  }), 'utf8'))
  const signature = base64url(createHmac('sha256', secretBytes).update(body).digest())
  return `${name}=v1.${body}.${signature}`
}

/** base64url without padding, matching the Host's own encoder. */
function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** One request against the loopback carrier, with exact header control. */
function send({ withCookie, host, body, raw, contentType = 'application/json', extraHeaders = {} }) {
  const payload = raw ?? (body === undefined ? '' : JSON.stringify(body))
  const headers = {
    host: host ?? authority,
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(payload)),
    ...(withCookie ? { cookie } : {}),
    ...extraHeaders,
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: ROUTE, method: 'POST', headers }, (response) => {
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
        resolve({ status: response.statusCode, text, json })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

/** Read one `--flag value` argument. */
function readOption(flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

// to keep this file's crypto surface identical to the implementation it mirrors.
