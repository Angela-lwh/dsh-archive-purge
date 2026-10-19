/**
 * @angela_lwh/dsh-archive-purge — Host half.
 *
 * DeepSeek Harness can archive a Session but has never been able to delete one:
 * `dsh-session-persistence-jsonl`'s own README states "Nothing deletes session
 * files — logs accumulate under `root` until removed externally; the seam has no
 * deletion API", and `dsh-workspace`'s `delete()` removes a Workspace
 * *registration* while explicitly retaining every session log. This plugin adds
 * the one missing verb.
 *
 * Why the Host and not the browser: a browser half cannot touch the filesystem,
 * and no generated Remote namespace exists for a third-party package (the Client
 * Remote table is a fixed build-time assembly in `dsh-api-remotes`, and the
 * Typert generator is not shipped).
 *
 * Which extension seam, and why not the other one: `ctx.connection.fetch.register()`
 * adds an exact route to the shared `/api` Fetch handler. That seat is
 * authenticated for free — the `/api` prefix route runs `connection.admit()`
 * before the bridge dispatches, so a request must pass the Host/Origin fence
 * (403) and carry the signed browser-session cookie (401) before it reaches this
 * handler. A bare `ctx.webServer.register()` route has neither check, which for
 * an irreversible delete would expose the operation to any local process.
 *
 * `ctx.connection.rpc.handle()` — the neighbouring generic RPC channel — was the
 * first choice and does NOT work in this build: it reads `webServer` through the
 * Connection *service's* own Context, which does not declare that service in its
 * `inject`, so Cordis' strict accessor throws `cannot get property "webServer"
 * without inject` from inside `register()`. The `/api` route itself is registered
 * in the plugin's `apply`, where the inject is declared, which is exactly why the
 * `/api` seat works and this seam does not.
 *
 * Ordering is deliberate: bytes first, metadata second. If the durable writes
 * fail after the files are gone, the result is an invisible stale id (rendering
 * skips members without a summary) rather than a visible row pointing at a
 * deleted log. The reverse order would resurrect a browsable session whose log
 * no longer exists.
 *
 * @module @angela_lwh/dsh-archive-purge
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Loader identity of this plugin's Host half. */
export const name = 'archive-purge'
/**
 * Internals exposed for the test harnesses. Cordis ignores exports it does not know,
 * and these four carry the arithmetic that silently misbehaves (a wrong home reads an
 * empty store and the deferred purge looks idle).
 */
export const __test = { pendingFilePath, resolveHarnessHome, locateAnyStoredArtifact, sessionsRootOf, harnessHomeOf, harnessHomeOfDirectory, resolveSessionsRoot, readPending, drainStagedPurges, listPendingPurge, retryPendingPurge, releaseLoadedSession }
/**
 * Hard service requirements. An array (not the older `{required, optional}`
 * object shape, which the vendored Cordis reads as services literally named
 * "required"/"optional" and then waits for forever) — every one of these is
 * mandatory for the single operation this plugin exposes.
 */
export const inject = ['connection', 'workspaceRegistry', 'sessionPersistence']

/**
 * Exact Fetch route. It must live under `/api` — that is the only seat whose
 * owner admits the request — and it is matched before the Gateway's Remote
 * interceptor, so it cannot collide with a generated endpoint.
 */
const ROUTE_PATH = '/api/archive-purge/deleteSession'
/**
 * Request verbs of the one route, carried in the body's `action` field.
 *
 * `delete` stays the default so an older browser half — or any caller written
 * against the first version — keeps working unchanged. `listPending` and
 * `retryPending` serve the retry seat: a staged purge used to be completable only
 * by restarting the Host, and both actions together replace that restart with one
 * request (`listPending` says whether anything is staged, `retryPending` runs the
 * stored pass immediately).
 */
const ACTION_DELETE = 'delete'
const ACTION_LIST_PENDING = 'listPending'
const ACTION_RETRY_PENDING = 'retryPending'
/** One log generation, or a migration staging file, inside a session directory. */
const SESSION_DIR_CONTENT = /^(?:session(?:\.[A-Za-z0-9]+)*\.jsonl(?:\.zstd)?|session\.migration\..*\.tmp)$/
/** Project directory keys are `--<slug>--`; the no-project fallback is `_no-cwd`. */
const PROJECT_DIR_KEY = /^--.*--$/

