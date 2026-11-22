# @vite-hub/sandbox decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Named Cloudflare Sandboxes are shared

`createCloudflareRuntime open`, `execute cleanup`, `runSandboxTask close` in `packages/sandbox/src/cloudflare.ts`, `packages/sandbox/src/task/runtime/execute.ts`, `packages/sandbox/src/task/runtime/runtime.ts`.

**Context:** Containers with the same ID serve several sessions.

**Decision:** Open with preserveHome, do not close a named Sandbox after a run, delete only run files.

**Consequences:** Other sessions keep their files; each run must clean its own.

## Own Sandbox Durable Object for @cloudflare/sandbox 1.0

`getCloudflareSandbox`, `module header` in `packages/sandbox/src/cloudflare.ts`, `packages/sandbox/src/internal/cloudflare-durable-object.ts`.

**Context:** SDK 1.0 has no Sandbox class or getSandbox.

**Decision:** ViteHub generates a Durable Object implementing CloudflareSandboxStub; base class and Files are injected.

**Consequences:** Tests run in Node; ViteHub owns the Container lifecycle.

## List stub methods explicitly

`getCloudflareSandbox` in `packages/sandbox/src/cloudflare.ts`.

**Context:** A DO stub returns a value for every property; the session feature-detects with if (stub.listFiles).

**Decision:** Wrap the stub in an object that lists only real methods.

**Consequences:** Feature detection works; a new method must be added to the list.

## Cancellation waits for exec exit

`exec finally / kill` in `packages/sandbox/src/cloudflare.ts`.

**Context:** Same-ID reuse can collide with a still-running command.

**Decision:** On abort, await all executions; a transport deadline bounds the wait.

**Consequences:** No stale process survives into reuse.

## Workers RPC drops error codes

`kill`, `module header`, `#start invariants` in `packages/sandbox/src/cloudflare.ts`, `packages/sandbox/src/internal/cloudflare-durable-object.ts`.

**Context:** Only the message crosses Workers RPC.

**Decision:** Check the signal on the caller side; errors inside the DO are plain and reported as SANDBOX_R0088.

**Consequences:** The DO does not throw coded errors; the diagnostics ratchet needs these exceptions.

## Retired diagnostic codes are never reused

`catalog headers` in `packages/sandbox/src/error-diagnostics.ts`, `packages/sandbox/src/task/error-diagnostics.ts`.

**Context:** Published codes have docs pages; retired numbers are absent from the catalog and nothing else records them.

**Decision:** Never reuse a retired code number; keep the list of retired codes.

**Consequences:** A new code could take a retired number and point old docs links and logs at the wrong failure.

## Lazy-load heavy dependencies

`toolchain provisioner import`, `node:child_process import`, `typescript loader`, `pnpm workspace loader` in `packages/sandbox/src/index.ts`, `packages/sandbox/src/task/internal/runtime-preparation.ts`, `packages/sandbox/src/task/internal/typescript.ts`, `packages/sandbox/src/task/project.ts`.

**Context:** Startup and bundle cost of optional dependencies.

**Decision:** Use dynamic imports at first use.

**Consequences:** Hoisting to static imports slows every vite start and pulls optional peers.

## Cloudflare Container platform limits

`keepAliveTimeout`, `host limit` in `packages/sandbox/src/internal/cloudflare-durable-object.ts`, `packages/sandbox/src/internal/network-policy.ts`.

**Context:** Platform maximums.

**Decision:** keepAlive uses the maximum idle duration; allow at most 64 hosts.

**Consequences:** Larger values are rejected by the platform.

## Timed exec under GNU timeout

`timedExecShell`, `cancelExec` in `packages/sandbox/src/internal/cloudflare-durable-object.ts`.

**Context:** Native cancellation leaves descendants running.

**Decision:** Wrap exec in timeout --signal=KILL; cancel sends ALRM.

**Consequences:** The whole group dies; exit codes 124 and 137 are reserved.

## Spawned commands get their own process group through bash job control

`processGroupShell` in `packages/sandbox/src/internal/cloudflare-durable-object.ts`.

**Context:** The Container API gives no PIDs and custom images may lack setsid.

**Decision:** Use set -m and write the group id to a file.

**Consequences:** kill() reaches descendants; kill retries until the group id exists.

## SSE format compatible with @cloudflare/sandbox 0.12

`streamProcessLogs` in `packages/sandbox/src/internal/cloudflare-durable-object.ts`.

**Context:** Existing stream parsers expect the 0.12 format.

**Decision:** Emit buffered output, then live output, then exit.

**Consequences:** Changing the format breaks caller parsers.

## Exited process records stay until the follow-up RPC attaches

