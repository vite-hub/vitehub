# @vite-hub/workflow decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Retired Workflow diagnostic codes

`workflowErrorDiagnostics` in `packages/workflow/src/error-diagnostics.ts`.

**Context:** The only record of retired codes is a comment above the catalog. No test or script reads it; each retired code appears only in that comment.

**Decision:** Published codes stay stable. Retired codes must never be reused: WORKFLOW_B0001, WORKFLOW_R0002, WORKFLOW_R0007, WORKFLOW_C0018, WORKFLOW_C0019, WORKFLOW_R0016, WORKFLOW_R0031, WORKFLOW_R0032, WORKFLOW_R0033, WORKFLOW_R0034, WORKFLOW_R0035.

**Consequences:** Deleting the comment loses the list, and a new code can reuse an identifier that old docs links and user logs still point to.

## Workflow DevKit drops `..` segments from Workflow and step IDs

`createVercelWorkflowTransformPlugin`, `ConfiguredWorkflowBuilder` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** Workflow DevKit computes Workflow and step IDs from the path relative to the working directory and removes `..` segments for files outside it.

**Decision:** The ViteHub SWC transforms compute the same relative path and filter `..` segments, so their IDs match the native Workflow build.

**Consequences:** Dropping the filter makes IDs differ from the native build for files outside the project root, and a start or a step lookup fails at runtime.

## Workflow DevKit resolves its builtins from the application root

`withVercelWorkflowPackageLink` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** Workflow DevKit looks for `workflow/internal/builtins` from the app root, even when a framework owns the `workflow` dependency.

**Decision:** ViteHub links the package that it resolves itself into the app root before the native build.

**Consequences:** Without the link, a native build in an app that does not list `workflow` directly cannot find the builtins.

## ViteHub bundles Workflow DevKit steps with its own resolution

`ConfiguredWorkflowBuilder`, `ConfiguredWorkflowBuilder.createWorkflowsBundle` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** Workflow DevKit bundles steps with its own esbuild plugins only and has no esbuild define option. Its SWC step transform drops the bare imports of the registration entry, which it passes as stdin.

**Decision:** The builder subclass bundles steps with ViteHub resolution (`?markdown-template`, missing optional peers such as @vite-hub/kv in @vite-hub/agent), keeps step files of `sideEffects: false` packages as side-effect entries, skips the SWC plugin for the registration entry, and applies defines to the interim VM bundle text.

**Consequences:** Removing any override breaks step registration or app-code imports in native Vercel builds.

## Native Vercel step options are literals and the step timeout is ViteHub's

`renderVercelNativeStep` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** The Workflow VM does not load step files. Workflow DevKit reads `maxRetries` from the step function and has no step timeout.

**Decision:** The generated native step writes options as literals and runs the step body with the ViteHub timer, imported only inside the step.

**Consequences:** Importing the step file or the timer at module level in the VM bundle breaks the VM; dropping the timer loses step timeouts on Vercel.

## Delayed starts: providers without a delay sleep first

`createVercelNativeWorkflowContents`, `startVercelWorkflow`, `runCloudflareWorkflow` in `packages/workflow/src/internal/vite-build.ts`, `packages/workflow/src/runtime/cloudflare-runner.ts`, `packages/workflow/src/runtime/vercel.ts`.

**Context:** Workflow DevKit `start()` has no delay. The generated native entry of a folder Workflow calls, before its first step, the global function that Workflow DevKit `sleep()` calls inside the VM (it does not import `workflow`, because every host bundles the file through the registry). A native entry that the developer wrote cannot sleep first. On Cloudflare a delayed start uses `step.sleepUntil`; a sleeping instance does not count toward the concurrency limit, and on replay the finished sleep returns at once.

**Decision:** Delayed starts are implemented as a first sleep on Vercel (generated entries only) and Cloudflare. A developer-written native entry rejects a delay with WORKFLOW_OPERATION_UNSUPPORTED.

**Consequences:** Importing `workflow` in the generated file breaks non-Vercel hosts; allowing a delay for developer-written native entries silently starts the run at once.

## Workspace runtime is imported only for the Shell loader

