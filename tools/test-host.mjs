/**
 * Headless test for the Host half, against a throwaway directory tree.
 *
 * The Host half performs an irreversible recursive delete, so its refusals matter
 * more than its happy path. This harness gives it a fake Connection route
 * registry, a fake Workspace registry, a fake persistence service, and a
 * temporary session root, then drives every branch: malformed bodies, live
 * session, unarchived session, missing target, a target that is not a session
 * directory, a target outside the project-key layout, the `locate()` fast path,
 * the documented-layout fallback, a successful purge that must remove the log
 * and retire the metadata, the cascade onto a conversation's subagent Sessions
 * (including a running or still-loaded child, and a fork that must survive), and
 * the sweep of subagent leftovers whose parent is already gone.
 *
 * Everything happens under a fresh `dsh-archive-purge-test-*` directory inside the
 * OS temporary area; no real session is read or written.
 *
 * Usage: node tools/test-host.mjs
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = join(HERE, '..', 'plugin', 'index.js')

const { name, inject, apply, __test } = await import(pathToFileURL(HOST).href)
assert.equal(name, 'archive-purge')
assert.deepEqual(inject, ['connection', 'workspaceRegistry', 'sessionPersistence'],
  'the Host half must declare the three services it cannot work without')

/** One isolated scenario: a fake Context plus the state its handler mutates. */
function scenario() {
  return {
    route: undefined,
    root: undefined,
    /** Deferred-purge store, always a temp path so a test can never touch $DSH_HOME. */
    pendingFile: undefined,
    events: [],
    warnings: [],
    unarchived: [],
    detached: [],
    archivedIds: [],
    workspaces: [],
    headers: {},
    /** Session ids the Host holds in its in-memory store. */
    loaded: new Set(),
    /** Session id -> Agent status, for ids the Host holds as live Agents. */
    agents: new Map(),
    /** Monotonic time after which the Host has released everything it held. */
    releaseAt: 0,
    useLocate: true,
    locatePath: () => '',
    async request(payload, { method = 'POST', jsonBody } = {}) {
      const response = await this.route.fetch({
        method,
        signal: undefined,
        json: async () => {
          if (jsonBody !== undefined) {
            if (jsonBody === INVALID_JSON) throw new SyntaxError('invalid JSON')
            return jsonBody
          }
          return payload
        },
      })
      return { status: response.status, body: await response.json() }
    },
  }
}

/** Sentinel meaning "this body is not JSON". */
const INVALID_JSON = Symbol('invalid-json')

/**
 * Activate the plugin for one scenario, always with its deferred-purge store
 * redirected into a temp path — a test must never write the real `$DSH_HOME`.
 * @param world - scenario state.
 * @param config - extra plugin config for this activation.
 * @returns the world, for chaining.
 */
function launch(world, config = {}) {
  if (world.pendingFile === undefined) {
    world.pendingFile = join(tmpdir(), `dsh-archive-purge-pending-${String(Date.now())}-${String(Math.trunc(Math.random() * 1e6))}.json`)
  }
  if (world.root === undefined) world.root = join(tmpdir(), `dsh-archive-purge-root-${String(Math.trunc(Math.random() * 1e9))}`)
  apply(ctxFor(world), { pendingFile: world.pendingFile, ...config })
  return world
}

/** The staged ids currently recorded in a world's deferred-purge store. */
function stagedIds(world) {
  try {
    return JSON.parse(readFileSync(world.pendingFile, 'utf8')).sessionIds
  } catch {
    return []
  }
}

/** Poll until `ready()` holds, or fail the run. */
async function waitFor(ready, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => {
      setTimeout(resolve, 25)
    })
  }
}

