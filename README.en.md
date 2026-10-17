# dsh-archive-purge

**English** | [中文](README.md)

A real delete button for **archived** DeepSeek Harness sessions. DSH can archive a Session but
has never been able to remove one.

## Source and form

| | |
|---|---|
| Public repository | `https://github.com/Angela-lwh/dsh-archive-purge` (PUBLIC) |
| Submission subpath | `plugin/` |
| Version / license | `1.0.0` · MIT (see `LICENSE`) |
| Author | [Angela-lwh](https://github.com/Angela-lwh) |
| Integration form | DSH **Profile Bundle** (`dsh.manifestVersion: 1`, `dsh.bundle.patch: ./cordis.patch.yml`) plus a Web client half (`dsh.client.platform: web`) |
| Host entry | `plugin/index.js` (ESM; `export const name = 'archive-purge'`, `inject = ['connection','workspaceRegistry','sessionPersistence']`) |
| Client entry | `plugin/lib/client.js` (hand-written lazy-CJS browser bundle) |
| Runtime | Node `>=22`; measured on DSH `0.2.1-rc.2`, `desktop` profile |
| Dependencies | none at runtime; no lockfile |

## How the plugin works

**In the UI**: every **archived** Session row gains two affordances — a **Delete session** row
in its `...` menu, and a **trash button** in its hover strip. Both ask for confirmation, naming
the Session and stating that the deletion cannot be undone. Neither appears on a live or merely
unarchived Session.

**A deletion does this, in order**:

1. refuses a Session with work in progress (a turn that is still running);
2. refuses a Session that is not archived — that mark is what authorizes the deletion;
3. locates the Session's directory (`$DSH_HOME/sessions/<project key>/<session id>/`) and
   checks that it really holds that Session's logs, so a wrong path is never deleted;
4. if the Host is still holding the Session, **releases** that hold first (only an archived,
   idle Session is ever released; one with work in progress never is);
5. recursively deletes the directory — every log generation of that Session;
6. clears the durable records — the Workspace membership and the archive mark — and tells every
   connected UI to drop the row immediately.

**When it cannot delete now**: a Session with work in progress is never deleted; one the plugin
cannot release is **staged** in `$DSH_HOME/archive-purge/pending.json`, and finished
automatically at the next DSH start or by hand (below). A staged Session's history is left
untouched, and **unarchiving it cancels the staged deletion**.

**Deliberately untouched**: attachments (`$DSH_HOME/attachments`, shared across Sessions) and
the projection cache. Deletion is irreversible — there is no trash.

## How to use it

**Install** (from the repository root; the path must be absolute):

```powershell
dsh plugin --profile desktop add file:<absolute path to this repo>/plugin
```

**Use it**:

1. switch the sidebar's view filter to **仅显示已归档 / Archived only**;
2. hover the row and click the **trash icon**, or open its `...` menu and choose
   **删除会话 / Delete session**;
3. confirm. A Session the Host can release is deleted on the spot and its row disappears
   immediately; a staged one is finished at the next start, and the dialog says so.

**Finish a staged deletion by hand**: any Session row's `...` menu → **完成待删除清理 / Finish
pending deletions** → **立即清理 / Clean up now**.

**Uninstall**:

```powershell
dsh plugin --profile desktop remove dsh-archive-purge
```

**How a change takes effect** (measured behaviour):

- browser half, `plugin/lib/client.js`: reload the page — the Host re-snapshots the artifact and
  the page fetches the new bundle;
- host half, `plugin/index.js`: an already-imported module is re-imported only after a DSH
  restart, or by toggling this bundle off and on to remount it.

## Permissions and side effects (declared as measured)

| | |
|---|---|
| Filesystem | reads and **recursively deletes** `$DSH_HOME/sessions/<project key>/<session id>/`; writes its own `$DSH_HOME/archive-purge/pending.json` |
| DSH durable state | removes the Session's Workspace membership and archive mark through DSH's Workspace API (`$DSH_HOME/storages/workspace.json`) |
| Local HTTP | registers one exact route, `POST /api/archive-purge/deleteSession`, on the Web server DSH already runs, inheriting DSH's own authentication |
| UI | registers a menu row and a hover button into two sidebar slots; after a deletion it announces `api-session/removed` so connected UIs drop the row |
| Network | **none** (`plugin/index.js` imports only `node:` builtins) |
| Subprocesses / install scripts | **none**; the package ships no install or postinstall script |
| External effect | **irreversibly deletes Session logs**; there is no trash |

## Status and boundaries

- This repository has **not** been reviewed, certified or compatibility-verified by the DSH Hub
  Workshop, and its Registry authority is 0. Nothing here constitutes a claim that the project
  is installable, safe, or officially compatible.
- **No submission has been created yet**: `plugin/package.json` does not declare `dshWorkshop`,
  so intake blocks at the read stage; the author must add it and push a new pinned commit first.
- The tests and reports in this repository are written and run by the author. They are not an
  independent gate — conclusions rest on independent review and testing.
- A submission uses only public, immutable source coordinates and a structured manifest; it
  contains no credential, private link, personal absolute path or local configuration.
- Deletion is irreversible: verify it on a **disposable** Session first.