`process lookup` in `packages/sandbox/src/internal/cloudflare-durable-object.ts`.

**Context:** Short commands can exit before the stream RPC arrives.

**Decision:** Keep the record until the stubs attach.

**Consequences:** Removing it early loses output of short commands.

## Network policy applied at Container start

`#running`, `#start`, `interception CA env` in `packages/sandbox/src/internal/cloudflare-durable-object.ts`, `packages/sandbox/src/internal/network-policy.ts`.

**Context:** Intercepts are added after running is reported; exec does not inherit the start env.

**Decision:** Wait for #starting, set enableInternet false plus intercepts, destroy the Container on intercept failure, pass the CA env on every exec.

**Consequences:** Otherwise the network can silently differ from the configured policy.

## Cloudflare retry policy

`canRetryCloudflareRequest`, `output recovery`, `retry classification` in `packages/sandbox/src/internal/cloudflare-failure.ts`, `packages/sandbox/src/task/runtime/output-recovery.ts`, `packages/sandbox/src/task/runtime/runtime.ts`.

**Context:** A command must not run twice.

**Decision:** Never retry an overloaded DO; a cold start can retry; a Task reruns only before its first command.

**Consequences:** Wider retries replay side effects.

## Docker env passing

`dockerCliOwnedNames`, `broker env` in `packages/sandbox/src/internal/container.ts`.

**Context:** argv is visible in ps; the CLI itself reads PATH, HOME, DOCKER_* and XDG_*.

**Decision:** Secrets go in the CLI env; names the CLI reads go inline.

**Consequences:** Otherwise secrets show in ps or Sandbox values change CLI behavior.

## Docker network isolation requirements

`isolated bridge checks` in `packages/sandbox/src/internal/container.ts`.

**Context:** Isolated gateway mode needs a recent Engine on rootful native Linux.

**Decision:** Check the daemon version and platform and refuse unsupported setups.

**Consequences:** Without the checks, isolation can silently not apply.

## Docker kill signals the recorded Sandbox PID

`spawn wrapper`, `kill` in `packages/sandbox/src/internal/container.ts`.

**Context:** Signalling the CLI does not reach the Container process.

**Decision:** Record the PID inside the Sandbox and wait for it before signalling.

**Consequences:** kill() would only stop the local CLI.

## Env marker establishes process ownership

`session marker`, `sessionEnvironmentKey`, `VITEHUB_SSH_COMMAND` in `packages/sandbox/src/internal/crabbox.ts`, `packages/sandbox/src/internal/trusted-host.ts`, `packages/sandbox/src/ssh.ts`.

**Context:** Process groups miss processes that call setsid.

**Decision:** Use an env marker to find processes to stop.

**Consequences:** Teardown would leave escaped processes running.

## Observe wait() rejection early

`spawn wait promise` in `packages/sandbox/src/internal/crabbox.ts`, `packages/sandbox/src/internal/trusted-host.ts`.

**Context:** Node crashes on unhandled rejections.

**Decision:** Attach a no-op handler at creation; wait() still rejects.

**Consequences:** Removing the handler crashes the process on early failures.

## Crabbox kill sends only SIGTERM

`kill` in `packages/sandbox/src/internal/crabbox.ts`.

**Context:** CLI limitation.

**Decision:** Ignore the chosen signal and send SIGTERM.

**Consequences:** Custom signals do not reach the remote command.

## File lock keeps a tombstone

`stale lock takeover` in `packages/sandbox/src/internal/file-lock.ts`.

**Context:** ABA race on stale-lock rename.

**Decision:** Leave a non-empty tombstone.

**Consequences:** Removing it lets two waiters both take the lock.

## Drain uploads before boot cleanup

`boot cleanup` in `packages/sandbox/src/internal/remote.ts`.

**Context:** An upload can still be writing into Home during cleanup.

**Decision:** Await all uploads first.

**Consequences:** Cleanup races uploads and leaves partial files.

## Integrity pin is part of the toolchain cache key

`cache identity` in `packages/sandbox/src/internal/toolchain.ts`.

**Context:** Supply-chain safety.

**Decision:** Include the pin in the cache key.

**Consequences:** A cached archive could bypass a project's integrity pin.

## Toolchain cache concurrency

`install publish`, `shared download` in `packages/sandbox/src/internal/toolchain.ts`.

**Context:** Several sessions and processes share one cache.

**Decision:** Publish with an atomic symlink; the shared download has its own deadline.

**Consequences:** Partial installs, or one cancellation aborting everyone.

## Corepack hash source by Yarn version

`corepack hash` in `packages/sandbox/src/internal/toolchain.ts`.