/** Build a Context whose registered route feeds `world.request`. */
function ctxFor(world) {
  return {
    connection: {
      fetch: {
        register: (route) => {
          world.route = route
        },
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() {
        return world.archivedIds
      },
      list: () => world.workspaces,
      async unarchiveSession(sessionId) {
        world.unarchived.push(sessionId)
        const index = world.archivedIds.indexOf(sessionId)
        if (index !== -1) world.archivedIds.splice(index, 1)
      },
    },
    sessionPersistence: {
      ...(world.useLocate === false ? {} : { locate: (header) => ({ kind: 'jsonl', path: world.locatePath(header) }) }),
      async stat(sessionId) {
        const header = world.headers[sessionId]
        return header === undefined ? undefined : { header, revision: 'test', sizeBytes: 1 }
      },
      async list() {
        return Object.values(world.headers).map((header) => ({ header, revision: 'test', sizeBytes: 1 }))
      },
    },
    get(service) {
      if (service === 'sessions') {
        return {
          get: (id) => {
            if (world.releaseAt !== 0 && Date.now() >= world.releaseAt) return undefined
            return world.loaded.has(id) ? { id } : undefined
          },
        }
      }
      if (service === 'agents') return { get: (id) => world.agents.get(id) }
      if (service === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: world.root } } }] }
      return undefined
    },
    emit: (event, sessionId) => world.events.push({ kind: 'emit', event, sessionId }),
    logger: { warn: (message) => world.warnings.push(String(message)) },
  }
}

/** A Workspace entity whose stored membership can be pruned. */
function workspaceFor(world, sessionId) {
  return workspaceWith(world, [sessionId])
}

/** A Workspace entity accounting for several Sessions, as the real one does. */
function workspaceWith(world, sessionIds) {
  return {
    sessionIds: [...sessionIds],
    record: { sessionIds: [...sessionIds] },
    async detachSession(id) {
      world.detached.push(id)
      this.record.sessionIds = this.record.sessionIds.filter((entry) => entry !== id)
    },
  }
}

// ---- registration --------------------------------------------------------------

{
  const world = scenario()
  launch(world)
  assert.equal(world.route.path, '/api/archive-purge/deleteSession',
    'the route must live under /api, the only authenticated seat')
  assert.deepEqual(world.route.methods, ['POST'])
  assert.equal(world.route.requestBody, 'buffered')
  assert.equal(typeof world.route.fetch, 'function')
}

// ---- body handling -------------------------------------------------------------

{
  const world = scenario()
  launch(world)
  const missing = await world.request({})
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'archive-purge/bad-request')

  const blank = await world.request({ sessionId: '   ' })
  assert.equal(blank.body.error.code, 'archive-purge/bad-request')

  const malformed = await world.request(undefined, { jsonBody: INVALID_JSON })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.error.code, 'archive-purge/bad-request')
}

// ---- refusals ------------------------------------------------------------------

{
  const world = scenario()
  launch(world)
  const result = await world.request({ sessionId: 'session-x' })
  assert.equal(result.status, 200, 'a Host decision is not a transport failure')
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'archive-purge/not-archived', 'the archive mark authorizes the deletion')
  assert.deepEqual(world.unarchived, [], 'a refusal must not touch durable state')
}

{
  const world = scenario()
  world.archivedIds = ['session-running']
  world.agents.set('session-running', { status: 'running' })
  launch(world, { releaseWaitMs: 0 })
  const result = await world.request({ sessionId: 'session-running' })
  assert.equal(result.body.error.code, 'archive-purge/session-running',
    'work in progress is refused before anything else is even examined')
}

