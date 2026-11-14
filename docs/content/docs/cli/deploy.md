---
title: Link and deploy commands
description: Link a project to its host, deploy it from your machine with your own login, and list its deployments with the vitehub CLI.
navigation.title: Link and deploy
navigation.order: 3
navigation.group: Start
icon: i-lucide-rocket
---

These commands run on your machine with your host login. They do not add a CI workflow. Each error code links to its page in the [CLI diagnostics](/docs/cli/diagnostics).

## Link a project to its host

`vitehub link` connects the project to a project on its host, so later commands know where to deploy.

```bash [Terminal]
pnpm vitehub link
pnpm vitehub link --host cloudflare --account <id> --create
pnpm vitehub unlink
```

- `--host`: `cloudflare`, `vercel`, `netlify`, or `deno`. The default is the host that `vitehub status` reports.
- `--project`: the project name on the host. The default is the `name` of `vitehub({ name })`, else the package.json name, in the same form that the build uses.
- `--account`: the Cloudflare account id, the Vercel team id, or the Netlify team slug.
- `--create`: create the project when the host does not have it. Without it, a missing project exits with `3`.

The credentials come from environment variables first, then from the host CLI login: `CLOUDFLARE_API_TOKEN` or a Wrangler login, `VERCEL_TOKEN` and `VERCEL_TEAM_ID`, `NETLIFY_AUTH_TOKEN`. For Cloudflare, install Wrangler in the project (for example, `pnpm add -D wrangler`) and run `pnpm exec wrangler login`, or make `wrangler` available on `PATH`. A login made only through a cached `npx` or `pnpm dlx` invocation needs that installation before ViteHub can discover it. ViteHub never stores or prints a token.

The command looks up the project through the host API: a Worker on Cloudflare, a project on Vercel, a site on Netlify. Deno has no lookup yet, so the link keeps the name with `verified: false`. The link is in `.vitehub/link.json`:

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

The file holds no secret, but it is local to your machine. `link` adds `.vitehub` to the project `.gitignore` when it is not there. `vitehub status` shows the link in `link` and where the credentials come from in `credentials`. `vitehub unlink` removes the file and does not change the project on the host.

