# Workspace decisions

## Batch new Source files without weakening replacement rollback

`materializeWorkspaceSourcesInternal` in `packages/workspace/src/sources/materialization.ts` and the batched write path in `packages/workspace/src/sources/file-ownership.ts`.

**Context:** Startup can write many new Source files. Replacing an existing file still needs its own checkpoint.

**Decision:** Batch only new paths under the Store mutation queue. On failure, remove only the files and ownership records created by the batch. Checkpoint replacements one at a time.

**Consequences:** A failed refresh can roll back without deleting files that another owner already held.

## Copy eligible Session trees with one archive

`extractSessionArchive` and `materializeWorkspace` in `packages/workspace/src/session/host.ts`.

**Context:** Each file write to a remote Session host is a separate operation, but the archive is built in memory.

**Decision:** Use one archive write and extraction for eligible trees. Keep individual writes for small or oversized trees and hosts that cannot extract the archive.

**Consequences:** Bulk copies save round trips without requiring every host to run `tar` or buffering an unbounded tree.

## Compare GitHub ref heads before deleting a branch

`deleteRef` in `packages/workspace/src/providers/github/history.ts`.

**Context:** GitHub's branch delete does not take a head condition.

**Decision:** Check `ifHead` immediately before deleting the branch.

**Consequences:** The check rejects a changed head that it observes, but cannot prevent a change between the check and the delete.

## Publish history only while verified blobs are still live

The commit path in `packages/workspace/src/storage/blob-database.ts` and the object catalog in `packages/workspace/src/storage/history-schema.ts`.

**Context:** Deleting a ref can remove bytes that a concurrent commit reuses. The digest alone does not identify the verified object generation.

**Decision:** Require the verified object keys to be live in the atomic database batch that advances the ref. Check other expected refs in that batch too. A negative catalog size queues a key for deletion; keys are legacy bare digests or digests with a generation suffix.

**Consequences:** When deletion races with a commit, the commit can register and upload the bytes again before it publishes a revision.