/**
 * Refusal codes the browser half turns into localized copy.
 *
 * `session-running` and `session-loaded` are deliberately distinct. A Session with
 * work in progress must never be purged, in any Host state. A Session the Host has
 * merely *loaded* is a different matter: its history is untouched, but the Host
 * lists live Sessions independently of their stored artifacts —
 * `sessionQuery.listSessions()` is the union of the in-memory store and the
 * persisted headers — so removing the log underneath a loaded Session would leave a
 * row that returns on the next refresh and can no longer be opened. Such a Session
 * is therefore released first (see {@link releaseLoadedSession}); `session-loaded`
 * is what is left when the caller disables that and the Session is still held.
 */
const CODE_RUNNING = 'archive-purge/session-running'
const CODE_LOADED = 'archive-purge/session-loaded'
/**
 * The loaded Session has been *staged* instead: its purge is recorded and finishes
 * at the next Host start, when nothing is loaded any more. This is the fallback for
 * the one case the release step cannot cover — work in progress, or a Session that
 * still reports loaded after both detaches — without ever lying about what happened.
 */
const CODE_DEFERRED = 'archive-purge/session-deferred'
/** Default budget for waiting out a Host release before refusing or staging, in milliseconds. */
const DEFAULT_RELEASE_WAIT_MS = 2000
/** Deferred purges, relative to `$DSH_HOME`. The archive mark stays the authorization. */
const DEFAULT_PENDING_FILE = 'archive-purge/pending.json'
/** Pending-store format, so a future change can migrate instead of misreading. */
const PENDING_VERSION = 1
/**
 * Refusals that can never become a purge, so a staged entry carrying one is dropped
 * instead of retried on every start. Everything else — including an unknown failure —
 * stays staged, because losing a deferred purge is worse than retrying it.
 */
const PERMANENT_REFUSALS = new Set([
  'archive-purge/not-archived',
  'archive-purge/subagent',
  'archive-purge/no-sessions-root',
  'archive-purge/target-mismatch',
  'archive-purge/target-not-a-session',
  'archive-purge/not-found',
  'archive-purge/bad-request',
])

/**
 * Register the deletion route, then finish any purge the previous Host could not.
 * @param ctx - Host plugin context carrying Connection, the Workspace registry, and persistence.
 * @param config - optional `{ sessionsRoot, releaseWaitMs, pendingFile, stageWhenLoaded }` overrides.
 */
export function apply(ctx, config = {}) {
  const settings = {
    sessionsRoot: readOptionalPath(config?.sessionsRoot),
    releaseWaitMs: readWaitBudget(config?.releaseWaitMs),
    pendingFile: readOptionalPath(config?.pendingFile),
    stageWhenLoaded: config?.stageWhenLoaded !== false,
    releaseLoaded: config?.releaseLoaded !== false,
  }
  ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleDeleteRequest(ctx, settings, request),
  })
  scheduleStagedPurges(ctx, settings)
}

/**
 * Answer one authenticated request on the plugin's route.
 *
 * Every refusal travels as a JSON envelope rather than an HTTP status, because
 * the browser half distinguishes a Host *decision* (not archived, session still
 * live) from a transport failure, and the dialog shows the former verbatim. The
 * same rule covers a retry: a Session that is still loaded is an outcome, not an
 * error.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param request - the buffered Fetch request built by the Connection bridge.
 * @returns the JSON response.
 */
