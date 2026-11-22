# @vite-hub/device decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Cap stored JSON at 5 MB because openDevice() reads every copy before the app mounts

`maxDeviceBytes` in `packages/device/src/device.ts`.

**Context:** open() loads the whole store with getAll() so the first render can show stored copies; the cap bounds that startup cost.

**Decision:** Cap stored JSON at 5 MB because openDevice() reads every copy before the app mounts.

**Consequences:** Raising the cap without changing the read path delays app mount.

## Meta changes from this tab's own operations apply inside the disk queue after their disk operation; meta from another tab's message applies at once

`meta` in `packages/device/src/device.ts`.

**Context:** Meta must follow the order of the disk operations of this tab, while a message reports a disk change that already happened.

**Decision:** Meta changes from this tab's own operations apply inside the disk queue after their disk operation; meta from another tab's message applies at once.

**Consequences:** Setting meta outside the queue makes later queued writes compare against a meta that does not match the disk order.

## Once a tab saw the disk in its own build version, a different version for the same account means a newer build took the disk: the old tab stops writing and never resets it back, while another account still resets

`versionSeen`, `ensure` in `packages/device/src/device.ts`.

**Context:** Old and new builds can run in two tabs at once; copies of another version can have another shape.

**Decision:** Once a tab saw the disk in its own build version, a different version for the same account means a newer build took the disk: the old tab stops writing and never resets it back, while another account still resets.

**Consequences:** Without versionSeen, tabs of two builds reset the disk back and forth and wipe each other's copies.

## The device stores an answer only when its loader call started in the current epoch, after the page named a string account; naming bumps the epoch at once in memory

`epoch`, `name`, `write` in `packages/device/src/device.ts`.

**Context:** An answer whose call started before a naming, sign-out, clear, or cross-tab change can belong to another session.

**Decision:** The device stores an answer only when its loader call started in the current epoch, after the page named a string account; naming bumps the epoch at once in memory.

**Consequences:** Storing earlier answers can persist one account's data under another account.

## persist() and ensure() compare `meta` by identity with the snapshot they started from, and skip adopt() when a cross-tab message already replaced it

`persist`, `ensure` in `packages/device/src/device.ts`.

**Context:** A message of another tab can arrive while this tab's disk operation is in flight; that message already carries the newer meta and already invalidated the tab.

**Decision:** persist() and ensure() compare `meta` by identity with the snapshot they started from, and skip adopt() when a cross-tab message already replaced it.

**Consequences:** Dropping the identity check lets a tab overwrite newer message meta with the stale result of its own write and invalidate twice.

## setAccount() names the account in memory at once (waiting only while the device opens), and pending writes wait in memory until the disk holds the page's account; ensure() flushes them afterwards

`flush`, `setAccount` in `packages/device/src/device.ts`.

**Context:** While open() reads the disk, its copies decide what the naming invalidates; after that, reads started after the naming must be storable before the disk reset completes.

**Decision:** setAccount() names the account in memory at once (waiting only while the device opens), and pending writes wait in memory until the disk holds the page's account; ensure() flushes them afterwards.

**Consequences:** Clearing pending while the disk lags drops answers stored right after the naming; naming during open before take() loads the wrong account's copies.

## The size cap is enforced by the disk inside each write transaction over the entries of every tab, oldest first; a tab's memory cap only bounds its own memory

`trim`, `evict` in `packages/device/src/device.ts`, `packages/device/src/indexeddb.ts`.

**Context:** Several tabs write to one disk, and each tab's memory is an outdated view of it.

**Decision:** The size cap is enforced by the disk inside each write transaction over the entries of every tab, oldest first; a tab's memory cap only bounds its own memory.

**Consequences:** Trimming from tab memory deletes newer copies written by other tabs or lets the disk exceed the cap.

## An `account` message without meta for the account this tab already named is ignored

`receive` in `packages/device/src/device.ts`.