{
  // A loaded Session cannot be purged now — the row would come back unopenable — so
  // it is staged for the next Host start instead.
  const world = scenario()
  const sessionId = 'session-loaded'
  const directory = join(tmpdir(), `dsh-archive-purge-loaded-${String(Date.now())}`, '--tmp--', sessionId)
  world.root = dirname(dirname(directory))
  world.archivedIds = [sessionId]
  world.headers[sessionId] = { id: sessionId, cwd: 'tmp' }
  world.locatePath = () => join(directory, 'session.v4.jsonl.zstd')
  world.loaded.add(sessionId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  launch(world, { releaseWaitMs: 0 })
  const result = await world.request({ sessionId })
  assert.equal(result.body.error.code, 'archive-purge/session-deferred')
  assert.deepEqual(stagedIds(world), [sessionId], 'the purge is staged for the next start')
  assert.deepEqual(world.unarchived, [], 'staging must not clear the archive mark')
  assert.ok(existsSync(directory), 'the log survives until the staged purge runs')
  await rm(dirname(dirname(directory)), { recursive: true, force: true })
}

{
  // With staging switched off the same state is a plain refusal.
  const world = scenario()
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-nostage-'))
  const sessionId = 'session-loaded'
  const directory = join(root, '--tmp--', sessionId)
  world.root = root
  world.archivedIds = [sessionId]
  world.headers[sessionId] = { id: sessionId, cwd: 'tmp' }
  world.locatePath = () => join(directory, 'session.v4.jsonl.zstd')
  world.loaded.add(sessionId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  launch(world, { releaseWaitMs: 0, stageWhenLoaded: false })
  const result = await world.request({ sessionId })
  assert.equal(result.body.error.code, 'archive-purge/session-loaded')
  assert.deepEqual(stagedIds(world), [], 'nothing is staged when staging is off')
  assert.ok(existsSync(directory), 'and nothing is deleted either')
  await rm(root, { recursive: true, force: true })
}

{
  // A loaded Session whose log is already gone must stay archived: clearing the mark
  // would surface it as a row that cannot be opened.
  const world = scenario()
  world.archivedIds = ['session-ghost']
  world.loaded.add('session-ghost')
  launch(world, { releaseWaitMs: 0 })
  const result = await world.request({ sessionId: 'session-ghost' })
  assert.deepEqual(result.body, { ok: true, value: { sessionId: 'session-ghost', deleted: false, reason: 'already-purged', descendants: [], orphansSwept: [] } })
  assert.deepEqual(world.unarchived, [], 'the mark stays so the row stays hidden')
}

{
  // A Host release that lands inside the wait budget turns the refusal into a purge.
  const world = scenario()
  const sessionId = 'session-released'
  const directory = join(tmpdir(), `dsh-archive-purge-release-${String(Date.now())}`, '--tmp--', sessionId)
  world.root = dirname(dirname(directory))
  world.archivedIds = [sessionId]
  world.headers[sessionId] = { id: sessionId, cwd: 'tmp' }
  world.locatePath = () => join(directory, 'session.v4.jsonl.zstd')
  world.loaded.add(sessionId)
  world.releaseAt = Date.now() + 150
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  launch(world, { releaseWaitMs: 2000 })
  const result = await world.request({ sessionId })
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(!existsSync(directory), true, 'the purge happens once the Host lets go')
  await rm(dirname(dirname(directory)), { recursive: true, force: true })
}

{
  const world = scenario()
  world.archivedIds = ['session-sub']
  world.headers['session-sub'] = { id: 'session-sub', cwd: 'C:\\Users\\example\\Desktop', origin: 'subagent' }
  launch(world)
  const result = await world.request({ sessionId: 'session-sub' })
  assert.equal(result.body.error.code, 'archive-purge/subagent')
}

// ---- a purge cascades onto the conversation's subagent Sessions ----------------

/** One project directory with a stored log generation inside every named Session. */
async function seedSessions(root, projectSlug, headers) {
  for (const id of Object.keys(headers)) {
    const directory = join(root, projectSlug, id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  }
}

{
  // A subagent Session is a Session of its own: the sidebar hides every
  // `origin: "subagent"` row, but `sessionQuery.listSessions()` still lists it, so
  // the `@` reference completion kept offering a deleted conversation's
  // transcripts until the purge took the children with the parent.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-cascade-'))
  const projectSlug = '--D-Project-demo--'
  const parentId = 'session-parent'
  const childId = 'session-child'
  const siblingId = 'session-sibling'
  const grandchildId = 'session-grandchild'
  const forkId = 'session-fork'
  const headers = {
    [parentId]: { id: parentId, cwd: 'D:\\Project\\demo' },
    [childId]: { id: childId, cwd: 'D:\\Project\\demo', origin: 'subagent', parentSession: parentId },
    [siblingId]: { id: siblingId, cwd: 'D:\\Project\\demo', origin: 'subagent', parentSession: parentId },
    [grandchildId]: { id: grandchildId, cwd: 'D:\\Project\\demo', origin: 'subagent', parentSession: childId },
    // A fork shares a parent id but is an independent conversation: it must survive.
    [forkId]: { id: forkId, cwd: 'D:\\Project\\demo', parentSession: parentId },
  }
  world.headers = headers
  world.archivedIds = [parentId]
  world.locatePath = (header) => join(world.root, projectSlug, header.id, 'session.v4.jsonl.zstd')
  await seedSessions(world.root, projectSlug, headers)
  world.workspaces = [workspaceWith(world, [parentId, childId])]
  launch(world)

  const result = await world.request({ sessionId: parentId })
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.deepEqual(result.body.value.descendants, [childId, siblingId, grandchildId],
    'every subagent descendant is removed with its conversation, grandchildren included')
  for (const id of [parentId, childId, siblingId, grandchildId]) {
    assert.equal(!existsSync(join(world.root, projectSlug, id)), true, `${id} must be gone`)
  }
  assert.equal(existsSync(join(world.root, projectSlug, forkId)), true, 'a fork is not subagent lineage')
  assert.deepEqual(world.events.map((entry) => entry.sessionId), [parentId, childId, siblingId, grandchildId],
    'every removed Session is published so the GUI can drop it without a reload')
  assert.deepEqual(world.detached, [parentId, childId], 'membership of every removed Session is pruned')
  assert.deepEqual(world.unarchived, [parentId, childId, siblingId, grandchildId],
    'every archive mark is cleared, so no ghost stays behind')
  await rm(world.root, { recursive: true, force: true })
}

{
  // Work in progress inside a child blocks the whole conversation: the child's
  // transcript is being written, and its history is the parent's history.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-cascade-'))
  const projectSlug = '--D-Project-demo--'
  const parentId = 'session-parent'
  const childId = 'session-child'
  const headers = {
    [parentId]: { id: parentId, cwd: 'D:\\Project\\demo' },
    [childId]: { id: childId, cwd: 'D:\\Project\\demo', origin: 'subagent', parentSession: parentId },
  }
  world.headers = headers
  world.archivedIds = [parentId]
  world.agents.set(childId, { status: 'running' })
  world.locatePath = (header) => join(world.root, projectSlug, header.id, 'session.v4.jsonl.zstd')
  await seedSessions(world.root, projectSlug, headers)
  launch(world, { releaseWaitMs: 0 })

  const result = await world.request({ sessionId: parentId })
  assert.equal(result.body.error.code, 'archive-purge/descendant-running')
  assert.equal(result.body.error.message.includes(childId), true, 'the refusal names the busy child')
  assert.equal(existsSync(join(world.root, projectSlug, parentId)), true, 'nothing is deleted')
  assert.equal(existsSync(join(world.root, projectSlug, childId)), true)
  assert.deepEqual(world.events, [], 'a refusal publishes nothing')
  await rm(world.root, { recursive: true, force: true })
}

{
  // A child the Host still holds cannot be removed now, so the whole purge is
  // staged rather than deleting the parent and stranding the child.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-cascade-'))
  const projectSlug = '--D-Project-demo--'
  const parentId = 'session-parent'
  const childId = 'session-child'
  const headers = {
    [parentId]: { id: parentId, cwd: 'D:\\Project\\demo' },
    [childId]: { id: childId, cwd: 'D:\\Project\\demo', origin: 'subagent', parentSession: parentId },
  }
  world.headers = headers
  world.archivedIds = [parentId]
  world.loaded.add(childId)
  world.locatePath = (header) => join(world.root, projectSlug, header.id, 'session.v4.jsonl.zstd')
  await seedSessions(world.root, projectSlug, headers)
  world.pendingFile = join(world.root, 'pending.json')
  launch(world, { releaseWaitMs: 0 })

  const result = await world.request({ sessionId: parentId })
  assert.equal(result.body.error.code, 'archive-purge/session-deferred')
  assert.deepEqual(stagedIds(world), [parentId], 'the parent is staged; the children follow when it runs')
  assert.equal(existsSync(join(world.root, projectSlug, parentId)), true)
  assert.equal(existsSync(join(world.root, projectSlug, childId)), true)
  await rm(world.root, { recursive: true, force: true })
}

{
  // A leftover subagent whose parent is already gone is deletable on its own.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-orphan-'))
  const projectSlug = '--D-Project-demo--'
  const orphanId = 'session-orphan'
  world.headers = { [orphanId]: { id: orphanId, cwd: 'D:\\Project\\demo', origin: 'subagent', parentSession: 'session-gone' } }
  world.archivedIds = [orphanId]
  world.locatePath = (header) => join(world.root, projectSlug, header.id, 'session.v4.jsonl.zstd')
  await seedSessions(world.root, projectSlug, world.headers)
  launch(world, { sweepOrphans: false })

  const result = await world.request({ sessionId: orphanId })
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(result.body.value.deleted, true, 'no dangling catalog can be left behind')
  assert.equal(!existsSync(join(world.root, projectSlug, orphanId)), true)
  await rm(world.root, { recursive: true, force: true })
}

// ---- leftovers from earlier deletions are reported and swept -------------------

/** A world holding one orphan subagent and one subagent whose parent still exists. */
async function leftoverWorld() {
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-leftover-'))
  const projectSlug = '--D-Project-demo--'
  const parentId = 'session-parent'
  const orphanId = 'session-orphan'
  const keptId = 'session-kept'
  world.headers = {
    [parentId]: { id: parentId, cwd: 'D:\\Project\\demo' },
    [orphanId]: { id: orphanId, cwd: 'D:\\Project\\demo', origin: 'subagent', parentSession: 'session-gone' },
    [keptId]: { id: keptId, cwd: 'D:\\Project\\demo', origin: 'subagent', parentSession: parentId },
  }
  world.locatePath = (header) => join(world.root, projectSlug, header.id, 'session.v4.jsonl.zstd')
  await seedSessions(world.root, projectSlug, world.headers)
  world.pendingFile = join(world.root, 'pending.json')
  return { world, projectSlug, orphanId, keptId }
}

{
  const { world, projectSlug, orphanId, keptId } = await leftoverWorld()
  launch(world, { sweepOrphans: false })
  const listed = await world.request({ action: 'listPending' })
  assert.equal(listed.body.ok, true, JSON.stringify(listed.body))
  assert.deepEqual(listed.body.value.orphanSubagentIds, [orphanId],
    'the pending read also names the leftovers the sidebar cannot show')
  assert.equal(existsSync(join(world.root, projectSlug, orphanId)), true, 'reading must not delete')
  assert.equal(existsSync(join(world.root, projectSlug, keptId)), true)

  const sweep = await __test.sweepOrphanSubagents(ctxFor(world), { sweepOrphans: true })
  assert.deepEqual(sweep.deleted, [orphanId], 'only the parentless child is swept')
  assert.equal(!existsSync(join(world.root, projectSlug, orphanId)), true)
  assert.equal(existsSync(join(world.root, projectSlug, keptId)), true, 'a child of a live conversation survives')
  await rm(world.root, { recursive: true, force: true })
}

{
  // A Host start sweeps them without being asked: nothing in the product can ever
  // show an orphan again, and `@` must stop offering a deleted conversation.
  const { world, projectSlug, orphanId, keptId } = await leftoverWorld()
  launch(world)
  await waitFor(() => !existsSync(join(world.root, projectSlug, orphanId)))
  assert.equal(!existsSync(join(world.root, projectSlug, orphanId)), true, 'the startup pass removes it')
  assert.equal(existsSync(join(world.root, projectSlug, keptId)), true)
  await rm(world.root, { recursive: true, force: true })
}

{
  // The on-demand cleanup pass reports the sweep beside the staged entries.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-nosweep-'))
  world.pendingFile = join(world.root, 'pending.json')
  writeFileSync(world.pendingFile, JSON.stringify({ version: 1, sessionIds: [] }), 'utf8')
  launch(world, { sweepOrphans: false })
  const retried = await world.request({ action: 'retryPending' })
  assert.equal(retried.body.ok, true, JSON.stringify(retried.body))
  assert.deepEqual(retried.body.value.orphans, { examined: 0, deleted: [], skipped: [], failed: [] },
    'the pass always carries a sweep report, even when sweeping is configured off')
  await rm(world.root, { recursive: true, force: true })
}

{
  const world = scenario()
  world.archivedIds = ['session-missing']
  launch(world)
  const result = await world.request({ sessionId: 'session-missing' })
  assert.deepEqual(result.body, { ok: true, value: { sessionId: 'session-missing', deleted: false, reason: 'no-stored-log', descendants: [], orphansSwept: [] } })
  assert.deepEqual(world.unarchived, ['session-missing'], 'a ghost id is still retired')
}

// ---- target verification -------------------------------------------------------

{
  // A located path whose parent is not a project-key directory must be refused.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-test-'))
  world.archivedIds = ['session-odd']
  world.headers['session-odd'] = { id: 'session-odd', cwd: 'C:\\Users\\example\\Desktop' }
  const directory = join(world.root, 'not-a-project-dir', 'session-odd')
  world.locatePath = () => join(directory, 'session.v4.jsonl.zstd')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  launch(world)
  const result = await world.request({ sessionId: 'session-odd' })
  assert.equal(result.body.error.code, 'archive-purge/target-mismatch')
  assert.ok(existsSync(directory), 'the refused tree must survive')
  await rm(world.root, { recursive: true, force: true })
}

{
  // A correctly named directory with no log generation must be refused.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-test-'))
  world.archivedIds = ['session-empty']
  world.headers['session-empty'] = { id: 'session-empty', cwd: 'C:\\Users\\example\\Desktop' }
  const directory = join(world.root, '--C-Users-example-Desktop--', 'session-empty')
  world.locatePath = () => join(directory, 'session.v4.jsonl.zstd')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'notes.txt'), 'not a session\n')
  launch(world)
  const result = await world.request({ sessionId: 'session-empty' })
  assert.equal(result.body.error.code, 'archive-purge/target-not-a-session')
  await rm(world.root, { recursive: true, force: true })
}

{
  // A traversal-shaped id must not escape the project directory.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-test-'))
  const outside = join(world.root, 'victim')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'session.v4.jsonl.zstd'), 'seed\n')
  world.archivedIds = ['../victim']
  world.headers['../victim'] = { id: '../victim', cwd: 'C:\\Users\\example\\Desktop' }
  world.useLocate = false
  launch(world)
  const result = await world.request({ sessionId: '../victim' })
  assert.notEqual(result.body.ok, true, 'a traversal id must never delete outside the session root')
  assert.ok(existsSync(outside), 'the outside directory must survive')
  await rm(world.root, { recursive: true, force: true })
}

