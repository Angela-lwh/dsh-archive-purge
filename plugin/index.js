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
 * A subagent Session is a Session of its own: its transcript lives in its own
 * log directory, it is listed by `sessionQuery.listSessions()` like any other,
 * and the sidebar hides every `origin: "subagent"` row unconditionally. That
 * combination is why a deletion which removed only the parent's directory left
 * the children behind, invisible in the sidebar but still offered by the `@`
 * reference completion — the deleted conversation stayed readable through them.
 * The purge therefore cascades to the target's subagent descendants, and
 * subagent leftovers whose parent is already gone are swept.
 *
 * @module @angela_lwh/dsh-archive-purge
 */
import { open, readdir, rm, stat } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Loader identity of this plugin's Host half. */
export const name = 'archive-purge'
/**
 * Internals exposed for the test harnesses. Cordis ignores exports it does not know,
 * and these carry the arithmetic that silently misbehaves (a wrong home reads an
 * empty store and the deferred purge looks idle, and a misread lineage either
 * strands a subagent log or deletes a fork).
 */
export const __test = { pendingFilePath, resolveHarnessHome, locateAnyStoredArtifact, sessionsRootOf, harnessHomeOf, harnessHomeOfDirectory, resolveSessionsRoot, readPending, drainStagedPurges, listPendingPurge, retryPendingPurge, releaseLoadedSession, collectSessionIndex, subagentDescendantIds, orphanSubagentIds, sweepOrphanSubagents, sweepProjectionCache, staleProjectionCacheRecords, dropProjectionCacheRecord, blankCandidates, sweepBlankSessions, runHygienePass }
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
 * A subagent Session spawned by the target still has work in progress. Its
 * transcript belongs to the target, so deleting the target would destroy a
 * running conversation's context: refuse, exactly like {@link CODE_RUNNING}.
 */
const CODE_DESCENDANT_RUNNING = 'archive-purge/descendant-running'
/**
 * The target is itself a subagent Session of a Session that still exists. Its
 * catalog entry lives in the parent's projection and a child delete would leave
 * that entry dangling; a parent delete takes the child with it instead.
 */
const CODE_SUBAGENT = 'archive-purge/subagent'
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
 * The list-metadata projection's key. `blank` there means "no `turn/start` was
 * ever committed" — the product's own definition of an untouched Session — and it
 * is the cheap prefilter before the authoritative log read.
 */
const BLANK_PROJECTION = 'sessionListMetadata'
/**
 * How long a blank Session must have existed before it is collectable. A freshly
 * created one may still be the conversation the user is opening, so the sweep
 * only takes what has demonstrably been abandoned.
 */
const DEFAULT_BLANK_MIN_AGE_MS = 10 * 60 * 1000
/**
 * How large a log may be before it is assumed to hold a conversation. It is only a
 * cost gate for Sessions no checkpoint can answer for: a placeholder written at
 * entity birth is a few hundred bytes, so anything bigger is left alone rather than
 * read. A Session this gate admits is still only deleted when its log proves it.
 */
const BLANK_LOG_LIMIT_BYTES = 4096
/** What this key is *not*: a scheduled task. The sweep runs on lifecycle events only. */
const BLANK_TRIGGER_EVENTS = ['session/created', 'session/disposed']
/**
 * Refusals that can never become a purge, so a staged entry carrying one is dropped
 * instead of retried on every start. Everything else — including an unknown failure —
 * stays staged, because losing a deferred purge is worse than retrying it.
 */
const PERMANENT_REFUSALS = new Set([
  'archive-purge/not-archived',
  CODE_SUBAGENT,
  'archive-purge/no-sessions-root',
  'archive-purge/target-mismatch',
  'archive-purge/target-not-a-session',
  'archive-purge/not-found',
  'archive-purge/bad-request',
])

/**
 * Register the deletion route, then finish any purge the previous Host could not.
 * @param ctx - Host plugin context carrying Connection, the Workspace registry, and persistence.
 * @param config - optional `{ sessionsRoot, releaseWaitMs, pendingFile, harnessHome, stageWhenLoaded, releaseLoaded, sweepOrphans, sweepBlanks, blankMinAgeMs, sweepCache, cacheMinAgeMs, filterBlankReferences }` overrides.
 */