`createWorkflowRegistryContents` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** A Workflow-only app, or one with only a Sandbox Task, does not install @vite-hub/workspace.

**Decision:** The registry imports the Workspace runtime only when a Shell Workspace dependency exists, the one loader that the Workspace runtime reads.

**Consequences:** An unconditional import breaks the build of apps without @vite-hub/workspace (registry.test.ts covers it).

## Generated Cloudflare runner loads cloudflare:workflows lazily and sets `cause` by hand

`renderProviderEntry`, `runViteHubWorkflowDefinition` in `packages/workflow/src/internal/vite-build.ts`, `packages/workflow/test/cloudflare-generated-errors.test.ts`.

**Context:** A prerender build loads the generated module in Node.js, which has no `cloudflare:workflows`. The native NonRetryableError constructor takes two arguments and ignores a third ErrorOptions argument.

**Decision:** The generated code imports `cloudflare:workflows` inside the run function and defines `cause` with Object.defineProperty.

**Consequences:** A top-level import breaks prerender builds; passing `{ cause }` to the constructor loses the cause.

## Nitro writes its Vercel and Wrangler config after the native Workflow build

`buildVercelNativeWorkflowOutput`, `addVercelWorkflowWebhookRoute`, `createCloudflareWorkflowCleanup` in `packages/workflow/src/internal/vite-build.ts`, `packages/workflow/src/vite.ts`.

**Context:** Nitro writes `.vercel/output/config.json` and its routes after the native Workflow functions, and it has already written the shared Wrangler config with the Workflow bindings when the Workflow Worker is inside Nitro.

**Decision:** ViteHub starts from an empty Vercel config in a Nitro build, adds the Workflow DevKit webhook route through Nitro options (only a native entry creates it), and owns no Wrangler keys when Nitro holds the Workflows.

**Consequences:** Writing routes directly or owning Wrangler keys in a Nitro build gets overwritten or overwrites Nitro's config.

## Native Vercel IDs come from the published source path

`publishGeneratedArtifacts`, `publishedSource`, `prepareVercelNitroRegistry`, `retainedSources` in `packages/workflow/src/internal/vite-build.ts`, `packages/workflow/src/vite.ts`.

**Context:** Native Vercel Workflow and step IDs come from the source path. The retained source copy has a new path on every build. The flow function holds IDs of the published `.vitehub/workflow/sources` copy, relative to the project root; the Schedule copy has the same layout under artifactDir. Nitro bundles the Vercel registry from sources in place, so the native build reads them in place too. Snapshotting every alias root is slow in large apps, so only Provider Output bundles retain sources.

**Decision:** The native build reads the published copy (or the sources in place for Nitro), never the per-build retained copy.

**Consequences:** Reading the retained copy gives IDs that change on every build, and a Schedule or server function starts IDs that the flow function does not know.

## Provider output transaction restores .vercel/output

`generateProviderOutputsWithinLock`, `writeOutputs` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** The provider output transaction snapshots .vercel/output before writeOutputs runs and restores it when it throws.

**Decision:** writeOutputs does no local rollback.

**Consequences:** Moving writeOutputs out of the transaction leaves a half-written output on failure.

## Concurrent provider finalizers may change the directory

`removeEmptyDirectories` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** Another provider finalizer may create or remove the directory after its contents are visited.

**Decision:** ENOTEMPTY and EEXIST mean keep the directory; ENOENT means it is gone. Other errors throw.

**Consequences:** Treating these codes as errors fails builds with several providers.

## package.json may start with a byte order mark

`createOptionalPeerReader` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** Node and esbuild accept a manifest that starts with a BOM; JSON.parse does not.

**Decision:** The reader strips a leading BOM before parsing.

**Consequences:** Removing the strip makes the optional-peer reader throw on such packages.

## Every native build path checks the Workflow DevKit first

`assertVercelWorkflowDevKit`, `hasVercelNativeWorkflowEntry` in `packages/workflow/src/internal/vite-build.ts`.

**Context:** hasVercelNativeWorkflowEntry() calls assertVercelWorkflowDevKit() when it finds a native entry.

**Decision:** Every path that builds a native Workflow, such as the Schedule entry that starts one, fails with the install error before it resolves `workflow/api`.

