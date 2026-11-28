---
description: Recover from a stale Workspace digest or head, a Content publish conflict, or an unsupported conditional removal.
---

Read the file or ref again and apply your change to the new content. Retry with the new digest in `ifDigest` or the new head in `ifHead`. For a merge conflict or a publish that is in progress, follow the steps in the error message first.

Vercel Blob cannot remove a file conditionally. Use a Store that supports conditional removal to keep the `ifDigest` check. Removing the file without `ifDigest` deletes it even if it changed since you read it.

## Content and CMS

`ifDigest` can stop matching a draft document, or `ifHead` can stop matching the published head. Check `details.ref`, `details.expected`, and `details.actual`. If `publish({ expect })` reports `ref: 'draft'`, review the changed documents in `details.documents` again. Each entry has `collection`, `id`, `expected`, and `actual`.

On the GitHub Store, a document can change in both the draft and the published branch. If the error reports `ref: 'published'`, reloading the draft does not help. Compare with `get(id, { ref: 'published' })`, then save with `ifPublishedDigest`. See [Changed on both sides](/docs/cms/limits-and-errors#changed-on-both-sides).
