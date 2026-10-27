/**
 * Headless test for the hand-written browser bundle.
 *
 * `plugin/lib/client.js` is an artifact, not source that a bundler type-checks,
 * so this harness stands in for the two things the page provides: the
 * `window.__ModuleLoader__` registration facade and the platform module table.
 * It then drives the registered components directly, which is where the real
 * risks live — slot names, the `hooks` -> `use<Name>` projection, the props the
 * workspace row passes, and the RPC envelope handling.
 *
 * Usage: node tools/test-client.mjs
 */
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'plugin', 'lib', 'client.js')

/** Captured `load({ id, factory })` call. */
let registration
globalThis.window = globalThis.window ?? {}
globalThis.window.__ModuleLoader__ = {
  load(value) {
    registration = value
  },
}

/** The page globals the bundle touches: a document and the route fetch. */
const styleElements = []
globalThis.document = {
  baseURI: 'http://127.0.0.1:19387/',
  querySelectorAll: () => [],
  createElement: () => ({
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    set textContent(value) {
      this.css = value
    },
  }),
  head: {
    append(element) {
      styleElements.push(element)
    },
  },
}

/** Recorded route calls and the answer the fake Host returns next. */
const routeCalls = []
let routeAnswer = { status: 200, body: { ok: true, value: { sessionId: 'session-archived-1', deleted: true } } }
globalThis.fetch = async (url, init) => {
  routeCalls.push({ url: String(url), init })
  return {
    status: routeAnswer.status,
    async text() {
      return typeof routeAnswer.body === 'string' ? routeAnswer.body : JSON.stringify(routeAnswer.body)
    },
  }
}

/** Minimal element factory standing in for the JSX runtime. */
const element = (type, props) => ({ type, props: props ?? {} })
const jsx = (type, props) => element(type, props)
const jsxs = (type, props) => element(type, props)
const Fragment = Symbol('Fragment')

/** React stand-in: only the hooks the bundle actually calls. */
const React = {
  useState: (initial) => [initial, () => {}],
  useMemo: (create) => create(),
  // The retry dialog reads the pending store from an effect, so the stub runs one
  // pass and its cleanup immediately — the same synchronous shape as the others.
  useEffect: (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  },
  createElement: element,
}

/** Primitive stand-ins, each identifiable by name so assertions can name them. */
const primitiveStub = (name) => ({ primitive: name })
const primitives = new Proxy({}, {
  get(_target, property) {
    return primitiveStub(String(property))
  },
})

/** Snapshot store stand-in with the observable contract the slot runtime expects. */
function createSnapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

const MODULES = {
  react: React,
  'react/jsx-runtime': { jsx, jsxs, Fragment },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
  '@deepseek-ai/dsh-client-store': { createSnapshotStore },
}

/** The page's synchronous module table. */
const require_ = (specifier) => {
  if (!(specifier in MODULES)) throw new Error(`unexpected module request: ${specifier}`)
  return MODULES[specifier]
}

// Importing the bundle executes the registration facade, exactly as a `<script>` load does.
await import(pathToFileURL(BUNDLE).href)
assert.ok(registration !== undefined, 'the bundle must register itself with window.__ModuleLoader__')
assert.equal(registration.id, '@angela_lwh/dsh-archive-purge', 'the module id must equal the package name')
assert.equal(typeof registration.factory, 'function')

const exported = registration.factory(require_)
assert.equal(exported.name, 'archive-purge')
assert.deepEqual(exported.inject, ['slots', 'workspaces', 'locale'])
assert.equal(typeof exported.apply, 'function')

// ---- drive apply() against a fake client Context -------------------------------

const registrations = []
const injections = []
/** Locale namespaces the bundle registered, captured for the copy assertions. */
const dictionaries = new Map()
/** Live archive set, replaced (never mutated) so the projection sees a new snapshot. */
let archivedIds = ['session-archived-1']
const refreshCalls = []

const workspaceModel = {
  getSnapshot: () => ({ archivedSessionIds: archivedIds }),
  subscribe: () => () => {},
}

