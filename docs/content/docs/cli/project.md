---
title: Project commands
description: Create a ViteHub app, turn features on and off, link the app to its host, and deploy it from your machine with the vitehub CLI.
navigation.order: 2
navigation.group: Start
icon: i-lucide-folder-cog
---

Project commands work on the files of your app. They read `vite.config.*` or `nuxt.config.*` without running it, so they work before the app starts and when the config does not load.

## Create a project

`vitehub init` creates a ViteHub app in a folder, or sets up the Vite or Nuxt app that is already there. It runs from the `vite-hub` package, so it needs no install first.

```bash [Terminal]
pnpm dlx vite-hub init my-app --host cloudflare --features kv,queue --yes
pnpm dlx vite-hub init my-app --host vercel --features email --option email.driver=resend --yes --json
```

- `<dir>`: the app folder. A new or empty folder gets the app from [Installation](/docs/getting-started/installation): `package.json`, `vite.config.ts` with `vitehub({ preset })`, `tsconfig.json`, `server/api/health.get.ts`, and a `.gitignore`. A folder with a Vite or Nuxt app keeps its files; `init` registers `vitehub()` or the Nuxt module in the config. Any other folder that is not empty exits with `3`.
- `--host`: `cloudflare`, `vercel`, `netlify`, `deno`, or `node`. It becomes `preset`. An existing ViteHub stack with enabled features keeps its host; migrate its providers and Definitions by hand before changing the host.
- `--features`: feature ids separated by commas, as `vitehub catalog` lists them. `init` plans them in one step with `vitehub add`, so a feature that the host does not support exits with `3` before any file is written.
- `--option feature.key=value`: an option of a feature, such as `email.driver=resend`. Repeat it for more options.
- `--framework vite|nuxt`: the default is `vite`. For `nuxt`, `init` runs the pinned `nuxi init` with a pinned starter and the `5x` nightly channel, checks that it declares a Nuxt 5 version, then adds the `vite-hub/nuxt` module. Existing Nuxt apps must also declare a known Nuxt 5 version before any installation or config edit. A tag or an unsupported version stops adoption and leaves existing files for manual setup.
- `--pm pnpm|npm|yarn|bun`: the package manager. The default is the one that the folder uses, else the one that runs the command, else pnpm.
- `--no-install` skips the install. `nextSteps` gives the install command. `--dry-run` prints the plan and writes nothing.
- `--yes` applies the plan. Without a terminal, a missing input fails and names the flag, for example `Pass --host (cloudflare, vercel, netlify, deno, node) when running without an interactive terminal.` The command exits with `2` and gives `missing` and `rerun`.

`init` writes the command that creates the same stack into `README.md`, between `<!-- vitehub:stack -->` and `<!-- /vitehub:stack -->`. `vitehub status --json` returns it as `stack.command`. A second run of the same command changes nothing.

### `SETUP_INIT_DIR_NOT_EMPTY`

The folder has files but no Vite or Nuxt app, so `init` cannot create or adopt an app there. ViteHub never overwrites a file. Choose a new or empty folder. The command exits with `3`.

### `SETUP_INIT_FRAMEWORK_MISMATCH`

`--framework` names another framework than the app in the folder uses. Pass the framework of the app, or choose another folder. The command exits with `3`.

### `SETUP_INIT_HOST_MIGRATION`

`init` cannot change the host of an existing ViteHub stack with enabled features. Use its current host, or review and migrate the feature options, providers and Definitions in the config first. The command exits with `3` before installing packages or writing files.

### `SETUP_INIT_NUXT_VERSION`

The Nuxt app does not declare a known Nuxt 5 version. ViteHub stops before adoption and package installation. If the command created a scaffold, those files remain. Set `nuxt` to a Nuxt 5 version and run `init` on the folder again. The command exits with `3`.

## Read a project without loading it

`vitehub catalog` and `vitehub status` run before the CLI loads the project config. They work in an empty folder and on a config that throws, because they parse the config file and never run it.

```bash [Terminal]
pnpm vitehub catalog --json
pnpm vitehub status --json
```

`catalog` lists every feature key of `vitehub({...})`, the packages that it needs, and how each host supports it: `native`, `explicit` (an option chooses the provider), or `unsupported`. It needs no project.

