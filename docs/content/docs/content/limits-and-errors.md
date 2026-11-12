---
title: Content limits and errors
description: Definition, path, collection, history, preview, and access limits for Content, and the errors they raise.
navigation.title: Limits and errors
navigation.order: 6
icon: i-lucide-circle-alert
---

## Definitions

- A project has one Content file. A second `content.ts` (or `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`) in any server directory fails route generation with `SOURCE_B0007`. The file must export `content`, else generation fails with `SOURCE_B0008`.
- Define `source` or `sources`, not both.
- `plugins` takes Comark Content plugins. A Comark parse plugin there throws `CONTENT_R0006`. Pass it in `markdown.plugins`.
- These throw `CONTENT_R0006`: `collections` without `workspace` or `extends: cms`, `extends` with `workspace`, a collection not made by `documents()`, or a collection named like a Source.
- `documents()` paths are relative globs with `*`, `**`, and `?` that end in one extension, such as `posts/**/*.md`. `path` can be a list of globs with that extension. An empty list, a repeated glob, mixed extensions, or a glob without a wildcard throws `CONTENT_R0006`. `content.resolve()` throws `CONTENT_R0008` for a path that is not a string. Every field is a Standard Schema validator.
- `defineContent()` needs `AsyncLocalStorage` from `node:async_hooks` in the runtime.

## Sources

