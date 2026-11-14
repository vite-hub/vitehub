---
title: Content, i18n, and Workspace commands
description: Edit and publish Content, move translations, run Workspace commands, sync a local folder, and read Workspace history with the vitehub CLI.
navigation.title: Content and Workspace
navigation.order: 6
navigation.group: Commands
icon: i-lucide-folder-git-2
---

These commands work on the documents and files of the app. Most of them call the dev server, or a deployed app with `--url`.

## Edit and publish Content

Start the dev server, then run `vitehub content` in another terminal. Each command runs a `content.*` [operation](/docs/console/operations) with the app's `server/content.ts`, so it sees the app's drafts and published documents.

```bash [Terminal]
pnpm vitehub content collections
pnpm vitehub content list posts
pnpm vitehub content edit posts hello
pnpm vitehub content diff posts hello
pnpm vitehub content publish --collection posts --id hello
pnpm vitehub content schedule --collection posts --id hello --at 2026-10-20T09:00:00+02:00
```

- `edit` opens the draft in `$EDITOR`, or saves `--file`, and prints the draft's field issues. While another session holds the edit lease, it fails with `CONTENT_LEASE_HELD`, unless you pass `--override-lease`.
- `publish` and `schedule` list the pending changes with their draft digests (content hashes), ask for confirmation, and pin exactly those digests. If a draft is saved in between, the command fails and nothing is published. `--yes` skips the prompt, and `--dry-run` only lists the changes. Without an interactive terminal, they need `--yes`.
- Omit the id for a singleton.

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. Without `--url`, it calls this project's dev server (see [Find the dev server](/docs/cli/operations#find-the-dev-server)). With `--url`, it calls a deployed app with the Console on, with the credentials in [Call a deployed app](/docs/cli/operations#call-a-deployed-app). See [Content CLI](/docs/content/cli) for each command's output.

## Check and move translations

`vitehub i18n status` reads `t`, `<Trans>`, `plural`, `select`, and `msg` in the code, and compares them with the records in `locales/<locale>/`. It prints, per locale, the number of messages, translated messages, missing messages, and unused records. It needs no dev server and changes no file.

```bash [Terminal]
pnpm vitehub i18n status --json
pnpm vitehub i18n export es --output es.po
pnpm vitehub i18n import es es.po
pnpm vitehub i18n prune --yes
```

`export` writes a PO file for Poedit or a translation service. `import` saves its translations as records. `prune` deletes the records of messages that the code no longer has. Without `--yes`, it only lists them. Read [Translate your first page](/docs/i18n/get-started) for the full flow.

## Run Workspace commands during development

Use `vitehub workspace dev` to run a command in a Workspace without an Agent.
Start the dev server, then run it in another terminal.

```bash [Terminal]
pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
pnpm vitehub workspace dev --timeout 180000 docs exec "npm run lint"
pnpm vitehub workspace dev --path guides --path examples docs exec pnpm test
```

The command runs through the Workspace dev endpoint of `hubWorkspace()` on the Compatible Vite Development Server.
ViteHub creates a Workspace Session, runs the command, prints stdout and stderr, and commits the session when the command succeeds.
Put options before the Workspace target, and `exec` before one-shot command args.
Repeat `--path <path>` to load only those paths into the session.
Without a command in an interactive terminal, the CLI opens a prompt for repeated commands.

```txt [Output]
Connected to docs at http://localhost:5173
> pnpm test
```

## Work on Workspace files in a local folder

`vitehub pull` and `vitehub push` keep a folder of the project in sync with one ref of a Workspace, as `git pull` and `git push` do with a branch. Edit the files in your editor, and edit the same ref in the Console. The first pull names the folder and the ref and writes `vitehub.lock`; commit that file. See [Work on a ref in a local folder](/docs/workspace/server-api#work-on-a-ref-in-a-local-folder).

```bash [Terminal]
pnpm vitehub pull site --dir content --ref draft --url https://docs.example.com
pnpm vitehub pull --dry-run
pnpm vitehub push --message "Fix the install guide"
```

Run `pnpm vitehub hooks install` once to check for conflicts before each commit and to push the checkout folders when you push the default branch. A push of another branch leaves the remote ref alone, so work in progress does not reach the shared draft. The Workspace push updates `vitehub.lock`, and Git cannot add it to a push that already started, so the hook stops that Git push. Commit `vitehub.lock` and any pulled files, then run `git push` again. Skip the hooks for one Git command with `--no-verify`.

## Read Workspace history during development

`vitehub workspace history`, `refs`, and `show` read a Workspace's [retained history](/docs/workspace/server-api#retained-folder-history): its refs, such as `draft` and `published`, and the revisions on each. Run them next to the dev server, or pass `--url <origin>` for a deployed app. They only read, and never commit or move a ref.

```bash [Terminal]
pnpm vitehub workspace history content
pnpm vitehub workspace history content --ref draft --limit 10
pnpm vitehub workspace refs content
pnpm vitehub workspace show content draft
pnpm vitehub workspace show content published posts/hello.md
pnpm vitehub workspace show content 9a97b4caf7ed04dd7d590ab9192ee21211375d0fb7652c586bd506049bd39f3a posts/hello.md
```

```txt [Output]
REVISION                                                          REF        CREATED AT                AUTHOR  FILES  MESSAGE
bc4cf2341f4244c405de80d58ff6b53b5855b27e22dfb9b61567c9cfc44a4f3d  draft      2026-10-15T12:12:47.744Z  maxi    2      Edit hello
9a97b4caf7ed04dd7d590ab9192ee21211375d0fb7652c586bd506049bd39f3a  published  2026-10-15T12:12:47.733Z  editor  1      Publish hello
c08f4415a5303b77a6a0e58436b885215950ed298e3e6cebbc85c18f2b97edb9  draft      2026-10-15T12:12:47.727Z  maxi    2      Save hello
8d104bde6b19e80361256ab8f6f0bfee81c2756210c864c5db1ea95a25e40d0f  main       2026-10-15T12:12:47.716Z  -       1      Start content
```

- `history <workspace>` lists revisions newest first. Without `--ref`, it merges all refs and shows the newest `--limit` revisions (default `20`, at most `100`). With `--ref <ref>`, it lists one ref and prints the `--cursor` of the next page.
- `refs <workspace>` lists each ref with its head revision.
- `show <workspace> <ref|revision> [path]` takes a ref name or full revision id. A ref name wins when both match. Without a path, it prints the revision and its files with size, media type, and SHA-256 digest. With a file path, it prints the file as it was then, so you can redirect it. A binary file prints a notice instead, and `--json` returns its bytes as `base64`. With a directory path, it lists the files under it.

`AUTHOR` is the revision `metadata.author`, or `-`. Times are ISO 8601 UTC. Blob + Database revision ids are SHA-256 digests of the revision manifest. Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. With `--json`, the CLI prints revision objects with `id`, `ref`, `parentId`, `createdAt`, `message`, `metadata`, `author`, `files`, and `bytes`, and `show` returns content as `utf8` text or `base64` bytes. Errors go to stderr, or to the JSON body with `--json`, with exit status 1.

A Workspace whose Store keeps no revisions fails with `WORKSPACE_R0069` and names the [Blob + Database Store](/docs/workspace/configure#blob-database-store), which keeps refs and revisions.

The commands are the `workspace.history`, `workspace.refs`, and `workspace.show` [operations](/docs/console/operations) of the Workspaces section. They run in the app's Nitro runtime, so they work on the dev server and on a deployed app. All three read, so `console.authorize` grants them with `workspaces` or `workspaces:read`.

