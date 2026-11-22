# @vite-hub/queue decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Node builds pass the resolved driver (`postgres`) as the hosting string, so inferDriver must map hosting `postgres` to the postgres driver

`inferDriver` in `packages/queue/src/config.ts`.

**Context:** `resolveQueueHosting()` returns the Node driver instead of a host name; the normalizer is called again with that value.

**Decision:** Node builds pass the resolved driver (`postgres`) as the hosting string, so inferDriver must map hosting `postgres` to the postgres driver.

**Consequences:** Removing the `hosting === "postgres"` branch makes a Node+Postgres build fall through to the Vercel driver.

## An options object with the former `provider` key and no `driver` throws QUEUE_RENAMED_PROVIDER_KEY instead of being ignored

`resolveDriver`, `createQueueClient` in `packages/queue/src/config.ts`, `packages/queue/src/runtime/create-client.ts`.

**Context:** Without `driver`, the driver is inferred from the host (or the client falls through to Vercel), so the renamed key would be dropped silently.

**Decision:** An options object with the former `provider` key and no `driver` throws QUEUE_RENAMED_PROVIDER_KEY instead of being ignored.

**Consequences:** Removing the check silently runs jobs on the wrong driver for configs written with `provider`.

## Contributed Queue modules must be absolute paths (or file: URLs) with a default export

`collectQueueContributions` in `packages/queue/src/contributions.ts`.

**Context:** The generated registry and types import the module by a path relative to the generated file and read its default export.

**Decision:** Contributed Queue modules must be absolute paths (or file: URLs) with a default export.

**Consequences:** Accepting relative paths or named exports produces a generated registry that imports the wrong file or undefined.

## Removed enqueue options (`id`, `delaySeconds`, `retentionSeconds`) are rejected at runtime when present

`queueUnsupportedOptionsError` in `packages/queue/src/errors.ts`.

**Context:** Untyped JavaScript callers can still pass them; ignoring them would run a delayed job at once or keep the default retention.

**Decision:** Removed enqueue options (`id`, `delaySeconds`, `retentionSeconds`) are rejected at runtime when present.

**Consequences:** Dropping the removed-option check turns old option names into silent behavior changes.

## Only `vite dev` keeps the message and stack of a plain Error in stored job errors; elsewhere a fixed message is stored

`QueueDeliveryErrorContext` in `packages/queue/src/internal/delivery-error.ts`.

**Context:** A plain Error message can hold private data, and stored errors reach the CLI, Console and job lists.

**Decision:** Only `vite dev` keeps the message and stack of a plain Error in stored job errors; elsewhere a fixed message is stored.

**Consequences:** Disclosing plain error messages outside development can leak private data through job inspection.

## The postgres engine key is the URL or the Database client object, and workers call refreshConnection on each poll to follow client replacement

`ResolvedConnection`, `usePostgresQueueEngine` in `packages/queue/src/internal/runtime/postgres-client.ts`.

**Context:** A Database can replace its client when its environment changes; workers must notice even when this instance never sends or reads jobs.

**Decision:** The postgres engine key is the URL or the Database client object, and workers call refreshConnection on each poll to follow client replacement.

**Consequences:** Keying by config only or dropping refreshConnection keeps workers on a stale, closed client.

## Postgres engine resolution is serialized per config through `state.pending`

`usePostgresQueueEngine` in `packages/queue/src/internal/runtime/postgres-client.ts`.

**Context:** Concurrent sends resolving at the same time would each create an engine and replace each other's engine.

**Decision:** Postgres engine resolution is serialized per config through `state.pending`.

**Consequences:** Parallel resolution leaks engines and closes an engine another send is still using.

## closePostgresQueues sets `closing` (admission closed) before awaiting pending resolutions, so no new engines or retirements can be added while it drains

`closePostgresQueues` in `packages/queue/src/internal/runtime/postgres-client.ts`.

**Context:** Queued resolutions call assertOpen after they resume; the sets are stable only because admission closed first.

