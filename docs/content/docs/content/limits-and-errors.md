---
title: Content limits and errors
description: Definition, path, collection, history, and access limits for Content, and the errors they raise.
navigation.title: Limits and errors
navigation.order: 5
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
- Content owns the `draft` and `published` refs of its Workspace. Other writers can commit to them, and the validation hook checks their files, but `revisions()` attributes only commits made through Content.
- Validation is installed when `server/content.ts` loads. A writer that runs before that, for example in a fresh server instance, is not checked. `publish()` validates every file it publishes, so invalid files never reach `published`.
- `list()` reads every document of one revision into server memory. Content caches parsed documents by digest and up to 32 MB of file text per runtime, so later revisions reread only changed files. Keep collections to a size you can hold in memory.
- Content reads check the `published` head with one Database query per call, so they see publishes from other instances.
- `updatedAt` walks the ref back once per revision per runtime, with one Database query per 100 revisions plus one per commit made outside Content. A walk stops at an earlier cached answer, and after 5,000 revisions it reports `null` for older changes.
- Frontmatter is YAML and values must survive a JSON round trip. A `Date` is stored as an ISO string.
- A field without a Standard JSON Schema, such as a plain Valibot schema, appears as `{}` in `schema`, and `defineContent()` warns once per field. Wrap Valibot schemas in `toStandardJsonSchema()`.
- `/api/content/**` serves published documents only. Content has no write routes, and the runtime methods do not call `authorize`.
- Without `authorize`, `content.can()` denies every action.
- The Store retains every revision. There is no pruning.

## Errors

| Code | Cause | What to do |
| --- | --- | --- |
| `CONTENT_INVALID` | A document failed its fields, from `save()`, `restore()`, `get()`, `publish()`, or any Workspace writer. `details.issues` lists `{ field, path, message }`. | Fix the listed fields. |
| `WORKSPACE_CONFLICT` | `ifDigest` no longer matches the draft document, or `ifHead` no longer matches the published head. `details` carry `ref`, `expected`, and `actual`. From `publish({ expect })`, a draft changed after review: `details` are `{ ref: 'draft', documents: [{ collection, id, expected, actual }] }`. | Read the document or head again and retry. After a `publish({ expect })` conflict, review the listed documents again. |
| `CONTENT_NOT_FOUND` | `remove()`, `restore()`, or `publish({ ids })` named a document that does not exist. | Check the id, ref, or revision. |
| `CONTENT_R0004` | A Comark Source read a file that is not in its revision. | Refresh the instance. |
| `CONTENT_R0005` | The Content handler received an unsupported request or body. | Send a Web or Node request. |
| `CONTENT_R0006` | A Content definition is invalid. | Fix `defineContent()` or `documents()`. |
| `CONTENT_R0007` | The collection Workspace has no retained history. | Use the Blob + Database Store. |
| `CONTENT_R0008` | An unknown collection, an invalid document id or ref, or invalid call options. | Use a defined collection, a relative id inside its path, and `draft` or `published`. |
| `CONTENT_R0009` | Invalid `publish()` options, such as `ids` without `collection`, `expect` combined with `collection` or `ids`, an empty or repeated `expect` entry, or an invalid digest. | Pass `collection` with `ids`, or `expect` alone with one entry per document, and `ifHead` as a revision id or `null`. |
