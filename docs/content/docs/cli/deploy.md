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

`vitehub link` connects the project to a project on a host, so later commands know where to deploy. It runs on your machine with your host login. It does not add a CI workflow.

```bash [Terminal]
pnpm vitehub link
pnpm vitehub link --host cloudflare --account <id> --create
pnpm vitehub link --host vercel
pnpm vitehub unlink --host vercel
pnpm vitehub unlink
```

| Flag | What it does |
| --- | --- |
| `--host` | `cloudflare`, `vercel`, `netlify`, or `deno`. The default is the host that `vitehub status` reports. |
| `--project` | the project name on the host. The default is the `name` of `vitehub({ name })`, else the package.json name, in the same form that the build uses. |
| `--account` | the Cloudflare account id, the Vercel team id, or the Netlify team slug. |
| `--create` | create the project when the host does not have it. Without it, a missing project exits with `3`. |
| `--default` | make this host the target that `vitehub deploy` uses without `--host`. The first linked host is the default. |

The credentials come from environment variables first, then from the host CLI login: `CLOUDFLARE_API_TOKEN` or a Wrangler login, `VERCEL_TOKEN` and `VERCEL_TEAM_ID`, `NETLIFY_AUTH_TOKEN`. For Cloudflare, install Wrangler in the project (for example, `pnpm add -D wrangler`) and run `pnpm exec wrangler login`, or make `wrangler` available on `PATH`. A login made only through a cached `npx` or `pnpm dlx` invocation needs that installation before ViteHub can discover it. ViteHub never stores or prints a token.

The command looks up the project through the host API: a Worker on Cloudflare, a project on Vercel, a site on Netlify. Deno has no lookup yet, so the link keeps the name with `verified: false`. The link is in `.vitehub/link.json`, with one target for each host:

```json [.vitehub/link.json]
{
  "schemaVersion": 2,
  "default": "cloudflare",
  "targets": {
    "cloudflare": {
      "account": { "id": "023e105f4ecef8ad9ca31a8372d0c353" },
      "project": { "id": "e8f70fdbc8b1fb0b8ddb1af166186758", "name": "my-app" },
      "verified": true,
      "linkedAt": "2026-11-05T12:00:00.000Z"
    },
    "vercel": {
      "account": { "id": "team_a1b2c3d4e5f6g7h8i9j0" },
      "project": { "id": "prj_12HKQaOmR5t5Uy6vdcQsNIiZgHGB", "name": "my-app" },
      "verified": true,
      "linkedAt": "2026-11-06T09:00:00.000Z"
    }
  }
}
```

`vitehub link --host <host>` adds the target of that host, or replaces it, and keeps the other targets. A file with `schemaVersion: 1` from an older CLI holds one host link. The CLI reads it as one target that is also the default, and the next write saves version 2.

Resources such as D1 databases, KV namespaces, R2 buckets, and libSQL databases are separate on each host. A second host starts with its own empty data. `link` and `deploy` print this once, when they add a second host.

The file holds no secret, but it is local to your machine. `link` adds `.vitehub` to the project `.gitignore` when it is not there. `vitehub status` shows the targets in `targets`, the default host in `default`, the target that deploy uses in `link`, and where its credentials come from in `credentials`. `vitehub unlink` removes the file, and `vitehub unlink --host <host>` removes one target. Neither changes the project on the host. When the default target goes and one target stays, that one becomes the default.