async function handleDeleteRequest(ctx, settings, request) {
  if (request.method !== 'POST') {
    return jsonResponse(405, failure('archive-purge/method-not-allowed', 'POST is required', { allow: 'POST' }))
  }
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse(400, failure('archive-purge/bad-request', 'request body must be JSON'))
  }
  const action = readAction(body)
  if (action === undefined) {
    return jsonResponse(400, failure('archive-purge/bad-request', 'action must be a string'))
  }
  if (action === ACTION_LIST_PENDING) {
    try {
      return jsonResponse(200, { ok: true, value: await listPendingPurge(ctx, settings) })
    } catch (error) {
      return jsonResponse(200, failure(error?.code ?? 'archive-purge/failed', messageOf(error)))
    }
  }
  if (action === ACTION_RETRY_PENDING) {
    try {
      return jsonResponse(200, { ok: true, value: await retryPendingPurge(ctx, settings, request.signal) })
    } catch (error) {
      return jsonResponse(200, failure(error?.code ?? 'archive-purge/failed', messageOf(error)))
    }
  }
  if (action !== ACTION_DELETE) {
    return jsonResponse(400, failure('archive-purge/bad-request', `unknown action "${action}"`))
  }
  const sessionId = readSessionId(body)
  if (sessionId === undefined) {
    return jsonResponse(400, failure('archive-purge/bad-request', 'sessionId must be a non-empty string'))
  }
  try {
    return jsonResponse(200, { ok: true, value: await purgeArchivedSession(ctx, settings, sessionId, request.signal) })
  } catch (error) {
    return jsonResponse(200, failure(error?.code ?? 'archive-purge/failed', messageOf(error)))
  }
}

/**
 * Permanently delete one archived Session: its log directory, its durable
 * membership, and its archive mark.
 *
 * Every precondition is re-checked here rather than trusted from the browser.
 * The archive mark is the only durable record that the user already asked this
 * history to leave the browsing surface, so it doubles as the authorization for
 * an irreversible operation.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param sessionId - target Session id.
 * @param signal - caller cancellation.
 * @returns a report of what was removed.
 * @throws {PurgeError} for every refusal, carrying a machine-readable `code`.
 */
async function purgeArchivedSession(ctx, settings, sessionId, signal) {
  const registry = ctx.workspaceRegistry
  const persistence = ctx.sessionPersistence
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')

  // Work in progress is the one state that can never be purged: the Agent would keep
  // writing, and the turn's own history would be destroyed mid-flight.
  if (agents?.get?.(sessionId)?.status === 'running') {
    throw new PurgeError(CODE_RUNNING, `session ${sessionId} has work in progress`)
  }

  if (!readArchivedIds(registry).includes(sessionId)) {
    throw new PurgeError('archive-purge/not-archived', `session ${sessionId} is not archived`)
  }

  const snapshot = await persistence.stat(sessionId, { signal })
  signal?.throwIfAborted()
  if (snapshot === undefined) {
    // Nothing on disk: retire the id so the browser stops listing a ghost. A loaded
    // Session whose log is already gone stays archived, because clearing the mark
    // would surface it as a row that cannot be opened.
    if (isLoaded(sessions, agents, sessionId)) {
      return { sessionId, deleted: false, reason: 'already-purged' }
    }
    await retireMetadata(ctx, registry, sessionId)
    return { sessionId, deleted: false, reason: 'no-stored-log' }
  }

  const header = snapshot.header
  if (header?.origin === 'subagent') {
    throw new PurgeError('archive-purge/subagent', `session ${sessionId} is subagent-owned history`)
  }

  // Resolve and verify the target BEFORE deciding whether to act now: a bad target is
  // a hard refusal in either case, and the directory is what locates the Harness home
  // for a staged purge.
  const directory = await resolveSessionDirectory(ctx, settings, persistence, header)
  await assertPurgeTarget(directory, sessionId)
  signal?.throwIfAborted()

  await waitForRelease(sessions, agents, sessionId, settings.releaseWaitMs, signal)
  if (isLoaded(sessions, agents, sessionId)) {
    // The Host holds nothing else that can free this Session, so release it here
    // rather than making the user restart DSH for a deletion they already
    // confirmed. Only an archived, idle Session is eligible; anything else keeps
    // the previous refusal-or-stage behaviour.
    const released = await releaseLoadedSession(ctx, sessions, agents, sessionId, settings)
    if (released.released) {
      ctx.logger?.info?.(`archive-purge: released the Host's hold on ${sessionId} to finish its deletion`)
    } else {
      ctx.logger?.info?.(`archive-purge: kept ${sessionId} loaded (${released.reason}); its purge is staged`)
    }
  }
  if (isLoaded(sessions, agents, sessionId)) {
    if (!settings.stageWhenLoaded) {
      throw new PurgeError(CODE_LOADED, `session ${sessionId} is still loaded by the Host`)
    }
    await stageStagedPurge(ctx, settings, sessionId, directory)
    throw new PurgeError(
      CODE_DEFERRED,
      `session ${sessionId} is loaded by the Host; its purge is staged for the next start`,
    )
  }

  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  await retireMetadata(ctx, registry, sessionId)
  // Display-only removal on the forwarded-event allowlist: every connected GUI
  // drops the row through `handleSessionRemoved` without a reload or restart.
  ctx.emit('api-session/removed', sessionId)
  return { sessionId, deleted: true, directory }
}

