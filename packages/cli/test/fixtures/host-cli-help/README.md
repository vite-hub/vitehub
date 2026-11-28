`--help` output of the host CLIs that `vitehub deploy`, `vitehub env diff`, and `vitehub env push` run, recorded on 2026-11-06 with color codes removed. `src/setup/deploy/*.ts` uses only the flags here. No test runs a real host CLI: `test/fixtures/fake-host-cli.cjs` stands in for all four.

- Wrangler 4.158.0 (the npx cache; the `wrangler` catalog entry in `pnpm-workspace.yaml` pins 4.147.0): `wrangler-deploy.txt`, `wrangler-versions-upload.txt`, `wrangler-secret-put.txt`, `wrangler-secret-list.txt` (restored from before #4069).
  - `--temporary` is a global flag that the help does not list. Wrangler's source names it in `WRANGLER_CLI.temporaryAccountFlag`, and a failed login suggests "rerun this command with `--temporary`". It prints `Claim within: <duration>` and `Claim URL: <url>`. Docs: https://developers.cloudflare.com/workers/wrangler/commands/#deploy
  - `secret put` reads the value from stdin when stdin is not a terminal, and creates a draft Worker without a prompt when the Worker does not exist (Wrangler source, `createDraftWorker`, `fallbackValue: true`). `secret list --format json` prints `[{ name, type }]`.
  - `WRANGLER_OUTPUT_FILE_PATH` gets one JSON object per line: `{ type: "deploy", version_id, targets }` or `{ type: "version-upload", version_id, preview_url }`.
- Wrangler 4.157.0 (the workspace install), recorded on 2026-11-13: `wrangler-d1-migrations-apply.txt`, for the `database.migrateOnDeploy` steps.
  - Without a terminal or with `CI` set, Wrangler skips the confirmation and applies. A failed migration exits with an error and keeps the migrations before it.
- Wrangler 4.160.1 (the workspace install), recorded on 2026-11-20: `wrangler-d1-execute.txt`, for the migrations table check of a deploy without `database.migrateOnDeploy`.
  - `--json` prints one `{ results, success, meta }` for each statement and sets the log level to errors only. `--json` also skips the confirmation. Wrangler names applied migrations by file name, `*.sql` in `migrations_dir` relative to the config file (`getD1MigrationFiles` in Wrangler's source). `wrangler deploy` does not compare them with the migrations table.
- Vercel CLI 65.11.0: `vercel-deploy.txt`, `vercel-env-add.txt`, `vercel-env-ls.txt` (restored from before #4069).
  - `deploy --json` prints `{ id, url, productionUrl }`, or `{ status, deployment }` without a terminal.
  - `env add` reads the value from stdin. ViteHub reads `envs[].key` and `envs[].target` from the last JSON object of `env ls --json`. The help says that output includes readable values, so its stdout never goes into an error. Not checked against a live account.
  - `deploy --temporary` keeps `{ projectId, token, claimUrl, expiresAt }` in `.vercel/anonymous.json`. It refuses in CI and in a folder with `.vercel/project.json`.
  - `vercel-project-inspect.txt` and `vercel-project-add.txt`, recorded on 2026-11-28, for the first deploy of a Vercel app with no link. `project inspect <name>` exits 1 when the project does not exist. `project add <name>` creates it: the help names it `project create`, and `add` still runs it, as it does in Vercel CLI 50.
- Netlify CLI 27.11.2: `netlify-deploy.txt`, `netlify-env-list.txt`, `netlify-env-import.txt`, recorded on 2026-11-15.
  - `env:list --context <context> --json` prints `{ KEY: value }`. `env:set` takes the value as an argument, and `env:import` deletes and creates each variable in every context (`dist/commands/env/env-import.js`), so `vitehub env push` writes through the API: https://open-api.netlify.com/#tag/environmentVariables
  - `deploy` adds `.netlify/functions-internal` and `.netlify/v1/functions` by itself. `--allow-anonymous` makes a password-protected claimable site, so `vitehub deploy` offers no temporary Netlify deploy.
- Deno Deploy CLI 0.0.9909 (`deno deploy`, Deno 2.9.7): `deno-deploy.txt`, and `deno-deploy-env-list.txt` and `deno-deploy-env-load.txt`, recorded on 2026-11-15.
  - `env add` takes the value as an argument. `env load <file>` reads a dotenv file with `@std/dotenv`, so a value goes through `/dev/stdin` as one single-quoted line. `env load` sets a variable for every context, `--replace` replaces an existing one without a prompt, and `--non-secrets` keeps a value readable; otherwise Deno decides from the name whether it is secret (`deploy/env.ts` in `jsr:@deno/deploy@0.0.9909`).

`vitehub deployments` and the `live` line of `vitehub status` read Cloudflare, Vercel, and Netlify through their REST APIs (see `test/fixtures/host-api/README.md`), and Deno through its CLI:

- Deno Deploy CLI 0.0.9909: `deno-deploy-deployments-list.txt` and `deno-deploy-apps-get.txt`. With `--json`, `deployments list` prints `{ items: [{ id, status, prod, createdAt, updatedAt, lastStep }], nextCursor, org, app }` and `apps get` prints `{ id, slug, org, productionUrl, domains, productionRevisionId, ... }` (the CLI source, `deploy/deployments.ts` and `deploy/apps.ts` in `jsr:@deno/deploy@0.0.9909`). Deno Deploy keeps no deploy message, so a Deno deployment has no commit marker.

When a `deploy.check` path fails, `vitehub deploy` prints the command that rolls production back. It runs none of them. Recorded on 2026-11-16:

- Wrangler 4.158.0: `wrangler-rollback.txt`. `wrangler rollback <version-id> --name <worker> --yes` takes the Worker version id.
- Vercel CLI 65.16.0: `vercel-rollback.txt`. `vercel rollback <deployment> --yes` takes the deployment id or URL.
- Netlify CLI 27.11.2: `netlify-api.txt`. Netlify has no rollback command; `netlify api restoreSiteDeploy --data '{"deploy_id":…,"site_id":…}'` calls `POST /sites/{site_id}/deploys/{deploy_id}/restore` (`netlify api --list` names it).
- Deno Deploy CLI 0.0.9909: `deno-deploy.txt` lists no rollback command, so the error names the revision to promote in the dashboard.
