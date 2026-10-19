# dsh-archive-purge

**English** | [中文](README.md)

A real delete button for **archived** DeepSeek Harness sessions. DSH can archive a Session but
has never been able to remove one.

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

**Install** — replace `desktop` with the profile you are installing into:

```powershell
# 1. from the npm registry — the shortest form. The name is scoped, because the unscoped
#    `dsh-archive-purge` on npm belongs to somebody else
dsh plugin --profile desktop add @anglea_lwh/dsh-archive-purge

# 2. paste the repository URL — in the Plugins page install box or on the command line
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge

# 3. pinned to one commit, so the source cannot drift with main (recommended for others)
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge#<full 40-character commit>

# 4. from the GitHub Release tarball
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge/releases/download/v1.0.3/dsh-archive-purge-1.0.3.tgz

# 5. from a local checkout — picks up your edits immediately
dsh plugin --profile desktop add file:<absolute path to this repo>/plugin
```

Each route writes the profile dependency, adds `@anglea_lwh/dsh-archive-purge` to
`dsh.profile.bundles`, and installs into the profile's `node_modules`.

The repository root is a **real package**: the root `package.json` is a shim whose `main` and
`dsh.bundle.patch` point into `plugin/`, which is what makes the repository URL installable.
`tools/verify-package.mjs` checks that the shim and `plugin/package.json` agree on every shared field
and that each declared path exists; it runs first in the publish gate.

> **Still do not use `github:owner/repo#<sha>&path:/subdir`**: pnpm derives the dependency alias from
> that spec (`<package-name>#<sha>`, not a valid dependency name) and refuses it with
> `ERR_PNPM_INVALID_DEPENDENCY_NAME`. To pin a commit use form 3, the plain `#<commit>` suffix.

**Use it**:

1. switch the sidebar's view filter to **仅显示已归档 / Archived only**;
2. hover the row and click the **trash icon**, or open its `...` menu and choose
   **删除会话 / Delete session**;
3. confirm. A Session the Host can release is deleted on the spot and its row disappears
   immediately; a staged one is finished at the next start, and the dialog says so.

Once installed, the **Plugins** page shows a 「归档会话清理」 card with a bilingual title and
description that follow the app locale, and the bundle can be switched off and on like any other.

**Finish a staged deletion by hand**: any Session row's `...` menu → **完成待删除清理 / Finish
pending deletions** → **立即清理 / Clean up now**.

**Uninstall**:

```powershell
dsh plugin --profile desktop remove @anglea_lwh/dsh-archive-purge
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
