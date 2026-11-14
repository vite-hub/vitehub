---
title: Link and deploy commands
description: Link a project to its host, deploy it from your machine with your own login, and list its deployments with the vitehub CLI.
navigation.title: Link and deploy
navigation.order: 3
navigation.group: Start
icon: i-lucide-rocket
---

These commands ship your app from your machine with your own host login, with no CI workflow. Each error code links to its page in the [CLI diagnostics](/docs/cli/diagnostics).

## Link a project to its host

`vitehub link` connects the project to its project on the host, so later commands know where to deploy.

```bash [Terminal]
pnpm vitehub link
pnpm vitehub link --host cloudflare --account <id> --create
pnpm vitehub unlink
```

| Flag | What it does |
| --- | --- |
| `--host <host>` | `cloudflare`, `vercel`, `netlify`, or `deno`. The default is the host that `vitehub status` reports. |
| `--project <name>` | The project name on the host. The default is `vitehub({ name })`, else the `package.json` name, in the form the build uses. |
| `--account <id>` | The Cloudflare account id, the Vercel team id, or the Netlify team slug. |
| `--create` | Create the project when the host does not have it. Without it, a missing project exits with `3`. |

Credentials come from the environment first, then from the host CLI login: `CLOUDFLARE_API_TOKEN` or a Wrangler login, `VERCEL_TOKEN` and `VERCEL_TEAM_ID`, or `NETLIFY_AUTH_TOKEN`. ViteHub never stores or prints a token. The command looks up the Worker, Vercel project, or Netlify site, but Deno has no lookup yet, so its link keeps the name with `verified: false`.

::tip
For Cloudflare, install Wrangler in the project (`pnpm add -D wrangler`) and run `pnpm exec wrangler login`, or put `wrangler` on `PATH`. ViteHub cannot find a login made only through a cached `npx` or `pnpm dlx` run.
::

The link lives in `.vitehub/link.json`:

```json [.vitehub/link.json]
{
  "schemaVersion": 1,
  "host": "cloudflare",
  "account": { "id": "023e105f4ecef8ad9ca31a8372d0c353" },
  "project": { "id": "e8f70fdbc8b1fb0b8ddb1af166186758", "name": "my-app" },
  "verified": true,
  "linkedAt": "2026-11-05T12:00:00.000Z"
}
```

The file holds no secret, but it belongs to your machine, so `link` adds `.vitehub` to `.gitignore`. `vitehub status` shows it in `link`, and where the credentials come from in `credentials`. `vitehub unlink` removes the file and leaves the host project alone.