**Decision:** closePostgresQueues sets `closing` (admission closed) before awaiting pending resolutions, so no new engines or retirements can be added while it drains.

**Consequences:** Reordering lets a pending resolution add an engine after close, leaking a connection and worker.

## A failed client creation removes its cache entry only if the entry is still the same pending promise

`getOrCreateQueueClient` in `packages/queue/src/internal/runtime/state.ts`.

**Context:** Runtime replacement can install a newer client while the failed creation was pending.

**Decision:** A failed client creation removes its cache entry only if the entry is still the same pending promise.

**Consequences:** Deleting unconditionally evicts the newer replacement client.

## `vite dev` runs every hosted driver (Cloudflare, Vercel, postgres) with the local engine and the delivery rules of the build's driver; a build keeps the configured driver

`resolveRuntimeQueueConfig` in `packages/queue/src/internal/vite-build.ts`.

**Context:** Dev runs in Node where Cloudflare and Vercel cannot deliver, and postgres apps should need no Postgres database in dev.

**Decision:** `vite dev` runs every hosted driver (Cloudflare, Vercel, postgres) with the local engine and the delivery rules of the build's driver; a build keeps the configured driver.

**Consequences:** Using the real driver in dev breaks Cloudflare/Vercel dev delivery or requires a Postgres DB; dropping `rules` loses host-faithful limits.

## The generated Nitro plugin starts postgres workers after the registry is set and hooks drain on Nitro close

`renderNitroPlugin` in `packages/queue/src/internal/vite-build.ts`.

**Context:** Workers load Queue Definitions from the registry as soon as they poll.

**Decision:** The generated Nitro plugin starts postgres workers after the registry is set and hooks drain on Nitro close.

**Consequences:** Starting workers before setQueueRuntimeRegistry makes the first claims fail with missing definitions.

## The Vercel consumer group name is derived from the Nitro function path `<route>.func`

`createVercelQueueConsumerRoutes` in `packages/queue/src/internal/vite-build.ts`.

**Context:** Nitro emits one function directory per route; the consumer group must match that function path (the older nested standalone segment is gone).

**Decision:** The Vercel consumer group name is derived from the Nitro function path `<route>.func`.

**Consequences:** A different consumer name makes Vercel deliver to a group no function serves.

## Queue operations import the runtime module lazily when they run

`(module)` in `packages/queue/src/operations.ts`.

**Context:** The runtime module reaches the Queue config that the generated server installs; the CLI and `vitehub inspect` list operations without a running server.

**Decision:** Queue operations import the runtime module lazily when they run.

**Consequences:** A static import makes listing operations require the generated runtime config.

## Only names that pass a safe-identifier check go into an error `why`

`(module)`, `loadNamedQueueDefinition` in `packages/queue/src/providers/cloudflare.ts`, `packages/queue/src/runtime/client.ts`.

**Context:** `why` text can reach public responses and Queue/binding names can come from external input.

**Decision:** Only names that pass a safe-identifier check go into an error `why`.

**Consequences:** Interpolating raw names exposes attacker-controlled text in public error responses.

## Cloudflare and Vercel delays/retention are rounded up to whole seconds (`ceil`)

`toSendOptions`, `createVercelQueueClient.send` in `packages/queue/src/providers/cloudflare.ts`, `packages/queue/src/providers/vercel.ts`.

**Context:** Both providers accept only whole seconds; rounding up never delivers earlier than asked.

**Decision:** Cloudflare and Vercel delays/retention are rounded up to whole seconds (`ceil`).

**Consequences:** Rounding down or sending fractions delivers early or is rejected by the provider.

## Cloudflare send returns no messageId

`createCloudflareQueueClient.send` in `packages/queue/src/providers/cloudflare.ts`.

**Context:** Cloudflare does not return the ID it assigns, and the handler receives Cloudflare's own ID, not a ViteHub one.

**Decision:** Cloudflare send returns no messageId.

**Consequences:** Returning the generated ViteHub ID would give callers an ID that never matches the delivered job.