/**
 * Release the Host's own hold on an archived, idle Session — the step that lets a
 * confirmed deletion finish now instead of at the next start.
 *
 * Both halves of "loaded" are separate registries with separate lifecycles, and
 * both must go: `ctx.sessions`' store entry owns the log handle and emits
 * `session/disposed`, and `ctx.agents`' registry entry owns the Agent and emits
 * `agent/disposed`. The detach closures live on those entries (measured against
 * the running Host), not on the services, so this reaches the entries rather than
 * calling `detachEntered` directly — that would remove the entry without emitting
 * the paired disposal edge.
 *
 * The authorization is the archive mark, re-read here rather than inferred from
 * the caller: an archived Session has already been asked to leave the browsing
 * surface, so releasing it destroys nothing the user can still see. A Session with
 * work in progress is never eligible, and neither is one the workspace registry
 * does not list as archived (a staged purge whose Session was unarchived in the
 * meantime).
 *
 * @param ctx - Host context.
 * @param sessions - `ctx.sessions`, when present.
 * @param agents - `ctx.agents`, when present.
 * @param sessionId - target Session id.
 * @param settings - resolved plugin config.
 * @returns whether it was released, and why not when it was not.
 */
async function releaseLoadedSession(ctx, sessions, agents, sessionId, settings) {
  if (settings.releaseLoaded !== true) return { released: false, reason: 'disabled by configuration' }
  if (agents?.get?.(sessionId)?.status === 'running') return { released: false, reason: 'work in progress' }
  if (!readArchivedIds(ctx.workspaceRegistry).includes(sessionId)) {
    return { released: false, reason: 'not archived' }
  }
  const entry = sessions?.store?.get?.(sessionId)
  if (entry !== undefined && typeof entry.detach === 'function') entry.detach()
  const agentEntry = agents?.store?.get?.(sessionId)
  if (agentEntry !== undefined && typeof agents?.detachEntered === 'function') agents.detachEntered(agentEntry)
  return isLoaded(sessions, agents, sessionId)
    ? { released: false, reason: 'the Host still reports it loaded' }
    : { released: true }
}

/**
 * Give the Host a bounded chance to release a loaded Session.
 *
 * A Session the UI has just archived is released by the Client immediately, but the
 * Host's own store entry and Agent are torn down by a Cordis effect nothing outside
 * owns — measured directly: the set of loaded Sessions did not change once in six
 * minutes of idle watching — so this wait only covers a release that lands inside the
 * window (a profile recomposition, for instance). The caller decides what to do when
 * the Session is still loaded.
 *
 * @param sessions - `ctx.sessions`, when present.
 * @param agents - `ctx.agents`, when present.
 * @param sessionId - target Session id.
 * @param budgetMs - maximum time to wait.
 * @param signal - caller cancellation.
 */
async function waitForRelease(sessions, agents, sessionId, budgetMs, signal) {
  const deadline = Date.now() + budgetMs
  while (isLoaded(sessions, agents, sessionId)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    await delay(Math.min(250, remaining), signal)
  }
}

/** Whether the Host still holds this Session in memory, as a store entry or an Agent. */
function isLoaded(sessions, agents, sessionId) {
  return sessions?.get?.(sessionId) !== undefined || agents?.get?.(sessionId) !== undefined
}