| Code | Cause | Fix | Exit |
| --- | --- | --- | --- |
| [`SETUP_LINK_HOST_UNSUPPORTED`](/docs/cli/diagnostics/setup_link_host_unsupported) | The host is `node`, a self-hosted server with no project to link. | Pass `--host`, or set `host` in `vitehub()`. | `3` |
| [`SETUP_LINK_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_link_credentials_missing) | No token in the environment or the host CLI login. `missing` lists the variables. | Run the login command or set the variable that `fix` names. | `2` |
| [`SETUP_LINK_ACCOUNT_REQUIRED`](/docs/cli/diagnostics/setup_link_account_required) | The Cloudflare token reaches more than one account, or none. `missing[0].choices` lists them. | Run again with `--account <id>`. | `2` |
| [`SETUP_LINK_NAME_REQUIRED`](/docs/cli/diagnostics/setup_link_name_required) | The project name is unknown, for example because `vitehub({ name })` is an expression. | Pass `--project <name>`. | `2` |
| [`SETUP_LINK_PROJECT_NOT_FOUND`](/docs/cli/diagnostics/setup_link_project_not_found) | The host has no project with that name. | Run `rerun`, which adds `--create`, or pass the `--project` of one that exists. | `3` |

## Deploy from your machine

`vitehub deploy` builds the app, then runs the deploy command that the build wrote for its host.

```bash [Terminal]
pnpm vitehub deploy
pnpm vitehub deploy --preview
pnpm vitehub deploy --temporary --yes --json
```

| Flag | What it does |
| --- | --- |
| `--preview` | Deploy a preview instead of production. Deno has none, and a preview never pushes checkout folders. |
| `--no-build` | Deploy the build output that is already there. |
| `--no-push` | Do not check or push the checkout folders of `vitehub.lock`. |
| `--temporary` | Deploy without an account. Only on Cloudflare and Vercel, and only when no credentials are found. |
| `--yes` | Skip the question. Without a terminal it is required, else the command exits with `2` and a `rerun`. |

ViteHub runs only the deploy command that its own build writes, with an argument array and no shell, and refuses any other command.

| Host | Deploy |
| --- | --- |
| Cloudflare | `wrangler deploy --config ./server/wrangler.json` from `commands.deploy` in `.output/nitro.json`, with `--tag` and `--message` for the commit. With `database.migrateOnDeploy`, it first runs `wrangler d1 migrations apply <binding> --remote` for each D1 binding and stops when one fails. `--preview` runs `wrangler versions upload` and applies no migrations. |
| Vercel | `vercel deploy --prebuilt --prod --project <name>`, with `--meta vitehubCommit=<sha>`. |
| Netlify | `netlify deploy --no-build --dir dist --prod`, with `--message` for the commit. |
| Deno | `node .output/deploy.mjs` with `DENO_DEPLOY_ORG` and `DENO_DEPLOY_APP`. |

The host CLIs read the same credentials as `vitehub link`. Vercel also accepts a saved `vercel login` session, checked with `vercel whoami`, instead of `VERCEL_TOKEN`. Deno needs `DENO_DEPLOY_ORG`, or a link made with `--account <org>`. After a first deploy, `.vitehub/link.json` gets the host project with `verified: false` so `vitehub status` finds it, and `vitehub link` verifies it.

::warning
A temporary deploy has no account. It prints a claim link, which `--json` returns in `temporary.claimUrl`. Do not share it, and claim a Cloudflare Worker within 60 minutes.
::

## Push the checkout folders

When `vitehub.lock` has checkout folders, a production deploy also pushes them, as `vitehub push` does. This needs `@vite-hub/workspace` or `vite-hub` installed, else the deploy skips the push with a warning.

After you confirm and before the build, the command pulls each folder and checks it for conflicts, so the build uses the pulled files. After the deploy, it pushes each folder to the app that `remote` names in its lock entry, or to the dev server without one. The push pulls again, so the command lists the files that changed in `vitehub.lock` and the folders. Commit them.

A conflict, a failed pull, or a Workspace module that does not load stops the deploy before the build. `--json` returns the push in `checkouts`:

```json [vitehub deploy --json]
{
  "schemaVersion": 1,
  "host": "cloudflare",
  "url": "https://my-app.example.workers.dev",
  "checkouts": {
    "results": [{ "workspace": "docs", "ref": "main", "revision": "r3", "pushed": ["guide.md"], "pull": { "ref": "main", "from": "r1", "head": "r2", "files": [{ "path": "news.md", "action": "added" }] } }],
    "changed": ["vitehub.lock", "content/news.md"]
  }
}
```

## Deploy errors

| Code | Cause | Fix | Exit |
| --- | --- | --- | --- |
| [`SETUP_DEPLOY_HOST_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_host_unsupported) | The host is `node`. | Start the server in `.output` yourself. | `3` |
| [`SETUP_DEPLOY_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_deploy_credentials_missing) | No token was found. | Run the login command or set the variable that `fix` names. On Cloudflare and Vercel, `rerun` is a temporary deploy. | `2` |
| [`SETUP_DEPLOY_TEMPORARY_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_temporary_unsupported) | The host has none, `--preview` was passed, credentials were found, or the Vercel CLI refuses it (in CI, or with `.vercel/project.json`). | Remove `--temporary` and deploy with your login. | `3` |
| [`SETUP_DEPLOY_PREVIEW_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_preview_unsupported) | The Deno deploy always goes to production. | Remove `--preview`. | `3` |
| [`SETUP_DEPLOY_ORG_REQUIRED`](/docs/cli/diagnostics/setup_deploy_org_required) | The Deno Deploy organization is unknown. | Set `DENO_DEPLOY_ORG`, or run `vitehub link --host deno --account <org>`. | `2` |
| [`SETUP_DEPLOY_BUILD_FAILED`](/docs/cli/diagnostics/setup_deploy_build_failed) | The build failed, or `package.json` has no `build` script. | Fix the build, or pass `--no-build` to deploy the output that is there. | `1` |
| [`SETUP_DEPLOY_OUTPUT_MISSING`](/docs/cli/diagnostics/setup_deploy_output_missing) | The output has no `deployment.json` or no deploy command for the host. | Build again. | `1` |
| [`SETUP_DEPLOY_HOST_MISMATCH`](/docs/cli/diagnostics/setup_deploy_host_mismatch) | The configured host conflicts with the link (caught before the build or upload), or the output is for another host. | Build for the linked host, or `vitehub unlink` and link the host the build targets. | `3` |
| [`SETUP_DEPLOY_COMMAND_REJECTED`](/docs/cli/diagnostics/setup_deploy_command_rejected) | The deploy command in the output is not the one ViteHub writes. | Build again with `vitehub()`, or run your own deploy command yourself. | `1` |
| [`SETUP_DEPLOY_FAILED`](/docs/cli/diagnostics/setup_deploy_failed) | A host CLI failed. The reason shows its last lines. | Fix the cause from the host output and run again. | `1` |
| [`SETUP_DEPLOY_CHECKOUT_CONFLICT`](/docs/cli/diagnostics/setup_deploy_checkout_conflict) | A checkout folder has conflict markers or an open binary conflict. Nothing was built or deployed. | Remove the markers, or run `vitehub resolve` for a binary file. `--no-push` deploys without the push. | `1` |
| [`SETUP_DEPLOY_CHECKOUT_MODULE_FAILED`](/docs/cli/diagnostics/setup_deploy_checkout_module_failed) | `@vite-hub/workspace/checkout` or `vite-hub/workspace/checkout` does not load, or lacks `localCheckoutStatus` and `pushWorkspaces`. Nothing was built or deployed. | Reinstall, and use the same Workspace package version as the CLI. `--no-push` deploys without the push. | `1` |
| [`SETUP_DEPLOY_PUSH_FAILED`](/docs/cli/diagnostics/setup_deploy_push_failed) | The app is deployed, but the Workspace push failed. `checkouts.error` has its code, message, and fix. | Fix the cause and run `vitehub push`. Do not deploy again. | `1` |

## List deployments

`vitehub deployments` asks the host for the linked project's deployments each time, because ViteHub keeps no local deploy log. It needs a link and the credentials that `link` reads.

```bash [Terminal]
pnpm vitehub deployments
pnpm vitehub deployments --limit 20 --json
```

```json [vitehub deployments --json]
{
  "schemaVersion": 1,
  "host": "cloudflare",
  "project": { "name": "my-app" },
  "deployments": [
    {
      "id": "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
      "url": "https://my-app.example.workers.dev",
      "createdAt": "2026-11-05T18:11:19.117Z",
      "state": "ready",
      "target": "production",
      "live": true,
      "version": "bcf48806-b317-4351-9ee7-36e7d557d4de",
      "commit": { "sha": "4f2a9c0e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39", "dirty": false, "from": "vitehub" },
      "source": "cli"
    }
  ]
}
```

`state` is `ready`, `building`, `error`, `canceled`, or `unknown`, `target` is `production` or `preview`, and `live` marks the one that receives production traffic. `source` is `cli`, `git`, `dashboard`, `api`, or `unknown`. `commit.from` is `vitehub` for the marker that `vitehub deploy` writes, or `host` for a Git integration build. `--limit` takes 1 to 100, and the default is 10.

Each host decides which deployment is live and where the commit comes from. On Cloudflare, a version in no deployment is a preview.

| Host | Live | Commit |
| --- | --- | --- |
| Cloudflare | The newest deployment | The `workers/message` annotation of the version |
| Vercel | `targets.production` of the project | `meta.vitehubCommit`, else `meta.githubCommitSha` |
| Netlify | `published_deploy` of the site | The deploy `title`, else `commit_ref` |
| Deno | `productionRevisionId` of the app | None, because Deno Deploy keeps no deploy message |

`vitehub status` shows the live deployment too, as `live  4f2a9c0 (3 commits behind)`. It counts `behind` and `ahead` when the commit is in your local repository, else `live.unknownReason` says why (`commit-not-local`, `no-marker`, or `no-git`). It asks the host only for a linked project with credentials, within 5 seconds. When it cannot, `live` is `null`, `liveReason` says why (`offline`, `not-linked`, `no-credentials`, `no-live-deployment`, `timeout`, or `host-error`), and the exit code stays `0`. `--offline` skips the host and its CLI, so credentials come from environment variables only.

These errors exit with `2`:

| Code | Cause | Fix |
| --- | --- | --- |
| [`SETUP_DEPLOYMENTS_NOT_LINKED`](/docs/cli/diagnostics/setup_deployments_not_linked) | The project has no host link. | Run `vitehub link`. |
| [`SETUP_DEPLOYMENTS_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_deployments_credentials_missing) | No token was found for the linked host. | Run the login command or set the variable that `fix` names. |
| [`SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED`](/docs/cli/diagnostics/setup_deployments_account_required) | The Cloudflare account is unknown. | Set `CLOUDFLARE_ACCOUNT_ID`, or run `vitehub link --host cloudflare --account <id>`. |
| [`SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED`](/docs/cli/diagnostics/setup_deployments_project_id_required) | The Netlify link has no site id. | Run `vitehub link --host netlify`. |