**Context:** Must match Corepack's integrity format.

**Decision:** Hash yarn.js for Yarn 2+ and the tarball otherwise.

**Consequences:** Pins would not match Corepack.

## Rollback only after teardown while the lease is held

`release` in `packages/sandbox/src/internal/trusted-host.ts`.

**Context:** Live processes could write state after the rollback.

**Decision:** Order: destroy, then rollback, then release the lease.

**Consequences:** State corruption from processes that outlive the rollback.

## Spawn fence with no await before launch

`spawn` in `packages/sandbox/src/internal/trusted-host.ts`.

**Context:** Race between teardown and spawn.

**Decision:** Check the fence, launch and register synchronously.

**Consequences:** An await there leaves orphaned children.

## One Vercel SDK loader with a literal specifier

`createVercelRuntime`, `loadVercelSdk` in `packages/sandbox/src/internal/vercel.ts`, `packages/sandbox/src/vercel.ts`.

**Context:** Nitro output is bundled without node_modules.

**Decision:** Use one import('@vercel/sandbox') with a literal specifier.

**Consequences:** A variable specifier fails in Nitro output.

## SSH prepare runs before the probe deadline

`prepare` in `packages/sandbox/src/ssh.ts`.

**Context:** Slow setup would fail the agent status probe.

**Decision:** Do the setup in prepare().

**Consequences:** Moving setup into launch makes probes time out.

## Do not log client command text

`protocol error handler` in `packages/sandbox/src/ssh.ts`.

**Context:** Commands can contain secrets.

**Decision:** Close the connection without logging the command.

**Consequences:** Logging leaks secrets.

## Commands run as non-login shells

`exec shell` in `packages/sandbox/src/ssh.ts`, `packages/sandbox/src/vercel.ts`.

**Context:** Debian /etc/profile resets PATH.

**Decision:** Use sh -c, not -l.

**Consequences:** A login shell drops the forwarded PATH.

## Track SSH sockets before the handshake

`connection tracking` in `packages/sandbox/src/ssh.ts`.

**Context:** Shutdown hangs on half-open handshakes.

**Decision:** Track each socket on connect.

**Consequences:** Shutdown can hang.

## Conservative project retention in Task bundling

`bundle retention`, `filesystem escape analysis` in `packages/sandbox/src/task/bundle.ts`, `packages/sandbox/src/task/internal/shared/discovered-definition/ast.ts`.

**Context:** Static analysis cannot prove every filesystem path.

**Decision:** Keep project files unless analysis proves they are unused; mkdtemp is the exception.

**Consequences:** Looser analysis drops files a Task reads at runtime.

## tini reaps orphans

`image entrypoint` in `packages/sandbox/src/task/cloudflare.ts`.

**Context:** Zombie processes in the Container.

**Decision:** Use tini as PID 1.

**Consequences:** Without tini, zombies accumulate.

## Runtime generations and real paths

`stable loader file`, `generation switch`, `server env move` in `packages/sandbox/src/task/feature.ts`, `packages/sandbox/src/task/internal/runtime-preparation.ts`, `packages/sandbox/src/task/vite.ts`.

**Context:** Nitro and Vite resolve real paths once.

**Decision:** Immutable generations plus one stable file outside them, replaced atomically.

**Consequences:** Dev reload breaks or loads mixed generations.

## Lazy ~standard getter tolerance

`isStandardSchema` in `packages/sandbox/src/task/internal/shared/validation.ts`.

**Context:** Some schema libraries define the marker lazily.

**Decision:** Read the marker before the own-property check.

**Consequences:** Lazy schemas would be rejected.

## Vercel VM timeout headroom

`timeout headroom` in `packages/sandbox/src/task/runtime/providers/vercel.ts`.

**Context:** The two timeouts start at different times.

**Decision:** Add headroom to the VM timeout.

**Consequences:** The VM kills runs before ViteHub reports a coded timeout.

## noExternal matches the package name

`noExternal` in `packages/sandbox/src/task/vite.ts`.

**Context:** Matching is by package name, not path.

**Decision:** Add @vite-hub/sandbox to noExternal.

**Consequences:** A path entry would not inline the Task runtime.

## Vercel SDK signal cancels only the start request

`spawn detached` in `packages/sandbox/src/vercel.ts`.

**Context:** The signal does not kill the running command.

**Decision:** Kill the command explicitly on abort.

**Consequences:** Aborted commands keep running.

## Abort a pending SDK read before iterator.return

`streamLogs stop()` in `packages/sandbox/src/vercel.ts`.

**Context:** return() waits for a pending next().

**Decision:** Call abort.abort() first.

**Consequences:** Stop hangs.
