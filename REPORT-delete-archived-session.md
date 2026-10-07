# Permanently deleting an archived DSH session — research report

Read-only investigation. No real session data was modified. Extra asar subtrees extracted into
`vendor/dsh/node_modules/@deepseek-ai/` : `dsh-session-persistence`, `dsh-session-persistence-jsonl`,
`dsh-session-format`, `dsh-session-format-catalog`, `dsh-session-query`, `dsh-session-query-sqlite`,
`dsh-session-projection`, `dsh-session-projection-cache`, `dsh-session`, `dsh-session-checkpoint-policy`,
`dsh-session-reference`, `dsh-session-stats`, `dsh-session-title`, `dsh-session-turn-outline`,
`dsh-storage`, `dsh-storage-json`, `dsh-storage-domain`, `dsh-api-session-controller`.

Path shorthands used below (all relative to `<project-dir>\`):

| Tag | Path |
|---|---|
| **J** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js` |
| **J-README** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\README.md` |
| **SP** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session-persistence\lib\index.js` |
| **FMT** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session-format\lib\index.js` |
| **CAT** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session-format-catalog\lib\index.js` |
| **W** | `vendor\dsh-workspace\dsh\node_modules\@deepseek-ai\dsh-workspace\lib\index.js` |
| **W-ent** | `vendor\dsh-workspace\dsh\node_modules\@deepseek-ai\dsh-workspace\lib\types\entity.js` |
| **WC** | `vendor\dsh-api-workspace-controller\dsh\node_modules\@deepseek-ai\dsh-api-workspace-controller\lib\index.js` |
| **WC-c** | `vendor\dsh-api-workspace-controller\dsh\node_modules\@deepseek-ai\dsh-api-workspace-controller\lib\client.js` |
| **WC-m** | `vendor\dsh-api-workspace-controller\dsh\node_modules\@deepseek-ai\dsh-api-workspace-controller\lib\types\client\model.js` |
| **SDL** | `vendor\dsh\node_modules\@deepseek-ai\dsh-storage-domain\lib\index.js` |
| **SJ** | `vendor\dsh\node_modules\@deepseek-ai\dsh-storage-json\lib\index.js` |
| **PC** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session-projection-cache\lib\index.js` |
| **Q** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session-query\lib\index.js` |
| **QS** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session-query-sqlite\lib\index.js` |
| **SESS** | `vendor\dsh\node_modules\@deepseek-ai\dsh-session\lib\index.js` |
| **SC** | `vendor\dsh\node_modules\@deepseek-ai\dsh-api-session-controller\lib\index.js` |
| **SC-list** | `vendor\dsh\node_modules\@deepseek-ai\dsh-api-session-controller\lib\types\list.js` |
| **SC-mgr** | `vendor\dsh\node_modules\@deepseek-ai\dsh-api-session-controller\lib\types\client\sessions\manager.js` |
| **UIW** | `vendor\dsh-client-ui-workspace\dsh\node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js` |
| **REM** | `vendor\dsh-api-remotes\dsh\node_modules\@deepseek-ai\dsh-api-remotes\lib\types\remote-events.js` |

Live files referenced: `C:\Users\example\.dsh\sessions\...`, `C:\Users\example\.dsh\storages\...`,
`C:\Users\example\.dsh\profiles\{web,desktop}\cordis.patch.yml`, and the bundle patch
`dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` inside `app.asar`.

---

## 1. Session persistence on disk

### 1a. Layout of one session

There is **no** sqlite/counter/checkpoint/index file inside a session directory: a session directory
contains only immutable format generations of the log, plus one POSIX-only lock file.

Documented layout, **J-README:58-70**:

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # released v0, compressed root
      session.v1.jsonl.zstd      # released v1, compressed root
      session.v2.jsonl.zstd      # released v2, compressed root
      session.v3.jsonl.zstd      # released v3/current, compressed root
      session.jsonl              # released v0, raw root
      session.v1.jsonl           # ... v2 / v3 raw counterparts
```

Code that builds every name (**J**):

- `encodeSegment(raw)` — **J:853-865**; `[A-Za-z0-9._-]` stay literal, everything else (incl. `~`)
  becomes `~XXXX`; `'.'`→`~002E`, `'..'`→`~002E~002E`. Injective over all JS strings; no traversal.
- `projectKey(cwd)` — **J:875-894**: `/`, `\`, `:` collapse to one `-` (separator runs collapse), unsafe
  units `~XXXX`, then `` `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--` ``.
  Lossy and intentionally truncating (README:866-871 says so explicitly).
- `projectDir(root, cwd)` — **J:902-905**: `cwd === undefined ? join(root,'_no-cwd') : join(root, projectKey(cwd))`.
- `sessionDir(root, cwd, id)` — **J:914-916**: `join(projectDir(root, cwd), encodeSegment(id))`.
- `generationLogPath(root, cwd, id, version, compression)` — **J:926-928**.
- `logPath(root, cwd, id, compression)` — **J:937-939** (uses `SESSION_FORMAT_VERSION`).
- `generationLogFilename(version, compression)` — **J:761-763**; `logSuffix`/`compressionSuffix` **J:747-752**;
  `<base>.jsonl.zstd` or `<base>.jsonl`.
- `sessionFormatLogFilename(version)` — **FMT:472-474**: `generation === 0 ? "session.jsonl" : \`session.v${generation}.jsonl\``.

**Current format version is 4, not 3**: `sessionFormatCatalog.currentVersion: 4` — **CAT:41**
(the README's "v3/current" prose is stale; `dsh-session-format-v3-to-v4` is the shipped edge).

Lock file: `LEASE_FILENAME = "session.lock"` — **J:643**; acquisition **J:666-712**.
- Windows: a named kernel semaphore derived from `<dir>/session.lock`, **no filesystem footprint**
  (**J:673-685**, and the JSDoc at **J:616-631**: "never a file lock or handle, so readers, searches,
  and directory removal proceed freely while the lock is held").
- POSIX: real `session.lock` file, flock(2), never removed on release (**J:719-729**).

Transient files that can exist inside a session dir only during a migration write:
`session.migration.<token><suffix>.tmp` (**J:1952**) and `<finalPath>.<hex>.tmp` (**J:3174-3182**).
Deleting the whole directory removes them too.

**Reality check** (`C:\Users\example\.dsh\sessions`):

- Project dirs: `--<project-slug>--`, `--<project-slug>--`, `--D-Project--`,
  `--<project-slug>--`, `--<project-slug>--`, `--<project-slug>--`,
  `--<project-slug>--`, `--<project-slug>--`, `--<project-slug>--`.
- Session dirs are named with the **raw** id (`00000001-0000-4000-8000-000000000000`,
  `session-00000002-0000-4000-8000-000000000000`, …) because real ids are already URL-safe, so
  `encodeSegment(id) === id`.
- A full recursive enumeration of `<root>` found exactly three file names: `session.v4.jsonl.zstd` (10),
  `session.v3.jsonl.zstd` (8), `session.jsonl.zstd` (5). Nothing else. No lock files (Windows).

### 1b. Path derivation from a session id

The directory is **not** derivable from the id alone; it needs the session's `cwd`:

`<persistence root>/<projectKey(header.cwd)>/<encodeSegment(id)>/`

- Persistence root in the shipped profile: `dshHomePath('sessions')` → `C:\Users\example\.dsh\sessions`
  (`dsh-base/cordis.patch.yml`, row `session-persistence-jsonl`).
- `assertStoredIdentity` (**J:3384-3395**) refuses any log whose physical path is not exactly
  `generationLogPath(root, meta.cwd, meta.id, storedVersion, compression)` — so a misplaced file is
  reported as corruption, and `cwd === undefined` ⇒ `_no-cwd/`.
- `findLog(id, signal)` (**J:3360-3373**) scans *every* project directory for
  `join(project, encodeSegment(id))`, so lookup by id works without knowing the cwd; it throws if the id
  appears in two project dirs (**J:3370**).
- Nothing exports `projectKey`/`encodeSegment`/`logPath`: the package's only named export is
  `export { JsonlCompressionSchema, JsonlSessionPersistence as default }` (**J:3527**).

`locate(meta)` exists on the concrete backend and returns `{kind:'jsonl', path: logPath(root, meta.cwd, meta.id, compression)}`
(**J:2416-2421**), but it is a *refusal-diagnostics hook* used internally at **J:2823**; it is **not**
part of the `SessionPersistence` seam contract (SP/README list only `create`/`open`/`stat`/`list`/`flush`).
It is still the most robust duck-typed way for a plugin to learn the absolute path from the shipped backend.

### 1c. The persistence service API — and there is no delete

Abstract service (**SP:261-267**) is a bare `Service` subclass named `sessionPersistence`; the interface is
documented in `vendor\dsh\node_modules\@deepseek-ai\dsh-session-persistence\README.md:45-53`:

```text
const handle = await ctx.sessionPersistence.create(header)     // store a new session, take write ownership
const handle = await ctx.sessionPersistence.open(id, 'write')  // claim single-writer ownership
const reader = await ctx.sessionPersistence.open(id, 'read')   // observe without ownership
const snap   = await ctx.sessionPersistence.stat(id)           // header + revision (+ eventCount / sizeBytes)
const all    = await ctx.sessionPersistence.list()             // one snapshot per visible stored session
await ctx.sessionPersistence.flush()                           // backend-wide durability barrier
```

Concrete signatures (**J**): `async create(header, options)` **2431**, `async open(id, access, options)` **2454**,
`flush()` **2526**, `async stat(id, options)` **2536**, `async list(options)` **2569**. `stat` returns
`undefined` when the session does not exist (**J:2546**, **J:2559**). Plus internal
`listGenerations` **3004**, `listArtifacts` **3031**, `listProjectDirs` **3422**, `listSessionDirs` **3434**.

**`SessionPersistence`, the JSONL backend, and every other layer have NO delete/remove/purge API.**
Verbatim: **J-README:163** — *"**Nothing deletes session files** — logs accumulate under `root` until
removed externally; the seam has no deletion API."* Greps for `delete|remove|unlink|rm(` in **J** return
only: `rm()` of staging temp files (J:603, 3146, 3150, 3164), the `rm` import, and log-text mentions —
no session-removal path. There is also no `stat`-independent "path" accessor on the seam.

### 1d. Global artifacts that reference a session id

Live root `C:\Users\example\.dsh\` contains: `.agent-presets`, `cache`, `dsh-runtimes`, `im`,
`integrations`, `llm-deepseek`, `profiles`, `sessions`, `storages`, plus loose files.

**`C:\Users\example\.dsh\storages\` — the storage backend root** (`dsh-base/cordis.patch.yml`:
`storage-json.root: !!js dshHomePath('storages')`, `storage-domain.backend: json`). Actual contents:

```text
workspace.json                              2476 B   (whole-unit 'single' layout)
session_projcache.json                    358774 B   (stale legacy whole-unit file, never deleted)
session_projcache\sessions\<sessionId>.json  (per-record layout, one checkpoint per session)
```

1. **`storages\workspace.json` — the workspace registry domain (see §2).** Keys a session id in
   `global.archivedSessionIds`, `global.pinnedSessionIds`, and each record's `sessionIds`. This is the
   only global store that *must* be updated for the sidebar to behave correctly.
2. **`storages\session_projcache\sessions\<sessionId>.json` — the durable session-projection cache.**
   Domain `session_projcache`, version 7, `layout: "per-record"`, `invalidRecords: "backup-and-skip"`,
   `tables: { sessions: domainTable(checkpointRecord) }` — **PC:90-101**. Opened by
   `SessionProjectionCache` (**PC:151-156**), service key `sessionProjectionCache` (**PC:147**).
   Record shape seen on disk: `{"version":7,"record":{"identity":{"formatVersion":4,"createdAt":…,"cwd":…,"isSeeded":false,"inheritedEventCount":0},"rows":{title,titleInput,llmRetry,sandboxMode,goal,tokenUsage,…}}}`.
   **There is no eviction or retention surface** (README:128: *"No eviction or retention surface — records
   accumulate per session; pruning stored checkpoints is out-of-band maintenance, same stance as session
   persistence itself."*). Reads are **keyed by session id from a header the caller already holds**
   (`cachedSnapshot(meta, keys)` **PC:193-198**, `cachedPredecessorTitle(meta)` **PC:214-219**,
   `recordFor(id, expected)` **PC:169-173**), so a stale row is inert — but it is never garbage-collected.
   `projectionCacheDomainSpec` **is** exported (**PC:411**), so in principle a plugin can delete the row;
   but `DomainFacility.open()` enforces **single-open per domain name** (`already-open`, **SDL:355-357**),
   so this only works via `ctx.storageDomain.get('session_projcache')?.table('sessions').delete(id)`
   (untyped diagnostic accessor, **SDL:406-408**) or by deleting the file out-of-band while the process holds it.
3. **SQLite session-query index — does not exist in this deployment.** `dsh-session-query-sqlite` is mounted
   with `path: ':memory:'` and `openAt: never` (`dsh-base/cordis.patch.yml`, row `session-query-sqlite`;
   comment: *"`openAt: never` keeps ctx.sessionQuery mounted … while search calls fail with
   SESSION_QUERY_SEARCH_DISABLED and SQLite is never opened"*). No `*.db`/`*.sqlite` exists anywhere under
   `C:\Users\example\.dsh`. If a deployment overrides `openAt`, the index is a **derived, self-healing**
   store, not durable truth: `_reconcile` computes
   `persistentDeletes = persistedRows.filter((row) => !observation.persisted.has(row.id))` (**QS:656**)
   and deletes those rows in the transaction (**QS:681**, `_deleteSession` **QS:760-769**). Tables:
   `persisted_sessions`/`persisted_docs` + TEMP `live_sessions`/`live_docs`, schema `user_version = 8`
   (**QS:85-117**). So a raw directory delete is pruned automatically on the next search.
4. **`dsh-session-format-catalog` writes no on-disk catalog.** It is an in-code codec chain
   (`createSessionFormatCatalog`, `currentVersion: 4` — **CAT:41**); the only "catalog" rows on disk are
   subagent catalog *projections* living inside `session_projcache` (see README of that package, and
   `sessionFormatCatalog` usages in **J**). No `*.json` index lists sessions.
5. **Spill (`dsh-spill-local`) is ephemeral and not under `.dsh`**: root is
   `mkdtempSync(join(tmpdir(), 'dsh-spill-'))` (per-process), session subdir =
   `session-${sha256(sessionId).slice(0,12)}` — `/tmp/dsh-spill-XXXXXX/session-<12hex>/…`; startup sweeps
   stale roots (`DEFAULT_ROOT_RE`, `SESSION_DIR_RE`). Nothing to clean for a deleted session beyond process exit.
6. **Attachments (`dsh-attachment-local`) are content-addressed and shared**: `DSH_HOME/attachments/v1/objects/<sha[0:2]>/<sha>`
   — image bytes are deduplicated across sessions. **A session delete must NOT touch attachment objects.**
7. `cache/attachments/request-images/...` is a request-image cache, also content-addressed; do not touch.

### 1e. In-memory state that must be invalidated

- **Live session store `ctx.sessions`** (**SESS**): `get(id)` **SESS:1861-1863**, `list()` **SESS:1868-1870**
  read an internal `Map` (`this.store`); entries are removed only in `detachEntered(entry)` **SESS:1767-1774**
  (`this.store.delete(entry.id)` at **1771**) which is reached through the **detach disposer returned by
  `enter(session)`** (**SESS:1734-1765**) or by disposing the owning fiber (`create()` folds it into
  `ctx.effect`, **SESS:1653-1660**). There is **no public `sessions.dispose(id)`/`remove(id)`**.
  Consequence: a plugin cannot evict a live session except by holding the disposer it got from `enter`,
  or by having the owning fiber disposed. Also `prepare()` creates un-entered sessions used by cold reads
  (**Q:368-373**) which never appear in `store`.
- **Persistence backend in-memory state** (**J**): the tracker holds `pendingEntries()` (created but not
  yet materialized) which `list()` merges with artifacts (**J:2573-2576**); `sessionPaths`/`headers` in the
  workspace registry (below); the per-session `SessionWriteLease` is kernel-held. There is **no cache of
  file paths** inside the backend beyond `this.root` — `findLog` re-scans the root every call, so a deleted
  directory is immediately invisible to `stat`/`list`/`open`.
- **`dsh-session-query` cold-read cache** (**Q**): `SessionObservationReader` caches prepared observations
  keyed by `(persistence.identity, sessionId, revision)` with LRU capacity 5 (**Q:322-431**). It is safe
  after deletion: `read()` always calls `statSource()` first, which throws `notFound(sessionId)` when
  `stat` returns `undefined` (**Q:356**, **Q:396-409**) — a cached entry can never be served for a gone log.
- **`dsh-session-projection-cache`**: rows live in the **domain's in-memory tables** (`this.table`,
  **PC:154**), and the JSON backend's `per-record` unit treats the *directory* as authoritative but only
  reloads on `loadAll()` (**SJ:450-459**). Deleting the file under a running process therefore does **not**
  clear the in-memory row; it disappears on the next process start. `ctx.sessionProjectionCache` exposes
  **no** delete/evict method (`recordFor`, `cachedSnapshot`, `cachedPredecessorTitle`, write-behind only).
- **Workspace registry in-memory state** (**W**): `headers` / `sessionPaths` / `invalidSessionPaths` maps
  (**W:360-372**) are the source of `Workspace.sessionIds` filtering. After a raw file delete they still
  hold the stale mapping until restart or until `indexHeaders(await listStoredHeaders())` runs again
  (**W:615**, called from `sessionKnown`). `entity.sessionIds` will keep returning the deleted id from
  memory — harmless for rendering (see §2c), and pruned durably by the next `mutate` (§2a).

### 1f. Summary of what a raw directory delete leaves stale

| Artifact | Stale after delete? | Harmful? |
|---|---|---|
| `<sessions>/<proj>/<id>/` | removed | — |
| `storages\workspace.json` `global.archivedSessionIds` | **yes** | id stays invisible-but-present; also gate + count logic |
| `storages\workspace.json` `tables.workspaces.*.sessionIds` | **yes** | filtered out of the projection, but logs a warning and lingers durably |
| `storages\session_projcache\sessions\<id>.json` | **yes** | inert (only read with a header); accumulates |
| `storages\session_projcache.json` (legacy) | yes (already stale today) | ignored once the per-record tree exists |
| sqlite query index | self-heals (`QS:656/681`); not opened in this deployment | no |
| spill temp dir | process-scoped | no |
| attachments / image cache | unrelated (content-addressed) | must not be touched |

---

## 2. Workspace registry durable state

### 2a. On-disk shape and the store name

Domain spec — **W:202-268** (identical twin `vendor\dsh-workspace\...\lib\types\spec.js:11-69`):

```js
const workspaceDomainSpec = defineDomain({
  name: "workspace",
  version: 2,
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
  },
  tables: { workspaces: domainTable(workspaceRecord) }
});
```

No `layout` key ⇒ the storage-json default, the **`single` (whole-unit) layout**: one file
`<storageRoot>/workspace.json` (`SJ:179`, `SJ:312-314`, README:78-88). Confirmed live — the whole unit is one file:

```json
{
  "unit": { "name": "workspace", "version": 2 },
  "global": {
    "initialized": true,
    "workspaceIds": ["7dfa2da1-…","20cc801e-…","b275bce0-…","35248390-…","8f86e49c-…"],
    "archivedSessionIds": [],
    "pinnedSessionIds": []
  },
  "tables": { "workspaces": {
    "8f86e49c-…": { "path": "<project-dir>", "title": "<workspace-title>",
                    "sessionIds": ["session-53a24636-…", …7 ids…],
                    "createdAt": "2026-08-14T09:31:14.284Z", "updatedAt": "2026-09-22T17:14:01.202Z" },
    … } }
}
```

Schemas (**W:209-248**): `workspaceRecord = { path, title, sessionIds: string[], createdAt, updatedAt }`;
`workspaceDomainState = { initialized, defaultWorkspaceId?, workspaceIds[], archivedSessionIds[] = [], pinnedSessionIds[] = [], pendingMutation? }`.
Only the `workspaces` table write path uses `table.update` (mutate); the global state holds archive/pin
sets. `domain/changed` events are emitted after durability (**SDL:214-220**, `put` **SDL:288-296**,
`deleted` **SDL:269-274**, global put with `table: ""` **SDL:162-172**).

Domain KV table API (**SDL:232-297**): `get(key)`, `entries()`, `keys()`, `size`,
`put(key, value)`, `delete(key) → Promise<boolean>`, `update(key, fn)`. **One domain name can be open only
once per process** (`DomainFacility.open`, **SDL:355-357**), so a plugin must **not** re-open
`workspaceDomainSpec` while `dsh-workspace` is mounted — it must go through `ctx.workspaceRegistry`.

### 2b. Host service APIs (verbatim, **W**)

`ctx.workspaceRegistry` — `class WorkspaceRegistry extends Service`, `static inject = ["storageDomain","sessionPersistence"]`, `super(ctx, "workspaceRegistry")` (**W:354-355**, **W:373-375**):

```js
async create(path, title)                       // W:406  create/reuse workspace for a canonical dir
initializeDefault(resolveDirectory)             // W:423
get(id)                                         // W:443  → Workspace | undefined
list()                                          // W:452  → Workspace[] in registry order
delete(id)                                      // W:467  → Promise<boolean>   *** WORKSPACE, not session ***
insertBefore(id, beforeId)                      // W:477
get archivedSessionIds()                        // W:504  → SessionId[]
archiveSession(sessionId, options = {})         // W:524  ({ stopActivity?: true })
unarchiveSession(sessionId)                     // W:551  idempotent, NO existence check (W:174/README:174)
get pinnedSessionIds()                          // W:566
pinSession(sessionId)                           // W:576
unpinSession(sessionId)                         // W:596
async sessionKnown(id)                          // W:612
async resolveByPath(path)                       // W:635
```

`ctx.workspaceRegistry.delete(id)` deletes a **workspace registration** only: *"Delete one workspace
registration while retaining its directory and every session log"* (**W:460-469**), and the package's Known
Limitations says outright: **"Removal never deletes data … session deletion or folder removal are separate,
absent capabilities"** (`vendor\dsh-workspace\...\README.md:171`).

**There is NO session-removal API anywhere in the host surface.** The `Workspace` entity's mutating methods
are `setTitle`, `attachSession`, `insertSessionBefore`, **`detachSession`**, `status`, and the private
`mutate`:

```js
async detachSession(sessionId) {               // W-ent:109-113  (twin W:148-153)
  await this.mutate(record => record.sessionIds.includes(sessionId)
    ? { ...record, sessionIds: record.sessionIds.filter(id => id !== sessionId) }
    : record);
}
```

`mutate` (**W-ent:136-154**, twin **W:173-191**) is the only write path and **prunes stale membership**:

```js
const sessionIds = changed.sessionIds.filter(id => this.host.sessionPath(id) === changed.path);
if (changed === current && sessionIds.length === current.sessionIds.length) throw unchangedSentinel;
return { ...changed, sessionIds, updatedAt: new Date().toISOString() };
```

so *any* successful entity mutation (including `setTitle`, e.g. a rename) durably drops ids whose log is gone.
`entity.sessionIds` (the getter, **W-ent:51-53**) already filters by `sessionPath(id) === record.path` for
readers, and startup logs one warning per filtered id:
`workspace '<id>' filtered session '<sid>' from membership: session header is missing` (**W:900-910**).

Host Remote surface (`ctx.workspaceController`, namespace `workspace`, **WC:840**, **WC:865-954**):
`create`, `initializeDefault`, `rename`, `delete` (workspace), `insertBefore`, `insertSessionBefore`,
`archiveSession({sessionId, stopActivity?})` **WC:297-309**, `unarchiveSession({sessionId})` **WC:317-320**,
`pinSession`, `unpinSession`, `follow (stream)`. Error mapping: `WorkspaceUnknownSessionError` →
`session/not-found`, `WorkspaceActiveSessionError` → `workspace/session-active` (with `activity` details).

Projection frames (**WC:66-147**): `baseline {items, archivedSessionIds, pinnedSessionIds}` then increments
`upsert` / `remove` / `order` / `archived` / `pinned`. `workspaceView()` sends `sessionIds: [...workspace.sessionIds]`
(**WC:17-26**) — i.e. the *filtered* list — while the `workspaces` table `put` frame re-projects the **raw**
record (`changedWorkspaceView`, **WC:27-37**).

Client services: `ctx.workspaces` (`WorkspaceController`, **WC-c:381-437**) with
`create/initializeDefault/rename/delete/insertBefore/archiveSession(sessionId,{stopActivity})/unarchiveSession/pinSession/unpinSession/insertSessionBefore`,
and `ctx.uiWorkspace` (`UiWorkspaceService`, **UIW:753-878**) with `archiveSession` (which also calls
`clearMain()` when the archived session is the open one, **UIW:861-864**), `unarchiveSession`, `pinSession`,
`unpinSession`, `openSession`, `openWorkspace`, …

### 2c. What the frontend does with a stale archived / membership id

It is **silently skipped**; nothing breaks. The authoritative walk is
`groupByWorkspace` (**UIW:420-439**):

```js
for (const workspace of workspaces) {
  for (const id of workspace.sessionIds) {
    const summary = list.byId[id];
    if (summary === void 0) continue;               // UIW:427-428  ← deleted session simply disappears
    accounted.add(id);
    if (!sessionVisible(summary, current, archived, archivedFilter)) continue;
    members.push(summary);
  }
  …
}
```

`list` is the client session store `ctx.sessions.list.getSnapshot()` (**UIW:106**, **UIW:802/848/901**),
whose rows come from the host `session.list` pull (below). Additional guards:

- `orderByRecency(sessionIds, summaries)` — **UIW:279-291**: *"members without a summary are omitted until
  it arrives"* (`if (summary === void 0) return [];`).
- `reconcileManualOrder` — **UIW:301-340**: pinned ids are skipped when
  `members.get(sessionId) === undefined || archived.has(id) || summaries[id] === undefined`.
- `sessionVisible` — **UIW:357-367**: `archived` is only ever consulted as a `Set.has(id)` test.
- `deriveFlat` — **UIW:539-547**, and `visibleSessionIds` **UIW:522-529**: both require `list.byId[id] !== undefined`.

There is **no** `missingArchives` / "missing members" repair concept in the workspace controller client
projection or in `dsh-client-ui-workspace` (grep for `missing` in both packages returns only unrelated
errors: `WC-m` has none, `UIW` has only the doc comment at **UIW:299**). `ClientWorkspaceModel` keeps
`archivedSessionIds` / `pinnedSessionIds` as plain id arrays and dedupes them on identity
(`installArchived`/`installPinned`, **WC-m:273-286**). A stale archived id is therefore inert for rendering —
it is just never matched to a row.

Where the session rows come from (host): `ApiSessionList.list()` (**SC-list:104-124**) →
`ctx.sessionQuery.listSessions()` → live `ctx.sessions.list()` ∪ `ctx.sessionPersistence.list()` headers
(**Q:95-118**, `listPersisted` **Q:283-289**). **Delete the directory and the row is gone from the next list
call.**

How the client learns:

- Full pull: `manager.refreshList()` (**SC-mgr:319-395**) → `remote.session.list({})`; `service.refresh()`
  **SC-list-service:253-255**; re-run on every reconnect by `handleConnected()` (**SC-mgr:651-669**).
- Push frames: host `ctx.on("session/created", s => ctx.emit("api-session/added", …))` and
  `ctx.on("session/disposed", s => ctx.emit("api-session/removed", s.id))` (**SC:2873-2878**, twin
  `SC lib/types/index.js:239-243`). Client:
  `ctx.remote.$on('api-session/removed', sessionId => sessions.handleSessionRemoved(sessionId))`
  (`lib/types/client/index.js:28`) → `manager.handleSessionRemoved` (**SC-mgr:593-616**) →
  `recordMutation({kind:'remove'})` (**SC-mgr:500-506**) → `applyMutation` `case 'remove'`
  (**SC-mgr:748-749**) removes the row from `this.summaries` and marks the notifier dirty, so the sidebar
  re-renders immediately.
- `api-session/removed` is on the **forwarded-event allowlist** — `{ event: 'api-session/removed', mode: 'emit' }`,
  **REM:18**; the host loop installs the forwarder with `ctx.on(event, (...args) => queue.push({event, args}))`
  (`vendor\dsh-api-remotes\...\lib\index.js:130-142`), so **any host plugin that calls
  `ctx.emit('api-session/removed', id)` reaches every connected client**. Args must be JSON (`assertJsonArgs`).
  Caveat: `handleSessionRemoved` treats a **subagent-origin** id as a status change, not a removal
  (**SC-mgr:594-602**).
- The `api-session/removed` relay is **display-only**: `ClientSession.handleRemoved` just sets
  `this.removed = true` (**session.js:495-497**); it does **not** dispose the live session, so it cannot be
  used to make a session cold.

Extension point for the UI (for the button): the client slot **`sidebar.workspaces.session.menu.item`**
(list, root scope) plus **`sidebar.workspaces.session.row.action`**, registered in
`ctx.slots.register({name, id, order, locale, inject}, Component)` — **UIW:4299-4376**; the archive action
(`ArchiveSessionMenuItem` **UIW:3424-3437**, `ArchiveSessionRowButton` **UIW:3443-3460**) is the 1:1 template.

---

## 3. Minimal, safest host sequence to permanently delete one archived session

Preconditions the plugin must enforce itself (no service enforces them):

- `ctx.sessions.get(id) === undefined` — the session must be **cold**. A live session's write handle holds a
  kernel lease and will re-materialize the log on its next append; deleting under it is not a delete.
  There is no supported way for a plugin to evict a live session (§1e), so refuse with a clear message.
- `id` is in `ctx.workspaceRegistry.archivedSessionIds` (archived), and `header.origin !== 'subagent'`
  (subagent child catalogs live inside the parent's projection; removing a child leaves a dangling catalog entry).
- `await ctx.sessionPersistence.stat(id)` returns a snapshot (it exists, and it is materialized).

Pseudocode (host plugin, real methods only):

```js
// 0. deps: ctx.sessions, ctx.workspaceRegistry, ctx.sessionPersistence, ctx.sessionStorageRoot
async function purgeArchivedSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry;

  // 1. refuse unless cold + archived + a real materialized log
  if (ctx.sessions.get(sessionId) !== undefined)
    throw new Error('refusing to delete: the session is still live in this process');
  if (!registry.archivedSessionIds.includes(sessionId))
    throw new Error('refusing to delete: the session is not archived');
  const snap = await ctx.sessionPersistence.stat(sessionId);          // SP/J:2536
  if (snap === undefined) {                                           // already gone: just clean bookkeeping
    await registry.unarchiveSession(sessionId);                        // W:551 idempotent, no existence check
    await detachEverywhere(ctx, sessionId);
    ctx.emit('api-session/removed', sessionId);                        // REM:18
    return;
  }
  const header = snap.header;                                          // { id, cwd, createdAt, … }

  // 2. absolute path — prefer the backend's own hook, fall back to the documented layout
  const dir = sessionDirectoryFor(ctx, header);   // see below
  assertPathInside(ctx.sessionStorageRoot, dir);  // resolve() both; last segment must be the raw/encoded id

  // 3. remove the bytes (whole session-owned directory: log generations + any POSIX session.lock + temp files)
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });   // node:fs/promises

  // 4. durable registry bookkeeping (order is deliberate: bytes first, then state)
  for (const ws of registry.list()) {                                  // W:452
    if (ws.rawSessionIds?.includes(sessionId) || ws.sessionIds.includes(sessionId))
      await ws.detachSession(sessionId);                               // W-ent:109-113 → one durable table.update
  }
  await registry.unarchiveSession(sessionId);                          // W:551 → one durable global.set
  // (defensive; archiving already cleared any pin — W:536, and pinSession refuses archived ids — W:579)

  // 5. tell every connected client the row is gone
  ctx.emit('api-session/removed', sessionId);                          // SC:2877 forwards this exact event
}