| Code | Cause | Fix | Exit |
| --- | --- | --- | --- |
| [`SETUP_LINK_HOST_UNSUPPORTED`](/docs/cli/diagnostics/setup_link_host_unsupported) | The host is `node`, a self-hosted server, which has no project to link. | Pass `--host`, or set `host` in `vitehub()`. | `3` |
| [`SETUP_LINK_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_link_credentials_missing) | No token was found in the environment or in the host CLI login. `missing` lists the variables. | Run the login command or set the environment variable that the `fix` names. | `2` |
| [`SETUP_LINK_ACCOUNT_REQUIRED`](/docs/cli/diagnostics/setup_link_account_required) | The Cloudflare token has access to more than one account, or to none. `missing[0].choices` lists the accounts. | Run the command again with `--account <id>`. | `2` |
| [`SETUP_LINK_NAME_REQUIRED`](/docs/cli/diagnostics/setup_link_name_required) | The project name is not known, for example because `vitehub({ name })` is an expression. | Pass `--project <name>`. | `2` |
| [`SETUP_LINK_PROJECT_NOT_FOUND`](/docs/cli/diagnostics/setup_link_project_not_found) | The host has no project with that name. | Run the command in `rerun`, which adds `--create`, or pass `--project` with the name of a project that exists. | `3` |

## Deploy from your machine

`vitehub deploy` builds the app, then runs the deploy that the build wrote for its host.

```bash [Terminal]
pnpm vitehub deploy
pnpm vitehub deploy --preview
pnpm vitehub deploy --temporary --yes --json
```

- `--preview`: a preview deploy instead of production. Deno has none. A preview does not push the checkout folders of `vitehub.lock`.
- `--no-build`: deploy the build output that is there.
- `--no-push`: do not check or push the checkout folders of `vitehub.lock`.
- `--temporary`: deploy without an account. Only Cloudflare and Vercel have it, and only when no credentials are found.
- `--yes`: deploy without the question. Without a terminal, the command needs it and exits with `2` and a `rerun`.

The command runs each host CLI with an argument array and no shell. It runs only the deploy command that ViteHub's build writes, and refuses any other command.

| Host | Deploy |
| --- | --- |
| Cloudflare | `wrangler deploy --config ./server/wrangler.json` from `commands.deploy` in `.output/nitro.json`, with `--tag` and `--message` for the commit. With `database.migrateOnDeploy`, it first runs `wrangler d1 migrations apply <binding> --remote` for each D1 binding, and stops when one fails. `--preview` runs `wrangler versions upload` and applies no migrations. |
| Vercel | `vercel deploy --prebuilt --prod --project <name>`, with `--meta vitehubCommit=<sha>` |
| Netlify | `netlify deploy --no-build --dir dist --prod`, with `--message` for the commit |
| Deno | `node .output/deploy.mjs` with `DENO_DEPLOY_ORG` and `DENO_DEPLOY_APP` |

The credentials are the ones that `vitehub link` reads, and the host CLIs read them from the environment. Vercel deploys also accept a saved `vercel login` session, checked with `vercel whoami`, without requiring `VERCEL_TOKEN`. Deno also needs `DENO_DEPLOY_ORG`, or a link with `--account <org>`.

A temporary deploy has no account. The command prints the claim link: claim a Cloudflare Worker within 60 minutes. `--json` returns it in `temporary.claimUrl`. Do not share the claim link.

After a first deploy, `.vitehub/link.json` gets the host project with `verified: false`, so `vitehub status` finds it. Run `vitehub link` to verify it.

### Push the checkout folders

When `vitehub.lock` has checkout folders, a production deploy also pushes them, as `vitehub push` does. The project must install `@vite-hub/workspace` or `vite-hub`, which read the lock. Without a lock or a checkout, the deploy does not push. Without that package, it does not push and prints one warning when the lock has checkout folders.

1. After the deploy question and before the build, the command checks each folder for conflicts, pulls remote changes, and checks for conflicts again. The build uses the pulled files. A declined question loads no project code. A file with unresolved conflicts stops the deploy with `SETUP_DEPLOY_CHECKOUT_CONFLICT`. A failed pull stops it before the build or deploy. An installed package that does not load stops it with `SETUP_DEPLOY_CHECKOUT_MODULE_FAILED`.
2. After the deploy, it pushes each folder to the app that `remote` of its lock entry names. A folder without `remote` goes to the dev server, as with `vitehub push`.
3. The push pulls again, so it can change `vitehub.lock` and files in the folders. The command lists the files changed by both pulls and the push. Commit them.

A `--preview` deploy does not push, so a preview never writes the shared Workspace ref. `--json` returns the push in `checkouts`:

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

### Deploy errors

| Code | Cause | Fix | Exit |
| --- | --- | --- | --- |
| [`SETUP_DEPLOY_HOST_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_host_unsupported) | The host is `node`. | Start the server in `.output` yourself. | `3` |
| [`SETUP_DEPLOY_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_deploy_credentials_missing) | No token was found. | Run the login command or set the variable that the `fix` names. On Cloudflare and Vercel, `rerun` is a temporary deploy that needs no account. | `2` |
| [`SETUP_DEPLOY_TEMPORARY_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_temporary_unsupported) | The host has no temporary deploy, `--preview` was passed, credentials were found, or the Vercel CLI refuses it (in CI, or in a folder with `.vercel/project.json`). | Remove `--temporary` and deploy with your host login. | `3` |
| [`SETUP_DEPLOY_PREVIEW_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_preview_unsupported) | The Deno deploy that the build writes always goes to production. | Remove `--preview` to deploy to production. | `3` |
| [`SETUP_DEPLOY_ORG_REQUIRED`](/docs/cli/diagnostics/setup_deploy_org_required) | The Deno Deploy organization is not known. | Set `DENO_DEPLOY_ORG`, or run `vitehub link --host deno --account <org>`. | `2` |
| [`SETUP_DEPLOY_BUILD_FAILED`](/docs/cli/diagnostics/setup_deploy_build_failed) | The build script failed, or package.json has no `build` script. | Fix the build error and run the command again, or pass `--no-build` to deploy the output that is there. | `1` |
| [`SETUP_DEPLOY_OUTPUT_MISSING`](/docs/cli/diagnostics/setup_deploy_output_missing) | The build output has no `deployment.json` or no deploy command for the host. | Build again. | `1` |
| [`SETUP_DEPLOY_HOST_MISMATCH`](/docs/cli/diagnostics/setup_deploy_host_mismatch) | The configured host conflicts with the link, or the build output is for another host. A configured host conflict is rejected before the build or the upload of existing output. | Build again for the linked host, or run `vitehub unlink` and link the host that the build targets. | `3` |
| [`SETUP_DEPLOY_COMMAND_REJECTED`](/docs/cli/diagnostics/setup_deploy_command_rejected) | The deploy command in the build output is not the one that ViteHub writes, so the command does not run it. | Build again with `vitehub()`. If you set the deploy command yourself, run it yourself. | `1` |
| [`SETUP_DEPLOY_FAILED`](/docs/cli/diagnostics/setup_deploy_failed) | A host CLI exited with an error. The reason shows its last lines. | Read the host output, fix the cause, and run the command again. | `1` |
| [`SETUP_DEPLOY_CHECKOUT_CONFLICT`](/docs/cli/diagnostics/setup_deploy_checkout_conflict) | A checkout folder of `vitehub.lock` has a file with conflict markers or an open binary conflict. Nothing was built or deployed. | Remove the markers, or run `vitehub resolve` for a binary file, then deploy again. `--no-push` deploys without the push. | `1` |
| [`SETUP_DEPLOY_CHECKOUT_MODULE_FAILED`](/docs/cli/diagnostics/setup_deploy_checkout_module_failed) | The project installs `@vite-hub/workspace/checkout` or `vite-hub/workspace/checkout`, but the module does not load: it has a syntax error, a missing dependency, an error when it starts, or no `localCheckoutStatus` and `pushWorkspaces` exports. Nothing was built or deployed. | Reinstall the dependencies and use the same version of the Workspace package as the CLI. `--no-push` deploys without the push. | `1` |
| [`SETUP_DEPLOY_PUSH_FAILED`](/docs/cli/diagnostics/setup_deploy_push_failed) | The app is deployed, but the Workspace push failed. `checkouts.error` has the code, message, and fix of the push. | Fix the cause and run `vitehub push`. Do not deploy again. | `1` |

## List deployments

`vitehub deployments` reads the deployments of the linked project from the host each time. ViteHub keeps no local deploy log. It needs a host link in `.vitehub/link.json` (from `vitehub link` or a first `vitehub deploy`) and the credentials that `vitehub link` reads.

```bash [Terminal]
pnpm vitehub deployments
pnpm vitehub deployments --limit 20 --json
```

Each deployment has `id`, `url`, `createdAt`, `state` (`ready`, `building`, `error`, `canceled`, or `unknown`), `target` (`production` or `preview`), `live` (true for the one that receives production traffic), `source` (`cli`, `git`, `dashboard`, `api`, or `unknown`), and `commit`. `commit.from` is `vitehub` for the marker that `vitehub deploy` writes, and `host` for the commit of a Git integration build. `--limit` is 1 to 100, and the default is 10.

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

| Host | Deployments | Live | Commit |
| --- | --- | --- | --- |
| Cloudflare | Workers API `.../workers/scripts/{name}/deployments` and `.../versions`. A version in no deployment is a preview. | The newest deployment | The `workers/message` annotation of the version |
| Vercel | `GET /v6/deployments?projectId=` | `targets.production` of the project | `meta.vitehubCommit`, else `meta.githubCommitSha` |
| Netlify | `GET /api/v1/sites/{site_id}/deploys` | `published_deploy` of the site | The deploy `title`, else `commit_ref` |
| Deno | `deno deploy deployments list --json` | `productionRevisionId` of `deno deploy apps get --json` | None. Deno Deploy keeps no deploy message. |

`vitehub status` adds a `live` field and a `live` line, such as `live  4f2a9c0 (3 commits behind)`. `behind` and `ahead` come from `git rev-list --left-right --count <sha>...HEAD` when the commit is in the local repository. Otherwise `live.unknownReason` is `commit-not-local`, `no-marker`, or `no-git`. `status` asks the host only when the project is linked and the credentials resolve, and gives credential discovery and deployment lookup a shared 5-second budget. It follows the host's production pointer even when that deployment is older than the recent history page. When it cannot read the host, `live` is `null` and `liveReason` is `offline`, `not-linked`, `no-credentials`, `no-live-deployment`, `timeout`, or `host-error`. The exit code stays `0`. Pass `--offline` to skip host requests and credential CLI discovery; the credential summary then uses environment variables only.

These `deployments` errors exit with `2`:

| Code | Cause | Fix |
| --- | --- | --- |
| [`SETUP_DEPLOYMENTS_NOT_LINKED`](/docs/cli/diagnostics/setup_deployments_not_linked) | The project has no host link. | Run `vitehub link`. |
| [`SETUP_DEPLOYMENTS_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_deployments_credentials_missing) | No token was found for the linked host. | Run the login command or set the variable that the `fix` names. |
| [`SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED`](/docs/cli/diagnostics/setup_deployments_account_required) | The Cloudflare account is not known. | Set `CLOUDFLARE_ACCOUNT_ID`, or run `vitehub link --host cloudflare --account <id>`. |
| [`SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED`](/docs/cli/diagnostics/setup_deployments_project_id_required) | The Netlify link has no site id. | Run `vitehub link --host netlify`. |
