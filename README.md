# dsh-archive-purge — a delete button for archived DSH sessions

DeepSeek Harness can archive a Session but has never been able to delete one. This
workspace contains a working plugin that adds that verb, plus the research and test
harnesses that established how to do it safely against a live Harness.

**Status: installed and verified on this machine** (`desktop` profile, GUI at
`http://127.0.0.1:19387`).

| | |
|---|---|
| Host entry | live Loader row `archive-purge-<revision>` → `fiberPhase: active` |
| Menu row | `sidebar.workspaces.session.menu.item` → `archive-purge.delete`, order 500 (after Archive 400) → `active` |
| Hover button | `sidebar.workspaces.session.row.action` → `archive-purge.delete`, order 300 (after Archive 100, Pin 200) → `active` |
| Route | `POST /api/archive-purge/deleteSession` → authenticated, all probes green |
| Patch row | `$DSH_HOME/profiles/desktop/cordis.patch.yml`, marker-delimited block, timestamped backup kept |

## First real use, and what it exposed

The first click on a real archived Session — its title is withheld here — was refused with
`archive-purge/session-live`. The diagnosis was worth the detour:

- the Session was still **loaded** by the Host (idle, not running) because it had just been
  open — and a loaded Session stays loaded for the Host's whole lifetime. Measured:
  `tools/watch-liveness.mjs` polled for six minutes and the loaded set never changed;
- it looked like it **cannot be unloaded** from a plugin: `ctx.sessions.enter()` throws for an
  id already in the store, the Client's release never reaches the Host, and the Agent's
  registration belongs to a Cordis effect inside the `agents` service;
- deleting the log anyway was not an option either: `sessionQuery.listSessions()` is the
  union of the in-memory store and the persisted headers, so the row would have come
  back — unopenable.

So the plugin grew a **deferred mode**: a loaded Session's purge is staged (history
untouched; the archive mark kept as both the authorization and the cancel switch) and
finished automatically at the next Host start, when nothing is loaded. The dialog says so in
both languages — and that is exactly how the Session above was eventually removed.

Deferred mode turned out to be only half the answer, because "the next start" meant "restart
DSH for a deletion you already confirmed". The measured runtime shows the release *is*
reachable from a plugin after all: both `ctx.sessions`' store entry and `ctx.agents`' registry
entry expose the `detach` closure that owns their lifecycle edge, and calling both leaves the
Session genuinely unloaded (`loaded after both detaches: false`, measured on the running
desktop Host). So a confirmed deletion now **releases an archived idle Session and deletes it
on the spot**; the staged path remains only for Sessions that report work in progress or that
the plugin could not release.

Two smaller truths came out of the same detour, both now encoded in the plugin: the desktop
Host does **not** export `DSH_HOME` to its own process, and a `!!js dshHomePath(...)` Loader
row keeps an *unevaluated* `{"__jsExpr": …}` marker — so the Harness home is derived from the
persistence layer's own located paths instead.

## How to use it

Install it as a profile bundle (see `plugin/README.md` for both install shapes):

```powershell
dsh plugin --profile desktop add file:D:/Project/dsh-archive-purge/plugin
```

Then, to see the buttons on an archived Session:

1. switch the sidebar's view filter to **仅显示已归档 / Archived only** (or 全部对话);
2. hover the archived row and click the **trash icon**, or open its `...` menu and choose
   **删除会话 / Delete session**;
3. confirm in the dialog. An **archived, idle** Session is deleted outright, even while the
   Host is still holding it in memory: the plugin releases that hold first (the Host pushes
   `api-session/removed`) and then removes the log directory. A Session with work in progress
   is refused; one the plugin could not release is **staged** and removed at the next start,
   and the dialog says so in both languages.

If the buttons do not appear, reload the page once (Ctrl+R). The Host half needed no
restart: the profile is a live-patch profile and the entry is already `active`.

A staged purge is recorded in `$DSH_HOME/archive-purge/pending.json`, and the deferred run
at the next start empties that file again. Unarchiving a Session before then cancels its
staged purge. To stage one from a shell instead, `node tools/purge.mjs <sessionId>`; to see
what is currently staged, read that JSON file.

### Finishing a staged purge without restarting

Nothing normally stages any more, but a staged entry can still exist — it comes from an older
run, or from a Session the plugin could not release. It need not wait for the next DSH start:

1. open any Session row's `...` menu and choose **完成待删除清理 / Finish pending deletions**;
2. the dialog reads the pending store and tells you how many Sessions are waiting;
3. press **立即清理 / Clean up now**.

Every entry whose Session is now releasable is released and deleted on the spot; one that
still cannot be released stays staged and the dialog says so. Nothing here widens what may be
deleted: each entry re-enters the same purge path, which re-checks the archive mark, the
running Agent, the target directory and the loaded state. The same pass also runs
automatically at every Host start.

### Iterating on the plugin (hot deploy)