**Context:** It comes from a tab without IndexedDB or from a reset that failed, so the disk did not change.

**Decision:** An `account` message without meta for the account this tab already named is ignored.

**Consequences:** Invalidating on it makes every diskless tab's naming wipe the memory and restart the reads of all tabs on the same account.

## When another tab clears, resets, or names another account, this tab invalidates everything and forgets its own naming; it stores again only after its page names an account

`receive` in `packages/device/src/device.ts`.

**Context:** The other tab's change is newer than this page's naming, and the session of this page can have changed since.

**Decision:** When another tab clears, resets, or names another account, this tab invalidates everything and forgets its own naming; it stores again only after its page names an account.

**Consequences:** Keeping the naming lets this tab write answers of its old session onto a disk that now belongs to another account.

## When the epoch moved while open() read the disk, the tab drops the snapshot copies and keeps the meta of the cross-tab message, using the read meta only when no message set one

`connectAndTake` in `packages/device/src/device.ts`.

**Context:** The only way the epoch moves during open is a message of another tab that changed the disk after the snapshot was taken.

**Decision:** When the epoch moved while open() read the disk, the tab drops the snapshot copies and keeps the meta of the cross-tab message, using the read meta only when no message set one.

**Consequences:** Taking the snapshot loads copies that another tab already deleted or replaced.

## At open, the disk is brought to this build's version for the account the page named, or else for the disk's own account; only a page naming is rechecked against `named` in ensure() (fromPage)

`connectAndTake` in `packages/device/src/device.ts`.

**Context:** The disk account only reflects what the disk had, while a page naming reflects the current session and can be replaced later.

**Decision:** At open, the disk is brought to this build's version for the account the page named, or else for the disk's own account; only a page naming is rechecked against `named` in ensure() (fromPage).

**Consequences:** Treating the disk account as a page naming makes ensure() skip the version migration, and the reverse lets a stale naming reset the disk.

## Queued ensure() tasks run only when the epoch (or the page naming) is unchanged since they were queued, so an outdated account never resets the disk

`connectAndTake`, `ensure` in `packages/device/src/device.ts`.

**Context:** A naming, a trim that found another account, or a cross-tab change can happen between queueing and running.

**Decision:** Queued ensure() tasks run only when the epoch (or the page naming) is unchanged since they were queued, so an outdated account never resets the disk.

**Consequences:** A stale task can delete the copies of the account that is now current.

## Copies of another version, or of an account other than the requested one, never load into memory; claim() sets `requested` before naming so this holds for session-read namings before open finishes

`take`, `claim` in `packages/device/src/device.ts`.

**Context:** Other versions can have another shape, and another account's copies would show for a moment.

**Decision:** Copies of another version, or of an account other than the requested one, never load into memory; claim() sets `requested` before naming so this holds for session-read namings before open finishes.

**Consequences:** Removing the filter shows wrong-shape data or another user's data on screen.

## During open, an answer that the page already stored in memory wins over the disk copy of the same key

`take` in `packages/device/src/device.ts`.

**Context:** A page can name its account and store answers before open() finishes reading the disk.

**Decision:** During open, an answer that the page already stored in memory wins over the disk copy of the same key.

**Consequences:** Overwriting it shows an older disk copy over a newer answer.

## ensure() makes one reset attempt as a compare-and-set on the generation known when the task started, inside one IndexedDB transaction; on mismatch it adopts the disk and does not rewrite meta until the next naming

`ensure`, `indexeddb.ts (module)` in `packages/device/src/device.ts`, `packages/device/src/indexeddb.ts`.

**Context:** Tabs race on one shared disk, and a tab with an old view must not fight the tab that changed it.

**Decision:** ensure() makes one reset attempt as a compare-and-set on the generation known when the task started, inside one IndexedDB transaction; on mismatch it adopts the disk and does not rewrite meta until the next naming.