// ---- the happy path, through both path sources ---------------------------------

for (const useLocate of [true, false]) {
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-test-'))
  world.useLocate = useLocate
  const sessionId = 'session-00000003-0000-4000-8000-000000000000'
  const projectSlug = '--C-Users-example-Desktop--'
  const directory = join(world.root, projectSlug, sessionId)
  world.archivedIds = [sessionId]
  world.headers[sessionId] = { id: sessionId, cwd: 'C:\\Users\\example\\Desktop' }
  world.locatePath = () => join(directory, 'session.v4.jsonl.zstd')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v3.jsonl.zstd'), 'old\n')
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'current\n')
  world.workspaces = [workspaceFor(world, sessionId)]
  // Without locate() the documented-layout fallback needs a root; the Loader row is
  // not a source, so an explicit sessionsRoot is the supported way.
  launch(world, useLocate ? {} : { sessionsRoot: world.root })

  const result = await world.request({ sessionId })
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(result.body.value.deleted, true)
  assert.equal(!existsSync(directory), true, `the session directory must be gone (locate=${String(useLocate)})`)
  assert.equal(existsSync(world.root), true, 'the session root itself must survive')
  assert.deepEqual(await readdir(join(world.root, projectSlug)), [], 'the project directory must survive')
  assert.deepEqual(world.unarchived, [sessionId], 'the archive mark must be cleared')
  assert.deepEqual(world.detached, [sessionId], 'durable Workspace membership must be pruned')
  assert.deepEqual(world.events, [{ kind: 'emit', event: 'api-session/removed', sessionId }],
    'connected clients must be told to drop the row')
  await rm(world.root, { recursive: true, force: true })
}

