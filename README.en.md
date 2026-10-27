# dsh-archive-purge

**English** | [中文](README.md)

A real "delete" for archived DeepSeek Harness sessions: removes the session and any subagent sessions it spawned from disk.

## Install

```powershell
# npm
dsh plugin --profile desktop add @angela_lwh/dsh-archive-purge

# GitHub
dsh plugin --profile desktop add https://github.com/Angela-lwh/dsh-archive-purge
```

Restart DSH afterwards: the Host half loads at startup, and an archived session's `...` menu and hover strip then show **Delete session**.

## Limits

- Only **archived** sessions can be deleted; archive one first.
- Refused while the session, or one of its subagent sessions, has work in progress; a session the Host still holds is staged and finished at the next start or from "Finish pending deletions".
- Deletion is irreversible and there is no trash; attachments (shared across sessions) and the projection cache are untouched.
- Subagent sessions are deleted with their parent; leftovers whose parent is already gone are swept at startup or on the next deletion.
- Blank sessions that never sent a message (the sidebar hides them) are removed automatically on Host start, on a new conversation, or on any deletion, and no longer show up in `@`; `sweepBlanks` / `filterBlankReferences` switch each part off.
- Only this machine's `$DSH_HOME/sessions` is touched, and no backup is kept; back it up first if you need a way back.
