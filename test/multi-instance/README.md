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
corepack pnpm exec vp run e2e:multi-instance --no-redis
```

Run both modes. The fixture selects the Redis KV driver when `REDIS_URL` is
set. Without Redis, KV infers the Postgres Default Database.

On Slimbook, run it through the shared lock:
`heavy corepack pnpm exec vp run e2e:multi-instance`.

The run takes a few minutes. It does these steps:

1. Starts Postgres 17 and Redis 7 from `compose.yaml` on free ports. With
   `--no-redis`, it starts only Postgres.
2. Packs the workspace packages and installs the fixture app from `app/` in a
   temporary directory outside the repository, with Nuxt 5 and the `node` preset.
3. Builds the app once with `nuxt build`.
4. Starts three instances of `.output/server/index.mjs` at the same time. Each
   instance has its own working directory, as if it ran on its own host.
5. Runs the checks and prints a table.
6. Stops the instances and removes the containers and the temporary directory.

Options:

- `--no-redis` runs without Redis. The build and the instances get no
  `REDIS_URL`.
- `--keep` keeps the temporary directory with the build and instance logs.
- `--app <dir>` reuses an app that an earlier `--keep` run built, and skips the
  pack, install and build steps. Use the same mode as that run, because the
  build reads `REDIS_URL`.
- `--only <id,id>` runs only these checks.

Put options after the task name, for example
`vp run e2e:multi-instance --no-redis --keep --only kv-shared`. `vp run` passes
them to the script.

## Checks

| Id | What must be true |
| --- | --- |
| `boot` | All three instances start and answer `/api/health`. The build and the instances see `REDIS_URL` only in the Redis mode, even when your shell sets it. |
| `queue-once` | 1,000 jobs sent to the queue through A each run exactly once. The table shows which instances ran them, as information only. It passes on `main` with every job on A, so it does not prove that the queue is shared. `queue-failover` proves that. |
| `rate-limit-shared` | A limit of 10 per minute allows exactly 10 of 60 requests that arrive at the same time, in two batches of 30 spread over the three instances. |
| `realtime-fanout` | A presence message sent on instance A reaches a peer that is connected to instance B. A second peer on A is the control. |
| `schedule-once` | Each schedule occurrence runs once, not once per instance. |
| `migrations-once` | Three cold starts apply the Database migrations once, and every instance can query the table. |
| `kv-shared` | A KV value written on instance A is read on instance B. |
| `blob-shared` | A Blob written on instance A is read on instance B, with a shared Blob store set in the config. |
| `workflow-shared` | With OpenWorkflow on Postgres set in the config, a worker starts on every instance, and a Workflow started on A completes once and B reads its result. |
| `queue-failover` | Jobs queued on A with a 5 second delay run on B or C after A stops. This check runs last, because it stops A. |

## What the instances share

On the `node` preset, the default file stores of Queue and Blob resolve
`.vitehub/data` from the working directory when the server starts. Three
processes in one directory would share these files by accident, without a lock.
Real instances run on different hosts and do not share them. So each instance
starts in its own working directory, and only these stores are shared:

- Postgres, through `DATABASE_URL`. The Database and OpenWorkflow use it.
- KV, through Redis at `REDIS_URL`, or the Postgres Default Database with `--no-redis`.
- Blob, set by hand in `app/nuxt.config.ts` to one `fs` directory, as a volume
  that every instance mounts.
- Workflow, set by hand to `provider: 'openworkflow'`. ViteHub does not start
  an OpenWorkflow worker on Node yet, so `app/server/plugins/openworkflow-worker.ts`
  starts one. Remove that plugin when #3839 lands, because then ViteHub starts
  the worker.

The fixture ships one migration in `app/server/databases/default/migrations/`. The
harness does not run `vitehub database migrate`, because `migrations-once` checks that
the instances apply it when they start. When you change the fixture schema,
build the app with `--keep`, run `pnpm exec vitehub database generate` in the kept
`app` directory, and copy the new files back.

The fixture app writes what happened to an `oracle_events` table in Postgres
with its own `postgres` client. The checks read this table, so the result does
not depend on the primitive under test.

## Known failures

`known-failing.json` lists the checks that fail on `main` today, with the
reason, in one list for each mode (`with-redis` and `without-redis`). The run
exits with code 1 when a check that is not on the list fails, and also when a
check on the list passes. So the list always matches `main`. When your change
makes a listed check pass, remove its entry in the same pull request.

The `flaky` list holds checks that pass or fail at random on `main`, in both
modes. They never change the exit code, and the table marks them `flaky`. Keep
this list short, and name the change that removes each entry.
