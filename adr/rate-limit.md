# @vite-hub/rate-limit decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Redact limited keys and driver error text before a result leaves the runtime or the CLI

`writeFailure`, `redact`, `guarded` in `packages/rate-limit/src/cli.ts`, `packages/rate-limit/src/runtime/operations.ts`.

**Context:** Keys are client IPs, user IDs or tokens, and driver errors can carry credentials; they reach the Console, CLI output and Agents.

**Decision:** Redact limited keys and driver error text before a result leaves the runtime or the CLI.

**Consequences:** Dropping redaction leaks keys and credentials into CLI output and the Console.

## A peek or reset answering unsupported or unavailable exits 1 even though it prints a result

`runRateLimitCommand` in `packages/rate-limit/src/cli.ts`.

**Context:** Scripts rely on the exit code to detect that a counter could not be read or reset.

**Decision:** A peek or reset answering unsupported or unavailable exits 1 even though it prints a result.

**Consequences:** Returning 0 for these statuses makes scripts treat a failed reset as done.

## On Cloudflare, an empty limiter list means the Rate Limit uses the binding, so peek and reset report unsupported

`limitersFor` in `packages/rate-limit/src/counters.ts`.

**Context:** Binding limiters are created per call and never registered; only KV-window limiters register in getRuntimeRateLimiter. A KV-window Rate Limit not yet used in this isolate is also reported as unsupported.

**Decision:** On Cloudflare, an empty limiter list means the Rate Limit uses the binding, so peek and reset report unsupported.

**Consequences:** Registering binding limiters, or changing KV-window registration, makes peek and reset report the wrong status.

## A slow KV operation resolves as a RATE_LIMIT_KV_TIMEOUT Result after 1 s, but a thrown KV error still rejects

`withKVDeadline` in `packages/rate-limit/src/drivers/kv.ts`.

**Context:** Thrown errors are configuration errors that must surface; only slow stores become a Result that the failure policy handles.

**Decision:** A slow KV operation resolves as a RATE_LIMIT_KV_TIMEOUT Result after 1 s, but a thrown KV error still rejects.

**Consequences:** Catching rejections here hides KV misconfiguration behind failure: "allow".

## Encode app-controlled key parts and every `.` before building a KV key

`keySegment` in `packages/rate-limit/src/drivers/kv.ts`.

**Context:** KV rejects `.` and `..` segments; a client key `..` would make every increment fail, and failure: "allow" would then let that client through unlimited.

**Decision:** Encode app-controlled key parts and every `.` before building a KV key.

**Consequences:** Removing the encoding lets a client bypass the limit with a crafted key.

## The KV key includes name, windowMs, key and window start, so each window gets a new key and needs no reset

`fixedWindow` in `packages/rate-limit/src/drivers/kv.ts`.

**Context:** Two limiters of one name with 1m and 1h windows have aligned starts; windowMs keeps their counters apart.

**Decision:** The KV key includes name, windowMs, key and window start, so each window gets a new key and needs no reset.

**Consequences:** Dropping windowMs from the key makes limiters of one name with different windows share one counter.

## Identify an event by the full shape of ~standard or of req/res, not by the presence of a property

`isRequestEvent` in `packages/rate-limit/src/guard.ts`.

**Context:** A structural Request can carry unrelated properties named like event fields, and would otherwise be read as an event.

**Decision:** Identify an event by the full shape of ~standard or of req/res, not by the presence of a property.

**Consequences:** A presence check like "req" in input misreads such Requests and loses their headers and key.

## Also accept a plain H3 event with own req and res, which getStandardContext() adapts

`isRequestEvent` in `packages/rate-limit/src/guard.ts`.

**Context:** Nitro may not have installed ~standard on the event yet when a guard runs.

**Decision:** Also accept a plain H3 event with own req and res, which getStandardContext() adapts.

**Consequences:** Dropping this branch treats early H3 events as plain Requests, without client address or request bindings.

## Read policy options only from own properties

`ownOption` in `packages/rate-limit/src/limiter.ts`.

**Context:** An inherited or polluted prototype must not set limit, window, enforcement or failure.

**Decision:** Read policy options only from own properties.

**Consequences:** Reading options with plain property access lets a prototype change a Rate Limit policy.

## RUNTIME_DURATION_INVALID counts as a Rate Limit diagnostic code

`rateLimitDiagnosticCodes` in `packages/rate-limit/src/limiter.ts`.

**Context:** parseDuration() from @vite-hub/runtime validates `window` and throws its own code.