export function apply(ctx, config = {}) {
  const settings = {
    sessionsRoot: readOptionalPath(config?.sessionsRoot),
    releaseWaitMs: readWaitBudget(config?.releaseWaitMs),
    pendingFile: readOptionalPath(config?.pendingFile),
    harnessHome: readOptionalPath(config?.harnessHome),
    stageWhenLoaded: config?.stageWhenLoaded !== false,
    releaseLoaded: config?.releaseLoaded !== false,
    sweepOrphans: config?.sweepOrphans !== false,
    sweepBlanks: config?.sweepBlanks !== false,
    blankMinAgeMs: readNonNegativeMs(config?.blankMinAgeMs, DEFAULT_BLANK_MIN_AGE_MS),
    sweepCache: config?.sweepCache !== false,
    cacheMinAgeMs: readNonNegativeMs(config?.cacheMinAgeMs, DEFAULT_BLANK_MIN_AGE_MS),
    filterBlankReferences: config?.filterBlankReferences !== false,
  }
  ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleDeleteRequest(ctx, settings, request),
  })
  installBlankReferenceFilter(ctx, settings)
  watchStoreHygiene(ctx, settings)
  scheduleStagedPurges(ctx, settings)
  scheduleHygieneWhenReady(ctx, settings)
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
 * Permanently delete one archived Session: its log directory, the log
 * directories of the subagent Sessions it spawned, their and its durable
 * membership, and their archive marks.
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
 * @returns a report of what was removed, including the subagent descendants.
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
      return { sessionId, deleted: false, reason: 'already-purged', descendants: [], orphansSwept: [] }
    }
    await retireMetadata(ctx, registry, sessionId)
    await dropProjectionCacheRecord(ctx, settings, sessionId)
    const swept = await sweepOrphanSubagents(ctx, settings, signal)
    return { sessionId, deleted: false, reason: 'no-stored-log', descendants: [], orphansSwept: swept.deleted }
  }

  const header = snapshot.header
  // One index serves the two questions a subagent target raises: does its parent
  // still exist (a child of a live parent is refused, a leftover is deletable), and
  // which Sessions did this one spawn. Without a listing the plugin cannot answer
  // either, so it falls back to the original refusal rather than guessing.
  const index = await collectSessionIndex(ctx)
  signal?.throwIfAborted()
  if (header?.origin === 'subagent' && !(await orphanSubagent(index, persistence, sessionId, signal))) {
    throw new PurgeError(CODE_SUBAGENT, `session ${sessionId} is subagent-owned history`)
  }

  // Resolve and verify the target BEFORE deciding whether to act now: a bad target is
  // a hard refusal in either case, and the directory is what locates the Harness home
  // for a staged purge.
  const directory = await resolveSessionDirectory(ctx, settings, persistence, header)
  await assertPurgeTarget(directory, sessionId)
  signal?.throwIfAborted()

  // The Sessions this deletion takes with it. A subagent child is hidden from the
  // sidebar by origin, but `sessionQuery.listSessions()` still lists it and the `@`
  // reference completion offers it — so deleting only the parent leaves the
  // conversation readable through its children.
  const descendants = subagentDescendantIds(index, sessionId)
  for (const descendant of descendants) {
    if (agents?.get?.(descendant)?.status === 'running') {
      throw new PurgeError(
        CODE_DESCENDANT_RUNNING,
        `subagent session ${descendant} of ${sessionId} has work in progress`,
      )
    }
  }
  // Verify every descendant directory BEFORE removing anything, so that one guard
  // failure cannot leave a conversation half-deleted.
  const plans = await planPurgeTargets(ctx, settings, persistence, index, directory, sessionId, descendants, signal)

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
  // A descendant the Host still holds is released on the same terms: it is invisible
  // history whose owner is being deleted, and work in progress was refused above.
  for (const descendant of descendants) {
    if (!isLoaded(sessions, agents, descendant)) continue
    const released = await releaseLoadedSession(ctx, sessions, agents, descendant, settings, true)
    ctx.logger?.info?.(released.released
      ? `archive-purge: released the Host's hold on subagent ${descendant}`
      : `archive-purge: kept subagent ${descendant} loaded (${released.reason})`)
  }
  if (isLoaded(sessions, agents, sessionId) || descendants.some((id) => isLoaded(sessions, agents, id))) {
    if (!settings.stageWhenLoaded) {
      throw new PurgeError(CODE_LOADED, `session ${sessionId} is still loaded by the Host`)
    }
    await stageStagedPurge(ctx, settings, sessionId, directory)
    throw new PurgeError(
      CODE_DEFERRED,
      `session ${sessionId} is loaded by the Host; its purge is staged for the next start`,
    )
  }

  for (const plan of plans) {
    if (plan.directory === undefined) continue
    await rm(plan.directory, { recursive: true, force: true, maxRetries: 3 })
  }
  for (const plan of plans) await retireMetadata(ctx, registry, plan.sessionId)
  for (const plan of plans) await dropProjectionCacheRecord(ctx, settings, plan.sessionId)
  for (const plan of plans) {
    // Display-only removal on the forwarded-event allowlist: every connected GUI
    // drops the row through `handleSessionRemoved` without a reload or restart.
    ctx.emit('api-session/removed', plan.sessionId)
  }
  // Leftovers from deletions this plugin performed before it cascaded: their parent
  // is already gone, so nothing can ever browse or open them again.
  const swept = await sweepOrphanSubagents(ctx, settings, signal)
  // Abandoned blank placeholders and orphaned cache records are collected on the same
  // occasion, so a deletion leaves the store as tidy as it found it.
  await runHygienePass(ctx, settings, signal)
  return {
    sessionId,
    deleted: true,
    directory,
    descendants: plans.slice(1).map((plan) => plan.sessionId),
    orphansSwept: swept.deleted,
  }
}

/**
 * Every Session a purge will touch, with its verified directory, computed before
 * the first byte is removed.
 *
 * A descendant whose log is not on disk (a live subagent that never materialized)
 * still gets a plan with no directory, so its bookkeeping is retired with the rest
 * instead of surviving as a ghost.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param persistence - `ctx.sessionPersistence`.
 * @param index - the Session index, when one could be listed.
 * @param directory - the target's own verified directory.
 * @param sessionId - target Session id.
 * @param descendants - subagent descendants of the target.
 * @param signal - caller cancellation.
 * @returns one plan per Session, the target first.
 * @throws {PurgeError} when any target fails the directory guard.
 */
