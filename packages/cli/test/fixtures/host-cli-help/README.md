`--help` output of the host CLIs that `vitehub deploy` runs, recorded on 2026-11-06 with color codes removed. `src/setup/deploy/*.ts` uses only the flags here. No test runs a real host CLI: `test/fixtures/fake-host-cli.cjs` stands in for all four.

- Wrangler 4.158.0 (the npx cache; `.github/ci-tools/package.json` pins 4.151.1): `wrangler-deploy.txt`, `wrangler-versions-upload.txt`, `wrangler-secret-put.txt`, `wrangler-secret-list.txt`.
  - `--temporary` is a global flag that the help does not list. Wrangler's source names it in `WRANGLER_CLI.temporaryAccountFlag`, and a failed login suggests "rerun this command with `--temporary`". It prints `Claim within: <duration>` and `Claim URL: <url>`. Docs: https://developers.cloudflare.com/workers/wrangler/commands/#deploy
  - `secret put` reads the value from stdin when stdin is not a terminal, and creates a draft Worker without a prompt when the Worker does not exist (Wrangler source, `createDraftWorker`, `fallbackValue: true`).
  - `WRANGLER_OUTPUT_FILE_PATH` gets one JSON object per line: `{ type: "deploy", version_id, targets }` or `{ type: "version-upload", version_id, preview_url }`.
- Vercel CLI 65.11.0: `vercel-deploy.txt`, `vercel-env-add.txt`, `vercel-env-ls.txt`.
  - `deploy --json` prints `{ id, url, productionUrl }`, or `{ status, deployment }` without a terminal.
  - `deploy --temporary` keeps `{ projectId, token, claimUrl, expiresAt }` in `.vercel/anonymous.json`. It refuses in CI and in a folder with `.vercel/project.json`.
  - Function `environment` in `.vc-config.json`: https://vercel.com/docs/build-output-api/primitives#serverless-function-configuration
- Netlify CLI 27.11.2: `netlify-deploy.txt`, `netlify-env-set.txt`.
  - `env:set` takes the value as an argument, so the secret goes through the API: https://open-api.netlify.com/#tag/environmentVariables
  - `deploy` adds `.netlify/functions-internal` and `.netlify/v1/functions` by itself. `--allow-anonymous` makes a password-protected claimable site, so `vitehub deploy` offers no temporary Netlify deploy.
- Deno Deploy CLI 0.0.9909 (`deno deploy`, Deno 2.9.7): `deno-deploy.txt`, `deno-deploy-env.txt`.
  - `env add` takes the value as an argument. `env load <file>` reads a dotenv file, so the secret goes through `/dev/stdin`.
  - Exit code 4 means NOT_FOUND: https://docs.deno.com/runtime/reference/cli/deploy/#agent--ci-usage
