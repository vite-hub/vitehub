---
title: Content, i18n, and Workspace commands
description: Edit and publish Content, move translations, run Workspace commands, sync a local folder, and read Workspace history with the vitehub CLI.
navigation.title: Content and Workspace
navigation.order: 6
navigation.group: Commands
icon: i-lucide-folder-git-2
---

These commands let you edit the documents and files of your app from a terminal and your own editor. Most of them call the dev server, or a deployed app with `--url`.

## Edit and publish Content

Start the dev server, then run `vitehub content` in another terminal. It works with the app's `server/content.ts`, so it sees the same drafts and published documents as the app.

```bash [Terminal]
pnpm vitehub content collections
pnpm vitehub content list posts
pnpm vitehub content edit posts hello
pnpm vitehub content diff posts hello
pnpm vitehub content publish --collection posts --id hello
pnpm vitehub content schedule --collection posts --id hello --at 2026-10-20T09:00:00+02:00
```

`edit` opens the draft in `$EDITOR`, or saves `--file`, and fails with `CONTENT_LEASE_HELD` while another session holds the edit lease, unless you pass `--override-lease`. `publish` and `schedule` list the pending changes, ask for confirmation, and pin the draft digests (content hashes) they showed, so a draft saved in between fails the command and nothing is published. `--yes` skips the question and is required without a terminal, and `--dry-run` only lists the changes. Omit the id for a singleton.

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. Without `--url`, it calls this project's dev server, as [Find the dev server](/docs/cli/operations#find-the-dev-server) explains. With `--url`, it calls a deployed app with the Console on, as [Call a deployed app](/docs/cli/operations#call-a-deployed-app) describes. [Content CLI](/docs/content/cli) covers each command and its output.

## Check and move translations

`vitehub i18n status` tells you how far each locale is translated. It reads `t`, `<Trans>`, `plural`, `select`, and `msg` in the code and compares them with the records in `locales/<locale>/`.

```bash [Terminal]
pnpm vitehub i18n status --json
pnpm vitehub i18n export es --output es.po
pnpm vitehub i18n import es es.po
pnpm vitehub i18n prune --yes
```

`status` prints the messages, translated, missing, and unused records per locale. It needs no dev server and changes no file. `export` writes a PO file for Poedit or a translation service, and `import` saves its translations as records. `prune` deletes the records of messages the code no longer has, and only lists them without `--yes`. [Translate your first page](/docs/i18n/get-started) walks through the full flow.

## Run Workspace commands during development

`vitehub workspace dev` runs a command in a Workspace without an Agent. Start the dev server, then run it in another terminal.

```bash [Terminal]
pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
pnpm vitehub workspace dev --timeout 180000 docs exec "npm run lint"
pnpm vitehub workspace dev --path guides --path examples docs exec pnpm test
```

```txt [Output]
Connected to docs at http://localhost:5173
> pnpm test
```

The command runs in a Workspace Session on the dev server, prints stdout and stderr, and commits the session when it succeeds. Put options before the Workspace name and `exec` before the command, and repeat `--path <path>` to load only those paths. Without a command, an interactive terminal opens a prompt.

## Work on Workspace files in a local folder

`vitehub pull` and `vitehub push` keep a project folder in sync with one ref of a Workspace, as `git pull` and `git push` do with a branch. You can edit the files in your editor and the same ref in the Console.

```bash [Terminal]
pnpm vitehub pull site --dir content --ref draft --url https://docs.example.com
pnpm vitehub pull --dry-run
pnpm vitehub push --message "Fix the install guide"
```

The first pull names the folder and the ref and writes `vitehub.lock`. Commit that file.

Run `pnpm vitehub hooks install` once to check for conflicts before each commit and to push the checkout folders when you push the default branch. Other branches leave the remote ref alone, so work in progress stays out of the shared draft. When the Workspace push changes `vitehub.lock` or pulls files, the hook stops the Git push: commit them, then run `git push` again. `--no-verify` skips the hooks for one Git command. [Work on a ref in a local folder](/docs/workspace/server-api#work-on-a-ref-in-a-local-folder) explains the hooks in full.

## Read Workspace history during development

`vitehub workspace history`, `refs`, and `show` read a Workspace's [retained history](/docs/workspace/server-api#retained-folder-history): its refs, such as `draft` and `published`, and the revisions on each. They only read, and never commit or move a ref.

```bash [Terminal]
pnpm vitehub workspace history content
pnpm vitehub workspace history content --ref draft --limit 10
pnpm vitehub workspace refs content
pnpm vitehub workspace show content published posts/hello.md
```

```txt [Output]
REVISION                                                          REF        CREATED AT                AUTHOR  FILES  MESSAGE
bc4cf2341f4244c405de80d58ff6b53b5855b27e22dfb9b61567c9cfc44a4f3d  draft      2026-10-15T12:12:47.744Z  maxi    2      Edit hello
9a97b4caf7ed04dd7d590ab9192ee21211375d0fb7652c586bd506049bd39f3a  published  2026-10-15T12:12:47.733Z  editor  1      Publish hello
c08f4415a5303b77a6a0e58436b885215950ed298e3e6cebbc85c18f2b97edb9  draft      2026-10-15T12:12:47.727Z  maxi    2      Save hello
8d104bde6b19e80361256ab8f6f0bfee81c2756210c864c5db1ea95a25e40d0f  main       2026-10-15T12:12:47.716Z  -       1      Start content
```

| Command | What it does |
| --- | --- |
| `history <workspace>` | Lists revisions newest first, all refs merged, up to `--limit` (default `20`, at most `100`). With `--ref <ref>`, it lists one ref and prints the `--cursor` of the next page. |
| `refs <workspace>` | Lists each ref with its head revision. |
| `show <workspace> <ref\|revision> [path]` | Takes a ref name or a full revision id, and the ref name wins when both match. Without a path, it prints the revision and its files with size, media type, and SHA-256 digest. A file path prints the file as it was, so you can redirect it, and a directory path lists the files under it. A binary file prints a notice, and `--json` returns its bytes as `base64`. |

`AUTHOR` is the revision's `metadata.author`, or `-`, and times are ISO 8601 UTC. Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`, and works on the dev server or a deployed app. Errors go to stderr, or to the JSON body with `--json`, and exit with status 1.

A Workspace whose Store keeps no revisions fails with `WORKSPACE_R0069` and names the [Blob + Database Store](/docs/workspace/configure#blob-database-store), which keeps refs and revisions. All three commands read, so `console.authorize` grants them with `workspaces` or `workspaces:read`.