| Code | Cause and fix |
| --- | --- |
| [`SETUP_LINK_HOST_UNSUPPORTED`](/docs/cli/diagnostics/setup_link_host_unsupported) | The host is `node`, a self-hosted server, which has no project to link. Pass `--host`, or set `host` in `vitehub()`. The command exits with `3`. |
| [`SETUP_LINK_HOST_REQUIRED`](/docs/cli/diagnostics/setup_link_host_required) | The project links several hosts and none is the default, so `vitehub deploy` or `vitehub deployments` does not know which one to use. Pass `--host <host>`, or run `vitehub link --host <host> --default`. The command exits with `2` and lists the hosts in `missing[0].choices`. |
| [`SETUP_LINK_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_link_credentials_missing) | No token was found in the environment or in the host CLI login. Run the login command or set the environment variable that the `fix` names. The command exits with `2` and lists the variables in `missing`. |
| [`SETUP_LINK_ACCOUNT_REQUIRED`](/docs/cli/diagnostics/setup_link_account_required) | The Cloudflare token has access to more than one account, or to none. The command exits with `2` and lists the accounts in `missing[0].choices`. Run it again with `--account <id>`. |
| [`SETUP_LINK_NAME_REQUIRED`](/docs/cli/diagnostics/setup_link_name_required) | The project name is not known, for example because `vitehub({ name })` is an expression. Pass `--project <name>`. The command exits with `2`. |
| [`SETUP_LINK_PROJECT_NOT_FOUND`](/docs/cli/diagnostics/setup_link_project_not_found) | The host has no project with that name. Run the command in `rerun`, which adds `--create`, or pass `--project` with the name of a project that exists. The command exits with `3`. |

## Deploy from your machine

`vitehub deploy` creates the missing resources of the app on one host target, builds the app for that host, then runs the deploy that the build wrote. It runs on your machine with your host login. It does not add a CI workflow.

```bash [Terminal]
pnpm vitehub deploy
pnpm vitehub deploy --host vercel
pnpm vitehub deploy --preview
pnpm vitehub deploy --push-env
pnpm vitehub deploy --temporary --yes --json
```

| Flag | What it does |
| --- | --- |
| `--host` | `cloudflare`, `vercel`, `netlify`, or `deno`. Without it, the command uses the default target of `.vitehub/link.json`, else the only target, else the host that `vitehub status` reports. With several targets and no default, it exits with `SETUP_LINK_HOST_REQUIRED`. |
| `--preview` | a preview deploy instead of production. Deno has none. A preview does not push the checkout folders of `vitehub.lock`. |
| `--push-env` | set every env value that is available locally on the host, also the names that the host has. See [Check Env before a deploy](#check-env-before-a-deploy). |
| `--no-build` | deploy the build output that is there. |
| `--no-provision` | do not create the missing host resources first. |
| `--no-push` | do not check or push the checkout folders of `vitehub.lock`. |
| `--temporary` | deploy without an account. Only Cloudflare and Vercel have it, and only when no credentials are found. |
| `--yes` | deploy and create resources without the questions, and generate a missing `VITEHUB_SECRET`. Without a terminal, the command needs it and exits with `2` and a `rerun`. |

The build runs with `VITEHUB_HOST=<host>` and `VITEHUB_HOST_SOURCE=cli`, so it uses the preset of that host even when `vitehub()` sets another `host`. A `nitro.preset`, `NITRO_PRESET`, or `SERVER_PRESET` for another host still fails the build. With `--no-build`, the build output must be for the same host.

The command runs each host CLI with an argument array and no shell. It runs only the deploy command that ViteHub's build writes, and refuses any other command.

| Host | Deploy |
| --- | --- |
| Cloudflare | `wrangler deploy --config ./server/wrangler.json` from `commands.deploy` in `.output/nitro.json`, with `--tag` and `--message` for the commit, and `--secrets-file` when deploy sets env values. With `database.migrateOnDeploy`, it first runs `wrangler d1 migrations apply <binding> --remote` for each D1 binding, and stops when one fails. `--preview` runs `wrangler versions upload` and applies no migrations. |
| Vercel | `vercel deploy --prebuilt --prod --project <name>`, with `--meta vitehubCommit=<sha>` |
| Netlify | `netlify deploy --no-build --dir dist --prod`, with `--message` for the commit |
| Deno | `node .output/deploy.mjs` with `DENO_DEPLOY_ORG` and `DENO_DEPLOY_APP` |

The credentials are the ones that `vitehub link` reads, and the host CLIs read them from the environment. Vercel deploys also accept a saved `vercel login` session, checked with `vercel whoami`, without requiring `VERCEL_TOKEN`. Deno also needs `DENO_DEPLOY_ORG`, or a link with `--account <org>`.

A temporary deploy has no account. The command prints the claim link: claim a Cloudflare Worker within 60 minutes. `--json` returns it in `temporary.claimUrl`. Do not share the claim link.

After a first deploy to a host, `.vitehub/link.json` gets the target of that host with `verified: false`, so `vitehub status` finds it, and keeps the other targets. Run `vitehub link --host <host>` to verify it.

**Create the host resources**

On Cloudflare and Vercel, the deploy runs the [provision](/docs/development/provisioning) plan of the host before the build. It creates the missing D1 databases, KV namespaces, R2 buckets, Queues, and Vercel Blob stores of the app, and records their ids in `.vitehub/provision.json`. The build binds those ids. A second deploy finds the resources and creates nothing. The order is provision, build, D1 migrations, deploy.

```txt [vitehub deploy]
Provision on cloudflare:
create	cloudflare-d1	my-app
Create or change 1 resource on cloudflare? [y/N] y
Provisioned 1 resource on cloudflare. Ids are in .vitehub/provision.json.
```

- Provision uses the credentials of the deploy: environment variables first, then a `wrangler login`. A Cloudflare login with several accounts needs `CLOUDFLARE_ACCOUNT_ID`, or the account of the link.
- Vercel Blob needs `VERCEL_TOKEN` and the project id of the link, or `VERCEL_PROJECT_ID`. A saved `vercel login` can deploy but cannot create resources.
- When a step cannot check its resources, the deploy stops before it builds or deploys, with `SETUP_DEPLOY_PROVISION_UNCHECKED`.
- The deploy asks before it creates or changes a resource. `--yes` skips the question. A preview deploy also provisions, because it binds the same resources. A temporary deploy does not.
- `--json` returns the result in `provision`: `changed` lists what the deploy created or changed, and `ids` the ids of the host resources. It is missing when the app declares no host resource, or with `--no-provision`.

```json [vitehub deploy --json]
{
  "schemaVersion": 1,
  "host": "cloudflare",
  "url": "https://my-app.example.workers.dev",
  "provision": {
    "changed": [{ "status": "create", "kind": "cloudflare-d1", "name": "my-app", "step": "database:cloudflare-d1" }],
    "ids": { "d1": { "DB": "8f3c..." } }
  }
}
```

### Check Env before a deploy

After provisioning and the build, before migrations, env writes, or publishing code, deploy checks the env names that the build wrote to `deployment.json`. The stage picks the local values and the host environment:

| Command | Stage | Local values | Host environment |
| --- | --- | --- | --- |
| `vitehub deploy` | `production` | The shell, then `.env.production.local`, `.env.production`, `.env.local`, `.env` | Production |
| Preview (`vitehub deploy --preview`) | `preview` | The shell, then `.env.preview.local`, `.env.preview`, `.env.local`, `.env` | Preview. Cloudflare re-supplies this stage’s local secrets with each version. |

1. Deploy reads the names that the host has, as `vitehub env diff` does. It reads them only when the build lists env names.
2. Each required name must be on the host or have a local value. When one has neither, nothing is deployed and the command exits with `SETUP_DEPLOY_ENV_MISSING`.
3. Deploy sets each name that the host lacks from its local value. `--push-env` also replaces the names that the host has. It uses the same rules as `vitehub env push`: it reads the env files in the recorded `envDir`, refuses a secret from a file that git tracks or does not ignore, never deletes a host variable, and prints names, never values.
4. An optional name that is on neither prints one warning line.

Cloudflare always uploads this stage's local values, including names already on the host, because Wrangler inherits omitted secrets from the latest uploaded version, which may be a preview. Every existing Worker secret (including undeclared and optional names) must have a local value for this stage. Otherwise deploy stops with `SETUP_DEPLOY_ENV_STAGE_UNSAFE`; set the listed names in the shell or a stage env file that git ignores. This also applies to a previously generated `VITEHUB_SECRET`: supply a locally managed value on subsequent deploys. Secrets are never read back from Cloudflare.

On Cloudflare, deploy does not run `wrangler secret put`, because that would roll the old code out with the new values. It writes the values to a temporary JSON file with mode 600 and passes it to `wrangler deploy --secrets-file`, or to `wrangler versions upload` for `--preview`, so the values arrive with the new version. The file is deleted when the deploy ends. It is JSON because Wrangler's dotenv mode expands `$VAR` and lets the shell override file values. On Vercel, Netlify, and Deno, deploy sets the values with the host env CLI just before the deploy.

A first deploy has no link target for the host, so the host has no names yet and every required name needs a local value. If the project already exists on the host, run `vitehub link --host <host>` first. Cloudflare creates the Worker with the uploaded secrets. Vercel, Netlify, and Deno need the project before deploy can set values: run `vitehub link --host <host> --create` first, or the command exits with `SETUP_DEPLOY_ENV_NOT_LINKED`.

When the build lists `VITEHUB_SECRET` as required and neither the host nor a local value has it, deploy asks to generate one. `--yes` generates it without the question. Deploy sets it on the host and prints only that it did.

`--json` returns the check in `env`, with names only:

```json
{
  "schemaVersion": 1,
  "env": {
    "stage": "production",
    "checked": ["VITEHUB_SECRET", "API_KEY", "SENTRY_DSN"],
    "missing": [{ "names": ["SENTRY_DSN"], "path": "env.server.sentryDsn", "secret": false }],
    "pushed": ["VITEHUB_SECRET", "API_KEY"],
    "generated": ["VITEHUB_SECRET"]
  }
}
```

`missing` lists the optional names without a value. `pushed` lists the names that deploy set.

<span id="push-the-checkout-folders"></span>

**Push the checkout folders**

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

<span id="deploy-errors"></span>

| Code | Cause and fix |
| --- | --- |
| [`SETUP_DEPLOY_HOST_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_host_unsupported) | The host is `node`. Start the server in `.output` yourself. The command exits with `3`. |
| [`SETUP_DEPLOY_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_deploy_credentials_missing) | No token was found. Run the login command or set the variable that the `fix` names. On Cloudflare and Vercel, `rerun` is a temporary deploy that needs no account. The command exits with `2`. |
| [`SETUP_DEPLOY_TEMPORARY_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_temporary_unsupported) | The host has no temporary deploy, `--preview` was passed, credentials were found, or the Vercel CLI refuses it (in CI, or in a folder with `.vercel/project.json`). The command exits with `3`. |
| [`SETUP_DEPLOY_PREVIEW_UNSUPPORTED`](/docs/cli/diagnostics/setup_deploy_preview_unsupported) | The Deno deploy that the build writes always goes to production. The command exits with `3`. |
| [`SETUP_DEPLOY_ORG_REQUIRED`](/docs/cli/diagnostics/setup_deploy_org_required) | Set `DENO_DEPLOY_ORG`, or run `vitehub link --host deno --account <org>`. The command exits with `2`. |
| [`SETUP_DEPLOY_BUILD_FAILED`](/docs/cli/diagnostics/setup_deploy_build_failed) | The build script failed, or package.json has no `build` script. The command exits with `1`. |
| [`SETUP_DEPLOY_OUTPUT_MISSING`](/docs/cli/diagnostics/setup_deploy_output_missing) | The build output has no `deployment.json` or no deploy command for the host. Build again. The command exits with `1`. |
| [`SETUP_DEPLOY_HOST_MISMATCH`](/docs/cli/diagnostics/setup_deploy_host_mismatch) | The build output is for another host than the deploy target, for example after `--no-build` with an output of an earlier build. Deploy again without `--no-build`. The command exits with `3`. |
| [`SETUP_DEPLOY_COMMAND_REJECTED`](/docs/cli/diagnostics/setup_deploy_command_rejected) | The deploy command in the build output is not the one that ViteHub writes, so the command does not run it. The command exits with `1`. |
| [`SETUP_DEPLOY_FAILED`](/docs/cli/diagnostics/setup_deploy_failed) | A host CLI exited with an error. The reason shows its last lines. The command exits with `1`. |
| [`SETUP_DEPLOY_PROVISION_UNCHECKED`](/docs/cli/diagnostics/setup_deploy_provision_unchecked) | A Provision Step could not read the host resources, so the deploy created, built, and deployed nothing. The reason names what is missing, such as `CLOUDFLARE_ACCOUNT_ID` for a `wrangler login` with several accounts, or `VERCEL_TOKEN` for a saved `vercel login`. `rerun` deploys with `--no-provision`. The command exits with `2`. |
| [`SETUP_DEPLOY_PROVISION_NEEDS_BUILD`](/docs/cli/diagnostics/setup_deploy_provision_needs_build) | The deploy must create or change resources, but `--no-build` would deploy an output that was built without their ids. Nothing was created or deployed. Deploy again without `--no-build`. The command exits with `3`. |
| [`SETUP_DEPLOY_CHECKOUT_CONFLICT`](/docs/cli/diagnostics/setup_deploy_checkout_conflict) | A checkout folder of `vitehub.lock` has a file with conflict markers or an open binary conflict. Nothing was built or deployed. Remove the markers, or run `vitehub resolve` for a binary file, then deploy again. `--no-push` deploys without the push. The command exits with `1`. |
| [`SETUP_DEPLOY_CHECKOUT_MODULE_FAILED`](/docs/cli/diagnostics/setup_deploy_checkout_module_failed) | The project installs `@vite-hub/workspace/checkout` or `vite-hub/workspace/checkout`, but the module does not load: it has a syntax error, a missing dependency, an error when it starts, or no `localCheckoutStatus` and `pushWorkspaces` exports. Nothing was built or deployed. Reinstall the dependencies and use the same version of the Workspace package as the CLI. `--no-push` deploys without the push. The command exits with `1`. |
| [`SETUP_DEPLOY_ENV_MISSING`](/docs/cli/diagnostics/setup_deploy_env_missing) | A required env name is on neither the host nor a local value for the stage. Nothing was deployed. Run `vitehub env push --host <host>`, set the name in the host dashboard, or set it in the shell or `.env.<stage>`. On a first deploy, every required name needs a local value. `missing` lists the names, and `env` the check. The command exits with `2`. |
| [`SETUP_DEPLOY_ENV_NOT_LINKED`](/docs/cli/diagnostics/setup_deploy_env_not_linked) | Deploy has values to set, but the Vercel, Netlify, or Deno project is not linked, so it cannot set them before the first deploy. Nothing was deployed. Run `vitehub link --host <host> --create`, then deploy again. The command exits with `2`. |
| [`SETUP_DEPLOY_PUSH_FAILED`](/docs/cli/diagnostics/setup_deploy_push_failed) | The app is deployed, but the Workspace push failed. `checkouts.error` has the code, message, and fix of the push. Fix the cause and run `vitehub push`. Do not deploy again. The command exits with `1`. |

