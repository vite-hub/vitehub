---
description: The browser rejected an unconfirmed Sync write because clearSync() cleared local data or the old stored IndexedDB copy was lost.
---

This write was not confirmed by the server before its local copy ended. Only the browser makes this code. It happens in two cases:

- `clearSync()` ran without `keepWrites: true` and dropped queued writes across every tab.
- The old stored copy in the browser's `vitehub-sync` IndexedDB database was lost, such as when another tab or the browser deleted, upgraded, or closed the database.

When the old stored copy is lost, the tab rejects every unconfirmed write that belonged to that copy with `SYNC_CLEARED`, including an in-flight write whose server response arrives after the loss. If the server already applied that write, the saved row returns in the next full snapshot. The tab reopens the database, drops its cursor so the next pull fetches a full snapshot, and sends writes made after the loss through the new copy. If another tab opened a newer database format, the old tab falls back to memory storage instead of changing the newer database.
