/**
 * Call the plugin's deletion route from a shell.
 *
 * The route is an exact Fetch route rather than a Remote namespace, so it takes a
 * plain `{ sessionId }` body instead of the RPC envelope; this is the CLI for it.
 * Authenticates exactly as the browser page does.
 *
 * Usage: node tools/purge.mjs <sessionId> [--port 19387] [--home <dsh home>]
 */
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const sessionId = argv.find((value) => !value.startsWith('--'))
if (sessionId === undefined) throw new Error('usage: node tools/purge.mjs <sessionId>')
const port = Number(readOption('--port') ?? new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').port)
const home = readOption('--home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const authority = `127.0.0.1:${String(port)}`
const body = JSON.stringify({ sessionId })

const response = await new Promise((resolve, reject) => {
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path: '/api/archive-purge/deleteSession',
    method: 'POST',
    headers: {
      host: authority,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      cookie: mintCookie(authority, readSecret(home)),
    },
  }, (incoming) => {
    const chunks = []
    incoming.on('data', (chunk) => chunks.push(chunk))
    incoming.on('end', () => resolve({ status: incoming.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
  })
  request.on('error', reject)
  request.end(body)
})

console.log(`HTTP ${String(response.status)}`)
try {
  console.log(JSON.stringify(JSON.parse(response.text), null, 2))
} catch {
  console.log(response.text)
}
process.exit(response.status === 200 ? 0 : 1)

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
  const body64 = base64url(Buffer.from(JSON.stringify({
    version: 1,
    authority: forAuthority,
    issuedAt,
    expiresAt: issuedAt + 60 * 60 * 1000,
  }), 'utf8'))
  return `${name}=v1.${body64}.${base64url(createHmac('sha256', secretBytes).update(body64).digest())}`
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