**Consequences:** Retrying, or checking the generation outside the transaction, lets two tabs clobber each other's resets and copies.

## When a reset or clear fails on the disk, the tab still broadcasts the account or clear message (without meta) so other tabs drop data of the previous account

`ensure`, `clear` in `packages/device/src/device.ts`.

**Context:** Sign-out and account switches are privacy boundaries even when IndexedDB fails.

**Decision:** When a reset or clear fails on the disk, the tab still broadcasts the account or clear message (without meta) so other tabs drop data of the previous account.

**Consequences:** Other tabs keep showing the previous account's copies after a failed reset or clear.

## name() invalidates everything on a change from an earlier naming, on null, or when memory holds another account's copies; only the first naming with no foreign copies keeps answers on screen (never stored) and emits `named` so reads reload

`name` in `packages/device/src/device.ts`.

**Context:** Loader calls running at a sign-out belong to the old session, but a first naming should not blank a screen that shows nothing foreign.

**Decision:** name() invalidates everything on a change from an earlier naming, on null, or when memory holds another account's copies; only the first naming with no foreign copies keeps answers on screen (never stored) and emits `named` so reads reload.

**Consequences:** Not invalidating on null lets old-session calls persist after sign-out; invalidating on the first naming blanks the screen for no reason.

## A session read names its account before it publishes its answer and waits for the disk copies; claim() succeeds only when its naming raised the epoch exactly once, the claiming read is exempt only from that one event, and a nested naming started by the event wins

`claim`, `claiming`, `load` in `packages/device/src/device.ts`, `packages/device/src/vue.ts`.

**Context:** Watchers and loaders started by the naming event can name another account synchronously, inside the claim.

**Decision:** A session read names its account before it publishes its answer and waits for the disk copies; claim() succeeds only when its naming raised the epoch exactly once, the claiming read is exempt only from that one event, and a nested naming started by the event wins.

**Consequences:** Without the epoch+1 check and the `claiming` exemption, a session answer can be stored under an account that a nested event already replaced, or the session read restarts itself forever.

## claim() queues ensure() also for the account that is already named

`claim` in `packages/device/src/device.ts`.

**Context:** A session answer then repairs a disk reset that failed earlier for the same account.

**Decision:** claim() queues ensure() also for the account that is already named.

**Consequences:** After a failed reset the disk stays on the previous account until a different account is named.

## A value over the size cap or not JSON also deletes the older stored copy of that key, in memory and on the disk

`store` in `packages/device/src/device.ts`.

**Context:** The latest answer replaced the old one on screen, so the old copy is out of date.

**Decision:** A value over the size cap or not JSON also deletes the older stored copy of that key, in memory and on the disk.

**Consequences:** A reload shows an outdated copy that a newer answer replaced.

## open() resets versionSeen, because messages received before open() were compared with the default version

`open` in `packages/device/src/device.ts`.

**Context:** versionSeen drives the rule that an old build yields the disk to a newer build.

**Decision:** open() resets versionSeen, because messages received before open() were compared with the default version.

**Consequences:** A message before open() makes a tab of the new build think a newer build took the disk and stop writing.

## Device diagnostic codes are a published contract, each with a docs page at vitehub.dev/docs/device/diagnostics/<code>

`deviceErrors` in `packages/device/src/errors.ts`.

**Context:** Users and docs link to and match on the codes.

**Decision:** Device diagnostic codes are a published contract, each with a docs page at vitehub.dev/docs/device/diagnostics/<code>.

**Consequences:** Renaming a code breaks docs links and user code that matches on it.

## Bumping the database format deletes every object store, so a database of another format starts empty

`format` in `packages/device/src/indexeddb.ts`.

**Context:** onupgradeneeded recreates the stores instead of migrating them.

**Decision:** Bumping the database format deletes every object store, so a database of another format starts empty.

**Consequences:** A format bump silently discards every user's stored copies.