The browser half is a plain artifact — no build step — and the Host re-snapshots it on every
change, so an edit is live without restarting the app. What you run depends on how the plugin
was installed:

**As a profile bundle (recommended).** `dsh plugin --profile <name> add file:<abs path to plugin/>`
writes the dependency, adds `dsh-archive-purge` to `dsh.profile.bundles`, and pnpm links the
package back into the profile's `node_modules` — an edit under `plugin/` is visible there
immediately, with no reinstall:

| you changed | do this | what the app does |
|---|---|---|
| `plugin/lib/client.js` | edit it, then reload the page once | the Host re-snapshots the artifact, the boot graph's entry revision changes, `/plugins/events` announces it, and the page fetches the new bundle |
| `plugin/index.js` | edit it; reload the page, and restart DSH if an already-imported module must be re-imported | the new bytes are what the Host imports next |
| `plugin/package.json`'s `dsh.client` | edit it, then reload the page | the entry list is rebuilt from the declaration |

The bundle route also puts the plugin on the sidebar's **Plugins** page, so it can be switched
off and on like any other bundle. Enable/disable recomposes the profile and remounts the row,
which is also the way to recover a row whose activation failed.

**As a file-URL Loader row** (`node install.mjs`, the first version's route): the row id and
its URL carry a revision derived from `index.js`'s bytes, so the Host imports a genuinely new
module generation. Same loop, one extra command:

| you changed | do this |
|---|---|
| `plugin/lib/client.js` | `node install.mjs`, then reload the page once |
| `plugin/index.js` | `node install.mjs` |
| `plugin/package.json`'s `dsh.client` | `node install.mjs` |

Two traps worth knowing, both hit while building this change:

- `install.mjs` copies `plugin/` over `$DSH_HOME/plugins/dsh-archive-purge` wholesale
  (`rm -rf` first). Edit the source under `plugin/`, never the installed copy — the next
  install overwrites it. This is one more reason to prefer the bundle route, where there is
  no second copy at all.
- An **unchanged** `index.js` keeps its revision, so re-running `install.mjs` is a no-op for
  the Host half. That is the intended behaviour, not a failure: change the bytes to change
  the revision.
- Install the bundle **before** retiring any file-URL row. Two rows both register
  `/api/archive-purge/deleteSession`, and the route is a composition-level contract: the
  second row's activation fails, so retiring the first row afterwards leaves no row holding
  the route. Disable and re-enable the bundle (or restart DSH) to remount it cleanly.

## Layout

| path | what it is |
|---|---|
| `plugin/` | the plugin: `index.js` (Host half), `lib/client.js` (hand-written browser bundle), `package.json`, `cordis.patch.yml`, `README.md` |
| `plugin/README.md` | the plugin's own documentation — design, seams, what it deletes, limits |
| `install.mjs` | install / uninstall / dry-run for one profile, with revisioned Loader rows |
| `tools/test-host.mjs` | Host half against a throwaway session root: every refusal + a real recursive delete |
| `tools/test-client.mjs` | browser bundle against a fake `__ModuleLoader__`, module table, React, and `fetch` |
| `tools/test-route.mjs` | the **running** Host end to end: trust fence, cookie, routing, JSON contract |
| `tools/e2e-delete.mjs` | creates + archives one throwaway Session through the product's own API, then probes the guards |
| `tools/e2e-immediate-delete.mjs` | **the confirmed-deletion path**: creates + archives a throwaway Session the Host is still holding, deletes it in one call, and audits the reply, the disk, the archive mark, the pending store, and `session/list` |
| `tools/e2e-forged-delete.mjs` | **the real destructive run** (`--staged` for the deferred path): manufactures a stored Session, hands it to the plugin, audits the disk and every durable store, and cleans up |
| `tools/purge.mjs` | call the deletion route from a shell |
| `tools/remote.mjs` | call any Remote namespace/method from a shell (file-based I/O, so PowerShell quoting cannot mangle it) |
| `tools/watch-liveness.mjs` | watch whether the Host ever releases loaded Sessions |
| `tools/verify-paths.mjs` | the session-directory derivation, checked against every real Session header |
| `tools/cycle.mjs` | force one fresh Host-side import while iterating on a live profile |
| `tools/asar.mjs` | list / cat / extract-tree inside the shipped `app.asar` |
| `vendor/` | read-only extracts of the DSH packages this work depends on |
| `REPORT-host-rpc.md`, `REPORT-delete-archived-session.md` | the two research reports: client→Host seams, and session/Workspace durable state |

## What the research established

These are not in DSH's public docs, and each one changed the design:

**1. `ctx.connection.rpc.handle()` — the seam DSH's own docs point at — is broken in this
build.** It reads `webServer` through the Connection *service's* Context, which does not
declare that service in its `inject`, so Cordis' strict accessor throws
`cannot get property "webServer" without inject` from inside `register()`
(`dsh-client-connection/lib/index.js:656`). The plugin surfaces as a `FAILED` fiber with no
message anywhere. The working seam is `ctx.connection.fetch.register()`, an exact route on
the shared `/api` Fetch handler: matched before the Gateway's Remote interceptor, and
authenticated for free because the `/api` prefix route runs `connection.admit()` (Host/Origin
fence → signed cookie) before dispatching.

**2. Deleting a Session means deleting a directory, and only that directory.** There is no
deletion API anywhere: `sessionPersistence`'s seam is `create/open/stat/list/flush`;
`workspaceRegistry.delete()` removes a Workspace registration. A Session owns exactly
`<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>/` — log generations only, no lock file
on Windows. The one durable store that must also change is `$DSH_HOME/storages/workspace.json`
(the `workspace` domain: membership, archive set, pin set), reachable through
`Workspace.detachSession()` and `workspaceRegistry.unarchiveSession()`. The SQLite search
index is `:memory:`/`openAt: never` here and self-prunes when enabled; the projection cache
row is inert; attachments are shared content-addressed blobs that must **not** be touched.

**3. A loaded Session is unremovable, and it is what broke the first real click.** The Host
keeps every Session it has ever loaded for its whole lifetime — measured: six minutes of
idle polling with `tools/watch-liveness.mjs` and the loaded set never changed. No
plugin-reachable API unloads one (`ctx.sessions.enter()` throws for an id already in the
store; the Client's release never reaches the Host), and deleting the log underneath it
would produce a row that returns on the next refresh and cannot be opened, because
`sessionQuery.listSessions()` is the union of the in-memory store and the persisted headers.
Hence the deferred mode.

**4. The Host's own process has no `DSH_HOME`, and the Loader row has no evaluated config
root.** `process.env.DSH_HOME` is undefined inside the Host (it is injected only into tool
subprocesses), a `!!js dshHomePath('sessions')` row keeps an *unevaluated*
`{"__jsExpr":"dshHomePath('sessions')"}` marker in `options.config`, and there is no
`dshHomePath` global at runtime. Paths are therefore derived from the persistence layer's own
`locate()` results, with each `dirname` hop spelled out in a named helper.

Also measured, and encoded in the installer: DSH's Loader does not re-evaluate a module for
an entry id it already knows, and Node's ESM cache is keyed by URL — so a reinstall only
takes effect in a running process when **both** the row id and the module URL carry a fresh
revision. A consequence worth knowing when debugging: re-writing the same row does not
re-run `apply`, so `tools/cycle.mjs` exists to force a genuinely new import.

## Reproduce the verification

```powershell
node tools/test-host.mjs      # host half: guards, staging, drain, real recursive delete
node tools/test-client.mjs    # browser half: slots, inject faces, components, route call, copy
node tools/verify-paths.mjs   # every stored session resolves to its own directory
node tools/test-route.mjs     # live host: 401 / 403 / 403 / 200 + refusal codes
node tools/e2e-forged-delete.mjs --template <id>            # real destructive run
node tools/e2e-forged-delete.mjs --template <id> --staged    # deferred path
```

### The destructive run, and its two traps

A Session created through `session/create` is **always live** (`agents.ensureSession`
returns a live ordinary Agent), and the plugin deliberately refuses live Sessions — so the
first attempt reports `archive-purge/session-live` and correctly deletes nothing. Calling
`session/rename` "to validate the log" makes it live too, because opening a stored Session
for write is what loads it. `tools/e2e-forged-delete.mjs` therefore manufactures a stored,
non-live Session out of a legitimate log (only the header's `id` changes), validates it with
`session/list` — the same header read `stat()` performs, and the only one the deletion path
needs — and then has the plugin delete it for real:

```
ok  a stored log now exists under the new identity
ok  DSH lists the manufactured Session            (cwd=<project-dir>)
ok  it is reported as stored, not live
ok  workspace/archiveSession succeeds
ok  the plugin deleted it        ({deleted:true, directory:"…\--<project-slug>--\session-…"})
ok  the log directory is gone
ok  the archive mark was cleared
ok  the Workspace membership was pruned
ok  DSH no longer lists it
ok  the archive set holds exactly what it did before
```

The script aborts before any deletion if DSH does not list the manufactured Session, and its
`finally` block removes the directory and clears the archive mark no matter what. Every
pre-existing Session was verified intact afterwards (15/15 directories self-consistent, 5/5
Workspace registrations unchanged).

Two protective refusals were also exercised on real data: a live Session, and an archived
subagent Session (`archive-purge/subagent`, verified by archiving one and unarchiving it
again — fully reversible).

## Reverting

```powershell
# bundle shape: drop the bundle and its dependency
dsh plugin --profile desktop remove dsh-archive-purge

# file-URL shape: removes the Loader row and $DSH_HOME/plugins/dsh-archive-purge
node install.mjs --uninstall
```

A timestamped copy of `cordis.patch.yml` from before every install sits beside it
(`cordis.patch.yml.bak-<timestamp>`), so any install can be undone from that file alone.