**Consequences:** Moving the check out of hasVercelNativeWorkflowEntry gives an unresolved-module error instead of WORKFLOW_R0006.

## Workflow Vite plugin runs before Nuxt and Nitro read config

`hubWorkflow plugin config hook` in `packages/workflow/src/vite.ts`.

**Context:** Nuxt replays plugins by enforcement order. Nitro reads `config.nitro` in its own `config` hook.

**Decision:** The plugin uses `enforce: "pre"` and `order: "pre"`, and reserves the startup plugin in Nitro config before Nitro reads it; later hooks may enable Workflows.

**Consequences:** Dropping the ordering makes Nitro start without the Workflow startup plugin.

## Vite reuses plugins and clones environment configs

`hubWorkflow config`, `configResolved`, `buildStart`, `workflowBuildAssociation` in `packages/workflow/src/vite.ts`.

**Context:** Vite clones environment configs by copying build options, its builder can resolve several environments before starting any, and a plugin instance is reused across builds.

**Decision:** The plugin stores forwarded server dirs on each config, keeps a stable owner token on build options, reads the environment config in buildStart, and reads each build's Nitro output instead of an early provider decision.

**Consequences:** Reading plugin-level state from the last configResolved call gives every build the last environment's config (schedule-build.test.ts models this).

## Vite does not call handleHotUpdate for new or deleted files

`configureServer refresh` in `packages/workflow/src/vite.ts`.

**Context:** Vite calls handleHotUpdate only for changed files.

**Decision:** The dev server watches Workflow directories directly for add and unlink.

**Consequences:** Removing the watcher stops the dev registry from picking up new or deleted Workflow files.

## Database Definitions can resolve after the startup plugin was written

`buildStart`, `readPostgresDefaultDatabase` in `packages/workflow/src/vite.ts`.

**Context:** The Database integration can resolve its Definitions after this plugin wrote the startup plugin.

**Decision:** buildStart reads the Default Database again and rewrites the startup plugin when it moved to or from Postgres.

**Consequences:** Without this, OpenWorkflow keeps runs in the wrong storage.

## Inline runs are not durable and run only where allowed

`resolveCloudflareBinding`, `createOpenWorkflowAdapter`, `isDurableOpenWorkflowDefinition` in `packages/workflow/src/runtime/adapters.ts`.

**Context:** Only a development server runs a Cloudflare Workflow inline without a binding. On OpenWorkflow, any worker can claim a run, but workers register only discovered Workflows and discovered Agent Workflows.

**Decision:** A missing Cloudflare binding fails outside dev. An inline `createWorkflow(name, handler)` on OpenWorkflow runs inline in this process with a warning. An undiscovered Agent turn fails with WORKFLOW_AGENT_NOT_DISCOVERED and never runs inline.

**Consequences:** Falling back to inline in production loses runs silently; sending undiscovered definitions to storage leaves runs no worker can execute.

## Cloudflare instance ids and createBatch

`isCloudflareInstanceId`, `createCloudflareAdapter`, `createStableWorkflowRunId` in `packages/workflow/src/runtime/adapters.ts`, `packages/workflow/src/runtime/client.ts`, `packages/workflow/test/duplicate-start.test.ts`.

**Context:** The array-form createBatch accepts reserved ids, unlike the object form. createBatch skips an id that already has an instance and returns no instance for it (seen on Miniflare 5.20261104). Cloudflare does not return the payload of an existing instance. Instance ids are at most 100 characters.

**Decision:** ViteHub uses the array form, checks the id in dev too so it fails before deployment, reads the existing instance without a payload when none is returned, and builds derived ids as 67 characters + `-` + 32 hex digits.

**Consequences:** Switching to the object form or skipping the dev check changes which ids work; longer prefixes exceed the Cloudflare id limit.

## Unknown acknowledgement for Cloudflare start failures

`invalidCloudflareWorkflowStart`, `isCloudflareRejection` in `packages/workflow/src/runtime/adapters.ts`.

**Context:** A failed start can have reached Cloudflare. A service rejection carries a service code such as `(instance.already_exists)`, or Miniflare rejects the id; a lost connection has neither.

**Decision:** Only a recognized rejection is a known non-start; other failures report acknowledgement `unknown`.

