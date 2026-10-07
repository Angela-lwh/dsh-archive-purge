/**
 * Minimal CLI for the running Host's Remote API.
 *
 * Authenticates exactly as the browser page does — a self-minted
 * `client-connection/browser-session` cookie for the loopback authority — so any
 * namespace the app mounts can be driven from a shell. Arguments and output move
 * through files on purpose: native-command quoting in PowerShell mangles inline
 * JSON (`{"a":1}` arrives as `{a:1}`), and piping between processes prepends a BOM.
 *
 * Usage:
 *   node tools/remote.mjs <namespace>/<method> [--args-file <path>] [--out <path>]
 *                          [--port 19387] [--home <dsh home>]
 *   node tools/remote.mjs session/list --out tools/out.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const port = Number(readOption('--port') ?? new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').port)
const home = readOption('--home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const authority = `127.0.0.1:${String(port)}`
const method = argv.find((value) => !value.startsWith('--') && value.includes('/'))
if (method === undefined) throw new Error('usage: node tools/remote.mjs <namespace>/<method> [--args-file path] [--out path]')
const argsFile = readOption('--args-file')
const args = argsFile === undefined ? {} : JSON.parse(readFileSync(argsFile, 'utf8'))

const cookie = mintCookie(authority, readSecret(home))
const payload = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
const response = await post(`/api/${method}`, payload, cookie)
const text = `${JSON.stringify(response.json ?? { status: response.status, text: response.text }, null, 2)}\n`
const out = readOption('--out')
if (out === undefined) process.stdout.write(text)
else {
  writeFileSync(out, text, 'utf8')
  process.stdout.write(`wrote ${out}\n`)
}
process.exit(response.json?.result?.ok === false ? 2 : 0)

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