## Sign in to a Console

`vitehub login` signs the CLI in to a ViteHub Console with the device flow of RFC 8628. It needs no project.

```bash [Terminal]
vitehub login                                         # console.vitehub.dev
vitehub login --console https://console.example.com   # a self-hosted Console
```

```txt [Output]
Open https://console.vitehub.dev/device and enter the code WDJB-MJHT
Or open https://console.vitehub.dev/device?user_code=WDJBMJHT
Waiting for approval...
Signed in to https://console.vitehub.dev as Ada (ada@example.com) in team Acme.
The API key expires on 13 Feb 2027. Saved in /home/ada/.config/vitehub/credentials.json.
```

1. The CLI asks the Console for a code and prints it with the `/device` address.
2. In the browser, you sign in, check the machine name and the code, choose a team, and click **Approve** or **Deny**.
3. The CLI gets an API key for that team, valid for 90 days. The Console keeps only a SHA-256 hash of the key, and the CLI never prints it.

The CLI saves the key in `$XDG_CONFIG_HOME/vitehub/credentials.json`, else `~/.config/vitehub/credentials.json`, with mode `600`, one entry for each Console origin. `--console` and `VITEHUB_CONSOLE_URL` name the Console. Plain `http://` works only for `localhost`.

- `vitehub whoami` shows the person, the team, the role, and the projects of the key.
- `vitehub logout` revokes the key on the Console and removes it from the file.
- In CI, set `VITEHUB_CONSOLE_TOKEN` to an API key from **Account settings** > **API keys** in the Console. It wins over the saved key.