// ---- the root fallback chain ---------------------------------------------------

{
  // The documented-layout fallback, driven by an explicit sessionsRoot: the Loader
  // row's own config is NOT a source (a `!!js dshHomePath(...)` row keeps an
  // unevaluated marker), which is why the root is either configured or derived from a
  // located artifact.
  const world = scenario()
  world.root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-test-'))
  const sessionId = 'session-rooted'
  const directory = join(world.root, '--tmp--', sessionId)
  world.archivedIds = [sessionId]
  world.headers[sessionId] = { id: sessionId, cwd: 'tmp' }
  world.useLocate = false
  launch(world, { sessionsRoot: world.root })
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  const result = await world.request({ sessionId })
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(!existsSync(directory), true)
  await rm(world.root, { recursive: true, force: true })
}

{
  // Without locate(), without a configured root, and without DSH_HOME there is no
  // honest way to find the directory, so the plugin must refuse rather than guess.
  const world = scenario()
  world.useLocate = false
  world.archivedIds = ['session-unrooted']
  world.headers['session-unrooted'] = { id: 'session-unrooted', cwd: 'tmp' }
  const previousHome = process.env.DSH_HOME
  delete process.env.DSH_HOME
  launch(world)
  const result = await world.request({ sessionId: 'session-unrooted' })
  if (previousHome !== undefined) process.env.DSH_HOME = previousHome
  assert.equal(result.body.error.code, 'archive-purge/no-sessions-root')
}