**Consequences:** Reporting a lost connection as not started invites a retry with a new id and a duplicate run.

## Cancel races with run completion

`cancelCloudflareRun`, `cancelOpenWorkflowRun` in `packages/workflow/src/runtime/adapters.ts`, `packages/workflow/src/runtime/openworkflow.ts`.

**Context:** Cloudflare `terminate()` throws when the instance finishes between the read and the call; an OpenWorkflow worker may finish between the read and the atomic cancel update.

**Decision:** On a cancel error, the run is read again and a finished status is returned instead of the error.

**Consequences:** Removing the re-read turns a normal race into a cancel failure.

## Long waits use several timers

`maximumTimerDelay`, `maxTimerDelay`, `waitUntilTime`, `waitUntil` in `packages/workflow/src/runtime/adapters.ts`, `packages/workflow/src/runtime/execute.ts`.

**Context:** setTimeout fires at once for a delay above 2^31 - 1 ms (about 24.8 days).

**Decision:** Long waits loop with timers capped at 2_147_483_647 ms.

**Consequences:** A single timer fires a long delayed start or sleep at once.

## Dev runs every Workflow inline, without the Workflow DevKit transform

`runsNatively`, `hasNativeWorkflowDefinition` in `packages/workflow/src/runtime/adapters.ts`.

**Context:** `vite dev` does not run the Workflow DevKit transform, so native entries run their normal handler inline. An inline run never waits for a signal. Without the Workflow DevKit, an app with no native entry runs only inline, so installing the SDK does not help.

**Decision:** Signals report WORKFLOW_OPERATION_UNSUPPORTED in dev and when the SDK fails to load in an app without native entries.

**Consequences:** Calling the Workflow DevKit in dev or suggesting an SDK install gives misleading errors.

## How OpenWorkflow modules are imported

`defaultImporter`, `bundledOpenWorkflowModules`, `useBundledOpenWorkflow` in `packages/workflow/src/runtime/openworkflow-worker.ts`, `packages/workflow/src/runtime/openworkflow.ts`.

**Context:** A variable import specifier keeps the optional OpenWorkflow packages out of host bundles. workerd blocks code generation when a module loads during a request. `.output` has no node_modules.

**Decision:** The default importer is `specifier => import(specifier)`, never built from a string (no `new Function`). installOpenWorkflow uses literal specifiers so the server bundle includes OpenWorkflow.

**Consequences:** A string-built importer fails on workerd; a variable import in the server worker cannot load OpenWorkflow from `.output`.

## OpenWorkflow Postgres setup runs under a transaction advisory lock

`withPostgresSetupLock` in `packages/workflow/src/runtime/openworkflow.ts`.

**Context:** OpenWorkflow creates its Postgres schema without a lock (0.11.0 uses a session lock that transaction poolers do not keep), and leaves a failed migration connection open in an aborted transaction. Its migrations are not exported and run on a connection that BackendPostgres.connect() opens. Ending a postgres.js probe while it waits rejects an unhandled promise.

**Decision:** One server at a time sets up the schema with pg_try_advisory_xact_lock in a short transaction, idle_timeout frees the waiting connection, the lock holder first probes for a second connection and fails with WORKFLOW_OPENWORKFLOW_SETUP_CONNECTION_UNAVAILABLE, a probe failure counts as an answer, and a probe that timed out ends only after it answers.

**Consequences:** Removing the lock or the probe brings back duplicate-key setup failures or a deadlock behind a one-connection pool.

## Only failWorkflowRun knows when an OpenWorkflow run failed

`reportFailedRuns` in `packages/workflow/src/runtime/openworkflow.ts`.

**Context:** OpenWorkflow retries a failed run by its retry policy.

**Decision:** The backend wrapper sends `workflow.failed` from failWorkflowRun().

**Consequences:** Sending it on the first error reports failures for runs that a retry still completes.

## OpenWorkflow run identity

`createRunIdLookup`, `toWorkflowRun`, `runOpenWorkflow` in `packages/workflow/src/runtime/openworkflow.ts`, `packages/workflow/test/openworkflow-run-state.test.ts`.