## A dead job retried by hand gets its original retention, stored in `retentionMs` before the first manual retry refreshes `expiresAt`

`StoredJob`, `retry` in `packages/queue/src/providers/local.ts`.

**Context:** After a retry, `expiresAt - enqueuedAt` no longer equals the original retention.

**Decision:** A dead job retried by hand gets its original retention, stored in `retentionMs` before the first manual retry refreshes `expiresAt`.

**Consequences:** Recomputing retention from refreshed timestamps grows or shrinks retention on each retry.

## A job whose handler finished but whose file could not be deleted is marked `done`, stays in the map, and its file is deleted on the next start without running

`StoredJob`, `complete` in `packages/queue/src/providers/local.ts`.

**Context:** Keeping the job in memory and on disk as done prevents a second run in this process and after restart.

**Decision:** A job whose handler finished but whose file could not be deleted is marked `done`, stays in the map, and its file is deleted on the next start without running.

**Consequences:** Removing the done state makes a failed delete run the job again.

## Timer delays are capped at 2^31-1 ms

`(module)` in `packages/queue/src/providers/local.ts`.

**Context:** setTimeout fires immediately for larger delays.

**Decision:** Timer delays are capped at 2^31-1 ms.

**Consequences:** Removing the cap fires long-delayed jobs at once.

## Local delivery rules copy each host's documented defaults: Cloudflare 4 attempts (max_retries 3, not set), 128 KB minus ~100 B metadata payload, immediate retry; Vercel unlimited attempts (no maxDeliveries in the generated trigger) and 60 s retry (retryAfterSeconds default)

`localQueueDeliveryRules` in `packages/queue/src/providers/local.ts`.

**Context:** Dev must fail, retry and stop as the host does; sources are the Cloudflare and Vercel queue docs linked inline.

**Decision:** Local delivery rules copy each host's documented defaults: Cloudflare 4 attempts (max_retries 3, not set), 128 KB minus ~100 B metadata payload, immediate retry; Vercel unlimited attempts (no maxDeliveries in the generated trigger) and 60 s retry (retryAfterSeconds default).

**Consequences:** Changing a number makes dev behavior diverge from production, or setting max_retries/maxDeliveries in generated config would require updating these rules.

## Local jobs store and deliver a JSON round-trip copy of the payload

`toStoredPayload` in `packages/queue/src/providers/local.ts`.

**Context:** Jobs cross restarts, and hosted providers also deliver JSON, so handlers see the same shape (Dates become strings).

**Decision:** Local jobs store and deliver a JSON round-trip copy of the payload.

**Consequences:** Passing the original object makes dev handlers see types production never delivers.

## Accepted jobs whose files are not written yet (`writingKeys`) hold their idempotency key but are not delivered or listed

`createLocalQueueEngine` in `packages/queue/src/providers/local.ts`.

**Context:** A job must not run or be visible before `send()` has persisted it, yet concurrent sends must see the key.

**Decision:** Accepted jobs whose files are not written yet (`writingKeys`) hold their idempotency key but are not delivered or listed.

**Consequences:** Delivering before persistence can run a job whose send then fails and rolls back.

## Local and postgres poll timers are unref'd

`arm` in `packages/queue/src/providers/local.ts`, `packages/queue/src/providers/postgres.ts`.

**Context:** A pending job must not keep a finished script alive; a server process keeps itself alive.

**Decision:** Local and postgres poll timers are unref'd.

**Consequences:** Removing unref keeps CLI scripts and tests hanging until the next due job.

## Dead jobs drop their payload from memory; the file keeps it and readPayload reads it back on demand

`markDead` in `packages/queue/src/providers/local.ts`.

**Context:** Up to localQueueDeadLimit dead jobs per queue would otherwise hold payloads in memory.

**Decision:** Dead jobs drop their payload from memory; the file keeps it and readPayload reads it back on demand.

**Consequences:** Reading a dead job's payload from memory returns undefined if this changes without updating readPayload.

## The attempt count is persisted before the handler runs; a job already at (local) or above (postgres) the limit is marked dead without running

