# @vite-hub/runtime decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Duration errors describe objects as "an object" without converting them

`describe` in `packages/runtime/src/duration.ts`.

**Context:** String conversion would call user toString/valueOf code.

**Decision:** Duration errors describe objects as "an object" without converting them.

**Consequences:** Converting the value could run arbitrary code while building an error.

## A budget child created after its parent was disposed is inert: it gets no timers or listeners and ignores a caller signal

`createBudgetNode`, `createBudget.assertAvailable` in `packages/runtime/src/execution-budget.ts`.

**Context:** Disposal must release every timer and listener; a late child would otherwise leak them or react to signals after release.

**Decision:** A budget child created after its parent was disposed is inert: it gets no timers or listeners and ignores a caller signal.

**Consequences:** Dropping the disposed check leaks timers/listeners and lets a disposed subtree throw on a late caller abort.

## When a child inherits its parent's deadline (including an equal one), the parent's deadline controller cancels it

`createBudget.child` in `packages/runtime/src/execution-budget.ts`.

**Context:** An inherited deadline belongs to its owner, so expiry must abort the owner's whole subtree, not only the child.

**Decision:** When a child inherits its parent's deadline (including an equal one), the parent's deadline controller cancels it.

**Consequences:** Using the child controller on a tie lets siblings and the owner keep running past the shared deadline.

## Console paths are checked by origin after URL parsing, not only by string prefix

`normalizeConsolePath` in `packages/runtime/src/hosted-console.ts`.

**Context:** The URL parser strips tabs and newlines, so `/\t/example.com` passes the `//` prefix check but parses as protocol-relative.

**Decision:** Console paths are checked by origin after URL parsing, not only by string prefix.

**Consequences:** Removing the origin check reopens an open redirect to another site.

## SharedArrayBuffer detection for trace privacy trusts only native intrinsics captured and validated at import (Function.prototype.toString, buffer getters, DataView), with probes against forged formatters and receiver-aware getters

`webAssemblyModule`, `captureFunctionToString`, `checkNativeFunctionToString`, `captureSharedBufferByteLength`, `isSharedArrayBuffer` in `packages/runtime/src/index.ts`.

**Context:** Trace payloads that hold shared memory must stay private; app code could replace intrinsics to brand arbitrary objects or hide shared buffers.

**Decision:** SharedArrayBuffer detection for trace privacy trusts only native intrinsics captured and validated at import (Function.prototype.toString, buffer getters, DataView), with probes against forged formatters and receiver-aware getters.

**Consequences:** Removing a probe or the import-time capture lets forged intrinsics misclassify buffers and leak or corrupt trace payloads.

## Timestamps use Date.prototype.toISOString via Reflect.apply so Dates from other realms are accepted

`timestamp` in `packages/runtime/src/index.ts`.

**Context:** `instanceof Date` fails for Dates created in another realm (VM, iframe); the intrinsic method checks the internal slot instead.

**Decision:** Timestamps use Date.prototype.toISOString via Reflect.apply so Dates from other realms are accepted.

**Consequences:** Relying on instanceof alone drops cross-realm Dates and records the current time instead.

## waitUntil attaches a no-op catch at once but keeps the original task queued

`createRuntimeWaitUntilController.waitUntil` in `packages/runtime/src/index.ts`.

**Context:** The early catch prevents an unhandled rejection; flushWaitUntil awaits the original task and reports its error.

**Decision:** waitUntil attaches a no-op catch at once but keeps the original task queued.

**Consequences:** Queuing the caught promise hides failures from flushWaitUntil; dropping the catch raises unhandled rejections.

## Structural capability handles are accepted only as own data fields on an ordinary-prototype object, and proxies are rejected where Node can detect them

`isCapabilityHandle` in `packages/runtime/src/index.ts`.

**Context:** Handles from other runtime copies must still work, but a proxy can fabricate own descriptors and prototypes that structural checks cannot tell from real data.

**Decision:** Structural capability handles are accepted only as own data fields on an ordinary-prototype object, and proxies are rejected where Node can detect them.

**Consequences:** Loosening the own-key, null-prototype or inherited-field checks lets a forged proxy pass as a capability handle.

## EPERM from kill(pid, 0) or a drain signal means the process is alive; the drain client then relies on the status endpoint

`isProcessRunning`, `runDrain` in `packages/runtime/src/internal/drain-process.ts`, `packages/runtime/src/internal/drain.ts`.