**Context:** ViteHub passes the caller's run id as the OpenWorkflow idempotency key; OpenWorkflow gives the run its own UUID, reads runs by UUID only, and deduplicates a key for 24 hours only. It lists step attempts by creation time in milliseconds, so fast steps can come in either order.

**Decision:** A lookup reads the key from the backend connection, the reported run id is the idempotency key, and a start checks for an existing run with that id before calling OpenWorkflow.

**Consequences:** Relying on OpenWorkflow dedupe starts a second run with the same id after 24 hours.

## Retry policy mapping to OpenWorkflow

`toOpenWorkflowRetryPolicy` in `packages/workflow/src/runtime/openworkflow.ts`.

**Context:** OpenWorkflow counts attempts, ViteHub `limit` counts retries after the first attempt, and OpenWorkflow caps each wait at maximumInterval (100 s by default).

**Decision:** maximumAttempts is limit + 1, and maximumInterval is the longest wait that the policy asks for.

**Consequences:** A direct mapping is off by one and caps backoff at 100 s.

## NonRetryableError works on every provider

`NonRetryableError`, `createOpenWorkflowProviderStep` in `packages/workflow/src/errors.ts`, `packages/workflow/src/runtime/openworkflow.ts`.

**Context:** Cloudflare reads `isRetryable`, Workflow DevKit reads `fatal`, and OpenWorkflow retries every error. ViteHub never throws this class; developers throw it with their own message.

**Decision:** The class carries both fields, and on OpenWorkflow the step returns a result marker and the run fails outside the retry loop.

**Consequences:** Renaming the fields or throwing inside the OpenWorkflow step makes the error retryable again.

## Sleeps replay from a stored wake time and call order

`createSleep`, `createOpenWorkflowProviderStep` in `packages/workflow/src/runtime/execute.ts`, `packages/workflow/src/runtime/openworkflow.ts`.

**Context:** Providers store the wake time of a sleep and do not read the duration again on replay. `context.sleep()` names each sleep by call order (`sleep-1`, `sleep-2`).

**Decision:** The orchestrator must call sleeps in the same order on each replay; without a provider sleep the run waits inline with a timer.

**Consequences:** Naming sleeps by anything other than call order, or recomputing durations, breaks replays.

## Redacted provider reasons and step errors

`WorkflowProviderFailure.reason`, `toWorkflowRunStepError` in `packages/workflow/src/errors.ts`, `packages/workflow/src/runtime/openworkflow.ts`.

**Context:** OpenWorkflow stores error name, message and stack; the stack has server paths. Provider reasons go to clients.

**Decision:** Run steps keep the message only, and the provider reason is the error name and first message line without URLs, file paths or credentials.

**Consequences:** Passing the stack or the raw provider message leaks server paths or secrets to clients.

## OpenWorkflow worker registration and dev reinstall

`prepareOpenWorkflowWorker`, `activeInstallKey`, `replaceActiveInstall`, `installOpenWorkflow` in `packages/workflow/src/runtime/openworkflow-worker.ts`.

**Context:** A worker copies the definitions registered on the client. `vite dev` runs the startup plugin again in the same process after a server file changes, and may evaluate the module again. The OpenWorkflow client keeps the definitions it registered.

**Decision:** Definitions are registered before the worker is created; the registry is not replaced on retries; the active install lives on globalThis; a reinstall creates a fresh runtime, drains the old worker and closes its backend after its runs finish; no storage is resolved when no discovered Workflow is left.

**Consequences:** Module-level state or reusing the client runs stale code in dev or leaks backends.

## A full connection pool at boot is retryable

`permanentSetupErrorCodes` in `packages/workflow/src/runtime/openworkflow-worker.ts`.

**Context:** A pool full with other boot traffic gives a second connection later.

**Decision:** WORKFLOW_OPENWORKFLOW_SETUP_CONNECTION_UNAVAILABLE is not a permanent setup error; the worker retries.

**Consequences:** Adding it to the permanent set leaves the worker off after a busy boot.

## Drain leaves unfinished runs to the lease

`installOpenWorkflow` in `packages/workflow/src/runtime/openworkflow-worker.ts`.

**Context:** A run that does not finish before the drain budget keeps its OpenWorkflow lease; another worker takes it when the lease ends.