## The age index key is [storedAt, bytes, expiresAt], so trim reads age, size, and expiry with a key cursor and never loads the values

`ageIndex` in `packages/device/src/indexeddb.ts`.

**Context:** The trim runs inside every write over up to 5 MB of entries.

**Decision:** The age index key is [storedAt, bytes, expiresAt], so trim reads age, size, and expiry with a key cursor and never loads the values.

**Consequences:** Reordering the fields breaks the sort and the destructuring in trim(); dropping bytes or expiresAt forces trim to load every value.

## The database closes on versionchange

`openIndexedDB` in `packages/device/src/indexeddb.ts`.

**Context:** A newer format opened in another tab must not stay blocked until this tab closes.

**Decision:** The database closes on versionchange.

**Consequences:** A newer build's upgrade stays blocked while an old tab is open.

## Loaders get the key as an argument, each component user registers its own loader, a leaving user takes its loader away, and a read without users never loads

`Loader`, `load`, `release` in `packages/device/src/vue.ts`.

**Context:** A shared read keeps the last caller's loader, which can belong to a component that moved to another key.

**Decision:** Loaders get the key as an argument, each component user registers its own loader, a leaving user takes its loader away, and a read without users never loads.

**Consequences:** Loaders that read component state fetch the wrong key after a reset, and late answers of released reads replace newer ones.

## Reads that show a stored copy hold their loader call while a session read runs and nothing is named, then start at the naming or when the session reads end; the hold never decides what is stored, and a loader that restarts the session read holds the rest again

`held`, `startHeld`, `load` in `packages/device/src/vue.ts`.

**Context:** A call that starts before the naming is never stored, so the naming would start it over and the request would run twice.

**Decision:** Reads that show a stored copy hold their loader call while a session read runs and nothing is named, then start at the naming or when the session reads end; the hold never decides what is stored, and a loader that restarts the session read holds the rest again.

**Consequences:** Removing the hold doubles requests on reload; letting it decide storage or skipping the identifying recheck breaks the epoch rule or starts reads too early.

## During hydration a component renders the server output (default, idle) until it mounts; hydration is detected because Vue sets vnode.el before setup only when hydrating, and device events do not reload idle reads because they load on mount

`watchDevice`, `useRead` in `packages/device/src/vue.ts`.

**Context:** The shared read can already hold a stored copy or another component's answer, which would not match the server HTML.

**Decision:** During hydration a component renders the server output (default, idle) until it mounts; hydration is detected because Vue sets vnode.el before setup only when hydrating, and device events do not reload idle reads because they load on mount.

**Consequences:** Hydration mismatches, or loaders that run before mount during hydration.

## useStoredFetch() has an overload with `default: () => NoInfer<TData>`, so an explicit type argument types the default from the data

`useStoredFetch` in `packages/device/src/vue.ts`.

**Context:** Without NoInfer, `default: () => []` would infer its own type instead of `TData`.

**Decision:** useStoredFetch() has an overload with `default: () => NoInfer<TData>`, so an explicit type argument types the default from the data.

**Consequences:** Removing the overload makes `useStoredFetch<Project[]>(url, { default: () => [] })` fail to type the data.

## On the server, fetchKey() resolves URLs against a placeholder `http://localhost/` base

`fetchKey` in `packages/device/src/vue.ts`.

**Context:** The server has no document base URL, reads no storage, and only validates the key.

**Decision:** On the server, fetchKey() resolves URLs against a placeholder `http://localhost/` base.

**Consequences:** Removing the placeholder makes relative URLs throw during server render.

## useStoredFetch() throws on a non-2xx answer instead of returning its body

`fetchJSON` in `packages/device/src/vue.ts`.

**Context:** An error body must never be stored, and an error body like `{ user: null }` must not name an account.

**Decision:** useStoredFetch() throws on a non-2xx answer instead of returning its body.

**Consequences:** Returning the body stores error pages and can sign the person out of the device.
