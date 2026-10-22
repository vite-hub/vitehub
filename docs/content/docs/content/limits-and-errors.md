---
title: Content limits and errors
description: Definition, path, collection, history, preview, and access limits for Content, and the errors they raise.
navigation.title: Limits and errors
navigation.order: 6
icon: i-lucide-circle-alert
---

## Definitions

- A project has one Content file. More than one `content.ts` (or `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`) across server directories fails route generation with `SOURCE_B0007`. The file must export `content`, or generation fails with `SOURCE_B0008`.
- Define either `source` or `sources`. Passing both throws.
- `plugins` takes Comark Content plugins. A Comark parse plugin there throws `CONTENT_R0006`; pass it in `markdown.plugins`.
- `collections` requires `workspace` or `extends: cms`, and `extends` cannot be combined with `workspace`. Every collection comes from `documents()`, and a collection name cannot match a Source name. Violations throw `CONTENT_R0006`.
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
- A field without a Standard JSON Schema, such as an async Valibot schema, appears as `{}` in `schema`, and `defineContent()` warns once per field. Content converts synchronous Valibot schemas itself.
- `/api/content/**` serves published documents, or drafts to a request with a valid [preview cookie](/docs/content/preview). Content has no write routes, and the runtime methods do not call `authorize`.
- Without `authorize`, `content.can()` denies every action.
- The Store retains every revision. There is no pruning.
- [`vitehub content`](/docs/content/cli) reaches only a local Vite + Nitro Development Server. It cannot inspect or publish a deployed app.

## Preview

- Preview tokens are signed with `VITEHUB_CONTENT_KEY`. Without it, preview works only when `NODE_ENV` is `development` or `test`, with a key that changes on restart.
- A token lives from 60 seconds to 24 hours (default one hour) and previews every collection. It is not bound to a user, and the server cannot revoke one token before it expires. Rotating the key ends all of them.
- Preview scopes requests that go through Nitro, on Nitro 3 and on Nuxt 4 (Nitro 2). Elsewhere, wrap reads in `content.preview.run(event, callback)`.
- Nitro's response and function cache skips preview requests. A CDN cannot see the cookie, so configure it to bypass its cache for preview requests; see [Caching](/docs/content/preview#caching).

## Sessions

- `content.sessions` needs the `vitehub_content_sessions` table from `contentSessionsSchema` in the Database of the Workspace history. The `cms` preset adds it. Without it, `content.sessions` throws `CONTENT_R0012`, and writes skip the lease check for a minute at a time before they look again.
- A session is present for 45 seconds after a report. A lease lasts 5 minutes after `acquire()`, a renewing report, or a save with `session`, and stops blocking others after 15 minutes without reported input. Times use the Database clock.
- Session tokens are 8 to 128 letters, digits, `-`, or `_`. User names keep their first 256 characters and images their first 2,048.
- `save()`, `remove()`, and `restore()` run one extra Database query for the lease check, unless the collection has `editing: { lease: false }` or the write passes `lease: 'override'`. The check runs once before the commit, so a lease taken during the commit does not stop that write.
- Workspace writers that bypass Content, such as Workspace `fs` writes or raw history commits, do not check leases.

## Errors