**Decision:** Shutdown waits for the drain budget, then stops without failing runs.

**Consequences:** Failing or releasing runs at shutdown would lose or duplicate work.

## Inline run state retention

`runs`, `inFlightRuns`, `fallbackRunKeys`, `setWorkflowRun` in `packages/workflow/src/runtime/state.ts`.

**Context:** Execution retains its state through the completion callback.

**Decision:** Inspection holds WeakRefs when GC APIs exist, pending runs stay strongly reachable for explicit-id deduplication, a bounded strong set is used without GC APIs, and settlement drops the in-flight reference even when the inspection entry was evicted.

**Consequences:** Strong inspection references leak payloads; weak in-flight references break id deduplication.

## A failed definition module load unregisters only its own definitions

`loadWorkflowDefinition` in `packages/workflow/src/runtime/state.ts`.

**Context:** Concurrent or newer loads can register the same names.

**Decision:** On failure, only definitions that are still the ones this load registered are removed.

**Consequences:** Clearing by name removes definitions of a newer generation.

## Generated folder entries win over the captured inline handler

`loadWorkflowDefinition` in `packages/workflow/src/runtime/state.ts`.

**Context:** Generated folder entries wrap the inline handler with step runners and options.

**Decision:** The loader caches the module's resolved default export, not the handler captured during import.

**Consequences:** Caching the captured handler runs folder Workflows without their steps.

## Cross-realm Response check

`isResponse (runtime/operations.ts)` in `packages/workflow/src/runtime/operations.ts`.

**Context:** A Response can come from another Fetch implementation; status and headers alone also match an Axios response.

**Decision:** The check reads status, headers.get, bodyUsed, clone and text; packages/agent/src/internal/response.ts has the same check.

**Consequences:** instanceof Response misses other realms; a looser check treats HTTP client results as Responses. Change both copies together.

## Step timeouts and default retries per provider

`runProviderStep`, `wrapCloudflareWorkflowStep` in `packages/workflow/src/runtime/cloudflare-runner.ts`, `packages/workflow/src/runtime/execute.ts`.

**Context:** The provider runs the attempt function for each attempt. Cloudflare enforces `timeout` itself and reads `retries` as given; elsewhere only the ViteHub timer enforces it.

**Decision:** ViteHub resolves its default retries before passing options to Cloudflare, and every attempt (also inline, which does not retry) runs with the ViteHub timer.

**Consequences:** Passing raw options gives Cloudflare's defaults; dropping the timer loses timeouts outside Cloudflare.

## Sleep duration units follow Cloudflare

`durationUnits` in `packages/workflow/src/runtime/execute.ts`.

**Context:** Cloudflare reads a month as 30 days and a year as 365.25 days.

**Decision:** ViteHub uses the same units on every provider.

**Consequences:** Other values make the same sleep last different times per provider.

## A root step sleep returns a marker instead of throwing

`rootStepSleepResult`, `runInRootStep` in `packages/workflow/src/runtime/execute.ts`.

**Context:** A thrown error in the root step makes the provider retry it and run the code before the sleep again.

**Decision:** The root step returns a marker result; a replay reads it and fails with WORKFLOW_ROOT_STEP_SLEEP the same way on every provider.

**Consequences:** Throwing re-runs side effects before the sleep.

## Cloudflare passes `step` as an RPC stub

`wrapCloudflareWorkflowStep` in `packages/workflow/src/runtime/cloudflare-runner.ts`.

**Context:** `step.sleep.bind(step)` is a remote call that sends the stub away and disposes it.

**Decision:** The wrapper calls stub methods directly.

**Consequences:** Binding stub methods disposes the step stub.

## Dev run history stays out of builds

`createWorkflowDevPluginModule`, `getWorkflowDevRecorder`, `createWorkflowDevRecorder` in `packages/workflow/src/internal/dev-registry.ts`, `packages/workflow/src/runtime/dev-recorder.ts`, `packages/workflow/src/runtime/dev-runs.ts`.

**Context:** Only the dev Nitro plugin imports runtime/dev-runs and installs the recorder in the dev-recorder slot.

