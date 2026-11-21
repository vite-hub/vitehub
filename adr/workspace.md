# Workspace decisions

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