/** Await one delay, honouring caller cancellation. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Retire the two durable traces of an archived Session: its Workspace
 * membership and its archive mark.
 *
 * `workspaceRegistry.delete()` is deliberately NOT used: it removes a Workspace
 * registration, never a Session.
 *
 * @param ctx - Host context.
 * @param registry - `ctx.workspaceRegistry`.
 * @param sessionId - the purged Session id.
 */
async function retireMetadata(ctx, registry, sessionId) {
  for (const workspace of safeList(registry)) {
    if (!rawMembership(workspace).includes(sessionId)) continue
    try {
      // Present on the Workspace entity; the durable write itself also prunes
      // membership whose session path no longer resolves.
      await workspace.detachSession?.(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`archive-purge: could not detach ${sessionId} from workspace: ${messageOf(error)}`)
    }
  }
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`archive-purge: could not clear the archive mark of ${sessionId}: ${messageOf(error)}`)
  }
}

/**
 * Record one Session whose purge has to wait for the next Host start.
 *
 * The archive mark is deliberately left in place: it is both the authorization for
 * the deferred deletion and the user's own cancellation — unarchiving the Session
 * before the next start drops the staged entry, and the deferred purge re-checks the
 * mark anyway.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param sessionId - Session to purge later.
 * @param directory - the Session's own directory, which locates the Harness home.
 * @throws {PurgeError} when no pending store can be located.
 */
async function stageStagedPurge(ctx, settings, sessionId, directory) {
  const path = await pendingFilePath(ctx, settings, directory)
  if (path === undefined) {
    throw new PurgeError(
      'archive-purge/no-pending-store',
      'the Host still holds this session and no Harness home could be resolved, so the purge cannot be staged',
    )
  }
  const staged = readPending(path)
  if (!staged.includes(sessionId)) writePending(path, [...staged, sessionId])
}

/**
 * Finish the purges staged by a previous Host, now that nothing is loaded.
 *
 * Runs once, off the composition path: a failure here must never stop the profile
 * from booting, and an entry that is somehow still loaded stays staged for the next
 * start instead of being dropped.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 */
function scheduleStagedPurges(ctx, settings) {
  Promise.resolve()
    .then(async () => {
      const report = await drainStagedPurges(ctx, settings, undefined)
      for (const entry of report.results) {
        if (entry.outcome === 'deleted') {
          ctx.logger?.info?.(`archive-purge: staged purge of ${entry.sessionId}: log removed`)
        } else if (entry.outcome === 'nothing-to-remove') {
          ctx.logger?.info?.(`archive-purge: staged purge of ${entry.sessionId}: nothing to remove (${String(entry.reason)})`)
        } else if (entry.outcome === 'dropped') {
          ctx.logger?.warn?.(`archive-purge: staged purge of ${entry.sessionId} dropped (${String(entry.code)}): ${String(entry.message)}`)
        } else {
          ctx.logger?.warn?.(`archive-purge: staged purge of ${entry.sessionId} could not run (${String(entry.code)}); keeping it staged`)
        }
      }
    })
    .catch((error) => {
      ctx.logger?.warn?.(`archive-purge: staged purge pass failed: ${messageOf(error)}`)
    })
}

/**
 * Run one pass over the deferred-purge store and publish what is left.
 *
 * Extracted so the startup pass and the on-demand retry share exactly one
 * implementation: they differ only in whether a report is returned to a caller or
 * written to the Host log. An entry is dropped when its refusal can never become a
 * purge (the user unarchived it, or the target is not deletable at all), and kept
 * otherwise — including for a failure this plugin does not understand, because
 * losing a deferred purge is worse than retrying it.
 *
 * The store is rewritten even when the pass changed nothing, so a retry that finds
 * every Session still loaded leaves an identical file rather than a stale one.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param signal - caller cancellation for an on-demand retry.
 * @returns counts plus one entry per attempted Session.
 */
