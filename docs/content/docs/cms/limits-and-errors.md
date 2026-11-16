---
title: CMS limits and errors
description: Limits of the GitHub store, how to publish a document that changed on both sides, and the fix for each error code of the cms preset.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

Both stores follow the [Content limits](/docs/content/limits-and-errors#collections). This page lists what the `cms` preset adds.

## Limits

- The build reads the preset from `server/content.ts` without running it, so options must be string literals ([Select the preset](/docs/cms/server-api#select-the-preset)).
- The preset's Workspace name must not match a Workspace in `server/workspaces/`.

On the GitHub store:

- `content.schedule()` throws `CONTENT_R0016`. Use `content.publish()`.
- `publish()` never touches a document that only `branch` changed or added. It does not revert or delete it, and `status()` reports it as `published`. Draft sync brings it into the draft. Until then, the draft keeps its old copy.
- Plain Git or Workspace commits on the draft keep publish protection. Content finds the nearest recorded bases and counts the document changes made since. If it finds neither Content metadata nor the current published revision within 100 draft ancestors, save and publish refuse instead of guessing. Keep those edits, recreate the draft from published, then apply them again through Content.
- About 600 unpublished changed documents fit in the 64 KiB commit metadata limit.
- Reads and writes call the GitHub API, so GitHub rate limits apply. A branch head is cached for 5 seconds, then revalidated with its ETag. Enable KV so new server instances read history and trees from KV ([Reads on serverless hosts](/docs/cms/configure#reads-on-serverless-hosts)).

### Changed on both sides

On the GitHub store, you cannot publish a document that the draft changed and `branch` also changed or deleted. `publish()` throws `WORKSPACE_CONFLICT` with `ref: 'published'` and the documents. It publishes nothing, not even the other documents you picked. You can still save and sync other documents. Publish them separately with `ids` or `expect`.

To publish the document:

1. Read the published version with `get(id, { ref: 'published' })`.
2. Reapply your edit.
3. Save with `ifPublishedDigest: published?.digest ?? null` and `ifDigest` set to the current draft digest.

This save records the published version you reviewed as the new base, even if the draft bytes stay the same. A save without `ifPublishedDigest` keeps the old base and cannot clear the conflict. `status()` marks such a document with `conflict` before anyone publishes ([Status](/docs/content/server-api#status)).

In the Console, the document list and editor show **Changed on the site too**. The editor compares the site version with the draft and offers **Use the site version** or **Keep my draft**. Both save with `ifPublishedDigest`.

### Pull request reservations

With `publish: 'pr'`, each instance reserves the selected documents on GitHub before it opens the pull request. Two publishes at once cannot open overlapping pull requests.

- If a publish is already opening for the same document, you get `CONTENT_R0017`. Retry after it finishes.
- A reservation left before pull request creation starts expires after five minutes.
- After creation starts, a timeout, lost response, or server error keeps the reservation and publish branch, because GitHub may still create the pull request. After five minutes, a retry checks that branch's open and closed pull requests to settle the attempt. Overlapping publishes stay blocked until GitHub shows a result.
- If no result ever appears, an administrator must confirm that the first request cannot still create a pull request, then remove its reservation.
- Other documents are not held back. A pull request moved to a base other than the published branch no longer counts as a pending publish.

## Errors

| Code | Cause | What to do |
| --- | --- | --- |
| `CONTENT_B0001` | The build cannot read the preset: `extends` is missing or built at runtime, the tuple is not `[cms, { ... }]`, an option is unknown, a value is not a valid string literal, or a GitHub option is used without `repo` or `store: 'github'`, or with `store: 'blob-database'`. | Pass `extends: cms` or `extends: [cms, { ... }]` with literal options that the message accepts ([Option values](/docs/cms/server-api#option-values)). |
| `CONTENT_R0006` | The same checks fail when `defineContent()` runs. | Fix the option that the message names. |
| `CONTENT_B0002` | The app lacks something the preset needs: Workspace, Database, or Blob (not with `store: 'github'`) is `false`, several Databases match and none is `default`, or the named Database or Blob store does not exist. | The message names the `vitehub()` setting or preset option to set. |
| `CONTENT_R0016` | `content.schedule()` ran on a Workspace on the GitHub store. | Use `content.publish()`, or the Blob + Database store. |
| `CONTENT_R0017` | `publish()` with `publish: 'pr'` named a document that an open publish pull request already covers. | Merge or close the pull request in the message, then publish again. |
| `WORKSPACE_CONFLICT` | On the GitHub store, `publish()` named a document that the draft and `branch` both changed (`details.ref` is `published`). | Review the published version, then save with `ifPublishedDigest` ([Changed on both sides](#changed-on-both-sides)). |
| `WORKSPACE_R0072` | The GitHub store has no repository or no token at its first request. | Set `repo` or `VITEHUB_WORKSPACE_GITHUB_REPOSITORY`, and `VITEHUB_GITHUB_TOKEN`. |
| `WORKSPACE_B0003` | Another Workspace already uses the preset's Workspace name. | Rename one, or pass `[cms, { workspace }]`. |
| `DATABASE_DUPLICATE_TABLE` | The Database Definition already lists the history tables. | Remove them from the Definition ([Migrate from manual wiring](/docs/cms/configure#migrate-from-manual-wiring)). |

[Content errors](/docs/content/limits-and-errors#errors) lists the other codes, such as `CONTENT_INVALID` and `CONTENT_LEASE_HELD`.
