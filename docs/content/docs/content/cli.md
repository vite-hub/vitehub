---
title: Content CLI
description: List, read, edit, delete, restore, publish, and schedule Content documents from the terminal, with field issues, edit leases, and pinned digests.
navigation.title: CLI
navigation.order: 13
icon: i-lucide-terminal-square
---

`vitehub content` reads, edits, deletes, restores, publishes, and schedules the [collections and singletons](/docs/content/configure#document-collections) of a running app. Start the app's dev server, then run the commands in another terminal. Each command runs a `content.*` [operation](/docs/development/operations) with the app's `server/content.ts`, so it uses the same storage as the app.

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

The commands appear when the app has a Content file. Without `--url`, they call the running dev server. With `--url https://app.example.com`, they call a deployed app with the [Console](/docs/development/console) on, and [sign each call](/docs/development/console#sign-console-requests) with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`.

## Commands

| Command | Use it for |
| --- | --- |
| `vitehub content collections` | List collections and singletons with path, fields, and document count per state. |
| `vitehub content list <collection>` | List one collection's documents with state, title, and field issue count. |
| `vitehub content show <collection> [id]` | Print one document's stored file and field issues. |
| `vitehub content status [collection] [id]` | Print the state of all documents, one collection, or one document, with field issues and schedules. |
| `vitehub content diff <collection> [id]` | Print a unified diff of one document from `published` to `draft`, with frontmatter. |
| `vitehub content revisions <collection> [id]` | List the revisions that saved, removed, restored, or published one document, newest first. |
| `vitehub content edit <collection> [id]` | Edit the draft of one document in your editor, or save it from a file. |
| `vitehub content delete <collection> [id]` | Delete one document from the draft. The next publish removes it from the site. |
| `vitehub content restore <collection> [id] --revision <id>` | Save one document's version from an earlier revision as its draft. |
| `vitehub content publish` | Publish the listed drafts, exactly as listed, in one revision. |
| `vitehub content schedule --at <time>` | Publish the listed drafts, exactly as listed, later. |
| `vitehub content scheduled [collection] [id]` | List pending, overdue, and failed schedules. |
| `vitehub content unschedule <schedule>` | Cancel a pending schedule, or dismiss a failed one. |
| `vitehub content sitemap` | Print the sitemap URLs of published documents. |

Omit the id for a [singleton](/docs/content/configure#singletons-and-data-files): `vitehub content edit settings` edits `settings.json`.

Every command takes `--json`, `--url <url>`, and `--timeout <ms>`. Without `--url`, it finds this project's dev server through `.vitehub/dev-server.json` or `VITEHUB_DEV_SERVER_URL` (see [Run any operation](/docs/cli/inspect#run-any-operation)). Errors go to stderr. With `--json`, they go to stdout as `{ "error": { "code", "message", "details"? } }`. Failed commands exit with status 1.

## List and show

```txt [Output]
draft      broken   (1 issue)
changed    hello    Hello world
published  launch   Launch day
```

`list` reads the `draft` ref (the branch that holds drafts). Pass `--ref published` for published documents. Each line shows the [state](/docs/content/server-api#status), the id, the [title field](/docs/content/configure#define-collections) value, and the draft's field issue count. A singleton shows its label. `--search <text>` matches the search fields. `--limit` defaults to 50, maximum 100. Stderr prints the `--cursor` value for the next page.

`show` prints the stored file as written, with frontmatter, so it works even when fields no longer validate. It reads `draft` unless you pass `--ref published`. Field issues go to stderr:

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

Without `--file`, `edit` opens the draft in `$VISUAL` or `$EDITOR` (else `vi`). A new document starts from a template with every field. When you close the editor, it saves the file to `draft` with [`save()`](/docs/content/server-api#save-and-remove), unless the file did not change.

The save pins the draft digest you opened. If someone saves the document while you edit, nothing is saved. The command keeps your edit in a file and names it:

```txt [Output]
Nothing was saved. posts/hello changed after you opened it (draft is now 7be5d20c13fa).
Your edit is kept in /tmp/vitehub-content-x1/hello.md. Save it with `vitehub content edit posts hello --file /tmp/vitehub-content-x1/hello.md`.
```

`--file <path>` saves a file without an editor. `--file -` reads standard input. It overwrites the draft unless you pass `--if-digest <digest>`. Without an interactive terminal, `edit` needs `--file`.

Drafts accept unfinished fields. The command saves them and prints each [issue](/docs/content/configure#drafts-in-progress). `publish` and `schedule` refuse the document until you fix it:

```txt [Output]
Saved posts/hello to the draft as 82f83f5e822e.
The draft has 1 field issue. Publishing refuses it until they are fixed:
  title: Too small: expected string to have >=1 characters
```

### Edit leases

`edit` honours [edit leases](/docs/content/editing-together#writes-and-leases) (a lock that says who is editing). While another session, such as a Console tab or a live room, holds the lease, nothing is saved:

```txt [Output]
Nothing was saved. Ana holds the edit lease since 2026-10-15T09:12:03.000Z on posts/hello.
Wait until they finish, or pass --override-lease to write anyway.
```

With `--json`, the error is `CONTENT_LEASE_HELD` with `details.holder`. `--override-lease` saves with `lease: 'override'`. `rm` and `restore` honour leases too.

## Delete and restore

```bash [Terminal]
pnpm vitehub content delete posts hello
pnpm vitehub content revisions posts hello
pnpm vitehub content restore posts hello --revision 01JB8Z7Q4M3T5V2X9K6N8P1R0S
```

`rm` reads the draft, asks `Delete? [y/N]`, and deletes it pinned to the digest it read. If someone saves in between, nothing is deleted. `--yes` skips the prompt and is required without a terminal. The document stays on the site until you publish. `status` shows it as `deleted`, and `publish` lists it as a `delete`.

`restore` saves the `--revision` version as the draft and publishes nothing. It also brings back a deleted draft. Like `edit`, it fails if the draft changed after the read. Get revision ids from `vitehub content revisions`, with `--ref published` for a published version.

## Status

```txt [Output]
published  posts/2026/kept
changed    posts/hello  (scheduled 2026-10-20T07:00:00.000Z)
draft      posts/new  (2 issues)
deleted    posts/old
```

Each line is a [`status()` state](/docs/content/server-api#status), `collection/id`, the draft's field issue count, and its schedule. `--json` prints `{ "documents": [{ "collection", "id", "state", "draft", "published", "issues"?, "schedule"? }] }`, where `draft` and `published` are the digests on each ref, or `null`. A document on neither ref fails with `CONTENT_NOT_FOUND`.

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

The diff compares stored files, so it shows frontmatter keys without a field and works for invalid documents. An unpublished document diffs from `/dev/null`, a deleted one to `/dev/null`. When both sides match, stdout is empty and stderr says so. `--json` adds `path`, `state`, both raw texts with digests, and the `diff` string.

## Revisions

`revisions` reads `draft`. Pass `--ref published` for publishes. Each line shows the revision id, time, Content action, and message. `--limit` defaults to 20, maximum 100. When more may exist, stderr prints the `--cursor` for the next page. Pass a revision id to [`get()` or `restore()`](/docs/content/server-api#revisions) to read or restore it. CLI revisions have `metadata.source: 'cli'`.

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

Without `--collection`, `publish` publishes every collection and singleton. `--id` picks documents of `--collection` and is repeatable. The command lists each change with the first 12 characters of its draft digest (`deleted` for a deletion), asks you to confirm, then calls [`content.publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed) with those digests. Without an interactive terminal, it fails with `CONTENT_PUBLISH_UNCONFIRMED` unless you pass `--yes`. `--dry-run` only lists changes. `--json` prints `{ "dryRun", "revision", "documents" }`. In a dry run, each document has its full draft `digest` and `issues` count.

`publish` publishes exactly the drafts it listed, also with `--yes`. If a draft changes in between, nothing is published and the command exits with status 1:

```txt [Output]
Nothing was published. 1 draft changed after you confirmed:
  posts/hello  draft is now 7be5d20c13fa (you confirmed 4f1c2a9be07d)
Review them with `vitehub content diff <collection> <id>`, then run the publish again.
```

With `--json`, the error is `WORKSPACE_CONFLICT`, and `details.documents` lists `{ collection, id, expected, actual }` per changed draft. When nothing differs from `published`, it exits with status 0 and makes no revision.

One draft with field issues fails the whole publish, so the command does not ask. It names each issue:

```txt [Output]
Nothing was published. 1 draft has invalid fields:
  posts/broken
    title: Too small: expected string to have >=1 characters
Fix them with `vitehub content edit <collection> <id>`, then run the command again.
```

With `--json`, the error is `CONTENT_INVALID` and `details.documents` lists `{ collection, id, path, issues }`.

The operations call `content.can()` with the user of the call: the person that the Console signed, or no user for the CLI. One exception: under `vite dev` without signed calls (`local` access, or `console: { auth: false }`), the CLI has no user and skips the policy. This applies only to a dev server, which serves only loopback requests (`localhost`, `127.0.0.1`, `[::1]`). A deployed app always applies `authorize`. Publishing does not check edit leases, because it does not change drafts.

## Schedule

```bash [Terminal]
pnpm vitehub content schedule --collection posts --id hello --at 2026-10-20T09:00:00+02:00
pnpm vitehub content scheduled
pnpm vitehub content unschedule 3b9c6a1e-5f2d-4c8a-9e7b-1d2f3a4b5c6d
```

`schedule` picks and lists drafts like `publish`, asks you to confirm, and calls [`content.schedule({ at, expect })`](/docs/content/scheduling) with the listed digests. `--at` takes a future ISO timestamp with a time zone. A Schedule Definition that calls `content.publishDue()` publishes at that time. If a draft is saved after scheduling, the run fails and publishes nothing.

```txt [Output]
pending  2026-10-20T07:00:00.000Z  3b9c6a1e-5f2d-4c8a-9e7b-1d2f3a4b5c6d  posts/hello
failed   2026-10-18T07:00:00.000Z  8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0  posts/launch
  WORKSPACE_CONFLICT: Content changed on the draft after it was reviewed, so publish() published nothing:
```

`scheduled` lists [pending, overdue, and failed](/docs/content/scheduling#statuses) schedules, earliest first. Filter by collection, document, or `--status`. `unschedule` cancels a pending schedule or dismisses a failed one. For a schedule that already ran, it fails with `CONTENT_NOT_FOUND`.

## Sitemap

```bash [Terminal]
pnpm vitehub content sitemap
pnpm vitehub content sitemap --xml --site https://example.com
```

`sitemap` prints the URL and last change time of each published, indexable document in a collection with a [`url`](/docs/content/seo#document-urls). `--xml` prints the `/sitemap.xml` XML. `--site` sets the origin. It defaults to `defineContent({ seo: { site } })`, else URLs are paths.

## How it reaches storage

`vitehub content` sends each `content.*` call to `POST /_vitehub/rpc`, the same route the Console uses. The app plugin `@vite-hub/content` contributes the `content.*` operations. The Console editor, the CLI, and agents run the same code. See [Operations](/docs/development/operations).

`vitehub inspect definitions --kind content` lists the Content file without starting a server.