async function drainStagedPurges(ctx, settings, signal) {
  const path = await pendingFilePath(ctx, settings, undefined)
  if (path === undefined) {
    throw new PurgeError('archive-purge/no-pending-store', 'no Harness home could be resolved, so there is no deferred-purge store to read')
  }
  const staged = readPending(path)
  const results = []
  const remaining = []
  for (const sessionId of staged) {
    try {
      const value = await purgeArchivedSession(ctx, settings, sessionId, signal)
      results.push(
        value.deleted
          ? { sessionId, outcome: 'deleted', directory: value.directory }
          : { sessionId, outcome: 'nothing-to-remove', reason: value.reason },
      )
    } catch (error) {
      const code = error?.code
      if (PERMANENT_REFUSALS.has(code)) {
        results.push({ sessionId, outcome: 'dropped', code, message: messageOf(error) })
      } else {
        remaining.push(sessionId)
        results.push({ sessionId, outcome: 'still-staged', code, message: messageOf(error) })
      }
    }
  }
  writePending(path, remaining)
  return {
    pendingFile: path,
    attempted: results.length,
    deleted: results.filter((entry) => entry.outcome === 'deleted').length,
    dropped: results.filter((entry) => entry.outcome === 'dropped').length,
    stillStaged: remaining.length,
    remaining,
    results,
  }
}

/**
 * What is staged right now, without touching it.
 *
 * The browser half asks before it offers the retry, and again after running one, so
 * the pending set is read in exactly one place.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @returns the pending store's path and its Session ids.
 */
async function listPendingPurge(ctx, settings) {
  const path = await pendingFilePath(ctx, settings, undefined)
  if (path === undefined) {
    throw new PurgeError('archive-purge/no-pending-store', 'no Harness home could be resolved, so there is no deferred-purge store to read')
  }
  return { pendingFile: path, sessionIds: readPending(path) }
}

/**
 * Run the stored pass now — the answer to "must I restart DSH to finish this?".
 *
 * A Session the Host has since released is purged on the spot; one it still holds
 * stays staged and is reported as such. Nothing here widens what may be deleted:
 * every entry re-enters {@link purgeArchivedSession}, which re-checks the archive
 * mark, the running Agent, the target directory and the loaded state.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param signal - caller cancellation.
 * @returns the pass report plus the ids that are still loaded.
 */
async function retryPendingPurge(ctx, settings, signal) {
  const report = await drainStagedPurges(ctx, settings, signal)
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  return { ...report, stillLoaded: report.remaining.filter((sessionId) => isLoaded(sessions, agents, sessionId)) }
}

/**
 * Absolute path of the deferred-purge store, or undefined without a Harness home.
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param hintDirectory - a known Session directory, when the caller has one.
 * @returns the absolute pending-store path, or undefined.
 */
async function pendingFilePath(ctx, settings, hintDirectory) {
  if (settings.pendingFile !== undefined) return settings.pendingFile
  const home = await resolveHarnessHome(ctx, settings, hintDirectory)
  return home === undefined ? undefined : join(home, ...DEFAULT_PENDING_FILE.split('/'))
}

/**
 * Resolve the Harness home, for placing the deferred-purge store.
 *
 * Same three dead ends as {@link resolveSessionsRoot}: `DSH_HOME` is not exported to
 * the Host, the Loader row keeps an unevaluated `__jsExpr`, and there is no
 * `dshHomePath` global. A caller that already knows the Session's own directory hands
 * it over as the hint; otherwise any stored artifact answers.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param hintDirectory - a known `<home>/sessions/<projectKey>/<id>` directory.
 * @returns the absolute Harness home, or undefined when nothing resolves.
 */
async function resolveHarnessHome(ctx, settings, hintDirectory) {
  const fromEnvironment = readOptionalPath(process.env.DSH_HOME)
  if (fromEnvironment !== undefined) return fromEnvironment
  if (hintDirectory !== undefined) return harnessHomeOfDirectory(hintDirectory)
  const located = await locateAnyStoredArtifact(ctx, settings, ctx.sessionPersistence)
  return located === undefined ? undefined : harnessHomeOf(located)
}

