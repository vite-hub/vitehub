---
title: Content CLI
description: List, read, edit, publish, and schedule Content documents from the terminal, with field issues, edit leases, and pinned digests.
navigation.title: CLI
navigation.order: 5
icon: i-lucide-terminal-square
---

`vitehub content` reads, edits, publishes, and schedules the [document collections and singletons](/docs/content/configure#document-collections) of a running app. Start the app's Vite Development Server, then run the commands from another terminal. They call the app's `server/content.ts` inside the Nitro dev environment, so they read and write the same Workspace Store as the app.

```bash [Terminal]
pnpm vitehub content collections
pnpm vitehub content list posts
pnpm vitehub content show posts hello
pnpm vitehub content edit posts hello
pnpm vitehub content status
pnpm vitehub content diff posts hello
pnpm vitehub content publish --collection posts --id hello
pnpm vitehub content schedule --collection posts --id hello --at 2026-10-20T09:00:00+02:00
```

The namespace appears when the app has a Content file. The commands work only against a local Vite + Nitro Development Server. They do not reach a deployed app, and Nuxt and plain Vite hosts are not supported. To publish on a deployed stage, call [`content.publish()`](/docs/content/server-api#publish) from a route you protect with `content.can()`.

## Commands

| Command | Use it for |
| --- | --- |
| `vitehub content collections` | List each collection and singleton with its path, fields, and how many documents are in each state. |
| `vitehub content list <collection>` | List the documents of one collection with their state, title, and field issue count. |
| `vitehub content show <collection> [id]` | Print the stored file of one document and its field issues. |
| `vitehub content status [collection] [id]` | Print the state of every document, of one collection, or of one document, with field issues and schedules. |
| `vitehub content diff <collection> [id]` | Print a unified diff of one document from `published` to `draft`, frontmatter included. |
| `vitehub content revisions <collection> [id]` | List the revisions that saved, removed, restored, or published one document, newest first. |
| `vitehub content edit <collection> [id]` | Edit the draft of one document in your editor, or save it from a file. |
| `vitehub content publish` | Publish the listed draft documents in one revision, exactly as listed. |
| `vitehub content schedule --at <time>` | Publish the listed draft documents at a later time, exactly as listed. |
| `vitehub content scheduled [collection] [id]` | List pending, overdue, and failed schedules. |
| `vitehub content unschedule <schedule>` | Cancel a pending schedule, or dismiss a failed one. |
| `vitehub content sitemap` | Print the sitemap URLs of published documents. |

Omit the id for a [singleton](/docs/content/configure#singletons-and-data-files): `vitehub content edit settings` edits `settings.json`.

Every command accepts `--json`, `--url <url>` when Vite does not listen on `http://localhost:5173` (or set `VITEHUB_DEV_SERVER_URL`), and `--timeout <ms>`. Errors go to stderr, or into `{ "error": { "code", "message", "details"? } }` on stdout with `--json`. Failed commands exit with status 1.

## List and show

```txt [Output]
draft      broken   (1 issue)
changed    hello    Hello world
published  launch   Launch day
```

`list` reads the `draft` ref. Pass `--ref published` for the published documents. Each line holds the [state](/docs/content/server-api#status), the id, the value of the collection's [title field](/docs/content/configure#define-collections), and the number of field issues of the draft. A singleton shows its label. `--search <text>` matches the collection's search fields, `--limit` defaults to 50 and has a maximum of 100, and stderr prints the `--cursor` value for the next page.

`show` prints the stored file as written, frontmatter included, so it also works for a document whose fields no longer validate. It reads the `draft` ref unless you pass `--ref published`. The field issues of that version go to stderr:

```txt [Output]
posts/broken has 1 field issue on draft:
  title: Too small: expected string to have >=1 characters
```

`--json` prints `{ collection, id, path, ref, text, digest, issues?, status }`. Pass the `digest` to `edit --if-digest`.

## Edit

```bash [Terminal]
pnpm vitehub content edit posts hello
pnpm vitehub content edit posts hello --file ./hello.md --message "Fix the title"
cat settings.json | pnpm vitehub content edit settings --file -
```

Without `--file`, `edit` opens the draft in `$VISUAL` or `$EDITOR` (else `vi`). A document that does not exist yet starts from a template with every field. When you close the editor, the command saves the file to the `draft` ref with [`save()`](/docs/content/server-api#save-and-remove). If the file did not change, nothing is saved.

The save pins the draft digest that the editor opened. If someone saves the document while you edit, nothing is saved, and the command keeps your edit in a file and names it:

```txt [Output]
Nothing was saved. posts/hello changed after you opened it (draft is now 7be5d20c13fa).
Your edit is kept in /tmp/vitehub-content-x1/hello.md. Save it with `vitehub content edit posts hello --file /tmp/vitehub-content-x1/hello.md`.
```

`--file <path>` saves a file without an editor, and `--file -` reads standard input. It overwrites the draft unless you pass `--if-digest <digest>`. Without an interactive terminal, `edit` needs `--file`.

Drafts accept fields in progress. The command saves a draft with invalid fields and prints each [issue](/docs/content/configure#drafts-in-progress). `publish` and `schedule` refuse that document until you fix it:

```txt [Output]
Saved posts/hello to the draft as 82f83f5e822e.
The draft has 1 field issue. Publishing refuses it until they are fixed:
  title: Too small: expected string to have >=1 characters
```

### Edit leases

`edit` honours [edit leases](/docs/content/editing-together#writes-and-leases). While another session, such as a Console tab or a live room, holds the lease of the document, nothing is saved:

```txt [Output]
Nothing was saved. Ana holds the edit lease since 2026-10-15T09:12:03.000Z on posts/hello.
Wait until they finish, or pass --override-lease to save anyway.
```

With `--json`, the error is `CONTENT_LEASE_HELD` with `details.holder`. `--override-lease` saves with `lease: 'override'`.

## Status

```txt [Output]
published  posts/2026/kept
changed    posts/hello  (scheduled 2026-10-20T07:00:00.000Z)
draft      posts/new  (2 issues)
deleted    posts/old
```

Each line is a [`status()` state](/docs/content/server-api#status), `collection/id`, and notes: the field issue count of the draft and the schedule that publishes the document. `--json` prints `{ "documents": [{ "collection", "id", "state", "draft", "published", "issues"?, "schedule"? }] }`, where `draft` and `published` are the document digests on each ref, or `null`. A document that exists on neither ref fails with `CONTENT_NOT_FOUND`.

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

`revisions` reads the `draft` ref. Pass `--ref published` for publishes. Each line holds the revision id, its time, the Content action, and the message. `--limit` defaults to 20 and has a maximum of 100. When more revisions may exist, stderr prints the `--cursor` value for the next page. Pass a revision id to [`get()` or `restore()`](/docs/content/server-api#revisions) to read or restore that version. Revisions that the CLI writes carry `metadata.source: 'cli'`.

## Publish

```bash [Terminal]
pnpm vitehub content publish --dry-run
pnpm vitehub content publish --collection posts --id hello --id 2026/launch --message "Ship launch posts"
pnpm vitehub content publish --collection settings
pnpm vitehub content publish --yes --json
```

```txt [Output]
Publish 2 documents:
  add     posts/hello        4f1c2a9be07d
  update  posts/2026/launch  9a03d1c4e8b2
Publish? [y/N] y
Published 2 documents in revision 3f1c…:
  add     posts/hello
  update  posts/2026/launch
```

Without `--collection`, `publish` publishes every collection and singleton. `--id` selects documents of `--collection` and is repeatable. The command lists each pending change with the first 12 characters of its draft digest (`deleted` for a deletion), asks for confirmation, and then calls [`content.publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed) with those digests. Without an interactive terminal it fails with `CONTENT_PUBLISH_UNCONFIRMED` unless you pass `--yes`. `--dry-run` only lists the changes. `--json` prints `{ "dryRun", "revision", "documents" }`; in a dry run each document carries its full draft `digest` and its `issues` count.

`publish` publishes exactly the drafts it listed, also with `--yes`. If a draft is saved between the list and the publish, nothing is published and the command exits with status 1:

```txt [Output]
Nothing was published. 1 draft changed after you confirmed:
  posts/hello  draft is now 7be5d20c13fa (you confirmed 4f1c2a9be07d)
Review them with `vitehub content diff <collection> <id>`, then run the publish again.
```

With `--json`, the error is `WORKSPACE_CONFLICT` and `details.documents` lists `{ collection, id, expected, actual }` for each changed draft. When nothing differs from `published`, the command exits with status 0 and creates no revision.

A listed draft with field issues makes the whole publish fail, so the command does not ask. It names each issue:

```txt [Output]
Nothing was published. 1 draft has invalid fields:
  posts/broken
    title: Too small: expected string to have >=1 characters
Fix them with `vitehub content edit <collection> <id>`, then run the command again.
```

With `--json`, the error is `CONTENT_INVALID` and `details.documents` lists `{ collection, id, path, issues }`.

The CLI does not call `authorize`: anyone who can reach the local Development Server can publish, as with the [trusted runtime methods](/docs/content/server-api#collections). Publishing does not check edit leases, because it does not change drafts.

## Schedule

```bash [Terminal]
pnpm vitehub content schedule --collection posts --id hello --at 2026-10-20T09:00:00+02:00
pnpm vitehub content scheduled
pnpm vitehub content unschedule 3b9c6a1e-5f2d-4c8a-9e7b-1d2f3a4b5c6d
```

`schedule` selects and lists drafts like `publish`, asks for confirmation, and calls [`content.schedule({ at, expect })`](/docs/content/scheduling) with the listed digests. `--at` takes an ISO timestamp with a time zone in the future. A Schedule Definition that calls `content.publishDue()` publishes the documents at that time. A draft saved after the schedule makes the run fail and publish nothing.

```txt [Output]
pending  2026-10-20T07:00:00.000Z  3b9c6a1e-5f2d-4c8a-9e7b-1d2f3a4b5c6d  posts/hello
failed   2026-10-18T07:00:00.000Z  8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0  posts/launch
  WORKSPACE_CONFLICT: Content changed on the draft after it was reviewed, so publish() published nothing:
```

`scheduled` lists [pending, overdue, and failed](/docs/content/scheduling#statuses) schedules, earliest first. Pass a collection, a document, or `--status` to filter. `unschedule` cancels a pending schedule or dismisses a failed one. A schedule that already ran fails with `CONTENT_NOT_FOUND`.

## Sitemap

```bash [Terminal]
pnpm vitehub content sitemap
pnpm vitehub content sitemap --xml --site https://example.com
```

`sitemap` prints one line per published, indexable document of a collection with a [`url`](/docs/content/seo#document-urls): the URL and when it last changed. `--xml` prints the XML that `/sitemap.xml` serves. `--site` sets the origin; it defaults to `defineContent({ seo: { site } })`, else the URLs are paths.

## How it reaches storage

`vitehub content` follows the same path as the other runtime commands. The Content Vite plugin registers a guarded endpoint on the Development Server, and in `vite dev` adds a dev-only Nitro route that imports `server/content.ts`. The endpoint forwards each command into the Nitro dev environment, which owns the Workspace Store and its bindings. Production builds do not contain the route.

`vitehub inspect definitions --kind content` lists the Content file without starting a server.
