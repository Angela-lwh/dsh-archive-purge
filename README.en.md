# dsh-archive-purge

**English** | [中文](README.md)

A real delete button for archived DeepSeek Harness sessions. DSH can archive a Session but has
never been able to remove one.

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

Reload the page (Ctrl+R) to see the buttons; no DSH restart is needed.