/** Session ids waiting for the next start. An unreadable store reads as empty. */
function readPending(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== PENDING_VERSION || !Array.isArray(parsed.sessionIds)) return []
    return parsed.sessionIds.filter((id) => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

/** Replace the deferred-purge store atomically. */
function writePending(path, sessionIds) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: PENDING_VERSION, sessionIds }, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/**
 * Absolute directory of one stored Session.
 *
 * Preferred source is the persistence backend's own `locate(meta)` — it is not
 * part of the abstract seam, so it is duck-typed behind a check and validated;
 * the fallback re-implements the documented layout
 * `<root>/<projectKey(cwd)>/<encodeSegment(id)>/`.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param persistence - `ctx.sessionPersistence`.
 * @param header - the Session's stored header.
 * @returns the absolute Session directory (not yet verified to exist).
 */
/**
 * Absolute directory of one stored Session.
 *
 * Preferred source is the persistence backend's own `locate(meta)` — it is not part
 * of the abstract seam, so it is duck-typed behind a check and validated. The
 * fallback re-implements the documented layout
 * `<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>/`.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param persistence - `ctx.sessionPersistence`.
 * @param header - the Session's stored header.
 * @returns the absolute Session directory (not yet verified to exist).
 * @throws {PurgeError} when no directory can be established.
 */
async function resolveSessionDirectory(ctx, settings, persistence, header) {
  if (typeof persistence.locate === 'function') {
    try {
      const located = persistence.locate(header)
      if (typeof located?.path === 'string' && located.path.length > 0) return dirname(resolve(located.path))
    } catch {
      // Fall through to the documented layout.
    }
  }
  const root = await resolveSessionsRoot(ctx, settings, persistence)
  const project = header?.cwd === undefined || header.cwd === null || header.cwd === ''
    ? '_no-cwd'
    : projectKey(String(header.cwd))
  return join(root, project, encodeSegment(String(header.id ?? '')))
}

/**
 * Resolve the session storage root for the documented-layout fallback.
 *
 * The Loader row's `config.root` is NOT a source: for a `!!js dshHomePath(...)` row the
 * config tree keeps the *unevaluated* marker (`{"__jsExpr":"dshHomePath('sessions')"}`),
 * the Host process does not export `DSH_HOME`, and no `dshHomePath` global exists at
 * runtime — all three verified against the running Host. The persistence service
 * itself is the reliable source, because it can locate any stored artifact: its
 * directory is `<sessionsRoot>/<projectKey>/<id>`, so two levels up is the root.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param persistence - `ctx.sessionPersistence`.
 * @returns the absolute session root.
 * @throws {PurgeError} when no root can be established.
 */
async function resolveSessionsRoot(ctx, settings, persistence) {
  if (settings.sessionsRoot !== undefined) return settings.sessionsRoot
  const located = await locateAnyStoredArtifact(ctx, settings, persistence)
  if (located !== undefined) return sessionsRootOf(located)
  throw new PurgeError(
    'archive-purge/no-sessions-root',
    'could not resolve the session storage root; set this plugin\'s `sessionsRoot` config',
  )
}

/**
 * `<sessionsRoot>` for one located artifact:
 * `<root>/<projectKey>/<id>/session.v4.jsonl.zstd` → `<root>`.
 *
 * Every hop is spelled out because this is where an off-by-one hides: a located path
 * is a *file*, a session directory is one `dirname` up from it, the project key one
 * more, and the root one more again.
 *
 * @param locatedPath - absolute path of a stored log artifact.
 * @returns the absolute sessions root.
 */
function sessionsRootOf(locatedPath) {
  return dirname(dirname(dirname(resolve(locatedPath))))
}

/** The Harness home for one located artifact (`<home>/sessions/<key>/<id>/<log>`). */
function harnessHomeOf(locatedPath) {
  return dirname(sessionsRootOf(locatedPath))
}

/** The Harness home for one Session directory (`<home>/sessions/<key>/<id>`). */
function harnessHomeOfDirectory(directory) {
  return dirname(dirname(dirname(resolve(directory))))
}

/**
 * Absolute path of any stored Session artifact, for deriving the roots above it.
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param persistence - `ctx.sessionPersistence`.
 * @returns one located artifact path, or undefined when none can be located.
 */
async function locateAnyStoredArtifact(ctx, settings, persistence) {
  if (typeof persistence?.locate !== 'function' || typeof persistence?.list !== 'function') return undefined
  try {
    for (const snapshot of await persistence.list()) {
      const located = persistence.locate(snapshot.header)
      if (typeof located?.path === 'string' && located.path.length > 0) return resolve(located.path)
    }
  } catch (error) {
    ctx.logger?.warn?.(`archive-purge: could not locate a stored Session: ${messageOf(error)}`)
  }
  return undefined
}

