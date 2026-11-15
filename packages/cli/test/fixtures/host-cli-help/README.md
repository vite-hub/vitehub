`--help` output of the host CLIs that `vitehub deploy` runs, recorded on 2026-11-06 with color codes removed. `src/setup/deploy/*.ts` uses only the flags here. No test runs a real host CLI: `test/fixtures/fake-host-cli.cjs` stands in for all four.

- Wrangler 4.158.0 (the npx cache; the `wrangler` catalog entry in `pnpm-workspace.yaml` pins 4.147.0): `wrangler-deploy.txt`, `wrangler-versions-upload.txt`.
  - `--temporary` is a global flag that the help does not list. Wrangler's source names it in `WRANGLER_CLI.temporaryAccountFlag`, and a failed login suggests "rerun this command with `--temporary`". It prints `Claim within: <duration>` and `Claim URL: <url>`. Docs: https://developers.cloudflare.com/workers/wrangler/commands/#deploy
  - `WRANGLER_OUTPUT_FILE_PATH` gets one JSON object per line: `{ type: "deploy", version_id, targets }` or `{ type: "version-upload", version_id, preview_url }`.
- Wrangler 4.157.0 (the workspace install), recorded on 2026-11-13: `wrangler-d1-migrations-apply.txt`, for the `database.migrateOnDeploy` steps.
  - Without a terminal or with `CI` set, Wrangler skips the confirmation and applies. A failed migration exits with an error and keeps the migrations before it.
- Vercel CLI 65.11.0: `vercel-deploy.txt`.
  - `deploy --json` prints `{ id, url, productionUrl }`, or `{ status, deployment }` without a terminal.
  - `deploy --temporary` keeps `{ projectId, token, claimUrl, expiresAt }` in `.vercel/anonymous.json`. It refuses in CI and in a folder with `.vercel/project.json`.
- Netlify CLI 27.11.2: `netlify-deploy.txt`.
  - `deploy` adds `.netlify/functions-internal` and `.netlify/v1/functions` by itself. `--allow-anonymous` makes a password-protected claimable site, so `vitehub deploy` offers no temporary Netlify deploy.
- Deno Deploy CLI 0.0.9909 (`deno deploy`, Deno 2.9.7): `deno-deploy.txt`.

`vitehub deployments` and the `live` line of `vitehub status` read Cloudflare, Vercel, and Netlify through their REST APIs (see `test/fixtures/host-api/README.md`), and Deno through its CLI:

- Deno Deploy CLI 0.0.9909: `deno-deploy-deployments-list.txt` and `deno-deploy-apps-get.txt`. With `--json`, `deployments list` prints `{ items: [{ id, status, prod, createdAt, updatedAt, lastStep }], nextCursor, org, app }` and `apps get` prints `{ id, slug, org, productionUrl, domains, productionRevisionId, ... }` (the CLI source, `deploy/deployments.ts` and `deploy/apps.ts` in `jsr:@deno/deploy@0.0.9909`). Deno Deploy keeps no deploy message, so a Deno deployment has no commit marker.
