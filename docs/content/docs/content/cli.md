---
title: Content CLI
description: List collections, check document status, diff drafts against published documents, read revisions, and publish from the terminal.
navigation.title: CLI
navigation.order: 5
icon: i-lucide-terminal-square
---

`vitehub content` inspects and publishes the [document collections](/docs/content/configure#document-collections) of a running app. Start the app's Vite Development Server, then run the commands from another terminal. They call the app's `server/content.ts` inside the Nitro dev environment, so they read and write the same Workspace Store as the app.

```bash [Terminal]
pnpm vitehub content collections
pnpm vitehub content status
pnpm vitehub content status posts hello
pnpm vitehub content diff posts hello
pnpm vitehub content revisions posts hello --ref published
pnpm vitehub content publish --collection posts --id hello
```

The namespace appears when the app has a Content file. The commands work only against a local Vite + Nitro Development Server. They do not reach a deployed app, and Nuxt and plain Vite hosts are not supported. To publish on a deployed stage, call [`content.publish()`](/docs/content/server-api#publish) from a route you protect with `content.can()`.

## Commands

| Command | Use it for |
| --- | --- |
| `vitehub content collections` | List each collection with its path, fields, and how many documents are in each state. |
| `vitehub content status [collection] [id]` | Print the state of every document, of one collection, or of one document. |
| `vitehub content diff <collection> <id>` | Print a unified diff of one document from `published` to `draft`, frontmatter included. |
| `vitehub content revisions <collection> <id>` | List the revisions that saved, removed, restored, or published one document, newest first. |
| `vitehub content publish` | Publish draft documents in one revision. It asks for confirmation unless you pass `--yes`. |

Every command accepts `--json`, `--url <url>` when Vite does not listen on `http://localhost:5173` (or set `VITEHUB_DEV_SERVER_URL`), and `--timeout <ms>`. Errors go to stderr, or into `{ "error": { "code", "message", "details"? } }` on stdout with `--json`. Failed commands exit with status 1.

## Status

```txt [Output]
published  posts/2026/kept
changed    posts/hello
draft      posts/new
deleted    posts/old
```

Each line is a [`status()` state](/docs/content/server-api#status) and `collection/id`. `--json` prints `{ "documents": [{ "collection", "id", "state", "draft", "published" }] }`, where `draft` and `published` are the document digests on each ref, or `null`. A document that exists on neither ref fails with `CONTENT_NOT_FOUND`.

## Diff

```txt [Output]
--- published/posts/hello.md
+++ draft/posts/hello.md
@@ -1,5 +1,5 @@
 ---
-title: Hello
+title: Hello again
 ---
 
 Hi.
```

The diff compares the stored files, so it includes frontmatter keys without a field and works for documents that no longer validate. A document that is not published yet diffs from `/dev/null`, and a deleted one diffs to `/dev/null`. When both sides match, stdout stays empty and stderr says so. `--json` adds `path`, `state`, both raw texts with their digests, and the `diff` string.

## Revisions

`revisions` reads the `draft` ref. Pass `--ref published` for publishes. Each line holds the revision id, its time, the Content action, and the message. `--limit` defaults to 20 and has a maximum of 100. When more revisions may exist, stderr prints the `--cursor` value for the next page. Pass a revision id to [`get()` or `restore()`](/docs/content/server-api#revisions) to read or restore that version.

## Publish

```bash [Terminal]
pnpm vitehub content publish --dry-run
pnpm vitehub content publish --collection posts --id hello --id 2026/launch --message "Ship launch posts"
pnpm vitehub content publish --yes --json
```

```txt [Output]
Publish 2 documents:
  add     posts/hello
  update  posts/2026/launch
Publish? [y/N] y
Published 2 documents in revision 3f1c…:
  add     posts/hello
  update  posts/2026/launch
```

Without `--collection`, `publish` publishes every collection. `--id` selects documents of `--collection` and is repeatable. The command lists the pending changes, asks for confirmation, and then calls `content.publish()`. Without an interactive terminal it fails with `CONTENT_PUBLISH_UNCONFIRMED` unless you pass `--yes`. `--dry-run` only lists the changes. `--json` prints `{ "dryRun", "revision", "documents" }`.

`publish` copies the draft as it is when you confirm. A save between the list and the confirmation is published too. When nothing differs from `published`, the command exits with status 0 and creates no revision.

The CLI does not call `authorize`: anyone who can reach the local Development Server can publish, as with the [trusted runtime methods](/docs/content/server-api#collections).

## How it reaches storage

`vitehub content` follows the same path as the other runtime commands. The Content Vite plugin registers a guarded endpoint on the Development Server, and in `vite dev` adds a dev-only Nitro route that imports `server/content.ts`. The endpoint forwards each command into the Nitro dev environment, which owns the Workspace Store and its bindings. Production builds do not contain the route.

`vitehub inspect definitions --kind content` lists the Content file without starting a server.