A key acts as you in one team. A key made in the Console can name some projects of the team: it then opens only those and cannot link or unlink projects. Revoke a key in **Account settings** > **API keys**.

| Code | Cause and fix |
| --- | --- |
| [`CLI_CONSOLE_LOGIN_FAILED`](/docs/cli/diagnostics/cli_console_login_failed) | The device flow did not finish: the Console did not answer, the person denied the code, or the code expired after 15 minutes. Run `vitehub login` again. |
| [`CLI_CONSOLE_SIGNED_OUT`](/docs/cli/diagnostics/cli_console_signed_out) | The CLI has no valid key for the Console: there is no saved key, or the Console answered `401` because the key expired or was revoked. Run `vitehub login`, or set `VITEHUB_CONSOLE_TOKEN`. |

## List deployments

`vitehub deployments` reads the deployments of the linked project from the host each time. ViteHub keeps no local deploy log. It needs a host link in `.vitehub/link.json` (from `vitehub link` or a first `vitehub deploy`) and the credentials that `vitehub link` reads.

```bash [Terminal]
pnpm vitehub deployments
pnpm vitehub deployments --limit 20 --json
pnpm vitehub deployments --host vercel
```

Each deployment has `id`, `url`, `createdAt`, `state` (`ready`, `building`, `error`, `canceled`, or `unknown`), `target` (`production` or `preview`), `live` (true for the one that receives production traffic), `source` (`cli`, `git`, `dashboard`, `api`, or `unknown`), and `commit`. `commit.from` is `vitehub` for the marker that `vitehub deploy` writes, and `host` for the commit of a Git integration build. `--limit` is 1 to 100, and the default is 10. `--host` reads another target than the default.

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

