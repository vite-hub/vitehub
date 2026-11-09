# Multi-instance harness

This harness runs one ViteHub app as three Node instances that share one
Postgres and one Redis. It checks that each primitive acts as one application
across the instances, and not as three separate processes.

It is the oracle for the work that makes ViteHub safe on several Node
instances. It is opt-in. The default `vp test` run does not include it.

## Run it

You need Docker with Compose, and built packages.

```bash
corepack pnpm exec vp run build
corepack pnpm exec vp run e2e:multi-instance
```

On Slimbook, run it through the shared lock:
`heavy corepack pnpm exec vp run e2e:multi-instance`.

The run takes a few minutes. It does these steps:

1. Starts Postgres 17 and Redis 7 from `compose.yaml` on free ports.
2. Packs the workspace packages and installs the fixture app from `app/` in a
   temporary directory outside the repository, with Nuxt 5 and the `node` preset.
3. Builds the app once with `nuxt build`.
4. Starts three instances of `.output/server/index.mjs` at the same time. Each
   instance has its own working directory, as if it ran on its own host.
5. Runs the checks and prints a table.
6. Stops the instances and removes the containers and the temporary directory.

Options:

- `--keep` keeps the temporary directory with the build and instance logs.
- `--app <dir>` reuses an app that an earlier `--keep` run built, and skips the
  pack, install and build steps.
- `--only <id,id>` runs only these checks.

To pass options, run the script directly after a build, for example
`node test/multi-instance/run.mjs --keep --only kv-shared`.

## Checks

| Id | What must be true |
| --- | --- |
| `boot` | All three instances start and answer `/api/health`. |
| `queue-once` | 1,000 jobs sent to the queue each run exactly once, and more than one instance runs jobs. |
| `rate-limit-shared` | A limit of 10 per minute allows 10 requests in total across the three instances. |
| `realtime-fanout` | A presence message sent on instance A reaches a peer that is connected to instance B. A second peer on A is the control. |
| `schedule-once` | Each schedule occurrence runs once, not once per instance. |
| `migrations-once` | Three cold starts apply the Database migrations once, and every instance can query the table. |
| `kv-shared` | A KV value written on instance A is read on instance B. |
| `blob-shared` | A Blob written on instance A is read on instance B, with a shared Blob store set in the config. |
| `workflow-shared` | With OpenWorkflow on Postgres set in the config, a worker starts on every instance, and a Workflow started on A completes once and B reads its result. |

## What the instances share

On the `node` preset, the default file stores of Queue, KV and Blob resolve
`.vitehub/data` from the working directory when the server starts. Three
processes in one directory would share these files by accident, without a lock.
Real instances run on different hosts and do not share them. So each instance
starts in its own working directory, and only these stores are shared:

- Postgres, through `DATABASE_URL`. The Database and OpenWorkflow use it.
- Redis, through `REDIS_URL`. No primitive reads it yet. It is there for the
  Redis drivers that come next.
- Blob, set by hand in `app/nuxt.config.ts` to one `fs` directory, as a volume
  that every instance mounts.
- Workflow, set by hand to `provider: 'openworkflow'`. ViteHub does not start
  an OpenWorkflow worker on Node yet, so `app/server/plugins/` starts one.

The fixture ships one migration in `app/server/databases/migrations/`. The
harness does not run `vitehub db migrate`, because `migrations-once` checks that
the instances apply it when they start. When you change the fixture schema,
build the app with `--keep`, run `pnpm exec vitehub db generate` in the kept
`app` directory, and copy the new files back.

The fixture app writes what happened to an `oracle_events` table in Postgres
with its own `postgres` client. The checks read this table, so the result does
not depend on the primitive under test.

## Known failures

`known-failing.json` lists the checks that fail on `main` today, with the
reason. The run exits with code 1 only when a check that is not on this list
fails. When your change makes a listed check pass, the run tells you. Remove the
entry in the same pull request.