async function detachEverywhere(ctx, sessionId) {
  for (const ws of ctx.workspaceRegistry.list())
    if (ws.sessionIds.includes(sessionId)) await ws.detachSession(sessionId);
}

function sessionDirectoryFor(ctx, header) {
  // (a) shipped JSONL backend exposes a duck-typed hook — no layout reimplementation needed:
  const located = ctx.sessionPersistence.locate?.(header);             // J:2416-2421 → {kind:'jsonl', path}
  if (located?.path !== undefined) return path.dirname(located.path);
  // (b) fallback: reproduce J:875-916 verbatim (projectKey + encodeSegment) using the configured root
  return path.join(ctx.sessionStorageRoot,
                   header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd),
                   encodeSegment(header.id));
}
```

Why this is minimal and safe:

1. **No new host API is required.** `detachSession` + `unarchiveSession` are the only durable writes
   needed, and both are ordinary public methods on objects `ctx.workspaceRegistry` already hands out.
2. **Bytes first, then metadata.** If step 4 fails, the id stays archived with no log — invisible in every
   view (the archive set hides it, and the membership id is already filtered by `entity.sessionIds`), i.e. a
   harmless ghost. The reverse order would resurrect a visible row on failure.
3. **The durable prune is guaranteed twice**: explicitly by `detachSession`, and implicitly by `mutate`'s
   `sessionPath` filter (**W-ent:141**) on any later entity write. Startup tolerates leftover ids
   (`validateStoredState` **W:831-855** checks duplicates/order only) and merely logs
   `session header is missing` (**W:900-910**) — so even a crash between rm and step 4 degrades gracefully.
4. **`.root`/`.archivedSessionIds` never need direct domain writes**, which is important because
   `storageDomain.open('workspace')` would throw `already-open` (**SDL:355-357**).
5. **Clients converge two ways**: the pushed `api-session/removed` gives an immediate row removal (§2c), and
   the next `session.list` pull (reconnect, or an explicit `ctx.sessions.refresh()` on the client side)
   simply never returns the session again because `listSessions()` no longer sees it in
   `sessionPersistence.list()`. **The sidebar is correct without a restart.**
6. **Nothing else needs touching**: the SQLite FTS index is `:memory:`/`openAt: never` here and self-prunes
   when enabled (**QS:656/681**); the projection-cache row is inert (never read without a header) and simply
   lingers; spill dirs are ephemeral; attachments are content-addressed and shared.

Optional hardening / cleanups, all non-essential:

- Prune the stale projection-cache row via the untyped accessor or the file:
  `ctx.storageDomain.get('session_projcache')?.table('sessions').delete(sessionId)` (**SDL:406-408**,
  **SDL:264-277**) — the domain's own `table()` succeeds even though `open()` would not. Deleting
  `<storageRoot>\session_projcache\sessions\<id>.json` directly also works but leaves the in-memory row until
  the next process start (**SJ:450-459**, **PC:154**).
- If the app is running with the deprecated legacy file `<storageRoot>\session_projcache.json`, leave it
  alone: it is only read when the per-record tree is empty (**SJ:337-349**).
- Wrap the multi-workspace loop in a small in-plugin mutex if two deletions can race; `WorkspaceRegistry`
  serializes its own writes (**W:937-944**) but `detachSession` across different workspaces does not.

Residual, unavoidable risks to state in the plugin's README:

- A **live** archived session cannot be deleted by any supported API; the user must let it go cold
  (closing the view that retains it — the GUI's own archive path calls `clearMain()`, **UIW:861-864**,
  which drops the client retain → `retireScope` → `manager.drop` → `session.dispose()`, **service.js:458-468**,
  **manager.js:108-116**).
- `stat` is the only existence probe on the seam, and a created-but-never-materialized session still appears
  in `list()` via `tracker.pendingEntries()` (**J:2573-2576**) while having no directory on disk; the
  `fs.rm(..., {force:true})` in step 3 makes that case a no-op, and step 4 still cleans the registry.
- `projectKey` is lossy/truncating (**J:866-894**); if a plugin reimplements it, an encoding drift would
  silently miss the target directory. Prefer `ctx.sessionPersistence.locate?.(header)`, and if falling back,
  verify the computed directory actually exists (`fs.stat`) and contains a `session*.jsonl[.zstd]` file
  before `rm`.