async function planPurgeTargets(ctx, settings, persistence, index, directory, sessionId, descendants, signal) {
  const plans = [{ sessionId, directory }]
  for (const descendant of descendants) {
    signal?.throwIfAborted()
    const header = index?.byId.get(descendant)
    const stored = await persistence.stat(descendant, { signal })
    if (stored === undefined) {
      plans.push({ sessionId: descendant, directory: undefined })
      continue
    }
    const childDirectory = await resolveSessionDirectory(ctx, settings, persistence, header ?? stored.header)
    await assertPurgeTarget(childDirectory, descendant)
    plans.push({ sessionId: descendant, directory: childDirectory })
  }
  return plans
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
 * meantime). A subagent descendant is the one exception: it never carries an
 * archive mark of its own because the sidebar never shows it, so the archived
 * ancestor it belongs to is its authorization instead.
 *
 * @param ctx - Host context.
 * @param sessions - `ctx.sessions`, when present.
 * @param agents - `ctx.agents`, when present.
 * @param sessionId - target Session id.
 * @param settings - resolved plugin config.
 * @param allowUnarchived - release a subagent descendant, which never carries an archive mark.
 * @returns whether it was released, and why not when it was not.
 */
async function releaseLoadedSession(ctx, sessions, agents, sessionId, settings, allowUnarchived = false) {
  if (settings.releaseLoaded !== true) return { released: false, reason: 'disabled by configuration' }
  if (agents?.get?.(sessionId)?.status === 'running') return { released: false, reason: 'work in progress' }
  if (!allowUnarchived && !readArchivedIds(ctx.workspaceRegistry).includes(sessionId)) {
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
 * `<home>/storages/session_projcache/sessions` — the projection cache's per-record
 * layout, one `<sessionId>.json` file per Session.
 *
 * The cache service exposes reads and writes but no delete, and the layout is a
 * documented per-record directory (`a write rewrites one record instead`), so a
 * record whose Session is gone is removed as a file. Its in-memory row is left
 * behind on purpose: nothing ever writes it again (a `put` needs a live Session),
 * and every read is identity-checked, so a stale row can never answer for another
 * lifecycle.
 */
const CACHE_RECORD_DIR = 'storages/session_projcache/sessions'
/** Suffix of one stored projection-cache record. */
const CACHE_RECORD_SUFFIX = '.json'

/**
 * Harness home, remembered once it resolves.
 *
 * Every path this plugin owns lives under it, and the original resolution needs at
 * least one stored artifact — so without a remembered home a store emptied by this
 * plugin could no longer locate its own deferred-purge file.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config, used as the memo.
 * @returns the absolute home, or undefined when nothing resolves.
 */
async function harnessHomeFor(ctx, settings) {
  if (settings.harnessHome !== undefined) return settings.harnessHome
  const home = await resolveHarnessHome(ctx, settings, undefined)
  if (home !== undefined) settings.harnessHome = home
  return home
}

/**
 * Absolute path of the projection-cache record directory, when it can be derived.
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @returns the directory path, or undefined.
 */
async function projectionCacheDirectory(ctx, settings) {
  const home = await harnessHomeFor(ctx, settings)
  return home === undefined ? undefined : join(home, ...CACHE_RECORD_DIR.split('/'))
}

/**
 * Whether a file is one of this cache's records, judged by its stored shape
 * (`{ version, record: { identity, rows } }`). Anything else is left alone: a shape
 * this plugin does not recognise is never deleted on a filename's word.
 *
 * @param path - absolute record path.
 * @returns true when the file parses as a cache record.
 */
async function isProjectionCacheRecord(path) {
  // A bounded read, not a parse: the directory belongs to the cache, and one of these
  // records can be a hundred kilobytes, so the pass must not walk them all.
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(4096)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const head = buffer.subarray(0, bytesRead).toString('utf8')
      return head.includes('"version"') && head.includes('"record"') && head.includes('"identity"')
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/**
 * Drop the projection-cache record of one Session this plugin just deleted.
 *
 * Best effort by design: the Session is already gone, and a cache record that
 * survives only costs a cold projection on a Session nobody can open.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param sessionId - the Session whose record is stale.
 */
async function dropProjectionCacheRecord(ctx, settings, sessionId) {
  try {
    const directory = await projectionCacheDirectory(ctx, settings)
    if (directory === undefined) return
    const path = join(directory, `${sessionId}${CACHE_RECORD_SUFFIX}`)
    if (!(await isProjectionCacheRecord(path))) return
    await rm(path, { force: true })
  } catch (error) {
    ctx.logger?.warn?.(`archive-purge: could not drop the projection-cache record of ${sessionId}: ${messageOf(error)}`)
  }
}

/**
 * Projection-cache records whose Session no longer exists anywhere.
 *
 * A record is stale only when the id is absent from the stored index *and* from the
 * live registry, its file still parses as a cache record, and it has been quiet for
 * `cacheMinAgeMs` — a Session created a moment ago may not have written its log yet.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @returns `{ directory, records }`, or undefined when nothing can be listed.
 */
async function staleProjectionCacheRecords(ctx, settings) {
  const index = await collectSessionIndex(ctx)
  if (index === undefined) return undefined
  const directory = await projectionCacheDirectory(ctx, settings)
  if (directory === undefined) return undefined
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { directory, records: [] }
    ctx.logger?.warn?.(`archive-purge: could not list the projection cache: ${messageOf(error)}`)
    return undefined
  }
  const live = new Set()
  for (const session of safeList(ctx.get('sessions'))) if (typeof session?.id === 'string') live.add(session.id)
  const now = Date.now()
  const records = []
  for (const entry of entries) {
    if (entry.isFile() !== true || !entry.name.endsWith(CACHE_RECORD_SUFFIX)) continue
    const sessionId = entry.name.slice(0, -CACHE_RECORD_SUFFIX.length)
    if (sessionId === '' || index.byId.has(sessionId) || live.has(sessionId)) continue
    const path = join(directory, entry.name)
    try {
      const stats = await stat(path)
      if (now - stats.mtimeMs < settings.cacheMinAgeMs) continue
      if (!(await isProjectionCacheRecord(path))) continue
      records.push({ sessionId, path })
    } catch {
      // An unreadable record is left alone; it is not worth failing the pass over.
    }
  }
  return { directory, records }
}

/**
 * Delete projection-cache records left behind by Sessions this plugin (or an older
 * install) already removed. Records of existing Sessions are never touched.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param signal - caller cancellation.
 * @returns what was examined, deleted, skipped, and failed.
 */
async function sweepProjectionCache(ctx, settings, signal) {
  const report = { examined: 0, deleted: [], skipped: [], failed: [] }
  if (settings.sweepCache !== true) return report
  const stale = await staleProjectionCacheRecords(ctx, settings)
  if (stale === undefined) {
    report.reason = 'no-cache-listing'
    return report
  }
  report.examined = stale.records.length
  for (const record of stale.records) {
    signal?.throwIfAborted()
    try {
      await rm(record.path, { force: true })
      report.deleted.push(record.sessionId)
    } catch (error) {
      report.failed.push({ sessionId: record.sessionId, code: error?.code ?? 'archive-purge/failed', message: messageOf(error) })
    }
  }
  if (report.deleted.length > 0) {
    ctx.logger?.info?.(`archive-purge: removed ${String(report.deleted.length)} orphaned projection-cache record(s)`)
  }
  return report
}

/**
 * Every Session header this Host can see, stored and live, keyed by id.
 *
 * The listing is the only source that can answer "does this Session's parent
 * still exist" and "which Sessions did this one spawn" without opening a log. It
 * is best-effort: a Host whose listing fails still deletes the Session the user
 * named, it just cannot also take the descendants with it.
 *
 * @param ctx - Host context.
 * @returns the index, or undefined when stored Sessions cannot be listed.
 */
async function collectSessionIndex(ctx) {
  const persistence = ctx.sessionPersistence
  if (typeof persistence?.list !== 'function') return undefined
  const byId = new Map()
  try {
    const listed = await persistence.list()
    if (Array.isArray(listed)) {
      for (const snapshot of listed) {
        const header = snapshot?.header
        if (typeof header?.id !== 'string' || header.id === '') continue
        byId.set(header.id, header)
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`archive-purge: could not list stored Sessions: ${messageOf(error)}`)
    return undefined
  }
  const live = ctx.get('sessions')?.list?.()
  if (Array.isArray(live)) {
    for (const session of live) {
      if (typeof session?.id !== 'string' || session.id === '') continue
      // A live Session without a stored log still owns its children: its header is
      // what keeps a just-spawned subagent from looking orphaned.
      if (!byId.has(session.id) && session.header !== undefined) byId.set(session.id, session.header)
    }
  }
  return { byId }
}

/**
 * Ids of the subagent Sessions spawned by one Session, transitively.
 *
 * Lineage follows `parentSession` through `origin: "subagent"` headers only: a
 * fork of a Session is an independent conversation and must survive its source.
 *
 * @param index - {@link collectSessionIndex}'s result, when available.
 * @param rootId - the Session being deleted.
 * @returns descendant ids, in breadth-first order, target excluded.
 */
function subagentDescendantIds(index, rootId) {
  if (index === undefined) return []
  const children = new Map()
  for (const [id, header] of index.byId) {
    if (header?.origin !== 'subagent') continue
    const parent = header.parentSession
    if (typeof parent !== 'string' || parent === '') continue
    const bucket = children.get(parent)
    if (bucket === undefined) children.set(parent, [id])
    else bucket.push(id)
  }
  const descendants = []
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      descendants.push(child)
      queue.push(child)
    }
  }
  return descendants
}

/**
 * Whether a subagent header's parent is absent from a listing.
 * @param index - the Session index.
 * @param header - the candidate's header.
 * @returns true for a subagent Session whose parent Session is gone.
 */
function isOrphanSubagentHeader(index, header) {
  if (header?.origin !== 'subagent') return false
  const parent = header.parentSession
  if (typeof parent !== 'string' || parent === '') return false
  return !index.byId.has(parent)
}

/**
 * Whether the target is a subagent Session whose parent no longer exists.
 *
 * The listing alone is not proof: a parent whose log is still on disk but whose
 * header cannot be decoded never reaches the listing, and its child must not be
 * mistaken for a leftover. The parent's own `stat` settles that case, and a
 * failure there counts as "still there" so an unreadable store never authorizes
 * a delete.
 *
 * @param index - the Session index, when one could be listed.
 * @param persistence - `ctx.sessionPersistence`.
 * @param sessionId - candidate Session id.
 * @param signal - caller cancellation.
 * @returns true only when the parent is provably gone.
 */
async function orphanSubagent(index, persistence, sessionId, signal) {
  if (index === undefined) return false
  const header = index.byId.get(sessionId)
  if (header === undefined || !isOrphanSubagentHeader(index, header)) return false
  const parent = header.parentSession
  try {
    return (await persistence.stat(parent, { signal })) === undefined
  } catch {
    return false
  }
}

/**
 * Leftover subagent Sessions: children whose parent Session is gone.
 *
 * These are what a deletion that did not cascade leaves behind. The sidebar
 * hides every `origin: "subagent"` row, so nothing in the product can show them
 * again, but `sessionQuery.listSessions()` still lists them and the `@`
 * reference completion still offers them — a deleted conversation's transcripts
 * stay readable through them.
 *
 * @param index - the Session index, when one could be listed.
 * @returns the orphaned ids, sorted for a deterministic report.
 */
function orphanSubagentIds(index) {
  if (index === undefined) return []
  const orphans = []
  for (const [id, header] of index.byId) if (isOrphanSubagentHeader(index, header)) orphans.push(id)
  return orphans.sort()
}

/**
 * Delete every leftover subagent Session whose parent is gone.
 *
 * Confined by construction: a candidate must be subagent-origin, its parent must
 * be absent from both the listing and a direct `stat`, it must be idle and not
 * held by the Host, and its directory must pass the same guard as a normal purge.
 * A candidate that is held, running, or fails a guard is reported and left for a
 * later pass; it is never forced.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param signal - caller cancellation.
 * @returns what was examined, deleted, skipped, and failed.
 */
async function sweepOrphanSubagents(ctx, settings, signal) {
  const report = { examined: 0, deleted: [], skipped: [], failed: [] }
  if (settings.sweepOrphans !== true) return report
  const index = await collectSessionIndex(ctx)
  if (index === undefined) return report
  const persistence = ctx.sessionPersistence
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const candidates = orphanSubagentIds(index)
  report.examined = candidates.length
  for (const sessionId of candidates) {
    signal?.throwIfAborted()
    if (agents?.get?.(sessionId)?.status === 'running') {
      report.skipped.push({ sessionId, reason: 'work in progress' })
      continue
    }
    if (isLoaded(sessions, agents, sessionId)) {
      report.skipped.push({ sessionId, reason: 'held by the Host' })
      continue
    }
    const header = index.byId.get(sessionId)
    if (!(await orphanSubagent(index, persistence, sessionId, signal))) {
      report.skipped.push({ sessionId, reason: 'its parent is back' })
      continue
    }
    try {
      const snapshot = await persistence.stat(sessionId, { signal })
      if (snapshot !== undefined) {
        const directory = await resolveSessionDirectory(ctx, settings, persistence, snapshot.header ?? header)
        await assertPurgeTarget(directory, sessionId)
        await rm(directory, { recursive: true, force: true, maxRetries: 3 })
      }
      await retireMetadata(ctx, ctx.workspaceRegistry, sessionId)
      await dropProjectionCacheRecord(ctx, settings, sessionId)
      ctx.emit('api-session/removed', sessionId)
      report.deleted.push(sessionId)
    } catch (error) {
      report.failed.push({ sessionId, code: error?.code ?? 'archive-purge/failed', message: messageOf(error) })
    }
  }
  if (report.deleted.length > 0) {
    ctx.logger?.info?.(`archive-purge: removed ${String(report.deleted.length)} leftover subagent session(s) of deleted conversations`)
  }
  return report
}

/**
 * What the projection cache remembers about a header's blankness, without reading
 * a log. `true` means the last checkpoint saw no `turn/start`; `undefined` means
 * the cache cannot answer (an uncheckpointed Session, a version mismatch, or no
 * cache service at all) and the caller must not guess.
 *
 * @param projections - `ctx.sessionProjectionCache`, when present.
 * @param header - the stored Session header.
 * @returns `true`, `false`, or `undefined` when unknown.
 */
function cachedBlank(projections, header) {
  try {
    return readBlankValue(projections?.cachedSnapshot?.(header, [BLANK_PROJECTION]))
  } catch {
    return undefined
  }
}

/** One projection snapshot's `blank` flag, or undefined when it cannot answer. */
function readBlankValue(snapshot) {
  const value = snapshot?.values?.[BLANK_PROJECTION]
  return typeof value?.blank === 'boolean' ? value.blank : undefined
}

/**
 * Whether a listed Session has never started a turn, answered the way the Session
 * list answers it: the live projection cut for an attached Session, the durable
 * checkpoint for a cold one. Unknown stays unknown.
 *
 * @param ctx - Host context.
 * @param header - the Session header the caller already holds.
 * @returns `true`, `false`, or `undefined`.
 */
function projectionBlank(ctx, header) {
  try {
    const session = ctx.get('sessions')?.get?.(header.id)
    if (session !== undefined) {
      return readBlankValue(ctx.get('sessionProjections')?.snapshot?.(session, [BLANK_PROJECTION]))
    }
    return cachedBlank(ctx.get('sessionProjectionCache'), header)
  } catch {
    return undefined
  }
}

/** Marks a resolver whose label projection this plugin already filtered. */
const BLANK_REFERENCE_FILTER = Symbol('archive-purge.blank-reference-filter')

/**
 * Keep untouched Session placeholders out of `@` reference discovery.
 *
 * `sessionQuery.listSessions()` lists a blank placeholder like any other Session,
 * while the sidebar hides every blank row — so the `@` menu offered the very
 * "new conversation" shells the user abandoned. The proper fix is in
 * `@deepseek-ai/dsh-session-reference` itself (its label projection never asks for
 * `sessionListMetadata`); until every Host carries it, this wraps the resolver's
 * label step, which is the one place where it already holds each listed header.
 *
 * Deliberately conservative: only a positive `blank` is dropped, an unanswerable
 * Session stays listed, a resolver without that step is left alone, and the filter
 * can be switched off with `filterBlankReferences: false`.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 */
function installBlankReferenceFilter(ctx, settings) {
  if (settings.filterBlankReferences !== true || typeof ctx.inject !== 'function') return
  ctx.inject(['sessionReferenceResolver'], () => {
    try {
      const resolver = ctx.get('sessionReferenceResolver')
      if (resolver === undefined || resolver[BLANK_REFERENCE_FILTER] === true) return
      if (typeof resolver.projectedLabels !== 'function') return
      const original = resolver.projectedLabels
      Object.defineProperty(resolver, BLANK_REFERENCE_FILTER, { value: true, configurable: true })
      resolver.projectedLabels = function filterBlankLabels(items) {
        const labelled = original.call(this, items)
        if (!Array.isArray(labelled)) return labelled
        return labelled.filter((item) => projectionBlank(ctx, item?.record?.header) !== true)
      }
    } catch (error) {
      ctx.logger?.warn?.(`archive-purge: blank reference filter not installed: ${messageOf(error)}`)
    }
  })
}

/** Whether the Workspace registry pins this Session; a pinned row is never swept. */
function isPinned(registry, sessionId) {
  const pinned = registry?.pinnedSessionIds
  return Array.isArray(pinned) && pinned.includes(sessionId)
}

/**
 * Blank Sessions the sweep may collect, filtered by everything that can be decided
 * without reading a log: subagent origin, work in progress, the Host's hold, a pin,
 * the minimum age, and what the projection cache can say. A cached `false` is
 * decisive (history), a cached `true` needs only the log confirmation, and an
 * unknown one is kept as a candidate so the caller can gate it on the log size.
 *
 * @param index - the Session index, when one could be listed.
 * @param projections - `ctx.sessionProjectionCache`, when present.
 * @param sessions - `ctx.sessions`, when present.
 * @param agents - `ctx.agents`, when present.
 * @param registry - `ctx.workspaceRegistry`.
 * @param options - `{ minAgeMs, now }`.
 * @returns the candidates, with their headers and whether a checkpoint vouched for them.
 */
function blankCandidates(index, projections, sessions, agents, registry, options) {
  if (index === undefined) return []
  const candidates = []
  for (const [sessionId, header] of index.byId) {
    if (header?.origin === 'subagent') continue
    if (agents?.get?.(sessionId)?.status === 'running') continue
    // A Session the Host holds may be open in a window, so it is never a candidate.
    if (isLoaded(sessions, agents, sessionId)) continue
    if (isPinned(registry, sessionId)) continue
    const createdAt = typeof header.createdAt === 'number' ? header.createdAt : undefined
    if (options.minAgeMs > 0 && (createdAt === undefined || options.now - createdAt < options.minAgeMs)) continue
    const cached = cachedBlank(projections, header)
    if (cached === false) continue
    if (options.confirmedOnly === true && cached !== true) continue
    candidates.push({ sessionId, header, cached: cached === true })
  }
  return candidates
}

/**
 * Delete blank Sessions: placeholders created for a conversation that was never
 * engaged, which the sidebar hides and the `@` reference completion still lists.
 *
 * Nothing about them is guesswork. A candidate must be cold (a Session open in any
 * window is loaded), older than `blankMinAgeMs`, unpinned, positively blank in the
 * projection cache, and its log must prove it: one `turn/start` anywhere and it is
 * history, not a placeholder. The directory then passes the same guard as a normal
 * purge. Anything else is skipped, never forced.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param signal - caller cancellation.
 * @returns what was examined, deleted, skipped, and failed.
 */
async function sweepBlankSessions(ctx, settings, signal) {
  const report = { examined: 0, deleted: [], skipped: [], failed: [] }
  if (settings.sweepBlanks !== true) return report
  const index = await collectSessionIndex(ctx)
  // `readSession` is the public read; `load` belongs to the internal corpus of
  // `@deepseek-ai/dsh-session-query` and is not on the service at all — checking for
  // it made every pass since the first release return here, silently.
  const query = settings.sessionQueryService ?? ctx.get('sessionQuery')
  const readLog = typeof query?.readSession === 'function'
    ? (sessionId) => query.readSession(sessionId)
    : undefined
  // Without the read service the plugin cannot prove "no turn ever started", so it
  // does nothing rather than deleting on a cache hint alone — and says why.
  if (index === undefined) {
    report.reason = 'no-session-listing'
    ctx.logger?.info?.('archive-purge: blank sweep found no session listing; skipping this pass')
    return report
  }
  if (readLog === undefined) {
    report.reason = 'no-session-query'
    ctx.logger?.info?.('archive-purge: blank sweep has no readable session query; skipping this pass')
    return report
  }
  const persistence = ctx.sessionPersistence
  const candidates = blankCandidates(index, ctx.get('sessionProjectionCache'), ctx.get('sessions'), ctx.get('agents'), ctx.workspaceRegistry, {
    minAgeMs: settings.blankMinAgeMs,
    now: Date.now(),
  })
  report.examined = candidates.length
  for (const { sessionId, header, cached } of candidates) {
    signal?.throwIfAborted()
    try {
      const snapshot = await persistence.stat(sessionId, { signal })
      if (snapshot === undefined) {
        report.skipped.push({ sessionId, reason: 'no stored log' })
        continue
      }
      // A snapshot without a physical size comes from the backend's pending-write
      // tracker: a handle is still open and dropping the file now would only make it
      // re-materialize on the next append.
      if (typeof snapshot.sizeBytes !== 'number') {
        report.skipped.push({ sessionId, reason: 'its write handle is still open' })
        continue
      }
      // Nothing vouched for this one, so it is read only when the log is small enough
      // to be a birth placeholder; a real conversation is never opened for the sweep.
      if (!cached && (snapshot.sizeBytes ?? Number.POSITIVE_INFINITY) > BLANK_LOG_LIMIT_BYTES) {
        report.skipped.push({ sessionId, reason: 'its log is too large to be a placeholder' })
        continue
      }
      const loaded = await readLog(sessionId)
      if (loaded.events.some((event) => event.type === 'turn/start')) {
        report.skipped.push({ sessionId, reason: 'it had a turn' })
        continue
      }
      const directory = await resolveSessionDirectory(ctx, settings, persistence, snapshot.header ?? header)
      await assertPurgeTarget(directory, sessionId)
      await rm(directory, { recursive: true, force: true, maxRetries: 3 })
      await retireMetadata(ctx, ctx.workspaceRegistry, sessionId)
      await dropProjectionCacheRecord(ctx, settings, sessionId)
      ctx.emit('api-session/removed', sessionId)
      report.deleted.push(sessionId)
    } catch (error) {
      report.failed.push({ sessionId, code: error?.code ?? 'archive-purge/failed', message: messageOf(error) })
    }
  }
  if (report.deleted.length > 0) {
    ctx.logger?.info?.(`archive-purge: removed ${String(report.deleted.length)} blank session placeholder(s)`)
  } else if (report.examined > 0) {
    ctx.logger?.info?.(`archive-purge: blank sweep left ${String(report.skipped.length)} of ${String(report.examined)} candidate placeholder(s) alone`)
  }
  if (report.failed.length > 0) {
    ctx.logger?.warn?.(`archive-purge: blank sweep could not remove ${String(report.failed.length)} placeholder(s)`)
  }
  return report
}

/**
 * Collect blank placeholders whenever a Session is born or leaves the store.
 *
 * These are lifecycle edges, not a schedule: starting a new conversation is the
 * moment the previous untouched placeholder stops being the one the user is about
 * to use, and a disposal is the moment a Session can no longer be open anywhere.
 * Bursts collapse into one pass, and nothing runs off a timer.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 */
function watchStoreHygiene(ctx, settings) {
  if (typeof ctx.on !== 'function') return
  if (settings.sweepBlanks !== true && settings.sweepCache !== true) return
  let running = false
  let dirty = false
  const run = () => {
    if (running) {
      dirty = true
      return
    }
    running = true
    Promise.resolve()
      .then(() => runHygienePass(ctx, settings, undefined))
      .catch((error) => {
        ctx.logger?.warn?.(`archive-purge: store hygiene pass failed: ${messageOf(error)}`)
      })
      .finally(() => {
        running = false
        if (dirty) {
          dirty = false
          run()
        }
      })
  }
  for (const event of BLANK_TRIGGER_EVENTS) ctx.on(event, () => run())
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
 * Finish the purges staged by a previous Host, now that nothing is loaded, and
 * sweep the subagent leftovers of deletions performed before the purge cascaded.
 *
 * Runs once, off the composition path: a failure here must never stop the profile
 * from booting, and an entry that is somehow still loaded stays staged for the next
 * start instead of being dropped. The two passes are independent so that an
 * unresolvable deferred-purge store cannot also strand the leftovers.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 */
function scheduleStagedPurges(ctx, settings) {
  Promise.resolve()
    .then(async () => {
      try {
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
      } catch (error) {
        ctx.logger?.warn?.(`archive-purge: staged purge pass failed: ${messageOf(error)}`)
      }
      try {
        await sweepOrphanSubagents(ctx, settings, undefined)
      } catch (error) {
        ctx.logger?.warn?.(`archive-purge: leftover subagent sweep failed: ${messageOf(error)}`)
      }
    })
    .catch((error) => {
      ctx.logger?.warn?.(`archive-purge: staged purge pass failed: ${messageOf(error)}`)
    })
}

/**
 * One hygiene pass: abandoned blank placeholders, then projection-cache records whose
 * Session is gone. Both are the residue of deletions, so they are collected together.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param signal - caller cancellation.
 * @returns both reports.
 */
async function runHygienePass(ctx, settings, signal) {
  const blanks = await sweepBlankSessions(ctx, settings, signal)
  const cache = await sweepProjectionCache(ctx, settings, signal)
  return { blanks, cache }
}

/**
 * Run the opening hygiene pass once the query service exists.
 *
 * The blank half cannot decide anything without `sessionQuery` — that is what proves
 * a log never started a turn — and a service read with `ctx.get` during `apply` may
 * not be registered yet (it is provided by another plugin row). Scheduling through
 * `ctx.inject` makes the pass wait for readiness instead of silently doing nothing,
 * which is exactly how the first automatic pass used to disappear.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 */
function scheduleHygieneWhenReady(ctx, settings) {
  const run = () => {
    Promise.resolve()
      .then(() => runHygienePass(ctx, settings, undefined))
      .catch((error) => {
        ctx.logger?.warn?.(`archive-purge: store hygiene pass failed: ${messageOf(error)}`)
      })
  }
  if (typeof ctx.inject !== 'function') {
    run()
    return
  }
  // Keep the resolved instance: `ctx.get` is a strict lookup that answers undefined
  // while the provider fiber has not finished loading, and every later pass (event
  // sweep, cleanup dialog) should reuse the one the fiber actually injected.
  ctx.inject(['sessionQuery'], (sub) => {
    if (sub?.sessionQuery !== undefined) settings.sessionQueryService = sub.sessionQuery
    run()
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
 * the pending set is read in exactly one place. The same read answers the second
 * kind of leftover: subagent Sessions whose parent conversation was deleted before
 * this plugin cascaded, which nothing else in the product can reach any more.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @returns the pending store's path, its Session ids, and the leftover subagent ids.
 */
async function listPendingPurge(ctx, settings) {
  const path = await pendingFilePath(ctx, settings, undefined)
  if (path === undefined) {
    throw new PurgeError('archive-purge/no-pending-store', 'no Harness home could be resolved, so there is no deferred-purge store to read')
  }
  const index = await collectSessionIndex(ctx)
  const blanks = settings.sweepBlanks === true
    ? blankCandidates(index, ctx.get('sessionProjectionCache'), ctx.get('sessions'), ctx.get('agents'), ctx.workspaceRegistry, {
      minAgeMs: settings.blankMinAgeMs,
      now: Date.now(),
      // The dialog promises only what a checkpoint already vouches for; the pass itself
      // also takes uncheckpointed small logs, and reports those when it runs.
      confirmedOnly: true,
    })
    : []
  const stale = settings.sweepCache === true ? await staleProjectionCacheRecords(ctx, settings) : undefined
  return {
    pendingFile: path,
    sessionIds: readPending(path),
    orphanSubagentIds: orphanSubagentIds(index),
    blankSessionIds: blanks.map((candidate) => candidate.sessionId),
    staleCacheRecordIds: (stale?.records ?? []).map((record) => record.sessionId),
  }
}

/**
 * Run the stored pass now — the answer to "must I restart DSH to finish this?".
 *
 * A Session the Host has since released is purged on the spot; one it still holds
 * stays staged and is reported as such. Nothing here widens what may be deleted:
 * every entry re-enters {@link purgeArchivedSession}, which re-checks the archive
 * mark, the running Agent, the target directory and the loaded state. The pass
 * then sweeps leftover subagent Sessions, so one cleanup also removes what earlier
 * deletions left behind.
 *
 * @param ctx - Host context.
 * @param settings - resolved plugin config.
 * @param signal - caller cancellation.
 * @returns the pass report plus the ids that are still loaded and the sweep.
 */
async function retryPendingPurge(ctx, settings, signal) {
  const report = await drainStagedPurges(ctx, settings, signal)
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const orphans = await sweepOrphanSubagents(ctx, settings, signal)
  const blanks = await sweepBlankSessions(ctx, settings, signal)
  const cache = await sweepProjectionCache(ctx, settings, signal)
  return {
    ...report,
    stillLoaded: report.remaining.filter((sessionId) => isLoaded(sessions, agents, sessionId)),
    orphans,
    blanks,
    cache,
  }
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
  if (home !== undefined) settings.harnessHome = home
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
  if (settings.harnessHome !== undefined) return settings.harnessHome
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
  return readNonNegativeMs(value, DEFAULT_RELEASE_WAIT_MS)
}

/** A non-negative millisecond budget, or the fallback for a missing/invalid value. */
function readNonNegativeMs(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
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