`status` reads `vite.config.*` or `nuxt.config.*` in the current folder and reports the items below. With `vitehub.lock`, it also lists each checkout folder with its local changes and conflicts, read by the installed Workspace package without calling the app; `--json` puts them in `checkouts`. See [Work on Workspace files in a local folder](/docs/cli/primitives#work-on-workspace-files-in-a-local-folder).

`status` reports:

- `framework`: `vite`, `nuxt`, or `none`, from the config files and the dependencies.
- `config`: the file and the config form, or `manual` with the reason when the options are not an object literal.
- `host`: the `preset` from the config, else the host from the environment, as `detectHost()` reads it, else `node`. `source` tells which one. A dynamic preset or config reports `name: "unknown"` and feature support with `level: "unknown"`.
- `live`: the deployment that receives production traffic, with its commit and how many commits it is `behind` and `ahead` of HEAD. See [List deployments](#list-deployments).
- `features`: each feature as `on`, `off`, or `unknown`. The reason is `config` when the config sets the key, `default` when it does not (including file discovery in `server/`), and `implied` when another feature turns it on or may turn it on. Expressions and keys overridden by a spread are `unknown`; their implications remain uncertain, respecting explicit `false`. An enabled feature lists `missingPackages` and a `fix`, such as the install command.

With `--json`, a command prints exactly one JSON document on stdout, `{ "schemaVersion": 1, ... }`. A failure prints `{ "schemaVersion": 1, "error": { "code", "message", "why", "fix", "docs" } }`. The exit code is `0` when the command is done, `1` for an error, `2` when input is needed, `3` for an unsupported or conflicting change, and `4` for a stale plan.

## Add a feature

`vitehub add` turns on one or more features. It plans the change first, then installs the owner packages, creates the starter files, and edits the config last. It parses the config and never runs it.

```bash [Terminal]
pnpm vitehub add kv queue --dry-run
pnpm vitehub add queue --name welcome-email --yes
pnpm vitehub add email --option email.driver=resend --yes --json
```

- `--dry-run` prints the diff, or the plan with `--json`, and writes nothing.
- `--yes` applies the plan. In a terminal without `--yes`, the command shows the diff and asks. Without a terminal, or with `--json`, it prints the plan and exits with `2` and a `rerun` command that includes `--yes`.
- `--no-install` skips the install. The plan still lists the packages and the install command.
- `--name <name>` creates a starter Definition, such as `server/queues/<name>.ts`, for each feature that has Definitions: Agent, Database, Queue, Realtime, Schedule, and Workflow. In Nuxt, it uses the application server directory when literal `rootDir` and `serverDir` options make that directory known; unresolved directories require creating the Definition by hand. It never overwrites a file.
- `--option key=value` sets an option of the feature, such as `--option email.driver=resend`. With one feature, the feature name is optional. Dotted keys make nested objects.

The command sets `<feature>: true`, or the object from `--option`. A feature that is already on gives no change, so a second run prints `"status": "unchanged"`. Features that an added feature turns on, such as Workflow for Agent, are listed in `implied`; the config names them when you supply their provider options. When an added feature requires Database, the command explicitly enables it if it was disabled. For example, on Netlify or Deno, `add comments` requires `--option database.connection.url=libsql://your-host` before writing the config.

The host decides what `add` accepts. A feature that the host does not support exits with `3`. A host that needs an explicit provider, such as Email on Vercel, exits with `2` and lists the option in `missing` with its `choices`. When ViteHub can choose the values, `rerun` is a command that succeeds as it is, including any provider prerequisites. Node Schedules require `--option schedule.runtime.driver=process`, or `--option schedule.providerOutput=false` when you will wake them yourself.

Some host defaults build and run but keep state in one process. `nextSteps` names them, with the option that selects a durable provider. For example, Workflow on Node and Deno runs inline in the request process until you select OpenWorkflow, and Workspace on Vercel keeps files in memory until `BLOB_READ_WRITE_TOKEN` is set. A provider option that needs more packages, such as `workflow.provider=openworkflow` or `blob.driver=s3`, adds them to the install.

`vitehub add console` sets `console: true`, so the app takes only [signed calls](/docs/development/console#sign-console-requests). Add `--option console.authorize=server/console-authorize.ts` to limit who may use which section. `--option console.auth=false` takes calls without a signature, for development only.

Observability papercut reports require Agent and Console. The command collects their provider inputs before applying these options.

Console does not enable Comments or Database. `vitehub add observability` registers Evlog. `--option observability.service=<name>` adds Agent telemetry, installs `@vite-hub/agent`, and supports Agents only when Nitro hosts them. Selecting PostHog installs `posthog-node` and enables Server Env. `--option observability.logs.source=./server/logs.ts` connects an existing log source for production. A Realtime starter enables Workspace; add the Workspace Definition named in its next steps.

When running a pkg.pr.new preview of the CLI, added ViteHub packages use the same preview reference.

### `SETUP_FEATURE_UNSUPPORTED`

The host of the project cannot provide the feature. Run `vitehub catalog` to see which hosts support it, or set `preset` to another host.

### `SETUP_INPUT_NEEDED`

The command needs more input, such as a feature name or the provider option that the host needs. The JSON output lists the fields in `missing`, and `rerun` gives a command that works when ViteHub can choose a value.

### `SETUP_CONFIG_MANUAL`

`vitehub add` or `vitehub remove` cannot edit the config safely: there is no `vitehub()` call, there are two, or the options are not an object literal. The error gives the keys to paste into the `vitehub()` options, and the JSON output has them in `snippet`.

### `SETUP_FILE_EXISTS`

A starter Definition file exists and has other content, or another file already defines the same Definition, such as `src/database.ts` for the Default Database or `src/<name>.queue.ts` for a Queue. ViteHub never overwrites a file and never writes a second Definition. Choose another `--name`, or edit the file by hand.

### `SETUP_SERVER_DIR_MANUAL`

Nuxt's application server directory needs config evaluation, for example because `serverDir` is an expression or the app uses layers. Create the Definition in that directory and rerun without `--name`, or use literal directory options without layers.

### `SETUP_INSTALL_FAILED`

The package manager exited with an error. ViteHub did not write starter or config files. The package manager may have changed package manifests or lockfiles, including during an earlier successful install. Run the install command by hand to see the error.

### `SETUP_STALE_PLAN`

The config file changed between the plan and the write. Run the command again.

### `SETUP_PLAN_UNKNOWN`

The dev Setup page applied a plan id that the dev server does not have. A plan applies once, and a restart of the dev server drops its plans. Plan the change again.

### `SETUP_NOT_A_PROJECT`

The folder has no `package.json`, no `vite.config.*`, and no `nuxt.config.*`. Run the command in the folder of your Vite or Nuxt app.

### `SETUP_CONFIG_NOT_LITERAL`

The `vitehub()` options are not an object literal, for example a variable, a function call, or `mergeConfig()`. ViteHub does not run the config to read them. Write the options as an object literal, such as `vitehub({ kv: true })`, or edit the config by hand. `vitehub status` reports this case as `config.manual` and exits with `0`.

## Remove a feature

`vitehub remove` undoes `vitehub add`. It plans the change first, then edits the config, deletes the starter files, and uninstalls the packages last, so the app stops using the feature before its files go. It parses the config and never runs it.

```bash [Terminal]
pnpm vitehub remove queue --dry-run
pnpm vitehub remove queue --yes
pnpm vitehub remove workflow --force --yes --json
```

- `--dry-run`, `--yes`, and `--json` work as they do for `add`. Without a terminal and without `--yes`, the command exits with `2` and a `rerun` command.
- `--keep-files` keeps the starter Definitions.
- `--no-uninstall` keeps the packages. `nextSteps` has the uninstall command.
- `--force` turns the feature off while the app still uses it. It writes `<feature>: false` when another feature turns it on, and it keeps every file that the app wrote.

The command deletes the `vitehub()` key. A feature that is on without a key, such as Env, gets `<feature>: false`. A feature that only the removed feature turned on, such as Workflow for Agent, goes off too and is listed in `turnedOff`. When `add` was the last change, `remove` gives back the original bytes of the config, the starter files, and package.json.

`remove` deletes a file only when it is exactly a starter that `add` writes. It refuses with `3` while the app still uses the feature: an import of `vite-hub/<feature>` or of a package that only this feature needs, a changed or extra file in the Definition folder, such as `server/queues/`, or a discovered file, such as `server/comments.ts`. The error lists each file and line in `references`. It uninstalls a package only when no enabled feature declares it and no source file imports it.

When Nuxt directories cannot be resolved without running the config, for example with `srcDir`, layers, or a dynamic `serverDir`, removing a feature with Definitions or discovered files exits with `3` and `SETUP_SERVER_DIR_MANUAL`. Use literal directory options without layers, or pass `--force` to turn it off while leaving those files in place.

`remove` never deletes host resources, such as a D1 database or a KV namespace, the local data in `.vitehub/data`, host credentials, or `.vitehub/link.json`. `nextSteps` names the host resources to delete by hand.

### `SETUP_FEATURE_IMPLIED`

Another enabled feature turns the feature on, such as Agent for Workflow, so deleting its key changes nothing. Remove the other feature too, or pass `--force` to write `<feature>: false`. The JSON output names the other features in `impliedBy`.

### `SETUP_FEATURE_IN_USE`

The app still uses the feature. `references` lists each file, with the line and the module for an import. Delete or move them and run the command again, or pass `--force` to turn the feature off and keep the files.

### `SETUP_FEATURE_REQUIRED`

An enabled feature's options require the feature, such as `cache: { driver: "kv" }` requiring KV. Remove both features in one command, or change the dependent options first. `--force` cannot remove these prerequisites.

### `SETUP_UNINSTALL_FAILED`

The package manager exited with an error after ViteHub deleted the starter files. The terminal command changes the config before uninstalling. The development Setup page keeps the config unchanged until cleanup succeeds, so a config-triggered restart cannot interrupt cleanup. Run the uninstall command by hand to see the error, then plan the removal again.

## Use Setup during development

`vite dev` adds the Setup endpoints below `/__vitehub/setup`. They plan and apply the same feature changes as `vitehub add` and `vitehub remove`, with the same JSON documents. They exist only on the development server, never in a build.

Only a page of the development server itself, such as a DevTools panel, can call them. A page on another origin gets `403`, and the hosted Console too. The endpoints send no CORS headers. Apply also needs writable Setup access under the project's Console policy.

A page gets its session token only over a loopback TCP connection. For a remote dev server, forward its port to your machine, for example `ssh -L 5173:127.0.0.1:5173 user@dev-server`, then open `http://localhost:5173`. A host name that `server.allowedHosts` lists one by one also works over the local connection, HTTP included. Listing a host does not give network clients the session token.

## Link a project to its host

`vitehub link` connects the project to a project on its host, so later commands know where to deploy. It runs on your machine with your host login. It does not add a CI workflow.

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

### `SETUP_LINK_HOST_UNSUPPORTED`

The host is `node`, a self-hosted server, which has no project to link. Pass `--host`, or set `preset` in `vitehub()`. The command exits with `3`.

### `SETUP_LINK_CREDENTIALS_MISSING`

No token was found in the environment or in the host CLI login. Run the login command or set the environment variable that the `fix` names. The command exits with `2` and lists the variables in `missing`.

### `SETUP_LINK_ACCOUNT_REQUIRED`

The Cloudflare token has access to more than one account, or to none. The command exits with `2` and lists the accounts in `missing[0].choices`. Run it again with `--account <id>`.

### `SETUP_LINK_NAME_REQUIRED`

The project name is not known, for example because `vitehub({ name })` is an expression. Pass `--project <name>`. The command exits with `2`.

### `SETUP_LINK_PROJECT_NOT_FOUND`

The host has no project with that name. Run the command in `rerun`, which adds `--create`, or pass `--project` with the name of a project that exists. The command exits with `3`.

## Deploy from your machine

`vitehub deploy` builds the app, then runs the deploy that the build wrote for its host. It runs on your machine with your host login. It does not add a CI workflow.

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
| Cloudflare | `wrangler deploy --config ./server/wrangler.json` from `commands.deploy` in `.output/nitro.json`, with `--tag` and `--message` for the commit. `--preview` runs `wrangler versions upload`. |
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

### `SETUP_DEPLOY_HOST_UNSUPPORTED`

The host is `node`. Start the server in `.output` yourself. The command exits with `3`.

### `SETUP_DEPLOY_CREDENTIALS_MISSING`

No token was found. Run the login command or set the variable that the `fix` names. On Cloudflare and Vercel, `rerun` is a temporary deploy that needs no account. The command exits with `2`.

### `SETUP_DEPLOY_TEMPORARY_UNSUPPORTED`

The host has no temporary deploy, `--preview` was passed, credentials were found, or the Vercel CLI refuses it (in CI, or in a folder with `.vercel/project.json`). The command exits with `3`.

### `SETUP_DEPLOY_PREVIEW_UNSUPPORTED`

The Deno deploy that the build writes always goes to production. The command exits with `3`.

### `SETUP_DEPLOY_ORG_REQUIRED`

Set `DENO_DEPLOY_ORG`, or run `vitehub link --host deno --account <org>`. The command exits with `2`.

### `SETUP_DEPLOY_BUILD_FAILED`

The build script failed, or package.json has no `build` script. The command exits with `1`.

### `SETUP_DEPLOY_OUTPUT_MISSING`

The build output has no `deployment.json` or no deploy command for the host. Build again. The command exits with `1`.

### `SETUP_DEPLOY_HOST_MISMATCH`

The configured host conflicts with the link, or the build output is for another host. A configured host conflict is rejected before building or uploading existing output. The command exits with `3`.

### `SETUP_DEPLOY_COMMAND_REJECTED`

The deploy command in the build output is not the one that ViteHub writes, so the command does not run it. The command exits with `1`.

### `SETUP_DEPLOY_FAILED`

A host CLI exited with an error. The reason shows its last lines. The command exits with `1`.

### `SETUP_DEPLOY_CHECKOUT_CONFLICT`

A checkout folder of `vitehub.lock` has a file with conflict markers or an open binary conflict. Nothing was built or deployed. Remove the markers, or run `vitehub resolve` for a binary file, then deploy again. `--no-push` deploys without the push. The command exits with `1`.

### `SETUP_DEPLOY_CHECKOUT_MODULE_FAILED`

The project installs `@vite-hub/workspace/checkout` or `vite-hub/workspace/checkout`, but the module does not load: it has a syntax error, a missing dependency, an error when it starts, or no `localCheckoutStatus` and `pushWorkspaces` exports. Nothing was built or deployed. Reinstall the dependencies and use the same version of the Workspace package as the CLI. `--no-push` deploys without the push. The command exits with `1`.

### `SETUP_DEPLOY_PUSH_FAILED`

The app is deployed, but the Workspace push failed. `checkouts.error` has the code, message, and fix of the push. Fix the cause and run `vitehub push`. Do not deploy again. The command exits with `1`.

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

`vitehub status` adds a `live` field and a `live` line, such as `live  4f2a9c0 (3 commits behind)`. `behind` and `ahead` come from `git rev-list --left-right --count <sha>...HEAD` when the commit is in the local repository. Otherwise `live.unknownReason` is `commit-not-local`, `no-marker`, or `no-git`. `status` asks the host only when the project is linked and the credentials resolve, and gives credential discovery and deployment lookup a shared 5-second budget. It follows the host’s production pointer even when that deployment is older than the recent history page. When it cannot read the host, `live` is `null` and `liveReason` is `offline`, `not-linked`, `no-credentials`, `no-live-deployment`, `timeout`, or `host-error`. The exit code stays `0`. Pass `--offline` to skip host requests and credential CLI discovery; the credential summary then uses environment variables only.

### `SETUP_DEPLOYMENTS_NOT_LINKED`

The project has no host link. Run `vitehub link`. The command exits with `2`.

### `SETUP_DEPLOYMENTS_CREDENTIALS_MISSING`

No token was found for the linked host. Run the login command or set the variable that the `fix` names. The command exits with `2`.

### `SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED`

The Cloudflare account is not known. Set `CLOUDFLARE_ACCOUNT_ID`, or run `vitehub link --host cloudflare --account <id>`. The command exits with `2`.

### `SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED`

The Netlify link has no site id. Run `vitehub link --host netlify`. The command exits with `2`.