**Context:** A process owned by another user exists but cannot be signaled or inspected by this user.

**Decision:** EPERM from kill(pid, 0) or a drain signal means the process is alive; the drain client then relies on the status endpoint.

**Consequences:** Treating EPERM as exit makes `vitehub drain` fail with R0005 for a process that is still running.

## Budget-handled tools are marked by object identity in an internal WeakMap, not by a public metadata field

`budgetHandledTools` in `packages/runtime/src/internal/execution-budget.ts`.

**Context:** A string field could be copied into any descriptor to opt a tool out of budget charging.

**Decision:** Budget-handled tools are marked by object identity in an internal WeakMap, not by a public metadata field.

**Consequences:** A public marker lets any tool skip the execution budget.

## Issued grant values are stored boxed as `{ value }`

`defineGrant` in `packages/runtime/src/internal/grant.ts`.

**Context:** A bind function may return undefined, and an unboxed WeakMap lookup could not tell that from a missing grant.

**Decision:** Issued grant values are stored boxed as `{ value }`.

**Consequences:** Unboxing makes grants whose bound value is undefined fail verification.

## Standard Context header writes go to both `res.headers` and H3 2's `errHeaders`

`responseHeaders` in `packages/runtime/src/internal/h3.ts`.

**Context:** H3 2 sends a returned error Response with separate errHeaders, so headers set by primitives would vanish on errors.

**Decision:** Standard Context header writes go to both `res.headers` and H3 2's `errHeaders`.

**Consequences:** Writing only `headers` drops primitive headers (cookies, CORS) from error responses.

## Clearing Headers copies the key list before deleting

`preparedResponse` in `packages/runtime/src/internal/h3.ts`.

**Context:** Deleting entries while iterating a live Headers iterator skips entries.

**Decision:** Clearing Headers copies the key list before deleting.

**Consequences:** Iterating and deleting in place leaves stale headers behind.

## H3 Standard Context properties are read lazily and cached on first access

`H3StandardProps` in `packages/runtime/src/internal/h3.ts`.

**Context:** ViteHub installs Standard Context on every request, but most requests never read it.

**Decision:** H3 Standard Context properties are read lazily and cached on first access.

**Consequences:** Eager reads add cost to every request.

## Run-failed listeners and run scopes live in a `Symbol.for` global registry shared by every copy of the runtime package

`listenersKey`, `scopesKey` in `packages/runtime/src/internal/run-failed.ts`, `packages/runtime/src/internal/run-scope.ts`.

**Context:** A primitive bundled twice in one process must still reach listeners and scopes registered by the other copy.

**Decision:** Run-failed listeners and run scopes live in a `Symbol.for` global registry shared by every copy of the runtime package.

**Consequences:** A module-local Set silently splits listeners/scopes between duplicate bundles.

## `hasRuntimeType` maps a callable `typeof === "undefined"` value to "function"

`hasRuntimeType` in `packages/runtime/src/internal/runtime-type.ts`.

**Context:** The HTMLDDA browser value (document.all) reports typeof undefined while not being undefined.

**Decision:** `hasRuntimeType` maps a callable `typeof === "undefined"` value to "function".

**Consequences:** Removing the check misclassifies document.all as undefined.

## Response detection brand-checks via the native `status` getter and also the getter of a server-installed global Response (srvx), rejecting proxies first where Node can detect them, and skipping plain records only when isProxy exists

`captureResponseChecks`, `replacedResponseStatus`, `isRuntimeResponse` in `packages/runtime/src/internal/runtime-type.ts`.

**Context:** srvx replaces the global Response with a class whose getters check private fields; Node 22 runs the brand check through a Proxy; a failed brand check costs a TypeError stack.

**Decision:** Response detection brand-checks via the native `status` getter and also the getter of a server-installed global Response (srvx), rejecting proxies first where Node can detect them, and skipping plain records only when isProxy exists.

**Consequences:** Dropping the srvx getter rejects app Responses on Node; dropping the proxy check lets proxies pass on Node 22; skipping records without isProxy would run proxy traps.

## The signal trap waits one turn for the host to install its stop listener, holds the srvx listener (matched by exact name `shutdown`/`stop`) until drains settle, and restores default signal behavior when no server owns signals

`installSignalTrap` in `packages/runtime/src/internal/shutdown.ts`.