const ctx = {
  get(name) {
    if (name === 'workspaces') return { list: workspaceModel }
    if (name === 'sessions') return { refresh: () => { refreshCalls.push(true); return Promise.resolve() } }
    return undefined
  },
  effect: (callback) => callback(),
  locale: {
    register: (namespace, dicts) => {
      dictionaries.set(namespace, dicts)
    },
  },
  slots: {
    inject: (slot, callback) => {
      injections.push(slot)
      callback()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

exported.apply(ctx)
assert.deepEqual(injections, [
  'sidebar.workspaces.session.menu.item',
  'sidebar.workspaces.session.row.action',
  'sidebar.workspaces.session.menu.item',
  'shell.overlay',
  'shell.overlay',
], 'all five seats must be injected through the reactive inject form')

const byId = new Map(registrations.map((entry) => [`${entry.options.name}#${entry.options.id}`, entry]))
const menu = byId.get('sidebar.workspaces.session.menu.item#archive-purge.delete')
const button = byId.get('sidebar.workspaces.session.row.action#archive-purge.delete')
const dialog = byId.get('shell.overlay#archive-purge.delete-dialog')
const retryMenu = byId.get('sidebar.workspaces.session.menu.item#archive-purge.retry-pending')
const pendingDialog = byId.get('shell.overlay#archive-purge.pending-dialog')
assert.ok(menu && button && dialog, 'the menu row, hover button, and dialog must all register')
assert.ok(retryMenu && pendingDialog, 'the retry menu row and its dialog must register too')
assert.equal(menu.options.order, 500, 'the menu row must follow the shipped archive row at order 400')
assert.equal(button.options.order, 300, 'the hover button must follow the shipped archive button at order 100')
assert.equal(retryMenu.options.order, 600, 'the retry row must follow the delete row in the same menu')
assert.equal(menu.options.locale, 'archivePurge')
assert.equal(button.options.locale, 'archivePurge')
assert.equal(dialog.options.locale, 'archivePurge')
assert.equal(retryMenu.options.locale, 'archivePurge')
assert.equal(pendingDialog.options.locale, 'archivePurge')

// ---- the entries only offer themselves on an archived row ----------------------

const t = (key, values) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`)
/** Point the fake Host projection at a new archive set. */
const setArchived = (ids) => {
  archivedIds = ids
}
const rowPropsFor = (entry, extra = {}) => {
  const face = entry.options.inject()
  return {
    sessionId: 'session-archived-1',
    displayTitle: 'Demo session',
    t,
    requestDelete: face.requestDelete,
    // The slot runtime binds every `hooks` source into a `use<Name>` selector hook.
    useArchived: (selector) => selector(face.hooks.archived.getSnapshot()),
    useMenuOpenState: () => [false, () => {}],
    ...extra,
  }
}

setArchived(['session-other'])
assert.equal(menu.component(rowPropsFor(menu)), null, 'no menu row on an unarchived Session')
assert.equal(button.component(rowPropsFor(button)), null, 'no hover button on an unarchived Session')
assert.deepEqual([...menu.options.inject().hooks.archived.getSnapshot()], ['session-other'],
  'the injected hook must track the Host archive set')

setArchived(['session-archived-1'])
const menuElement = menu.component(rowPropsFor(menu))
assert.equal(menuElement.type.primitive, 'MenuItemButton')
assert.equal(menuElement.props.danger, true)
assert.equal(menuElement.props.separatorBefore, true)
assert.equal(menuElement.props.children, 'menu.deleteSession')

const buttonElement = button.component(rowPropsFor(button))
assert.equal(buttonElement.type.primitive, 'Tooltip')
assert.equal(buttonElement.props.label, 'actions.delete')
assert.equal(buttonElement.props.children.type, 'button')
assert.equal(buttonElement.props.children.props.className, 'dsh-ap-icon')

// ---- the dialog opens per request and closes on settle -------------------------

const dialogFace = dialog.options.inject()
assert.equal(dialog.component({ ...dialogFace, t, useDeleteRequest: (selector) => selector(null) }), null,
  'nothing renders while no deletion is pending')

const request = { sessionId: 'session-archived-1', displayTitle: 'Demo session', seq: 1 }
const confirm = dialog.component({ ...dialogFace, t, useDeleteRequest: (selector) => selector(request) })
assert.equal(confirm.type.name, 'DeleteSessionConfirm')

// ---- the route call and its failure mapping ------------------------------------

await dialogFace.deleteSession('session-archived-1')
assert.equal(routeCalls.at(-1).url, 'http://127.0.0.1:19387/api/archive-purge/deleteSession',
  'the route must resolve document-relatively, exactly like the shipped file-upload plugin')
assert.equal(routeCalls.at(-1).init.method, 'POST')
assert.equal(routeCalls.at(-1).init.credentials, 'same-origin')
assert.deepEqual(JSON.parse(routeCalls.at(-1).init.body), { action: 'delete', sessionId: 'session-archived-1' },
  'the browser half names its verb; the Host defaults a body without one for older clients')
assert.equal(refreshCalls.length, 1, 'a successful delete must also pull a fresh Session baseline')

routeAnswer = {
  status: 200,
  body: { ok: false, error: { code: 'archive-purge/not-archived', message: 'session x is not archived', details: {} } },
}
await assert.rejects(
  () => dialogFace.deleteSession('session-archived-1'),
  (error) => error.code === 'archive-purge/not-archived' && error.message === 'session x is not archived',
  'a Host refusal must carry its code and text',
)
assert.equal(refreshCalls.length, 1, 'a refusal must not trigger a refresh')

routeAnswer = { status: 200, body: { ok: true, value: { sessionId: 'session-archived-1', deleted: true } } }
assert.deepEqual(
  await dialogFace.deleteSession('session-archived-1'),
  { sessionId: 'session-archived-1', deleted: true },
  'the Host result must reach the caller unchanged',
)
assert.equal(refreshCalls.length, 2, 'every successful delete pulls a fresh Session baseline')

routeAnswer = { status: 502, body: '<html>bad gateway</html>' }
await assert.rejects(
  () => dialogFace.deleteSession('session-archived-1'),
  /unexpected Host response \(HTTP 502\)/u,
  'a non-JSON response must be reported as a transport problem',
)

// ---- refusal copy --------------------------------------------------------------

const zh = dictionaries.get('archivePurge')?.zh
const en = dictionaries.get('archivePurge')?.en
assert.ok(zh !== undefined && en !== undefined, 'both dictionaries must be registered')
for (const key of ['failed.loaded', 'failed.running', 'failed.descendantRunning', 'failed.notArchived', 'failed.subagent', 'failed.guard']) {
  assert.equal(typeof zh[key], 'string', `zh must define ${key}`)
  assert.equal(typeof en[key], 'string', `en must define ${key}`)
}

/** The locale seat backed by the registered dictionaries, for copy assertions. */
const tZh = (key, values) => {
  const raw = zh[key] ?? String(key)
  return values === undefined ? raw : raw.replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ''))
}

const loaded = Object.assign(new Error('still loaded after 5000ms'), { code: 'archive-purge/session-loaded' })
assert.match(exported.describeFailure(loaded, tZh), /宿主加载/u, 'a loaded refusal gets its own explanation')
assert.ok(!exported.describeFailure(loaded, tZh).includes('5000ms'), 'the raw Host detail is not shown for a known code')

const running = Object.assign(new Error('has work in progress'), { code: 'archive-purge/session-running' })
assert.match(exported.describeFailure(running, tZh), /正在进行/u)

const descendantRunning = Object.assign(new Error('subagent session child has work in progress'), {
  code: 'archive-purge/descendant-running',
})
assert.match(exported.describeFailure(descendantRunning, tZh), /子代理会话仍在工作/u,
  'a busy child gets its own explanation rather than the parent-session one')

const unknown = Object.assign(new Error('boom'), { code: 'archive-purge/added-later' })
assert.match(exported.describeFailure(unknown, tZh), /archive-purge\/added-later: boom/u,
  'an unknown code still surfaces the Host code and text')

const plain = new Error('transport exploded')
assert.match(exported.describeFailure(plain, tZh), /transport exploded/u)

// ---- triggering the dialog carries the row identity ---------------------------

const requested = []
const capturingProps = {
  ...rowPropsFor(menu),
  requestDelete: (sessionId, displayTitle) => requested.push({ sessionId, displayTitle }),
}
menu.component(capturingProps).props.onSelect()
assert.deepEqual(requested, [{ sessionId: 'session-archived-1', displayTitle: 'Demo session' }])

// ---- the retry seat: pending list, pass, and the menu row that opens it --------

/** Menu closes recorded by the retry row's own select handler. */
const menuClosed = []
const retryFace = retryMenu.options.inject()
assert.deepEqual(Object.keys(retryFace.hooks), ['retryRequest'],
  'the retry row is driven by its own request store, not the deletion one')
assert.equal(typeof retryFace.listPending, 'function')
assert.equal(typeof retryFace.retryPending, 'function')

assert.deepEqual(retryFace.hooks.retryRequest.getSnapshot(), null,
  'nothing is requested until the row is used')

const retriesRequested = []
retryMenu.component({
  t,
  useMenuOpenState: () => [false, () => { menuClosed.push(true) }],
  requestRetry: () => retriesRequested.push(true),
}).props.onSelect()
assert.equal(menuClosed.length, 1, 'using the row must close the menu first')
assert.equal(retriesRequested.length, 1, 'using the row must raise the retry dialog')

routeAnswer = { status: 200, body: { ok: true, value: { pendingFile: '/tmp/pending.json', sessionIds: ['session-a', 'session-b'] } } }
assert.deepEqual(await retryFace.listPending(), { pendingFile: '/tmp/pending.json', sessionIds: ['session-a', 'session-b'] })
assert.deepEqual(JSON.parse(routeCalls.at(-1).init.body), { action: 'listPending' },
  'the pending read must name its verb, so the Host never mistakes it for a delete')

const report = { attempted: 2, deleted: 1, dropped: 0, stillStaged: 1, remaining: ['session-b'], stillLoaded: ['session-b'], results: [] }
routeAnswer = { status: 200, body: { ok: true, value: report } }
assert.deepEqual(await retryFace.retryPending(), report, 'the pass report must reach the caller unchanged')
assert.deepEqual(JSON.parse(routeCalls.at(-1).init.body), { action: 'retryPending' },
  'the cleanup pass must name its verb')

const pendingFace = pendingDialog.options.inject()
assert.equal(
  pendingDialog.component({ ...pendingFace, t, useRetryRequest: (selector) => selector(null) }),
  null,
  'the retry dialog renders nothing while no retry is pending',
)
const pendingElement = pendingDialog.component({
  ...pendingFace,
  t,
  useRetryRequest: (selector) => selector({ seq: 1 }),
})
assert.equal(pendingElement.type.name, 'PendingPurgeConfirm',
  'a raised retry must render the confirm face, with the same props shape as the delete dialog')
assert.equal(pendingElement.props.request.seq, 1)
assert.equal(pendingElement.props.t, t)

// The pending screen's own copy, and the code a missing store reports.
for (const key of ['pending.title', 'pending.lead', 'pending.count', 'pending.orphans', 'pending.orphansDone', 'pending.blanks', 'pending.blanksDone', 'pending.blanksHeld', 'pending.blanksFailed', 'pending.cache', 'pending.cacheDone', 'pending.cacheFailed', 'pending.none', 'pending.retry', 'pending.still', 'menu.retryPending']) {
  assert.equal(typeof zh[key], 'string', `zh must define ${key}`)
  assert.equal(typeof en[key], 'string', `en must define ${key}`)
}
const noStore = Object.assign(new Error('no home'), { code: 'archive-purge/no-pending-store' })
assert.equal(exported.describeFailure(noStore, tZh), zh['pending.noStore'],
  'a missing pending store gets its own explanation rather than a raw code')

// ---- the idle reconnect: the carrier has no heartbeat ---------------------------

assert.equal(exported.shouldReconnectAfterIdle({ idleMs: 29 * 60 * 1000, sinceReconnectMs: 60 * 60 * 1000 }), false,
  'a short idle gap must never reconnect')
assert.equal(exported.shouldReconnectAfterIdle({ idleMs: 31 * 60 * 1000, sinceReconnectMs: 5 * 60 * 1000 }), false,
  'the gap since the last reconnect must pass as well')
assert.equal(exported.shouldReconnectAfterIdle({ idleMs: 31 * 60 * 1000, sinceReconnectMs: 31 * 60 * 1000 }), true,
  'a long idle gap with no recent reconnect is due')

const listeners = new Map()
const reconnects = []
let clock = 0
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: (name, fn) => listeners.set(`doc:${name}`, fn),
  removeEventListener: (name) => listeners.delete(`doc:${name}`),
}
const fakeWindow = {
  addEventListener: (name, fn) => listeners.set(`win:${name}`, fn),
  removeEventListener: (name) => listeners.delete(`win:${name}`),
}
const connectionCtx = {
  get: (name) => (name === 'connection' ? { reconnect: () => reconnects.push(clock) } : undefined),
}
assert.equal(exported.installIdleReconnect({ get: () => undefined }, { document: fakeDocument, window: fakeWindow, now: () => clock }), undefined,
  'a Host without the connection service installs nothing')
const dispose = exported.installIdleReconnect(connectionCtx, { document: fakeDocument, window: fakeWindow, now: () => clock })
assert.equal(typeof dispose, 'function', 'the watchdog must be removable')

clock = 1000
listeners.get('win:pointerdown')()
assert.deepEqual(reconnects, [], 'activity inside the gap must not reconnect')
clock += 31 * 60 * 1000
listeners.get('win:pointerdown')()
assert.deepEqual(reconnects, [clock], 'the first activity after a long gap reconnects once')
listeners.get('win:keydown')()
assert.deepEqual(reconnects, [clock], 'the cooldown holds for the activity right after it')
clock += 31 * 60 * 1000
listeners.get('doc:visibilitychange')()
assert.equal(reconnects.length, 2, 'a later long gap reconnects again')

dispose()
assert.equal(listeners.has('win:pointerdown'), false, 'disposing unbinds the activity listeners')
assert.equal(listeners.has('doc:visibilitychange'), false, 'disposing unbinds the visibility listener')

// ---- drafts the user typed but never sent ---------------------------------------

function storageOf(entries) {
  const keys = () => Object.keys(entries)
  return {
    get length() { return keys().length },
    key: (index) => keys()[index] ?? null,
    getItem: (key) => (key in entries ? entries[key] : null),
  }
}

const entries = {
  'dsh.conversation.session-a': JSON.stringify({ draft: 'half a thought' }),
  'dsh.conversation.session-b': JSON.stringify({ draft: { text: '   ', references: [{ id: 'ref-1' }] } }),
  'dsh.conversation.session-c': JSON.stringify({ draft: { text: '' } }),
  'dsh.conversation.session-d': JSON.stringify({ draft: '' }),
  'dsh.conversation.session-e': 'not json',
  'dsh.conversation.session-f': JSON.stringify({ view: 'compact' }),
  'dsh.other.session-g': JSON.stringify({ draft: 'ignored key' }),
  'dsh.conversation.': JSON.stringify({ draft: 'no session id' }),
}
const drafts = storageOf(entries)
assert.deepEqual(exported.draftSessionIds(drafts), ['session-a', 'session-b'],
  'only a non-empty draft of a real Session is reported')
assert.deepEqual(exported.draftSessionIds(undefined), [], 'a page without storage reports nothing')
assert.equal(exported.isDraftPresent(' x '), true)
assert.equal(exported.isDraftPresent('   '), false)
assert.equal(exported.isDraftPresent({ text: 'x' }), true)
assert.equal(exported.isDraftPresent({ text: '', command: { token: 't' } }), true)
assert.equal(exported.isDraftPresent({ text: '', references: [] }), false)

const reports = []
const reporterListeners = new Map()
const reporterDocument = {
  visibilityState: 'visible',
  addEventListener: (name, fn) => reporterListeners.set(`doc:${name}`, fn),
  removeEventListener: (name) => reporterListeners.delete(`doc:${name}`),
}
const reporterWindow = {
  addEventListener: (name, fn) => reporterListeners.set(`win:${name}`, fn),
  removeEventListener: (name) => reporterListeners.delete(`win:${name}`),
}
const disposeReporter = exported.installDraftReporter(
  (body, options) => {
    reports.push({ body, options })
    return Promise.resolve()
  },
  { document: reporterDocument, window: reporterWindow, localStorage: drafts },
)
assert.equal(reports.length, 1, 'the first report runs at install')
assert.deepEqual(reports[0].body, { action: 'reportDrafts', sessionIds: ['session-a', 'session-b'] })
reporterListeners.get('win:pointerdown')()
assert.equal(reports.length, 1, 'an unchanged set is not re-sent')

entries['dsh.conversation.session-a'] = JSON.stringify({ draft: '' })
reporterListeners.get('win:keydown')()
assert.equal(reports.length, 2, 'a changed set is re-sent on the next activity')
assert.deepEqual(reports[1].body, { action: 'reportDrafts', sessionIds: ['session-b'] })

reporterListeners.get('win:pagehide')()
assert.equal(reports.length, 3, 'the closing page reports regardless of change')
assert.equal(reports[2].options?.keepalive, true, 'the closing report must survive the teardown')

disposeReporter()
assert.equal(reporterListeners.has('win:pointerdown'), false, 'disposing unbinds the reporter listeners')

console.log('client bundle: all assertions passed')