// ---- staged purges finish at the next Host start -------------------------------

{
  // Archived and cold at activation: the staged purge simply runs.
  const world = scenario()
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-drain-'))
  const sessionId = 'session-staged'
  const directory = join(root, '--tmp--', sessionId)
  world.root = root
  world.archivedIds = [sessionId]
  world.headers[sessionId] = { id: sessionId, cwd: 'tmp' }
  world.useLocate = false
  world.pendingFile = join(root, 'pending.json')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  writeFileSync(world.pendingFile, JSON.stringify({ version: 1, sessionIds: [sessionId] }), 'utf8')
  launch(world, { sessionsRoot: root })
  await waitFor(() => !existsSync(directory))
  assert.equal(!existsSync(directory), true, 'the staged purge removes the log on activation')
  assert.deepEqual(stagedIds(world), [], 'the store is emptied once the pass settles')
  assert.deepEqual(world.unarchived, [sessionId], 'the archive mark is cleared by the purge')
  await rm(root, { recursive: true, force: true })
}

{
  // The archive mark is the authorization, so unarchiving cancels a staged purge.
  const world = scenario()
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-drain-'))
  const sessionId = 'session-unstaged'
  const directory = join(root, '--tmp--', sessionId)
  world.root = root
  world.headers[sessionId] = { id: sessionId, cwd: 'tmp' }
  world.useLocate = false
  world.pendingFile = join(root, 'pending.json')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  writeFileSync(world.pendingFile, JSON.stringify({ version: 1, sessionIds: [sessionId] }), 'utf8')
  launch(world, { sessionsRoot: root })
  await waitFor(() => stagedIds(world).length === 0)
  assert.ok(existsSync(directory), 'an unarchived Session is left alone')
  assert.deepEqual(world.unarchived, [], 'and its archive mark is untouched')
  await rm(root, { recursive: true, force: true })
}