**Context:** Nitro servers add stop listeners after plugins run; HTTP must stay up during drains, and a registered SIGTERM listener disables Node's default exit.

**Decision:** The signal trap waits one turn for the host to install its stop listener, holds the srvx listener (matched by exact name `shutdown`/`stop`) until drains settle, and restores default signal behavior when no server owns signals.

**Consequences:** Changing the handoff order or name matching lets an early signal bypass the close path, closes HTTP before drains, or leaves the process unkillable.

## The final shutdown record is written through stdout's callback with a 1 s bound, then one setImmediate turn before exit

`installSignalTrap` in `packages/runtime/src/internal/shutdown.ts`.

**Context:** On piped stdout, writes are async; exiting immediately loses the record, and a broken stream must not block exit.

**Decision:** The final shutdown record is written through stdout's callback with a 1 s bound, then one setImmediate turn before exit.

**Consequences:** Using console.info and exiting at once loses the final record when stdout is piped.

## The signal trap installs only on Node, Bun and Deno (release name node/bun), never on Cloudflare Workers

`onShutdown` in `packages/runtime/src/internal/shutdown.ts`.

**Context:** Workers may polyfill `process` but own the isolate lifecycle and forbid timers during startup.

**Decision:** The signal trap installs only on Node, Bun and Deno (release name node/bun), never on Cloudflare Workers.

**Consequences:** Installing the trap on Workers throws at startup or interferes with the isolate lifecycle.

## Each test process sweeps temp folders of dead pids under `.vitehub/test`

`processTemporaryRoot` in `packages/runtime/src/internal/test-mode-setup.ts`.

**Context:** Test runners can kill workers without an exit event, so the exit cleanup never runs.

**Decision:** Each test process sweeps temp folders of dead pids under `.vitehub/test`.

**Consequences:** Removing the sweep leaks temp folders across test runs.

## In metadata mode, accessor-backed trace content keys are recorded as omitted without invoking the getter

`normalizeTraceAttributes` in `packages/runtime/src/internal/trace-attributes.ts`.

**Context:** Reading a getter runs user code and can expose content that metadata mode must not capture.

**Decision:** In metadata mode, accessor-backed trace content keys are recorded as omitted without invoking the getter.

**Consequences:** Reading accessors would leak content into metadata-only traces or run side effects.

## Each LeaseBackend operation must be atomic

`LeaseBackend` in `packages/runtime/src/lease.ts`.

**Context:** Lease correctness (one winner, ID-matched renew/release) depends on the store, not on caller locking.

**Decision:** Each LeaseBackend operation must be atomic.

**Consequences:** A non-atomic backend gives two holders for one key.

## SQLite lease statements retry SQLITE_BUSY asynchronously (5 s, jittered backoff) instead of PRAGMA busy_timeout, and detect busy by code, message, or cause chain

`retryBusy`, `isBusy` in `packages/runtime/src/lease.ts`.

**Context:** busy_timeout blocks the event loop on synchronous clients; libSQL/better-sqlite3 set code, other drivers only the message, Drizzle wraps in cause.

**Decision:** SQLite lease statements retry SQLITE_BUSY asynchronously (5 s, jittered backoff) instead of PRAGMA busy_timeout, and detect busy by code, message, or cause chain.

**Consequences:** Narrowing detection or using busy_timeout causes spurious lease failures or blocks the event loop.

## Postgres lease table creation runs under pg_advisory_xact_lock, after a cheap existence probe

`createSqlLeaseStore`, `createSqlLeaseStore.ensureTable` in `packages/runtime/src/lease.ts`.

**Context:** Concurrent `create ... if not exists` can fail on the catalog in Postgres, and each skipped `if not exists` prints a notice.

**Decision:** Postgres lease table creation runs under pg_advisory_xact_lock, after a cheap existence probe.

**Consequences:** Removing the lock causes startup races between processes; removing the probe floods logs with notices.

## Lease backend operations are each one atomic SQL statement; acquire is a single upsert that recomputes expiry in DO UPDATE, and Postgres renew locks the holder with a FOR UPDATE CTE

`createSqlLeaseStore.acquire`, `createSqlLeaseStore.renew` in `packages/runtime/src/lease.ts`.

**Context:** Two processes acquiring at once must get one winner; a SQLITE_BUSY retry must find its own committed ID; Postgres evaluates proposed values before waiting on row locks.

