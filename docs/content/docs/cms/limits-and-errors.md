---
title: CMS limits and errors
description: Limits of the GitHub store, how to publish a document that changed on both sides, and the fix for each error code of the cms preset.
navigation.title: Limits and errors
navigation.order: 6
icon: i-lucide-circle-alert
---

The collections follow the [Content limits](/docs/content/limits-and-errors#collections) on both stores. This page lists what the `cms` preset adds.

## Limits

- The build reads the preset selection from `server/content.ts` without running it. Options must be string literals. See [Select the preset](/docs/cms/server-api#select-the-preset).
- The preset's Workspace name must not match a Workspace in `server/workspaces/`.
- On the GitHub store, `content.schedule()` throws `CONTENT_R0016`. Use `content.publish()`.
- On the GitHub store, a document that only `branch` changed or added is never touched by `publish()`: it is not reverted or deleted, and `status()` reports it as `published`. Draft sync brings such documents into the draft; until it runs, the draft keeps its old copy.
- On the GitHub store, ordinary Git or Workspace commits on the draft keep publish protection: Content recovers the nearest recorded bases and accounts for intervening document changes. If neither Content metadata nor the current published revision is found within 100 draft ancestors, saving and publishing refuse rather than guessing. Preserve those edits, recreate the draft from published, then reapply them through Content.
- On the GitHub store, up to about 600 unpublished changed documents fit in the 64 KiB commit metadata limit.
- On the GitHub store, each read and write calls the GitHub API, so GitHub rate limits apply. The head of a branch is cached for 5 seconds.

### Changed on both sides

On the GitHub store, a document that the draft changed and `branch` changed too (or deleted) cannot be published. `publish()` throws `WORKSPACE_CONFLICT` with `ref: 'published'` and the documents, and publishes nothing, not even the other documents you selected. Saving and syncing other documents can continue; publish them separately with `ids` or `expect`.

To publish the document:

1. Read the published version with `get(id, { ref: 'published' })`.
2. Reapply your edit.
3. Save with `ifPublishedDigest: published?.digest ?? null` and `ifDigest` set to the current draft digest.

This one save records the reviewed published version as the new base, even if the draft bytes stay the same. A blind save keeps the original base and cannot clear the conflict. `status()` marks such a document with `conflict` before anyone publishes. See [Status](/docs/content/server-api#status).

In the Console, the document list and the editor show **Changed on the site too**. The editor compares the site version with the draft and offers **Use the site version** or **Keep my draft**. Both save with `ifPublishedDigest`.

### Pull request reservations

With `publish: 'pr'`, separate runtime instances reserve the selected documents on GitHub before opening the pull request, so simultaneous publishes cannot open overlapping pull requests.

- A publish already opening for the same document returns `CONTENT_R0017`. Retry after it finishes.
- Reservations abandoned before pull request creation starts expire after five minutes.
- Once creation starts, a timeout, lost response, or server error keeps the reservation and publish branch: GitHub may still create the pull request after the client stops waiting. After five minutes, a retry checks that branch's open and closed pull requests to reconcile the attempt. Until GitHub exposes a result, overlapping publishes stay blocked.
- If no result ever appears, an administrator must confirm that the original request cannot still create a pull request before removing its reservation.
- Other documents are not held back. A pull request retargeted away from the published branch no longer counts as a pending publish.

## Errors

| Code | Cause | What to do |
| --- | --- | --- |
| `CONTENT_B0001` | The build cannot read the preset selection: `extends` is missing or built at runtime, the tuple is not `[cms, { ... }]`, an option is unknown, a value is not a string literal or is not valid for its option, or a GitHub option is used without `repo` or `store: 'github'`, or with `store: 'blob-database'`. | Pass `extends: cms` or `extends: [cms, { ... }]` with literal options that the message accepts. See [Option values](/docs/cms/server-api#option-values). |
| `CONTENT_R0006` | The same checks fail when `defineContent()` runs. | Fix the option that the message names. |
| `CONTENT_B0002` | The app lacks something the preset needs: Workspace, Database, or Blob (not with `store: 'github'`) is set to `false`, several Databases match and none is `default`, or the named Database or Blob store does not exist. | Follow the message. It names the `vitehub()` setting or the preset option to set. |
| `CONTENT_R0016` | `content.schedule()` ran on a Workspace on the GitHub store. | Use `content.publish()`, or the Blob + Database store. |
| `CONTENT_R0017` | `publish()` with `publish: 'pr'` named a document that an open publish pull request already covers. | Merge or close the pull request that the message names, then publish again. |
| `WORKSPACE_CONFLICT` | On the GitHub store, `publish()` named a document that the draft and `branch` both changed (`details.ref` is `published`). | Review the published version, then save with `ifPublishedDigest`. See [Changed on both sides](#changed-on-both-sides). |
| `WORKSPACE_R0072` | The GitHub store has no repository or no token at its first request. | Set `repo` or `VITEHUB_WORKSPACE_GITHUB_REPOSITORY`, and `VITEHUB_GITHUB_TOKEN`. |
| `WORKSPACE_B0003` | Another Workspace already uses the preset's Workspace name. | Rename one, or pass `[cms, { workspace }]`. |
| `DATABASE_B0010` | The Database Definition already lists the history tables. | Remove them from the Definition. See [Migrate from manual wiring](/docs/cms/configure#migrate-from-manual-wiring). |

[Content errors](/docs/content/limits-and-errors#errors) lists every other code that the collections raise, such as `CONTENT_INVALID` and `CONTENT_LEASE_HELD`.