`deliver` in `packages/queue/src/providers/local.ts`, `packages/queue/src/providers/postgres.ts`.

**Context:** A handler that crashes the process would otherwise be retried forever as the last attempt is never recorded.

**Decision:** The attempt count is persisted before the handler runs; a job already at (local) or above (postgres) the limit is marked dead without running.

**Consequences:** Counting after the handler lets a process-killing job crash-loop all workers.

## The concurrency limit of a queue is read when its first job loads its Definition, then schedule() runs again to start the other due jobs

`deliver` in `packages/queue/src/providers/local.ts`.

**Context:** Before the Definition loads, the default concurrency of 1 applies.

**Decision:** The concurrency limit of a queue is read when its first job loads its Definition, then schedule() runs again to start the other due jobs.

**Consequences:** Removing the extra schedule() leaves due jobs waiting until another job ends.

## On recovery outside development, stored plain errors without a code are rewritten to the fixed redacted message

`recover` in `packages/queue/src/providers/local.ts`.

**Context:** A production server can reopen the job directory that `vite dev` wrote with full error details.

**Decision:** On recovery outside development, stored plain errors without a code are rewritten to the fixed redacted message.

**Consequences:** Removing the rewrite lets a production server expose dev-time error messages and stacks.

## Local enqueue is serialized through `enqueueTail`, and the tail continues after both success and failure

`enqueue` in `packages/queue/src/providers/local.ts`.

**Context:** Idempotency checks must see the result of persistence and rollback of earlier sends; a failed send must release admission so the key can be retried.

**Decision:** Local enqueue is serialized through `enqueueTail`, and the tail continues after both success and failure.

**Consequences:** Parallel enqueues can store duplicates; a tail that rejects blocks all later sends.

## Local `send()` returns only after all job files exist, and a partially failed batch deletes every file it wrote

`enqueue` in `packages/queue/src/providers/local.ts`.

**Context:** An accepted job must survive a crash right after send, and a retried failed send must not store jobs twice.

**Decision:** Local `send()` returns only after all job files exist, and a partially failed batch deletes every file it wrote.

**Consequences:** Returning before writes loses accepted jobs on crash; skipping rollback duplicates jobs on retry.

## Postgres job times are read as ISO strings via `to_json(col) #>> '{}'`

`JobRow`, `createPostgresQueueEngine` in `packages/queue/src/providers/postgres.ts`.

**Context:** A Database's Drizzle client returns timestamps as Postgres text, not Date, and parsers differ between clients.

**Decision:** Postgres job times are read as ISO strings via `to_json(col) #>> '{}'`.

**Consequences:** Selecting raw timestamp columns yields client-dependent formats in job lists.

## A `no_payload` flag distinguishes `send()` without a payload from a JSON null payload

`JobRow` in `packages/queue/src/providers/postgres.ts`.

**Context:** postgres.js reads SQL NULL and JSON null both as null.

**Decision:** A `no_payload` flag distinguishes `send()` without a payload from a JSON null payload.

**Consequences:** Removing the flag delivers `null` to handlers that were sent no payload.

## A `running` row whose lock expired is reported as `pending`

`toJobSummary` in `packages/queue/src/providers/postgres.ts`.

**Context:** An expired claim can be taken again even if its previous handler is still running.

**Decision:** A `running` row whose lock expired is reported as `pending`.

**Consequences:** Reporting it as running hides that another worker may start it.

## Table creation runs once per process under a transaction-scoped advisory lock

`ensureTable` in `packages/queue/src/providers/postgres.ts`.

**Context:** Concurrent cold starts of several instances would race on `create table/index if not exists`.

**Decision:** Table creation runs once per process under a transaction-scoped advisory lock.

**Consequences:** Removing the lock can fail cold starts with duplicate-object errors.

## The idempotency unique index is partial: only non-dead jobs hold a key; completed jobs are deleted

`ensureTable` in `packages/queue/src/providers/postgres.ts`.

**Context:** A dead job must not block a new send with the same key.