**Decision:** Lease backend operations are each one atomic SQL statement; acquire is a single upsert that recomputes expiry in DO UPDATE, and Postgres renew locks the holder with a FOR UPDATE CTE.

**Consequences:** Splitting statements or using excluded.expires_at / an inlined UPDATE gives two winners or TTLs that start before the lock is obtained.

## consoleInvocationUrl builds its query string by hand

`consoleInvocationUrl` in `packages/runtime/src/public-url.ts`.

**Context:** Vercel's Workflow VM provides URL but not URLSearchParams.

**Decision:** consoleInvocationUrl builds its query string by hand.

**Consequences:** Using URLSearchParams crashes link building inside Vercel Workflow steps.

## Blob and Response values from other realms are recognized by calling native prototype accessors (internal-slot brand checks), not by tags or duck typing

`getBlobMethods`, `isResponse` in `packages/runtime/src/response.ts`.

**Context:** A configurable toStringTag and a few methods can be spoofed; native accessors throw on objects without the internal slot.

**Decision:** Blob and Response values from other realms are recognized by calling native prototype accessors (internal-slot brand checks), not by tags or duck typing.

**Consequences:** Replacing brand checks with tag/method checks lets spoofed objects reach the Response or stream constructors.

## Serialized Response records are fully validated (base64 shape, null-body statuses, header/status via the native constructor) before decoding with a permissive decoder

`isSerializedResponse`, `isBase64`, `base64ToBytes` in `packages/runtime/src/response.ts`.

**Context:** atob/Buffer accept malformed input and the native Response constructor throws on bodies for 204/205/304; the regex avoids a repeated group that overflows on large bodies.

**Decision:** Serialized Response records are fully validated (base64 shape, null-body statuses, header/status via the native constructor) before decoding with a permissive decoder.

**Consequences:** Skipping validation lets malformed durable records throw at deserialize time or decode to wrong bytes.

## Opaque and opaqueredirect responses are rebuilt from Response.error() with type, url and clone overridden

`createStatusZeroResponse` in `packages/runtime/src/response.ts`.

**Context:** The Web API cannot construct opaque responses.

**Decision:** Opaque and opaqueredirect responses are rebuilt from Response.error() with type, url and clone overridden.

**Consequences:** Constructing a normal Response loses the durable type and URL.

## Identity is asserted after the read-count assertions

`snapshots frozen accessor descriptors only once` in `packages/runtime/test/execution-authority.test.ts`.

**Context:** Vitest's assertion formatting reads accessors, which would bump the read count.

**Decision:** Identity is asserted after the read-count assertions.

**Consequences:** Reordering makes the read-count check fail spuriously.

## The Postgres row-lock lease test warms the store first, uses a longer TTL, confirms blocking via pg_blocking_pids, and compares against the DB clock at commit

`starts the %s TTL after obtaining the row lock` in `packages/runtime/test/lease.test.ts`.

**Context:** Each step stops the test from passing for the wrong reason or flaking on slow runners.

**Decision:** The Postgres row-lock lease test warms the store first, uses a longer TTL, confirms blocking via pg_blocking_pids, and compares against the DB clock at commit.

**Consequences:** Changing any step makes the test pass without proving the TTL starts after the lock, or flake.

## The cross-process test reads the winner from a separate connection

`gives a free key and an expired lease to exactly one of 8 processes` in `packages/runtime/test/lease.test.ts`.

**Context:** A write that SQLite rolled back could still look present on the writing connection.

**Decision:** The cross-process test reads the winner from a separate connection.

**Consequences:** Reading on the same connection could pass for a lost write.

## Tests disable Buffer only after reading the Response body

`restores binary response bodies with Buffer disabled`, `preserves binary bodies and padding with Buffer disabled` in `packages/runtime/test/response-base64-decode.test.ts`, `packages/runtime/test/response.test.ts`.

**Context:** Node's Response body reader needs Buffer even though the decoder under test does not.

**Decision:** Tests disable Buffer only after reading the Response body.

**Consequences:** Disabling Buffer earlier breaks the test harness, not the code under test.

## Opaque response tests model the filtered state instead of fetching

`preserves %s responses and rejects malformed status-zero records` in `packages/runtime/test/response.test.ts`.

**Context:** Node cannot produce opaque responses via fetch.

**Decision:** Opaque response tests model the filtered state instead of fetching.

**Consequences:** None at runtime; replacing the model needs a browser environment.