/**
 * Refuse to hand an unverified path to a recursive delete. The directory must be
 * named by the encoded Session id, live under a project-key parent, and actually
 * contain session log generations — so a layout change downstream degrades to a
 * refusal instead of deleting the wrong tree.
 *
 * @param directory - candidate directory.
 * @param sessionId - expected owning Session id.
 * @throws {PurgeError} when the target fails any check.
 */
async function assertPurgeTarget(directory, sessionId) {
  const target = resolve(directory)
  if (basename(target) !== encodeSegment(sessionId)) {
    throw new PurgeError('archive-purge/target-mismatch', `refusing ${target}: it is not this session's directory`)
  }
  const parent = basename(dirname(target))
  if (parent !== '_no-cwd' && !PROJECT_DIR_KEY.test(parent)) {
    throw new PurgeError('archive-purge/target-mismatch', `refusing ${target}: unexpected project directory ${JSON.stringify(parent)}`)
  }
  const info = await stat(target).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new PurgeError('archive-purge/not-found', `session directory ${target} does not exist`)
  }
  const names = await readdir(target)
  if (!names.some((entry) => SESSION_DIR_CONTENT.test(entry))) {
    throw new PurgeError('archive-purge/target-not-a-session', `refusing ${target}: it holds no session log generation`)
  }
}

/** Archived Session ids as a plain array, tolerant of a missing accessor. */
function readArchivedIds(registry) {
  const ids = registry?.archivedSessionIds
  return Array.isArray(ids) ? ids : []
}

/** `registry.list()` behind a capability check. */
function safeList(registry) {
  try {
    const list = registry?.list?.()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * A Workspace's stored membership. The public getter filters ids whose session
 * path no longer resolves, so it would hide exactly the stale member this
 * function exists to prune; the raw record is preferred when reachable.
 */
function rawMembership(workspace) {
  const raw = workspace?.record?.sessionIds
  if (Array.isArray(raw)) return raw
  const view = workspace?.sessionIds
  return Array.isArray(view) ? view : []
}

/**
 * Mirror of the persistence backend's project directory key (`/ \ :` collapse to
 * one dash, unsafe code units become `~XXXX`, wrapped in `--` and bounded).
 * @param cwd - the Session's stored project directory.
 * @returns the project directory name.
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new PurgeError('archive-purge/bad-header', 'session header carries no working directory')
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

/**
 * Mirror of the persistence backend's path-segment escape. Real Session ids are
 * already segment-safe, so this is an identity for every ordinary id and a
 * traversal guard for a hostile one.
 * @param raw - the id to encode.
 * @returns the escaped single path segment.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new PurgeError('archive-purge/bad-request', 'session id must not be empty')
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

/** A refusal with a machine-readable code, surfaced to the browser unchanged. */
class PurgeError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - human-readable reason.
   */
  constructor(code, message) {
    super(message)
    this.name = 'PurgeError'
    this.code = code
  }
}

/** The JSON body's failure arm. */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/** A JSON response that is never cached. */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Non-empty string or undefined. */
function readOptionalPath(value) {
  return typeof value === 'string' && value.trim() !== '' ? resolve(value.trim()) : undefined
}

/** A non-negative wait budget in milliseconds, or the default. */
function readWaitBudget(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_RELEASE_WAIT_MS
}

/**
 * The requested verb, defaulting to `delete`.
 *
 * A body without `action` is the first version's request shape and keeps working;
 * an `action` of the wrong type is malformed rather than defaulted, because a typo
 * in a verb must not silently become a deletion.
 *
 * @param payload - the parsed request body.
 * @returns the verb, or undefined when `action` is present but not a string.
 */
function readAction(payload) {
  const value = payload?.action
  if (value === undefined || value === null) return ACTION_DELETE
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The requested Session id, or undefined when the payload is malformed. */
function readSessionId(payload) {
  const value = payload?.sessionId
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Message of an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
