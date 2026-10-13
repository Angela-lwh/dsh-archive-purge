# dsh-archive-purge

Adds the one verb DeepSeek Harness does not have: **delete an archived Session for real**.

DSH can archive a Session but has never been able to remove one. Its own
documentation says so twice:

- `@deepseek-ai/dsh-session-persistence-jsonl` — *"Nothing deletes session files — logs
  accumulate under `root` until removed externally; the seam has no deletion API."*
- `@deepseek-ai/dsh-client-ui-workspace` — *"No Session deletion — sessions can be
  archived but never deleted."*

`ctx.workspaceRegistry.delete()` is not the missing piece: it removes a Workspace
*registration* and deliberately retains every Session log.

## What you get

On any **archived** Session row:

- a **删除会话 / Delete session** row in the row's `...` menu, placed after the shipped
  Archive row (`order: 500` against Archive's `400`), rendered in the danger tone;
- a **trash icon button** in the row's hover strip, after Archive (`100`) and Pin (`200`);
- for both, a confirmation dialog that names the Session and states that the deletion
  cannot be undone. Only the archived row offers either affordance — a live or merely
  unarchived Session is never a target.

A second menu row, **完成待删除清理 / Finish pending deletions** (`order: 600`), opens the
deferred-purge seat: it reads the pending store, runs the stored pass on request, and reports
what each entry did.

Both buttons ship in Simplified Chinese and English, following the app locale, and installed
as a bundle the plugin's own card on the Plugins page reads `locale/en.json` and
`locale/zh.json` for its title and description.

## Install

Two shapes work. The **bundle** shape is the documented DSH route and the one recommended
here, because it needs no second copy of the package and no revisioned row:

```powershell
# from a checkout of this repo; the path must be absolute
dsh plugin --profile desktop add file:D:/Project/dsh-archive-purge/plugin
```

That writes the dependency into the profile's `package.json`, adds `dsh-archive-purge` to its
`dsh.profile.bundles`, and installs the package into the profile's `node_modules`. This
package already declares itself a bundle (`dsh.bundle.patch` below), so its row is then
composed from `cordis.patch.yml` like any other bundle's, and the plugin appears on the
sidebar's **Plugins** page with the `locale/<lang>.json` title and description.

The materialization is a **hard-link farm frozen at install time**, not a live window on this
directory. Measured: a file pnpm hard-linked does see later in-place edits to the source, but a
file whose source was replaced afterwards keeps its stale bytes, and a file added later
(`locale/`) never appears at all. Bring an edit into the profile by re-materializing —
reinstalling without removing first is a no-op (`Already up to date`):

```powershell
Remove-Item $env:DSH_HOME\profiles\<name>\node_modules\dsh-archive-purge -Recurse -Force
dsh plugin --profile <name> add file:<abs path to plugin/>
```

The row has no `?rev=` query, so an already-imported Host module is only re-imported after a
DSH restart; the browser half needs a page reload.

The **file-URL Loader row** shape is what `install.mjs` writes, and it is still supported:

```powershell
# default profile is $env:DSH_PROFILE, else "desktop"
node install.mjs
node install.mjs --profile web
node install.mjs --dry-run          # show what would change
node install.mjs --uninstall        # remove the row and the copied files
```

The installer does two things, outside the profile's package manager on purpose:

1. copies this package to `$DSH_HOME/plugins/dsh-archive-purge/`;
2. writes one marker-delimited Loader row into
   `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, keeping a timestamped backup of that
   file first.

Its advantage over the bundle shape is the revision, which is the reason the first version
chose it: a local plugin that a `pnpm install` may prune is a plugin that silently disappears.

The row names the Host half by `file:` URL whose `?rev=` query is a hash of the published
bytes, and the row's own id carries the same revision. Both matter, and both were
established by measurement rather than assumption:

- Node's ESM cache is keyed by URL, so a reused URL returns the *previous* build;
- DSH's Loader does not re-evaluate a module for an entry id it already knows — a changed
  URL under a reused id produced no import at all.

With both revisioned, reinstalling takes effect in the running process while unchanged
bytes keep the same row instead of churning the Loader tree.

Install the bundle, or the row — **not both at the same time**. Two rows both register
`/api/archive-purge/deleteSession`, and a route is a composition-level contract, so the
second row's activation fails; if you then remove the first row, no row holds the route any
more. Toggling the bundle off and on (or restarting DSH) remounts it cleanly.

## Verify

The test harnesses live in the development checkout beside this package, not in the
installed copy:

```powershell
node tools/test-host.mjs        # Host half against a throwaway session root
node tools/test-client.mjs      # browser bundle against a fake module loader and page
node tools/verify-paths.mjs     # the path derivation, against every real Session header
node tools/test-route.mjs       # the running Host, end to end
node tools/purge.mjs <sessionId>  # call the deletion route from a shell
node tools/remote.mjs <ns>/<method> --args-file args.json --out out.json
node tools/watch-liveness.mjs   # watch whether the Host ever releases loaded Sessions
node tools/cycle.mjs --variant x  # force one fresh import while iterating on a live profile
```

`tools/test-route.mjs` mints the browser-session cookie exactly as `BrowserAuth` does
(`dsh-auth-<base64url(sha256(authority))>`, `v1.<body>.<hmac>`, signed with the durable
`client-connection/browser-session` secret) and asserts the whole chain: no cookie → 401,
foreign `Host` → 403, cross-site → 403, then the real refusals. It never deletes anything —
every request targets a Session the Host must reject. Pass `--token <launch token>` to use
a cookie the Host issues itself instead; the Host half can log one from
`ctx.connection.authenticatedUrl(...)` if you need it.

## What it deletes, and what it does not

For one archived Session id, in this order:

1. refuses a Session with **work in progress** (`ctx.agents.get(id).status === 'running'`);
2. refuses a Session that is not archived — that mark authorizes the deletion;
3. locates the Session directory — preferring the JSONL backend's own `locate(meta)` and
   otherwise re-deriving `<root>/<projectKey(cwd)>/<encodeSegment(id)>/`, verified against
   every real Session on this machine (`node tools/verify-paths.mjs`);
4. refuses a target whose last segment is not the encoded id, whose parent is not a
   project-key directory, or that holds no `session*.jsonl*` generation;
5. **waits briefly for the Host to release a loaded Session** (default 2 s,
   `releaseWaitMs`) and, if it is still loaded, **stages the purge for the next start**
   instead of refusing outright — see the next section;
6. recursively deletes that directory — the Session's log generations and any migration
   staging files, i.e. all of it;
7. prunes the durable Workspace membership (`Workspace.detachSession`) and the archive mark
   (`workspaceRegistry.unarchiveSession`), then emits the allowlisted
   `api-session/removed` event so every connected GUI drops the row without a reload.

**Bytes first, metadata second** is deliberate: if a durable write fails after the files
are gone, the result is an invisible stale id — rendering skips members without a summary —
rather than a visible row pointing at a log that no longer exists.

Deliberately untouched: attachment objects (`$DSH_HOME/attachments`, content-addressed and
shared across Sessions), the projection-cache row (inert; reads require a header the
Session no longer has), and spill files (process-scoped, outside `$DSH_HOME`).

## When the Host still holds the Session

This is the case the button first failed on, and the reason the plugin has a deferred mode.

A Session the Host has ever loaded stays loaded for the Host's lifetime. Measured on the
running Host: `tools/watch-liveness.mjs` polled `session/list` every 15 s for six minutes
and the loaded set never changed. `ctx.sessions.enter()` also refuses an id already in the
store (`if (this.store.has(id)) throw new Error('session "…" already exists')`), and the
Client's release is purely client-side (`manager.drop` never reaches the Host).

It is, however, **releasable** — which is what the second version of this plugin is built on.
The `detach` closure that owns each lifecycle edge lives on the *entry*, not on the service:
`ctx.sessions.store.get(id).detach()` and `ctx.agents.store.get(id)` followed by
`ctx.agents.detachEntered(entry)`. Calling both leaves the Session genuinely unloaded
(`loaded after both detaches: false`, measured on the running desktop Host), and each detach
emits its paired `session/disposed` / `agent/disposed` edge, so nothing that observes those
events is bypassed. Reaching the entries rather than calling `detachEntered` directly is
deliberate for exactly that reason.

So a confirmed deletion now releases an **archived, idle** Session and deletes it on the spot.
The guards are re-read at release time, not inferred from the caller:

| condition | outcome |
|---|---|
| the Agent's `status` is `running` | never released — the turn's own history would be destroyed mid-flight |
| the workspace registry does not list the Session as archived | never released (a staged purge whose Session was unarchived meanwhile) |
| `releaseLoaded: false` in config | never released |
| the Session is released | its log directory is removed in the same request |
| it still reports loaded after both detaches | the previous staged path, unchanged |

Deleting the log underneath a *still-loaded* Session is still not an option:
`sessionQuery.listSessions()` is the union of the in-memory store and the persisted headers,
so the row would return on the next refresh — unopenable, because its log is gone. That is why
release is attempted first and staging remains as the fallback:

```
POST /api/archive-purge/deleteSession  { sessionId }
→ { ok:false, error:{ code:"archive-purge/session-deferred",
                      message:"… is loaded by the Host; its purge is staged for the next start" } }
```

- the Session's history is left completely untouched;
- the archive mark is kept — it is both the authorization the next start re-checks and your
  own cancel switch: **unarchive the Session and the staged purge is dropped**;
- the id is recorded in `$DSH_HOME/archive-purge/pending.json`;
- at the next Host start, when nothing is loaded, the plugin finishes the purge by itself.

The dialog says exactly this in Chinese and English, so a deferred deletion never looks like
a silent success. Set `stageWhenLoaded: false` to get the plain
`archive-purge/session-loaded` refusal instead.

### Finishing a staged purge on demand

Waiting for the next start was the first version's only answer, and it made every
"the Host still holds it" case cost a restart. The route therefore carries two more verbs,
and the row menu offers them as **完成待删除清理 / Finish pending deletions**:

```
POST /api/archive-purge/deleteSession  { action:"listPending" }
→ { ok:true, value:{ pendingFile:"…/pending.json", sessionIds:[…] } }

POST /api/archive-purge/deleteSession  { action:"retryPending" }
→ { ok:true, value:{ attempted:2, deleted:1, dropped:0, stillStaged:1,
                     remaining:[…], stillLoaded:[…], results:[…] } }
```

`action` defaults to `"delete"`, so the original body shape keeps working. The retry runs
exactly the pass the next start would run: each entry re-enters the same purge path, so the
archive mark, the running Agent, the target directory and the loaded state are all re-checked,
and an entry whose Session is *still* loaded stays staged and is reported as `stillStaged`
rather than being deleted or silently dropped. Nothing that was previously refused becomes
deletable — the retry only removes the *restart*.

The one implementation is shared by both callers (`drainStagedPurges`): the startup pass logs
its report, the retry returns it.

`$DSH_HOME` is deliberately **not** read from the environment to find that file: the desktop
Host does not export it to its own process, the Loader row keeps an *unevaluated*
`{"__jsExpr":"dshHomePath('storages')"}` marker, and there is no `dshHomePath` global at
runtime — all three verified against the running Host. The home is derived from the
persistence layer's own located paths instead (`resolveHarnessHome`).

## Extension seams, and one that does not work

The browser half cannot touch the filesystem, and no generated Remote namespace exists for
a third-party package — the Client Remote table is a fixed build-time assembly in
`dsh-api-remotes`, and the Typert generator is not shipped. So the two halves talk over
`ctx.connection.fetch.register()`, an **exact** route on the shared `/api` Fetch handler:

- it is matched before the Gateway's Remote interceptor, so it cannot collide with a
  generated endpoint;
- it is authenticated for free, because the `/api` prefix route runs `connection.admit()`
  before the bridge dispatches: the Host/Origin fence (403) then the signed browser-session
  cookie (401). A bare `ctx.webServer.register()` route has neither check, which for an
  irreversible delete would expose it to any local process.

`ctx.connection.rpc.handle()` — the neighbouring generic RPC channel, and the seam DSH's
own docs suggest first — **does not work in this build**. It reads `webServer` through the
Connection *service's* Context, which does not declare that service in its `inject`, so
Cordis' strict accessor throws from inside `register()`:

```
Error: cannot get property "webServer" without inject
    at HostConnectionService.register (dsh-client-connection/lib/index.js:656)
```

The `/api` route itself is registered in the plugin's `apply`, where the inject *is*
declared — which is exactly why the `/api` seat works and `rpc.handle()` does not. The
failure arrives as a `FAILED` fiber for the whole plugin, with no diagnostic beyond the
entry's phase.

## Configuration

| key | default | meaning |
|---|---|---|
| `sessionsRoot` | derived from the persistence layer's located paths | session storage root, for the documented-layout fallback |
| `releaseWaitMs` | `2000` | how long to wait for the Host to release a loaded Session before releasing it ourselves |
| `releaseLoaded` | `true` | release an archived idle Session so the deletion completes now, instead of staging it |
| `stageWhenLoaded` | `true` | stage a loaded Session's purge for the next start instead of refusing |
| `pendingFile` | `$DSH_HOME/archive-purge/pending.json` | where staged purges wait |

```yaml
- id: archive-purge-<revision>
  name: 'file:///…/dsh-archive-purge/index.js?rev=<revision>'
  config:
    releaseWaitMs: 5000
    releaseLoaded: false
    stageWhenLoaded: false
```

Set `releaseLoaded: false` to keep the Host's hold untouched — the behaviour of the first
version, where every loaded Session is staged (or refused, with `stageWhenLoaded: false`).

Note that a patch row replaces the targeted row's whole `config`.

## Limits

- **A loaded Session is released and purged immediately when it is archived and idle.** One
  that is not released — work in progress, or a release that did not take — stays staged for
  the next start, or can be retried from the pending dialog. Unarchiving cancels a staged entry.
- **A Session with running work cannot be deleted at all**, by any path; stop the work first.
- **`projectKey` is lossy and truncating by design** (it collapses `/ \ :` runs and caps the
  component at 251 characters). The fallback derivation mirrors it, is covered by
  `tools/verify-paths.mjs` against real data, and is only reached when the backend offers no
  `locate()`.
- **Deletion is irreversible and leaves no trash.** That is the requested behaviour; the
  confirmation dialog is the only guard, and the archive mark is the authorization.
- **No bulk delete, no undo, no retention policy.**