// ---- the located-artifact branch, which is the one the real Host takes ----------

{
  // No pendingFile config, no sessionsRoot, no DSH_HOME: the Harness home has to come
  // from `locate()`. This is the arithmetic that an off-by-one silently breaks, so it
  // gets its own test — a wrong home reads an empty store and the drain looks idle.
  const world = scenario()
  const base = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-home-'))
  const root = join(base, 'sessions')
  const sessionId = 'session-located'
  const directory = join(root, '--tmp--', sessionId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'seed\n')
  world.root = root
  world.archivedIds = [sessionId]
  world.headers[sessionId] = { id: sessionId, cwd: 'tmp' }
  world.locatePath = (header) => join(root, '--tmp--', header.id, 'session.v4.jsonl.zstd')
  const pendingPath = join(base, 'archive-purge', 'pending.json')
  mkdirSync(dirname(pendingPath), { recursive: true })
  writeFileSync(pendingPath, JSON.stringify({ version: 1, sessionIds: [sessionId] }), 'utf8')

  const previousHome = process.env.DSH_HOME
  delete process.env.DSH_HOME
  apply(ctxFor(world), {})
  // DSH_HOME stays unset until the drain has run: restoring it immediately would send
  // the asynchronous pass to the real store instead of this sandbox.
  await waitFor(() => !existsSync(directory))
  if (previousHome !== undefined) process.env.DSH_HOME = previousHome

  assert.equal(!existsSync(directory), true, 'the drain derives the home from locate()')
  assert.deepEqual(JSON.parse(readFileSync(pendingPath, 'utf8')).sessionIds, [],
    'and empties the store it derived that home from')
  await rm(base, { recursive: true, force: true })
}

console.log('host half: all assertions passed')