`vitehub status` adds a `live` field and a `live` line, such as `live  4f2a9c0 (3 commits behind)`. `behind` and `ahead` come from `git rev-list --left-right --count <sha>...HEAD` when the commit is in the local repository. Otherwise `live.unknownReason` is `commit-not-local`, `no-marker`, or `no-git`. `status` asks the host only when the project is linked and the credentials resolve, and gives credential discovery and deployment lookup a shared 5-second budget. It follows the host’s production pointer even when that deployment is older than the recent history page. When it cannot read the host, `live` is `null` and `liveReason` is `offline`, `not-linked`, `no-credentials`, `no-live-deployment`, `timeout`, or `host-error`. The exit code stays `0`. Pass `--offline` to skip host requests and credential CLI discovery; the credential summary then uses environment variables only.

| Code | Cause and fix |
| --- | --- |
| [`SETUP_DEPLOYMENTS_NOT_LINKED`](/docs/cli/diagnostics/setup_deployments_not_linked) | The project has no host link, or no target for `--host`. Run `vitehub link`, or `vitehub link --host <host>`. The command exits with `2`. |
| [`SETUP_DEPLOYMENTS_CREDENTIALS_MISSING`](/docs/cli/diagnostics/setup_deployments_credentials_missing) | No token was found for the linked host. Run the login command or set the variable that the `fix` names. The command exits with `2`. |
| [`SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED`](/docs/cli/diagnostics/setup_deployments_account_required) | The Cloudflare account is not known. Set `CLOUDFLARE_ACCOUNT_ID`, or run `vitehub link --host cloudflare --account <id>`. The command exits with `2`. |
| [`SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED`](/docs/cli/diagnostics/setup_deployments_project_id_required) | The Netlify link has no site id. Run `vitehub link --host netlify`. The command exits with `2`. |
