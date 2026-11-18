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

- `<dir>`: the app folder. A new or empty folder gets the app from [Installation](/docs/getting-started/installation): `package.json`, `vite.config.ts` with `vitehub({ host })`, `tsconfig.json`, `server/api/health.get.ts`, and a `.gitignore` that ignores every `.env*` file except `.env.example`. A folder with a Vite or Nuxt app keeps its files; `init` registers `vitehub()` or the Nuxt module in the config. Any other folder that is not empty exits with `3`.
- `--host`: `cloudflare`, `vercel`, `netlify`, `deno`, or `node`. It becomes `host`. An existing ViteHub stack with enabled features keeps its host; migrate its providers and Definitions by hand before changing the host.
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

Other commands load the project config the way `nuxt dev` does: in a Nuxt app, the `$development` overrides apply, so a command next to a running dev server resolves the same config and leaves its generated files alone. `--stage <name>` loads `$<name>` instead.

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
- `host`: the `host` from the config, else the host from the environment, as `detectHost()` reads it, else `node`. `source` tells which one. A dynamic host or config reports `name: "unknown"` and feature support with `level: "unknown"`.
- `link`, `targets`, and `default`: the host targets of `.vitehub/link.json`. `link` is the target that `vitehub deploy` uses without `--host`. See [Link a project to its host](#link-a-project-to-its-host).
- `live`: the deployment that receives production traffic of the `link` target, with its commit and how many commits it is `behind` and `ahead` of HEAD. See [List deployments](#list-deployments).
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

The command sets `<feature>: true`, or the object from `--option`. With `--name`, the starter Definition turns the feature on, so the command sets no `<feature>: true`. A feature that is already on gives no change, so a second run prints `"status": "unchanged"`. Features that an added feature turns on, such as Workflow for Agent, are listed in `implied`; the config names them when you supply their provider options. When an added feature requires Database, the command explicitly enables it if it was disabled. For example, on Netlify or Deno, `add comments` requires `--option database.connection.url=libsql://your-host` before writing the config.

The host decides what `add` accepts. A feature that the host does not support exits with `3`. A host that needs an explicit provider, such as Email on Vercel, exits with `2` and lists the option in `missing` with its `choices`. For Email, the choices are `resend` and `log`. `log` prints each message to the server log and sends nothing, for a build without an Email provider. When ViteHub can choose the values, `rerun` is a command that succeeds as it is, including any provider prerequisites. Node Schedules require `--option schedule.runtime.driver=process`, or `--option schedule.providerOutput=false` when you will wake them yourself.

Some host defaults build and run but keep state in one process. `nextSteps` names them, with the option that selects a durable driver. For example, Workspace on Vercel keeps files in memory until `BLOB_READ_WRITE_TOKEN` is set. A driver option that needs more packages, such as `blob.driver=s3`, adds them to the install.

`vitehub add console` sets `console: true`, so the app takes only [signed calls](/docs/development/console#sign-console-requests). Add `--option console.authorize=server/console-authorize.ts` to limit who may use which section. `--option console.auth=false` takes calls without a signature, for development only.

Observability papercut reports require Agent and Console. The command collects their provider inputs before applying these options.

Console does not enable Comments or Database. `vitehub add observability` registers Evlog. `--option observability.service=<name>` adds Agent telemetry, installs `@vite-hub/agent`, and supports Agents only when Nitro hosts them. Selecting PostHog installs `posthog-node` and enables Server Env. `--option observability.logs.source=./server/logs.ts` connects an existing log source for production. A Realtime starter enables Workspace; add the Workspace Definition named in its next steps.

When running a pkg.pr.new preview of the CLI, added ViteHub packages use the same preview reference.

### `SETUP_FEATURE_UNSUPPORTED`

The host of the project cannot provide the feature. Run `vitehub catalog` to see which hosts support it, or set `host` to another host.

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

`vitehub link` connects the project to a project on a host, so later commands know where to deploy. It runs on your machine with your host login. It does not add a CI workflow.

```bash [Terminal]
pnpm vitehub link
pnpm vitehub link --host cloudflare --account <id> --create
pnpm vitehub link --host vercel
pnpm vitehub unlink --host vercel
pnpm vitehub unlink
```

- `--host`: `cloudflare`, `vercel`, `netlify`, or `deno`. The default is the host that `vitehub status` reports.
- `--project`: the project name on the host. The default is the `name` of `vitehub({ name })`, else the package.json name, in the same form that the build uses.
- `--account`: the Cloudflare account id, the Vercel team id, or the Netlify team slug.
- `--create`: create the project when the host does not have it. Without it, a missing project exits with `3`.
- `--default`: make this host the target that `vitehub deploy` uses without `--host`. The first linked host is the default.

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

### `SETUP_LINK_HOST_UNSUPPORTED`

The host is `node`, a self-hosted server, which has no project to link. Pass `--host`, or set `host` in `vitehub()`. The command exits with `3`.

### `SETUP_LINK_HOST_REQUIRED`

The project links several hosts and none is the default, so `vitehub deploy` or `vitehub deployments` does not know which one to use. Pass `--host <host>`, or run `vitehub link --host <host> --default`. The command exits with `2` and lists the hosts in `missing[0].choices`.

### `SETUP_LINK_CREDENTIALS_MISSING`

No token was found in the environment or in the host CLI login. Run the login command or set the environment variable that the `fix` names. The command exits with `2` and lists the variables in `missing`.

### `SETUP_LINK_ACCOUNT_REQUIRED`

The Cloudflare token has access to more than one account, or to none. The command exits with `2` and lists the accounts in `missing[0].choices`. Run it again with `--account <id>`.

### `SETUP_LINK_NAME_REQUIRED`

The project name is not known, for example because `vitehub({ name })` is an expression. Pass `--project <name>`. The command exits with `2`.

### `SETUP_LINK_PROJECT_NOT_FOUND`

The host has no project with that name. Run the command in `rerun`, which adds `--create`, or pass `--project` with the name of a project that exists. The command exits with `3`.

## Deploy from your machine

`vitehub deploy` creates the missing resources of the app on one host target, builds the app for that host, then runs the deploy that the build wrote. It runs on your machine with your host login. It does not add a CI workflow.

```bash [Terminal]
pnpm vitehub deploy
pnpm vitehub deploy --host vercel
pnpm vitehub deploy --preview
pnpm vitehub deploy --push-env
pnpm vitehub deploy --temporary --yes --json
```

- `--host`: `cloudflare`, `vercel`, `netlify`, or `deno`. Without it, the command uses the default target of `.vitehub/link.json`, else the only target, else the host that `vitehub status` reports. With several targets and no default, it exits with `SETUP_LINK_HOST_REQUIRED`.
- `--preview`: a preview deploy instead of production. Deno has none. A preview does not push the checkout folders of `vitehub.lock`.
- `--push-env`: set every env value that is available locally on the host, also the names that the host has. See [Check Env before a deploy](#check-env-before-a-deploy).
- `--no-build`: deploy the build output that is there.
- `--no-provision`: do not create the missing host resources first.
- `--no-push`: do not check or push the checkout folders of `vitehub.lock`.
- `--no-check`: do not request the `deploy.check` paths after the deploy. See [Check the deployed app](#check-the-deployed-app).
- `--no-index-now`: do not send the sitemap URLs to IndexNow.
- `--temporary`: deploy without an account. Only Cloudflare and Vercel have it, and only when no credentials are found.
- `--yes`: deploy and create resources without the questions, and generate a missing `VITEHUB_SECRET`. Without a terminal, the command needs it and exits with `2` and a `rerun`.

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

### Create the host resources

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

### Check the deployed app

Set `deploy.check` in `vitehub()` to the paths that must work after each deploy. With `health`, deploy checks the health route first.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: {
    health: true,
    deploy: { check: ["/", "/api/products"] },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from "vite"
import { nitro } from "nitro/vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({
    health: true,
    deploy: { check: ["/", "/api/products"] },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({
    health: true,
    deploy: { check: ["/", "/api/products"] },
  })],
})
```
:::
::

After the upload, deploy requests each path on the deployed URL. A path must answer with a `2xx` status, after redirects. Deploy tries each path 4 times in 7 seconds, because a new version can take a few seconds to reach every location.

```txt [vitehub deploy]
Deployed my-app to cloudflare: https://my-app.example.workers.dev
Version: 6b1f2c84-0d3e-4a52-9a77-3c1e5f0b2d19
Checked /_vitehub/health: 200
Checked /: 200
Checked /api/products: 200
```

When a path fails, the new version already serves production. Deploy exits with `1` and `SETUP_DEPLOY_CHECK_FAILED`, and prints the command that puts the deployment that it replaced back on production. It does not run that command for you. It does not push the checkout folders and does not send URLs to IndexNow.

| Host | Rollback |
| --- | --- |
| Cloudflare | `npx wrangler rollback <version-id> --name <worker> --yes` |
| Vercel | `npx vercel rollback <deployment-id> --yes` |
| Netlify | `npx netlify api restoreSiteDeploy --data '{"deploy_id":"<id>","site_id":"<site>"}'` |
| Deno | No CLI command. Promote the revision that the error names in the Deno Deploy dashboard. |

Deploy reads the deployment that serves production before it uploads, with the credentials of the deploy. It needs a link in `.vitehub/link.json`. On a first deploy, or with a saved `vercel login` and no `VERCEL_TOKEN`, the error says that the previous deployment is not known: run `vitehub deployments` to find it. A failed `--preview` check does not change production, so it prints no rollback.

`--json` returns the checks in `checks`, and on a failure the rollback in `rollback`:

```json [vitehub deploy --json]
{
  "schemaVersion": 1,
  "host": "cloudflare",
  "url": "https://my-app.example.workers.dev",
  "checks": [
    { "path": "/_vitehub/health", "url": "https://my-app.example.workers.dev/_vitehub/health", "ok": false, "status": 503 }
  ],
  "rollback": {
    "previous": { "deploymentId": "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", "version": "bcf48806-b317-4351-9ee7-36e7d557d4de" },
    "command": "npx wrangler rollback bcf48806-b317-4351-9ee7-36e7d557d4de --name my-app --yes"
  },
  "error": { "code": "SETUP_DEPLOY_CHECK_FAILED" }
}
```

### Tell search engines about new pages

`deploy: { indexNow: true }` sends the URLs of your sitemap to [IndexNow](https://www.indexnow.org) after each production deploy that passes its checks. Bing, Yandex, Seznam, Naver, and Yep then crawl the pages again. It needs a string `publicUrl`, and a `/sitemap.xml` on that site: [`seo: { sitemap: true }`](/docs/frameworks-hosts/sitemap) serves one.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: {
    publicUrl: "https://shop.example.com",
    deploy: { indexNow: true },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from "vite"
import { nitro } from "nitro/vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({
    publicUrl: "https://shop.example.com",
    deploy: { indexNow: true },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({
    publicUrl: "https://shop.example.com",
    deploy: { indexNow: true },
  })],
})
```
:::
::

- The build serves the IndexNow key at `/<key>.txt`. The key comes from `publicUrl`, so each build serves the same key and you keep no file. The key is public: it only lets a sender submit URLs of your site.
- Deploy reads `<publicUrl>/sitemap.xml`, and the sitemaps of a sitemap index on the same site. It sends each URL of the site once, at most 10,000 in one request.
- A failed submission prints one line and does not fail the deploy. `--json` returns `indexNow: { submitted, status }`, or `indexNow: { error }`.
- A `--preview` or `--temporary` deploy sends nothing. `--no-index-now` skips it for one deploy.

### `SETUP_DEPLOY_CHECK_FAILED`

The app is deployed, and it serves production, but a `deploy.check` path did not answer with a `2xx` status. The `why` lists each failed path with its status or error. Run the rollback command in the `fix`, then fix the app and deploy again. `rollback` has the previous deployment. Pass `--no-check` only when the check itself is wrong. The command exits with `1`.

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

The build output is for another host than the deploy target, for example after `--no-build` with an output of an earlier build. Deploy again without `--no-build`. The command exits with `3`.

### `SETUP_DEPLOY_COMMAND_REJECTED`

The deploy command in the build output is not the one that ViteHub writes, so the command does not run it. The command exits with `1`.

### `SETUP_DEPLOY_FAILED`

A host CLI exited with an error. The reason shows its last lines. The command exits with `1`.

### `SETUP_DEPLOY_PROVISION_UNCHECKED`

A Provision Step could not read the host resources, so the deploy created, built, and deployed nothing. The reason names what is missing, such as `CLOUDFLARE_ACCOUNT_ID` for a `wrangler login` with several accounts, or `VERCEL_TOKEN` for a saved `vercel login`. `rerun` deploys with `--no-provision`. The command exits with `2`.

### `SETUP_DEPLOY_PROVISION_NEEDS_BUILD`

The deploy must create or change resources, but `--no-build` would deploy an output that was built without their ids. Nothing was created or deployed. Deploy again without `--no-build`. The command exits with `3`.

### `SETUP_DEPLOY_CHECKOUT_CONFLICT`

A checkout folder of `vitehub.lock` has a file with conflict markers or an open binary conflict. Nothing was built or deployed. Remove the markers, or run `vitehub resolve` for a binary file, then deploy again. `--no-push` deploys without the push. The command exits with `1`.

### `SETUP_DEPLOY_CHECKOUT_MODULE_FAILED`

The project installs `@vite-hub/workspace/checkout` or `vite-hub/workspace/checkout`, but the module does not load: it has a syntax error, a missing dependency, an error when it starts, or no `localCheckoutStatus` and `pushWorkspaces` exports. Nothing was built or deployed. Reinstall the dependencies and use the same version of the Workspace package as the CLI. `--no-push` deploys without the push. The command exits with `1`.

### `SETUP_DEPLOY_ENV_MISSING`

A required env name is on neither the host nor a local value for the stage. Nothing was deployed. Run `vitehub env push --host <host>`, set the name in the host dashboard, or set it in the shell or `.env.<stage>`. On a first deploy, every required name needs a local value. `missing` lists the names, and `env` the check. The command exits with `2`.

### `SETUP_DEPLOY_ENV_NOT_LINKED`

Deploy has values to set, but the Vercel, Netlify, or Deno project is not linked, so it cannot set them before the first deploy. Nothing was deployed. Run `vitehub link --host <host> --create`, then deploy again. The command exits with `2`.

### `SETUP_DEPLOY_PUSH_FAILED`

The app is deployed, but the Workspace push failed. `checkouts.error` has the code, message, and fix of the push. Fix the cause and run `vitehub push`. Do not deploy again. The command exits with `1`.

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

### `CLI_CONSOLE_LOGIN_FAILED`

The device flow did not finish: the Console did not answer, the person denied the code, or the code expired after 15 minutes. Run `vitehub login` again.

### `CLI_CONSOLE_SIGNED_OUT`

The CLI has no valid key for the Console: there is no saved key, or the Console answered `401` because the key expired or was revoked. Run `vitehub login`, or set `VITEHUB_CONSOLE_TOKEN`.

## Pull env values from a Console

A self-hosted Console can keep the env values of each app and stage when its operator turns them on. The hosted Console at console.vitehub.dev never stores values. `vitehub env pull --from console` writes the values of one stage to `.env.<stage>` with the key of `vitehub login`. It needs no project config.

```bash [Terminal]
vitehub env pull --from console                                # production of the only project of the key
vitehub env pull --from console --stage preview --project <id>
vitehub env pull --from console --yes                          # replace the file
```

```txt [Output]
Wrote 2 values of production to .env.production (mode 600): API_TOKEN, DATABASE_URL.
```

- Values retain literal dollar expressions, quotes and newlines when Vite loads the file. If dotenv cannot represent a value faithfully (such as a carriage return or a value containing every quote delimiter), the pull fails before writing the file.
- With `--yes`, the command replaces the file entry; it never writes through a symlink to another file.
- The command prints names, never values. The Console logs each value that it gives out, with the key and the person.
- You must be an owner or admin of the team. A member gets `CONSOLE_ENV_FORBIDDEN`.
- `--project` is needed when the key opens more than one project.
- In a git repository, git must ignore the file and must not track it. The command checks this before it calls the Console.

### `CLI_ENV_FILE_EXISTS`

`.env.<stage>` exists. Pass `--yes` to replace it. A replaced file gets mode `600`.

### `CLI_ENV_FILE_NOT_IGNORED`

git tracks `.env.<stage>`, or `.gitignore` does not cover it, so the values could be committed. Add `.env.*` to `.gitignore`, and run `git rm --cached .env.<stage>` for a tracked file.

### `CLI_ENV_PULL_FAILED`

The Console refused the pull. The message has the Console's code, such as `CONSOLE_ENV_VALUES_OFF` when the Console stores no values, or `CONSOLE_ENV_FORBIDDEN` for a member.

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

### `SETUP_DEPLOYMENTS_NOT_LINKED`

The project has no host link, or no target for `--host`. Run `vitehub link`, or `vitehub link --host <host>`. The command exits with `2`.

### `SETUP_DEPLOYMENTS_CREDENTIALS_MISSING`

No token was found for the linked host. Run the login command or set the variable that the `fix` names. The command exits with `2`.

### `SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED`

The Cloudflare account is not known. Set `CLOUDFLARE_ACCOUNT_ID`, or run `vitehub link --host cloudflare --account <id>`. The command exits with `2`.

### `SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED`

The Netlify link has no site id. Run `vitehub link --host netlify`. The command exits with `2`.
