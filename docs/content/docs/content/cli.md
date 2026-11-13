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
| `vitehub content head [source]` | Show the commit that each `github()` Source serves, and what holds it back. |
| `vitehub content advance [source]` | Move the head to the latest commit of the branch when every document parses and `check` finds no error. |
| `vitehub content pin <sha> [source]` | Serve one commit until `unpin`, for example to roll back. |
| `vitehub content unpin [source]` | Remove the pin and move to the latest valid commit. |
| `vitehub content check [source]` | Check frontmatter, links, titles, and descriptions. With `--dir`, check a folder without an app. |

Omit the id for a [singleton](/docs/content/configure#singletons-and-data-files): `vitehub content edit settings` edits `settings.json`.

Every command takes `--json`, `--url <url>`, and `--timeout <ms>`. Without `--url`, it finds this project's dev server through `.vitehub/dev-server.json` or `VITEHUB_DEV_SERVER_URL` (see [Run any operation](/docs/development/cli#run-any-operation)). Errors go to stderr. With `--json`, they go to stdout as `{ "error": { "code", "message", "details"? } }`. Failed commands exit with status 1.

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

## GitHub Source heads

A `github()` Source with a GitHub token and a KV store serves one validated commit, the head. These commands call [`content.sources`](https://github.com/vite-hub/vitehub/tree/main/packages/content#live-github-sources) in the app, so they read and move the same head as the app.

```bash [Terminal]
pnpm vitehub content head
pnpm vitehub content advance docs
pnpm vitehub content pin 9d1c4e2a7b3f5c8d0e6a1b4f7c2d9e3a5b8f0c1d docs
pnpm vitehub content unpin docs
```

```txt [Output]
docs stays on 978e88bf21f94b93237cfa6e11b6e1277758dc61.
docs
  Head:      978e88bf21f94b93237cfa6e11b6e1277758dc61 on main, moved 2026-11-11T12:38:12.512Z
  Checked:   2026-11-11T12:38:12.525Z
  Rejected:  062822c8aa1dc2530d98426a6e9f40b856f75579 at 2026-11-11T12:38:12.525Z
  CONTENT_R0019: Commit 062822c8aa1dc2530d98426a6e9f40b856f75579 of Content source "docs" failed validation, so Content keeps commit 978e88bf21f94b93237cfa6e11b6e1277758dc61: broken.md: unexpected end of the stream within a flow collection (1:17)
  Fix: Fix the document in the repository and push a new commit, then run `vitehub content advance` or call `content.sources.advance()`. `vitehub content head` and `content.sources.head()` show the rejected commit and the reason.
```

`head` without a name shows every `github()` Source. The others take the Source name, and need it only when the app has more than one `github()` Source. Each head shows the commit, the branch, the pin, the last branch check, the rejected commit, and the last [push webhook](https://github.com/vite-hub/vitehub/tree/main/packages/content#github-push-webhook) delivery. When the head does not follow the branch, it shows the diagnostic and its fix:

| Code | Why |
| --- | --- |
| [`CONTENT_R0020`](/docs/content/diagnostics/content_r0020) | The Source has no GitHub token, so it has no head. |
| [`CONTENT_R0021`](/docs/content/diagnostics/content_r0021) | The app has no KV store, so the Source has no head. |
| [`CONTENT_R0019`](/docs/content/diagnostics/content_r0019) | The newest commit has a document that does not parse. The head stays on the last valid commit. |
| [`CONTENT_R0035`](/docs/content/diagnostics/content_r0035) | GitHub answered 403 or 429 to the branch lookup, as it does when the rate limit is hit. The head did not move. This server instance shows it until a lookup succeeds. |

`advance` and `unpin` exit with status 1 when the head is held back, so a CI step fails on a broken push. A pinned head does not move and exits with status 0. `pin` needs the full 40-character SHA and checks that every document of the commit parses. `--json` prints the [`ContentSourceHead`](https://github.com/vite-hub/vitehub/tree/main/packages/content#live-github-sources), with the diagnostic in `diagnostic: { code, message, fix }`. `head --json` prints `{ "heads": [...] }`.

`head` needs the `content` section of the Console access, read-only is enough. `advance`, `pin`, and `unpin` need the whole section. `defineContent({ authorize })` does not apply, because Sources are read-only and public.

## Check

```bash [Terminal]
pnpm vitehub content check
pnpm vitehub content check docs --sha 9d1c4e2a7b3f5c8d0e6a1b4f7c2d9e3a5b8f0c1d
pnpm vitehub content check --dir content --site https://acme.dev --ignore "/learn" --title-template "%s · Acme"
```

```txt [Output]
docs/kv/configure.md:41  error  CONTENT_R0062  /docs/kv/configure links to /docs/kv/drivers, which is no page of Source "docs". Fix the link, or add the path to `check.ignoreLinks` when another route serves it.
docs/kv/index.md:2  warning  CONTENT_R0065  /docs/kv has a title of 2 characters, "KV". Keep it between 10 and 60, with `seo.title` when the heading must stay.

357 pages in docs: 1 error, 1 warning.
```

`check` reads the parsed documents, not built HTML, and makes no network calls. A `github()` Source is checked at `--sha`, or at the latest commit of its branch. The head does not move. `advance` runs the same error rules before it moves a head.

Links can target pages and headings in any configured Source. A check of one Source and a head change use the published heads of the other Sources, or their branch commits when no head exists. A check of all Sources uses their checked commits. Pages removed from a checked commit cannot resolve against its previous head.

| Code | Severity | Finds |
| --- | --- | --- |
| [`CONTENT_R0060`](/docs/content/diagnostics/content_r0060) | error | A document that does not parse. |
| [`CONTENT_R0061`](/docs/content/diagnostics/content_r0061) | error | Frontmatter that does not match the Source `schema`. |
| [`CONTENT_R0062`](/docs/content/diagnostics/content_r0062) | error | A link to a missing page below a first path segment that holds pages, such as `/docs/kvv`. |
| [`CONTENT_R0063`](/docs/content/diagnostics/content_r0063) | warning | A link to a path that no page serves, such as `/learn`. Another route may serve it. |
| [`CONTENT_R0064`](/docs/content/diagnostics/content_r0064) | warning | A link to a heading that the target page does not have. |
| [`CONTENT_R0065`](/docs/content/diagnostics/content_r0065) | warning | No title, or a title outside 10 to 60 characters. |
| [`CONTENT_R0066`](/docs/content/diagnostics/content_r0066) | warning | No description, or one outside 70 to 160 characters. |
| [`CONTENT_R0067`](/docs/content/diagnostics/content_r0067) | warning | Pages with the same title or description. |
| [`CONTENT_R0068`](/docs/content/diagnostics/content_r0068) | warning | A heading that skips a level. |

Warnings do not hold a head back. Errors do, and `check` exits with status 1 on them. Against the app, the options come from [`defineContent({ check })`](https://github.com/vite-hub/vitehub/tree/main/packages/content#check-documents). With `--dir`, `check` needs no app, so a CI step can run it on a content pull request. It parses the folder as one Source with the default Content Markdown, and these options replace the app config:

| Option | Use it for |
| --- | --- |
| `--page-url <pattern>` | The page URL of each document, such as `/blog/:id`. Defaults to the document path. |
| `--schema <file>` | A JSON Schema file that the frontmatter must match. |
| `--site <url>` | The site origin. Absolute links to it are checked too. |
| `--ignore <path>` | A link target that another route serves: a path or a glob such as `/docs/*/diagnostics/**`. Repeatable. |
| `--title-template <pattern>` | The `<title>` pattern, such as `%s · Acme`, for the title length rule. |

`--json` prints `{ ok, errors, warnings, sources, findings }`. Each finding has `source`, `path`, `url`, `line`, `rule`, `code`, `severity`, and `message`. `check` against the app needs `content:read`.

## How it reaches storage

`vitehub content` sends each `content.*` call to `POST /_vitehub/rpc`, the same route the Console uses. The app plugin `@vite-hub/content` contributes the `content.*` operations. The Console editor, the CLI, and agents run the same code. See [Operations](/docs/development/operations).

`vitehub inspect definitions --kind content` lists the Content file without starting a server.
