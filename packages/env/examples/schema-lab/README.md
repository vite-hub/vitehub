# Environment contract lab

This runs the real Vite plugin and built Node server from one committed `.env.example`. It has no external services. The token shown below is synthetic.

From the repository root, build Env and run the lab's typecheck and production build. Server variables can remain unset for these commands:

```sh
corepack pnpm exec vp run --cache -t @vite-hub/env#build
corepack pnpm --dir packages/env/examples/schema-lab typecheck
corepack pnpm --dir packages/env/examples/schema-lab build
```

Start the compiled server with runtime values:

```sh
VITEHUB_API_TOKEN=synthetic-local-token VITEHUB_RETRIES=3 \
  corepack pnpm --dir packages/env/examples/schema-lab start
curl http://127.0.0.1:4317/api/config
```

Open `http://127.0.0.1:4317` to see Public Env from the browser bundle.

The response contains typed runtime values, `tokenConfigured: true` and `tokenRedacted: "<redacted>"`. It never returns the token. Stop the process, change `VITEHUB_RETRIES` or `VITEHUB_MODE`, and start the same output again. The server values change without rebuilding.

`VITEHUB_PUBLIC_APP_NAME` and `VITEHUB_PUBLIC_PLAN` are captured during the build. Changing them only when starting the server does not change Public Env. Set them before building if the browser needs different public values.

The server fails at startup when the token is missing, a required value is empty, or a value violates its type or constraints. `VITEHUB_TIMEOUT=` is optional and uses its default of `5`; an empty optional string remains empty. `@example` is documentation and never fills the token.

The package-owned production test builds this lab once, checks the generated consumer types, starts that artifact with two different runtime environments, checks failure cases, scans output for synthetic secret/example markers, and stops every child process:

```sh
corepack pnpm --dir packages/env exec vp test test/env-schema-production.test.ts --maxWorkers=1
```

The test requires the initial Env build above. It uses an operating-system-assigned production server port and does not start a development server.