| Code | Cause | What to do |
| --- | --- | --- |
| `CONTENT_B0001` | The build cannot read how `server/content.ts` selects the `cms` preset. | Pass `extends: cms` or `extends: [cms, { ... }]` with string literal options. See [CMS preset](/docs/content/cms-preset#errors). |
| `CONTENT_B0002` | Workspace, Database, or Blob is set to `false` in `vitehub()`, a Blob store or Database that the `cms` preset needs does not exist, or the Database choice is ambiguous. | Set the `vitehub()` setting or preset option that the message names. |
| `CONTENT_INVALID` | `publish()` or `schedule()` found a draft with field issues, `get()` read an invalid document on `published`, a writer put an invalid file outside the draft, or a file cannot be parsed as an object of fields. `save()` throws it only for input that cannot become a file. `details.issues` lists `{ field, path, message }`; from `publish()` and `schedule()`, `details.documents` names every invalid document. | Fix the listed fields, save, and publish again. |
| `WORKSPACE_CONFLICT` | `ifDigest` no longer matches the draft document, or `ifHead` no longer matches the published head. `details` carry `ref`, `expected`, and `actual`. From `publish({ expect })`, a draft changed after review: `details` are `{ ref: 'draft', documents: [{ collection, id, expected, actual }] }`. | Read the document or head again and retry. After a `publish({ expect })` conflict, review the listed documents again. |
| `CONTENT_LEASE_HELD` | Another session holds the edit lease of the document, from `save()`, `remove()`, or `restore()`. `details` carry `collection`, `id`, and `holder: { user, since, expiresAt }`. The Console returns it as `409`. | Wait for the holder to finish, take the lease with `content.sessions.acquire({ takeover: true })`, or pass `lease: 'override'` (`--override-lease` for [`vitehub content edit`](/docs/content/cli#edit-leases)). See [Editing together](/docs/content/editing-together). |
| `CONTENT_NOT_FOUND` | `remove()`, `restore()`, or `publish({ ids })` named a document that does not exist, or `unschedule()` named a schedule that already ran or is gone. | Check the id, ref, or revision. |
| `CONTENT_R0004` | A Comark Source read a file that is not in its revision. | Refresh the instance. |
| `CONTENT_R0005` | The Content handler received an unsupported request or body. | Send a Web or Node request. |
| `CONTENT_R0006` | A Content definition is invalid. | Fix `defineContent()` or `documents()`. |
| `CONTENT_R0007` | The collection Workspace has no retained history. | Use the Blob + Database Store. |
| `CONTENT_R0008` | An unknown collection, an invalid document id or ref, invalid call options, such as a malformed session token or `lease` other than `'override'`, or `content.preview.enable()` without collections. | Use a defined collection, a relative id inside its path, and `draft` or `published`. Pass `maxAge` from 60 to 86400. |
| `CONTENT_R0009` | Invalid `publish()` options, such as `ids` without `collection`, `expect` combined with `collection` or `ids`, an empty or repeated `expect` entry, or an invalid digest. | Pass `collection` with `ids`, or `expect` alone with one entry per document, and `ifHead` as a revision id or `null`. |
| `CONTENT_R0010` | `content.preview.enable()` has no signing key outside development and tests, or `VITEHUB_CONTENT_KEY` is not 32 bytes. | Set `VITEHUB_CONTENT_KEY` to `openssl rand -base64 32` on every instance. |
| `CONTENT_R0011` | Invalid `schedule()` options: `at` not in the future or without a time zone, an invalid `expect`, every document already published as reviewed, or a document that already has a pending schedule. | Pass a future time with a zone, and `unschedule()` the existing schedule first. See [Scheduling](/docs/content/scheduling). |
| `CONTENT_R0012` | `content.sessions` cannot reach its table: the Database of the Workspace history has no `vitehub_content_sessions` table, or the Workspace does not use the Blob + Database Store. | Use the `cms` preset, or add `contentSessionsSchema` from `vite-hub/content/database` to that Database next to `workspaceHistorySchema`, then run `vitehub db generate` and `vitehub db migrate`. |
| `CONTENT_R0013` | A writer other than `publish()` deleted a document from the `published` ref, such as a raw history commit. | Remove the document from the draft with `remove()`, then publish the deletion with `content.publish()`. |
| `CONTENT_R0014` | Invalid [`vitehub content`](/docs/content/cli) arguments, such as a missing collection, `--id` without `--collection`, `schedule` without `--at`, or `edit` without `--file` and without an interactive terminal. | Run the command with `--help`. |
| `CONTENT_UNDEFINED` | `vitehub content` reached a Content file that does not export a `defineContent()` runtime named `content`. | Export `content` from `server/content.ts`. |
| `CONTENT_PUBLISH_UNCONFIRMED` | `vitehub content publish` or `schedule` ran without an interactive terminal and without `--yes`. | Pass `--yes`, or `--dry-run` to only list the changes. |
| `CONTENT_DEV_RUNTIME_UNAVAILABLE` | The Development Server does not run Nitro in the Vite process, as with Nuxt or plain Vite. | Run the commands against a Vite + Nitro app. |