**Decision:** The idempotency unique index is partial: only non-dead jobs hold a key; completed jobs are deleted.

**Consequences:** A full unique index rejects new sends after a job died.

## The claim query uses a MATERIALIZED CTE with FOR UPDATE SKIP LOCKED LIMIT

`claim` in `packages/queue/src/providers/postgres.ts`.

**Context:** The planner can choose a nested loop that evaluates the locking LIMIT more than once, claiming more rows than slots.

**Decision:** The claim query uses a MATERIALIZED CTE with FOR UPDATE SKIP LOCKED LIMIT.

**Consequences:** Inlining the CTE can over-claim jobs beyond the concurrency limit.

## close() awaits the in-progress pump before draining `running`

`close` in `packages/queue/src/providers/postgres.ts`.

**Context:** A claim in progress adds its jobs to `running` only when it ends.

**Decision:** close() awaits the in-progress pump before draining `running`.

**Consequences:** Draining first misses just-claimed jobs, which then run after close.

## Lease renewals continue during the drain and stop after its deadline

`close` in `packages/queue/src/providers/postgres.ts`.

**Context:** Running jobs must keep their claim while draining, but unfinished jobs must expire so another instance takes them.

**Decision:** Lease renewals continue during the drain and stop after its deadline.

**Consequences:** Stopping renewals earlier lets another instance double-run draining jobs; never stopping holds claims of dead processes.

## Idempotent insert uses `on conflict ... do update set updated_at = updated_at` to lock the live row and return its message_id

`enqueue` in `packages/queue/src/providers/postgres.ts`.

**Context:** `do nothing` returns no row, so the existing job's ID would be lost.

**Decision:** Idempotent insert uses `on conflict ... do update set updated_at = updated_at` to lock the live row and return its message_id.

**Consequences:** Switching to `do nothing` makes duplicate sends return no messageId.

## pg_notify is called inside the insert transaction

`enqueue` in `packages/queue/src/providers/postgres.ts`.

**Context:** Postgres delivers the notification only on commit, so listeners never wake before rows are visible.

**Decision:** pg_notify is called inside the insert transaction.

**Consequences:** Notifying outside the transaction can wake workers before the jobs exist, or after a rollback.

## A null messageId from `@vercel/queue` is accepted as success with no ID

`parseVercelMessageId` in `packages/queue/src/providers/vercel.ts`.

**Context:** The SDK returns `messageId: null` when it accepts a message for deferred processing (HTTP 202).

**Decision:** A null messageId from `@vercel/queue` is accepted as success with no ID.

**Consequences:** Treating null as invalid reports accepted jobs as failures, prompting duplicate sends.

## When the Vercel SDK import fails with Node's 'dynamic import callback' TypeError, it falls back to a plain `import()`

`loadVercelQueueClient` in `packages/queue/src/providers/vercel.ts`.

**Context:** Node reports a missing dynamic import callback (e.g. inside a vm context) only via this TypeError message.

**Decision:** When the Vercel SDK import fails with Node's 'dynamic import callback' TypeError, it falls back to a plain `import()`.

**Consequences:** Removing the fallback makes Vercel SDK loading fail in those contexts.

## Cloudflare Queue listing paginates until result_info says to stop

`plan` in `packages/queue/src/provision.ts`.

**Context:** The Queues list accepts `page` but documents no page size.

**Decision:** Cloudflare Queue listing paginates until result_info says to stop.

**Consequences:** Stopping on a guessed page size misses existing queues and re-creates them.

## useDynamicQueue checks for a disabled Queue before loading the definition

`useDynamicQueue` in `packages/queue/src/runtime/client.ts`.

**Context:** A disabled Queue loads no definitions, so QUEUE_DEFINITION_NOT_FOUND would wrongly tell the developer to add an existing file.

**Decision:** useDynamicQueue checks for a disabled Queue before loading the definition.

**Consequences:** Reordering gives a misleading not-found error for disabled Queues.

## A provider failure while the client starts is returned as `[error, undefined]`; config errors still throw

