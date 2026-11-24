---
description: The browser rejected an unconfirmed Sync write because clearSync() cleared local data or the old stored IndexedDB copy was lost.
---

The browser dropped this write before it received confirmation from the server. It happens in two cases:

- `clearSync()` dropped queued writes across every tab. Even with `keepWrites: true`, writes without an account are still dropped.
- The old stored copy in the browser's `vitehub-sync` IndexedDB database was lost, such as when another tab or the browser deleted, upgraded, or closed the database.

When the old stored copy is lost, the tab rejects every unconfirmed write from that copy with `SYNC_CLEARED`, even if the server applied the write before the tab received its response. The tab reopens the database, drops its cursor so the next pull fetches a full snapshot, and sends writes made after the loss through the new copy. If another tab opened a newer database format, the old tab falls back to memory storage instead of changing the newer database.

The next full snapshot shows current rows in scope. It does not tell you whether the server applied a specific write. For example, an action can change another table without changing the rows in this snapshot. Repeat the write only if you can verify it did not apply or know it is safe to repeat.