- Public paths stay inside the Source root. ViteHub rejects absolute paths, `.` and `..` segments, Windows drive paths, and paths that start with `.git` or `.vitehub` (`CONTENT_R0001`).
- Two items with one public path fail the load (`CONTENT_R0003`).
- An item without `content` or `data` fails to parse (`CONTENT_R0002`).
- Raw media uses the newest Source revision that finished enumeration.
- The full-text index of `sqlite()` from `vite-hub/content/sqlite` lives in each server instance's memory. Each instance parses its Sources and builds the index on its first Content request. After `content.update()`, Comark's full-text search plugin does not see the change until the instance loads the Source again.
- A build ships the parsed documents of `glob()` and `files()` Sources in the server bundle, next to the files. With gzip they add a little more than the gzipped Markdown, so check the bundle size against the host limit, such as the Cloudflare Workers limit. Cloudflare Workers compile every module when an isolate starts, so the parsed pages also add to startup time: in local workerd, the 1.5 MB of the ViteHub docs added about 45 ms. See [Sources parsed at build](/docs/content/configure#sources-parsed-at-build).

## Collections

- Collections need a Workspace Store that keeps history, such as the Blob + Database Store. Other Stores fail on first use with `CONTENT_R0007`.
- The `cms` preset's [GitHub store](/docs/cms/configure#github-store) keeps history in Git. It has no schedules (`schedule()` throws `CONTENT_R0016`). With `publish: 'pr'`, `publish()` returns a pending result with a `pullRequest`, and documents stay pending until it merges. Digests are Git blob shas. Reads and writes use the GitHub API, so rate limits apply. Enable KV so new server instances share what they read ([Reads on serverless hosts](/docs/cms/configure#reads-on-serverless-hosts)).
- Content owns its Workspace's `draft`, `published`, and `schedules` refs. Other writers can commit to them, and the validation hook checks their files, but `revisions()` credits only commits made through Content.
- Only the draft accepts fields that fail validation. `status()` reads each draft file once per digest to count issues.
- Validation starts when `server/content.ts` loads, so an earlier writer, for example in a fresh server instance, is not checked. `publish()` validates every file, so invalid files never reach `published`.
- `list()` reads a revision's documents into memory. Content caches parsed documents by digest, and up to 32 MB of file text per runtime, so later revisions reread only changed files. Keep collections small enough for memory.
- Each read checks the `published` head with one Database query, so it sees publishes from other instances.
- `updatedAt` walks the ref back once per revision per runtime, with one Database query per 100 revisions plus one per outside commit. It stops at a cached answer, and reports `null` past 5,000 revisions.
- Frontmatter is YAML, and values must survive a JSON round trip. A `Date` is stored as an ISO string.
- A field without a Standard JSON Schema, such as an async Valibot schema, shows as `{}` in `schema`, and `defineContent()` warns once per field. Content converts synchronous Valibot schemas itself.
- `/api/content/**` serves published documents, or drafts with a valid [preview cookie](/docs/content/preview). Content has no write routes, and runtime methods do not call `authorize`.
- Without `authorize`, `content.can()` denies every action.
- The Store retains every revision. There is no pruning.
- [`vitehub content`](/docs/content/cli) reaches only a local Vite + Nitro Development Server. It cannot inspect or publish a deployed app.

## Preview

- `VITEHUB_CONTENT_KEY` signs preview tokens. Without it, preview works only when `NODE_ENV` is `development` or `test`, with a key that changes on restart.
- A token lives 60 seconds to 24 hours (default one hour) and previews every collection. It is not bound to a user, and the server cannot revoke one token early. Rotating the key ends all of them.
- Preview covers requests through Nitro 3, in Vite and in Nuxt 5. Elsewhere, wrap reads in `content.preview.run(event, callback)`.
- Nitro's response and function cache skips preview requests. A CDN cannot see the cookie, so make it skip its cache for preview requests. See [Caching](/docs/content/preview#caching).

## Sessions

- `content.sessions` needs the `vitehub_content_sessions` table from `contentSessionsSchema` in the Workspace history Database, or on the GitHub store, the Store's `database`. The `cms` preset sets both up. Without it, `content.sessions` throws `CONTENT_R0012`, and writes skip the lease check, looking again each minute.
- A session is present for 45 seconds after a report. A lease lasts 5 minutes after `acquire()`, a renewing report, or a save with `session`. It stops blocking others after 15 minutes without reported input. Times use the Database clock.
- Session tokens are 8 to 128 letters, digits, `-`, or `_`. User names keep their first 256 characters, images their first 2,048.
- `save()`, `remove()`, and `restore()` run one more Database query for the lease check, except with `editing: { lease: false }` or `lease: 'override'`. It runs once before the commit, so a lease taken during the commit does not stop that write.
- Workspace commits to the draft, such as `vitehub push` or raw history commits, check leases with one Database query per document in a collection with leases. Workspace `fs` writes to the working tree do not check leases.

## Errors

| Code | Cause | What to do |
| --- | --- | --- |
| `CONTENT_B0001` | The build cannot read how `server/content.ts` selects the `cms` preset, or an option is not valid. | Pass `extends: cms` or `extends: [cms, { ... }]` with string literal options. See [CMS errors](/docs/cms/limits-and-errors#errors). |
| `CONTENT_B0002` | Workspace, Database, or Blob is set to `false` in `vitehub()`, a Blob store or Database that the `cms` preset needs does not exist, or the Database choice is ambiguous. | Set the `vitehub()` setting or preset option that the message names. |
| `CONTENT_INVALID` | `publish()` or `schedule()` found a draft with field issues, `get()` read an invalid document on `published`, a writer put an invalid file outside the draft, or a file cannot be parsed as an object of fields. `save()` throws it only for input that cannot become a file. `details.issues` lists `{ field, path, message }`; from `publish()` and `schedule()`, `details.documents` names every invalid document. | Fix the listed fields, save, and publish again. |
| `WORKSPACE_CONFLICT` | `ifDigest` no longer matches the draft document, `ifHead` no longer matches the published head, or, on the GitHub store, a document that the draft changed also changed on the published branch (`details.ref` is `published`). `details` carry `ref`, `expected`, and `actual`. From `publish({ expect })`, a draft changed after review: `details` are `{ ref: 'draft', documents: [{ collection, id, expected, actual }] }`. | Read the document or head again and retry. After a `publish({ expect })` conflict, review the listed documents again. When `ref` is `published`, reloading the draft does not help: compare with `get(id, { ref: 'published' })` and save with `ifPublishedDigest`. |
| `CONTENT_LEASE_HELD` | Another session holds the edit lease of the document, from `save()`, `remove()`, or `restore()`, or from a Workspace commit to the draft such as `vitehub push`. `details` carry `collection`, `id`, and `holder: { user, since, expiresAt }`; a Workspace commit adds `documents` with every held document. The Console and `workspace.commit` return it as `409`. | Wait for the holder to finish, take the lease with `content.sessions.acquire({ takeover: true })`, or pass `lease: 'override'` (`--override-lease` for [`vitehub content edit`](/docs/content/cli#edit-leases) and `vitehub push`, `metadata: { lease: 'override' }` for `history.commit()`). See [Editing together](/docs/content/editing-together). |
| `CONTENT_NOT_FOUND` | `remove()`, `restore()`, or `publish({ ids })` named a document that does not exist, or `unschedule()` named a schedule that already ran or is gone. | Check the id, ref, or revision. |
| `CONTENT_R0004` | A Comark Source read a file that is not in its revision. | Refresh the instance. |
| `CONTENT_R0006` | A Content definition is invalid. | Fix `defineContent()` or `documents()`. |
| `CONTENT_R0007` | The collection Workspace has no retained history. | Use the Blob + Database Store. |
| `CONTENT_R0008` | An unknown collection, a bad document id or ref, bad call options, such as a malformed session token or a `lease` other than `'override'`, or `content.preview.enable()` without collections. | Use a defined collection, a relative id inside its path, and `draft` or `published`. Pass `maxAge` from 60 to 86400. |
| `CONTENT_R0009` | Bad `publish()` options, such as `ids` without `collection`, `expect` with `collection` or `ids`, an empty or repeated `expect` entry, or a bad digest. | Pass `collection` with `ids`, or `expect` alone with one entry per document, and `ifHead` as a revision id or `null`. |
| `CONTENT_R0010` | `content.preview.enable()` has no signing key outside development and tests, or `VITEHUB_CONTENT_KEY` is not 32 bytes. | Set `VITEHUB_CONTENT_KEY` to `openssl rand -base64 32` on each instance. |
| `CONTENT_R0011` | Bad `schedule()` options: `at` not in the future or without a time zone, a bad `expect`, every document already published as reviewed, or a document with a pending schedule. | Pass a future time with a zone, and `unschedule()` the old schedule first. See [Scheduling](/docs/content/scheduling). |
| `CONTENT_R0012` | `content.sessions` cannot reach its table. The Workspace history Database has no `vitehub_content_sessions` table, or the Store has no Database (use the Blob + Database Store, or the GitHub Store with a `database`). | Use the `cms` preset, or add `contentSessionsSchema` from `vite-hub/content/database` next to `workspaceHistorySchema`, then run `vitehub database generate` and `vitehub database migrate`. |
| `CONTENT_R0013` | A writer other than `publish()`, such as a raw history commit, deleted a document from `published`. | `remove()` it from the draft, then publish the deletion with `content.publish()`. |
| `CONTENT_R0014` | Bad [`vitehub content`](/docs/content/cli) arguments, such as a missing collection, `--id` without `--collection`, `schedule` without `--at`, or `edit` without `--file` or an interactive terminal. | Run the command with `--help`. |
| `CONTENT_R0016` | `schedule()` ran on the GitHub store, which keeps no schedules. | Use `content.publish()`, or the Blob + Database store. See [GitHub store](/docs/cms/configure#github-store). |
| `CONTENT_R0017` | `publish()` on the GitHub store with `publish: 'pr'` named a document that an open publish pull request covers. | Merge or close the named pull request, then publish again. See [Pull request mode](/docs/cms/configure#pull-request-mode). |
| `CONTENT_R0018` | SQLite WASM for `sqlite()` from `vite-hub/content/sqlite` could not start on Cloudflare Workers, usually because only a file other than `server/content.ts` imports it. | Import `sqlite` from `vite-hub/content/sqlite` in `server/content.ts`. See [Providers](/docs/content/configure#providers). |
| `CONTENT_UNDEFINED` | `vitehub content` found no default-exported `defineContent()` runtime. | Write `export default defineContent({ ... })` in `server/content.ts`. |
| `CONTENT_PUBLISH_UNCONFIRMED` | `vitehub content publish` or `schedule` ran without an interactive terminal or `--yes`. | Pass `--yes`, or `--dry-run` to only list changes. |
| `CONTENT_DEV_RUNTIME_UNAVAILABLE` | The Development Server does not run Nitro in the Vite process, as with Nuxt or plain Vite. | Run the commands against a Vite + Nitro app. |