`sendDynamicQueue` in `packages/queue/src/runtime/client.ts`.

**Context:** Runtime errors are returned from send APIs; config errors need a code or deployment change.

**Decision:** A provider failure while the client starts is returned as `[error, undefined]`; config errors still throw.

**Consequences:** Throwing provider failures breaks callers that handle the result tuple.

## The postgres client is imported through the `#vitehub/queue/node-client` subpath import

`createQueueClient` in `packages/queue/src/runtime/create-client.ts`.

**Context:** Node bundlers keep the driver, while Worker conditions resolve to a module without the optional postgres dependency.

**Decision:** The postgres client is imported through the `#vitehub/queue/node-client` subpath import.

**Consequences:** A direct import pulls postgres.js into Worker bundles.

## Queue operations and internal runtime modules are imported by generated code by file path and are excluded from package exports

`(module)`, `vite.config exports` in `packages/queue/src/vite.ts`, `packages/queue/vite.config.ts`.

**Context:** They are not public API; generated code resolves them by path.

**Decision:** Queue operations and internal runtime modules are imported by generated code by file path and are excluded from package exports.

**Consequences:** Adding them as exports makes them public API; removing ownModule paths breaks generated imports.

## postgres-Database detection runs when the Nitro config is made and again at buildStart, rewriting server plugins if the Default Database moved to or from Postgres

`hubQueue`, `hubQueue.buildStart` in `packages/queue/src/vite.ts`.

**Context:** The Database integration can resolve its Definitions after this plugin made the Nitro config.

**Decision:** postgres-Database detection runs when the Nitro config is made and again at buildStart, rewriting server plugins if the Default Database moved to or from Postgres.

**Consequences:** Reading only once can generate a local-driver server for a Postgres app or vice versa.

## Node server plugin writes are tracked by root, and buildStart rewrites them in the root that Nitro reads

`hubQueue`, `writes the Nitro plugin of the Nuxt project root again when the Database resolves at buildStart` in `packages/queue/src/vite.ts`, `packages/queue/test/vite.test.ts`.

**Context:** Nuxt makes the Nitro config in its project root but builds with Vite in its source directory.

**Decision:** Vite uses the Nuxt project root for discovery, generated files, and Vitest setup. Both passes name Definitions from that root. Node server plugin writes are tracked by root, and buildStart rewrites them in the root that Nitro reads.

**Consequences:** Writing to the Vite root leaves Nitro reading a stale plugin. Naming from the source directory can also make `app/sync` and `sync` collide.

## Nuxt state is stored per root and merged into an existing build state

`hubQueue` in `packages/queue/src/vite.ts`.

**Context:** Nuxt can configure Nitro after another project's Vite config resolves.

**Decision:** Nuxt state is stored per root and merged into an existing build state.

**Consequences:** Using a single global state mixes Definitions between projects.

## Contributions are collected again in configResolved from the resolved plugin list

`hubQueue.configResolved` in `packages/queue/src/vite.ts`.

**Context:** Plugins added by other plugins after the `config` hook appear only in the resolved list.

**Decision:** Contributions are collected again in configResolved from the resolved plugin list.

**Consequences:** Skipping the second collection drops Queue Definitions contributed by late-added plugins.

## Postgres integration tests are opt-in through VITEHUB_TEST_POSTGRES_URL against a local Postgres 17 container

`(module)` in `packages/queue/test/postgres.test.ts`.

**Context:** CI and default runs have no Postgres server.

**Decision:** Postgres integration tests are opt-in through VITEHUB_TEST_POSTGRES_URL against a local Postgres 17 container.

**Consequences:** Without the documented command, contributors cannot run the postgres tests.

## Vitest aliases `#vitehub/queue/node-client` to the source postgres-client module

`vitest alias` in `packages/queue/vitest.config.ts`.

**Context:** Source tests load and close the provider state directly, so they must share the same module instance as src.

**Decision:** Vitest aliases `#vitehub/queue/node-client` to the source postgres-client module.

**Consequences:** Resolving to dist creates a second module state the tests cannot close.