**Decision:** RUNTIME_DURATION_INVALID counts as a Rate Limit diagnostic code.

**Consequences:** Removing it treats an invalid window error as a foreign error and wraps or rethrows it differently.

## Operations import the runtime module lazily, only when they run

`runtime` in `packages/rate-limit/src/operations.ts`.

**Context:** The runtime module reads app counters that exist only in the Nitro runtime; the CLI and `vitehub inspect` list operations without it.

**Decision:** Operations import the runtime module lazily, only when they run.

**Consequences:** A static import breaks the CLI and inspect outside Nitro.

## Generated code imports the operations and runtime modules by absolute path, so cli and operations are excluded from package exports

`operationsModule`, `exports.exclude` in `packages/rate-limit/src/vite.ts`, `packages/rate-limit/vite.config.ts`.

**Context:** These modules are internal; ownModule() gives generated Nitro code a file path that works without a package export.

**Decision:** Generated code imports the operations and runtime modules by absolute path, so cli and operations are excluded from package exports.

**Consequences:** Switching generated code to package specifiers fails to resolve the excluded operations module.

## Fall back to memory with a warning only when ViteHub selected `kv` itself; an explicit `kv` driver fails the build

`InternalRateLimitOptions.memoryFallback` in `packages/rate-limit/src/vite.ts`.

**Context:** A developer who chose kv expects shared counts, while an auto-selected kv on a non-shared store should still run.

**Decision:** Fall back to memory with a warning only when ViteHub selected `kv` itself; an explicit `kv` driver fails the build.

**Consequences:** Setting memoryFallback for explicit kv silently counts per process in production.

## In dev, check Cloudflare policies when the build targets Cloudflare, although dev counts in memory

`hubRateLimit` in `packages/rate-limit/src/vite.ts`.

**Context:** The memory driver accepts every policy, so without this the error appears only at deploy build.

**Decision:** In dev, check Cloudflare policies when the build targets Cloudflare, although dev counts in memory.

**Consequences:** Removing the dev check lets unsupported Cloudflare windows or strict enforcement pass dev and fail the build.

## validateNitroBuild re-runs driver resolution and policy checks for Nuxt Nitro-only rebuilds, and is called only after Database and KV resolved

`validateNitroBuild` in `packages/rate-limit/src/vite.ts`.

**Context:** Nuxt can reuse a cached Vite bundle while Nitro rebuilds server policies, so configResolved checks do not run again; nuxt.ts calls it after finalizeNitroReplayPlugins.

**Decision:** validateNitroBuild re-runs driver resolution and policy checks for Nuxt Nitro-only rebuilds, and is called only after Database and KV resolved.

**Consequences:** Removing it or calling it earlier skips build checks on Nuxt or reads an unresolved KV driver.

## The plugin runs with enforce: "pre" so its Nitro config is composed before Nitro's config hook captures it

`hubRateLimit` in `packages/rate-limit/src/vite.ts`.

**Context:** Nitro snapshots config in its own hook; plugin registration order in the app is not controlled.

**Decision:** The plugin runs with enforce: "pre" so its Nitro config is composed before Nitro's config hook captures it.

**Consequences:** Removing enforce: "pre" makes Cloudflare Rate Limit bindings missing when the app registers Nitro first.

## With the kv driver, build assertions and the memory warning wait until buildStart

`configResolved` in `packages/rate-limit/src/vite.ts`.

**Context:** KV rereads Database's resolved definitions at buildStart, so its store driver is not final in configResolved.

**Decision:** With the kv driver, build assertions and the memory warning wait until buildStart.

**Consequences:** Asserting in configResolved for kv fails or warns on a provisional KV store.

## Catch and log errors from refreshDeclarations in handleHotUpdate

`handleHotUpdate` in `packages/rate-limit/src/vite.ts`.

**Context:** Vite drops errors thrown from this hook, so an unsupported policy added in a saved file would be invisible.

**Decision:** Catch and log errors from refreshDeclarations in handleHotUpdate.

**Consequences:** Rethrowing instead of logging hides policy errors during dev.

## Pack Rate Limit's workspace dependencies too, so the consumer installs local copies

`publishes every documented Rate Limit entrypoint` in `packages/rate-limit/test/published-types.test.ts`.

**Context:** Otherwise pnpm installs older published @vite-hub packages and the type test checks the wrong code.

**Decision:** Pack Rate Limit's workspace dependencies too, so the consumer installs local copies.

**Consequences:** Packing only rate-limit makes the test pass or fail against stale npm versions.