**Decision:** Builds have no recorder and no history code; inline runs without the recorder keep no history and forget finished runs after five minutes.

**Consequences:** Importing dev-runs from runtime code ships the history in production bundles (dev-registry.test.ts checks this).

## Startup plugin installs OpenWorkflow after config and registry

`createWorkflowDevPluginModule` in `packages/workflow/src/internal/dev-registry.ts`.

**Context:** installOpenWorkflow reads the runtime config and the registry.

**Decision:** The generated plugin sets them first.

**Consequences:** Reordering starts the worker without definitions.

## Workflow storage selection: dev stays local, never an ambient database

`localDevWorkflowOptions` in `packages/workflow/src/internal/dev-registry.ts`, `packages/workflow/test/runtime.test.ts`.

**Context:** A dev server must not run the runs of a shared database with local code. Workflow shares the Default Database or an explicit URL, like Queue and Realtime.

**Decision:** Without `remote: true` or configured storage, `vite dev` uses the local SQLite file, not DATABASE_URL or OPENWORKFLOW_POSTGRES_URL; a Default Database without a URL fails rather than falling back to a host SQLite file.

**Consequences:** Reading an ambient URL in dev runs production runs with local code.

## Workflow operations load the runtime lazily

`runtime (operations.ts)` in `packages/workflow/src/operations.ts`.

**Context:** The runtime module reads app Workflow state that exists only in the Nitro runtime.

**Decision:** Operations import it when they run, so the CLI and `vitehub inspect` can list them.

**Consequences:** A static import breaks listing outside the Nitro runtime.

## Vercel step listing page limit

`vercelStepPageLimit` in `packages/workflow/src/runtime/vercel.ts`.

**Context:** Vercel's step listing fails with HTTP 400 above 100; Workflow DevKit's CLI uses the same bound (packages/cli/src/lib/inspect/flag-bounds.ts in vercel/workflow).

**Decision:** Pages are at most 100 steps.

**Consequences:** Raising it fails step listing.

## Failed native run error comes from WorkflowRunFailedError.cause

`readVercelRunError` in `packages/workflow/src/runtime/vercel.ts`.

**Context:** Workflow DevKit rejects `returnValue` of a failed run with WorkflowRunFailedError, which keeps the thrown value in `cause`.

**Decision:** The run error reads `cause`.

**Consequences:** Reading the rejection itself reports the wrapper, not the developer's error.

## Inherited schema methods count only on custom prototypes, across realms

`hasSchemaMethod` in `packages/workflow/src/runtime/payload.ts`.

**Context:** hasSchemaMethod walks the prototype chain of a payload schema. Native Object constructors have the same source text across realms; a custom class prototype can also have a null parent.

**Decision:** A method found on a prototype counts when the prototype owns a constructor whose prototype is that object and the constructor is not a realm's Object (compared by Function.prototype.toString, not identity).

**Consequences:** An identity check against this realm's Object accepts methods on another realm's Object.prototype; a stricter check rejects valid class-based schemas.

## `definition` is a separate entry for the Vercel flow sandbox

`privateEntries (vite.config.ts)` in `packages/workflow/vite.config.ts`.

**Context:** The Vercel Workflow flow sandbox has no `require`; Workflow DevKit leaves Node built-ins external in the flow bundle.

**Decision:** `./definition` is its own entry so defineWorkflow never shares a chunk that keeps require("node:async_hooks").

**Consequences:** Merging it into a shared chunk breaks native flow bundles (flow-bundle-sandbox.test.ts covers it).

## steps.test-d.ts must not augment the registry

`steps.test-d.ts` in `packages/workflow/test/steps.test-d.ts`.

**Context:** registry-types.test.ts checks typed folder steps in its own program with the generated `.vitehub/workflow.d.ts`.

**Decision:** No module augmentation in this file.

**Consequences:** An augmentation here would reach every handler type of the package.

## vite-output temp apps need a source-root marker

`createWorkspaceTempDir` in `packages/workflow/test/vite-output.test.ts`.

**Context:** Provider output copies the app's source root: the nearest folder with .git or pnpm-workspace.yaml.

**Decision:** Each temp app writes pnpm-workspace.yaml.

**Consequences:** Without it every build copies the whole repository.
