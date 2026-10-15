---
title: Content limits and errors
description: Definition, path, collection, history, and access limits for Content, and the errors they raise.
navigation.title: Limits and errors
navigation.order: 6
icon: i-lucide-circle-alert
---

## Definitions

- A project has one Content file. More than one `content.ts` (or `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`) across server directories fails route generation with `SOURCE_B0007`. The file must export `content`, or generation fails with `SOURCE_B0008`.
- Define either `source` or `sources`. Passing both throws.
- `collections` requires `workspace`. Every collection comes from `documents()`, and a collection name cannot match a Source name. Violations throw `CONTENT_R0006`.
- `documents()` paths are relative globs that use `*`, `**`, and `?`, and end with one extension, such as `posts/**/*.md`. Every field is a Standard Schema validator.
- `defineContent()` uses `AsyncLocalStorage` from `node:async_hooks`. The runtime must provide it.

## Sources

- Public paths must stay inside the Source root. ViteHub rejects absolute paths, `.` and `..` segments, Windows drive paths, and paths that start with `.git` or `.vitehub` (`CONTENT_R0001`).
- Two items with the same public path fail the load (`CONTENT_R0003`).
- An item without `content` or `data` fails to parse (`CONTENT_R0002`).
- Raw media uses the newest Source revision that finished enumeration.

## Collections

- Collections need a Workspace whose Store keeps retained history, such as the Blob + Database Store. Other Stores fail on first use with `CONTENT_R0007`.
- Content owns the `draft`, `published`, and `schedules` refs of its Workspace. Other writers can commit to them, and the validation hook checks their files, but `revisions()` attributes only commits made through Content.
- The draft accepts fields that fail validation; `published` and every other ref do not. `status()` reads every draft file once per digest to count issues.
- Validation is installed when `server/content.ts` loads. A writer that runs before that, for example in a fresh server instance, is not checked. `publish()` validates every file it publishes, so invalid files never reach `published`.
- `list()` reads every document of one revision into server memory. Content caches parsed documents by digest and up to 32 MB of file text per runtime, so later revisions reread only changed files. Keep collections to a size you can hold in memory.
- Content reads check the `published` head with one Database query per call, so they see publishes from other instances.
- `updatedAt` walks the ref back once per revision per runtime, with one Database query per 100 revisions plus one per commit made outside Content. A walk stops at an earlier cached answer, and after 5,000 revisions it reports `null` for older changes.
- Frontmatter is YAML and values must survive a JSON round trip. A `Date` is stored as an ISO string.
- A field without a Standard JSON Schema, such as a plain Valibot schema, appears as `{}` in `schema`, and `defineContent()` warns once per field. Wrap Valibot schemas in `toStandardJsonSchema()`.
- `/api/content/**` serves published documents only. Content has no write routes, and the runtime methods do not call `authorize`.
- Without `authorize`, `content.can()` denies every action.
- The Store retains every revision. There is no pruning.

## Sessions

- `content.sessions` needs the `vitehub_content_sessions` table from `contentSessionsSchema` in the Database of the Workspace history. Without it, `content.sessions` throws `CONTENT_R0012`, and writes skip the lease check for a minute at a time before they look again.
- A session is present for 45 seconds after a report. A lease lasts 5 minutes after `acquire()`, a renewing report, or a save with `session`, and stops blocking others after 15 minutes without reported input. Times use the Database clock.
- Session tokens are 8 to 128 letters, digits, `-`, or `_`. User names keep their first 256 characters and images their first 2,048.
- `save()`, `remove()`, and `restore()` run one extra Database query for the lease check, unless the collection has `editing: { lease: false }` or the write passes `lease: 'override'`. The check runs once before the commit, so a lease taken during the commit does not stop that write.
- Workspace writers that bypass Content, such as Workspace `fs` writes or raw history commits, do not check leases.

## Errors

| Code | Cause | What to do |
| --- | --- | --- |
| `CONTENT_INVALID` | `publish()` or `schedule()` found a draft with field issues, `get()` read an invalid document on `published`, a writer put an invalid file outside the draft, or a file cannot be parsed as an object of fields. `save()` throws it only for input that cannot become a file. `details.issues` lists `{ field, path, message }`; from `publish()` and `schedule()`, `details.documents` names every invalid document. | Fix the listed fields, save, and publish again. |
| `WORKSPACE_CONFLICT` | `ifDigest` no longer matches the draft document, or `ifHead` no longer matches the published head. `details` carry `ref`, `expected`, and `actual`. From `publish({ expect })`, a draft changed after review: `details` are `{ ref: 'draft', documents: [{ collection, id, expected, actual }] }`. | Read the document or head again and retry. After a `publish({ expect })` conflict, review the listed documents again. |
| `CONTENT_LEASE_HELD` | Another session holds the edit lease of the document, from `save()`, `remove()`, or `restore()`. `details` carry `collection`, `id`, and `holder: { user, since, expiresAt }`. The Console returns it as `409`. | Wait for the holder to finish, take the lease with `content.sessions.acquire({ takeover: true })`, or pass `lease: 'override'`. See [Editing together](/docs/content/editing-together). |
| `CONTENT_NOT_FOUND` | `remove()`, `restore()`, or `publish({ ids })` named a document that does not exist, or `unschedule()` named a schedule that already ran or is gone. | Check the id, ref, or revision. |
| `CONTENT_R0004` | A Comark Source read a file that is not in its revision. | Refresh the instance. |
| `CONTENT_R0005` | The Content handler received an unsupported request or body. | Send a Web or Node request. |
| `CONTENT_R0006` | A Content definition is invalid. | Fix `defineContent()` or `documents()`. |
| `CONTENT_R0007` | The collection Workspace has no retained history. | Use the Blob + Database Store. |
| `CONTENT_R0008` | An unknown collection, an invalid document id or ref, or invalid call options, such as a malformed session token or `lease` other than `'override'`. | Use a defined collection, a relative id inside its path, and `draft` or `published`. |
| `CONTENT_R0009` | Invalid `publish()` options, such as `ids` without `collection`, `expect` combined with `collection` or `ids`, an empty or repeated `expect` entry, or an invalid digest. | Pass `collection` with `ids`, or `expect` alone with one entry per document, and `ifHead` as a revision id or `null`. |
| `CONTENT_R0012` | `content.sessions` cannot reach its table: the Database of the Workspace history has no `vitehub_content_sessions` table, or the Workspace does not use the Blob + Database Store. | Add `contentSessionsSchema` from `vite-hub/content/database` to that Database next to `workspaceHistorySchema`, then run `vitehub db generate` and `vitehub db migrate`. |
| `CONTENT_R0013` | A writer other than `publish()` deleted a document from the `published` ref, such as a raw history commit. | Remove the document from the draft with `remove()`, then publish the deletion with `content.publish()`. |
| `CONTENT_R0011` | Invalid `schedule()` options: `at` not in the future or without a time zone, an invalid `expect`, every document already published as reviewed, or a document that already has a pending schedule. | Pass a future time with a zone, and `unschedule()` the existing schedule first. See [Scheduling](/docs/content/scheduling). |
