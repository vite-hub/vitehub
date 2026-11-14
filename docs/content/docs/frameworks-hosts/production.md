---
title: Prepare a production deployment
description: Choose durable providers, protect entry points, and verify recovery before serving application traffic.
navigation.title: Production deployment
navigation.order: 48
navigation.group: Deployment hosts
icon: i-lucide-clipboard-check
---

A successful build only proves that ViteHub can generate the host's output. Before you serve traffic, check that the deployed app protects its data and recovers from failures with your providers.

ViteHub is under active development. Pin deployed versions, keep the lockfile, and test upgrades against your app before rollout. The [security policy](https://github.com/vite-hub/vitehub/blob/main/SECURITY.md) lists supported versions and private reporting.

## Choose the contract your application needs

Primitives give different guarantees. Start with the smallest one that fits.

| Application requirement | Use | Check before deployment |
| --- | --- | --- |
| Store individual objects | [Blob](/docs/blob) | Access, retention, and provider credentials. |
| Edit a file tree with snapshots and Sources | [Workspace](/docs/workspace) | Store durability, file permissions, and concurrent writers. |
| Read external content | [Source](/docs/source) | Upstream access and refresh policy. A Source does not grant write access. |
| Deliver a job after a request returns | [Queue](/docs/queue) | Retry behavior, duplicate delivery, and failed-job handling. |
| Resume and inspect long-running work | [Workflow](/docs/workflows) | Durable provider setup and retry-safe steps. Vercel inline handlers do not survive a function restart. |
| Start work at a time or on a recurring schedule | [Schedule](/docs/schedule) | Who wakes the target, where records persist, and whether two runners can run the same occurrence. |
| Execute commands | [Shell](/docs/shell) | Commands, file access, network access, and timeouts the execution provider allows. |
| Isolate a process from the application host | [Sandbox](/docs/sandbox) | The provider's isolation and resource limits. Command parsing and Workspace rules do not isolate a host process. |

Check the [test status](/docs/frameworks-hosts/support-matrix#test-status) of each host and primitive. Live tested, Tested locally, and Experimental prove different things. A live test shows what CI checks on the host, not that your deployment works.

## Decide which state must survive

List the data that must survive a process restart, a new container, and a deployment. Configure a store for each: Agent State, run journals, transcripts, Schedule Runs, Workflow state, uploads, and Workspace files, as your app uses them.

- Memory stores lose their data when the process exits.
- Filesystem and file-backed SQLite stores need a persistent volume on a host that supports one.
- Hosted SQLite stores, such as `libsql://…` and Cloudflare D1, persist through their provider without a local volume.
- Replicas with the same configuration do not share local files or memory.
- A remote store gives only the concurrency guarantees that its provider and ViteHub adapter document.

For Agents, [Chat History and sessions](/docs/agents/chat-history-sessions#partition-transcripts) covers Agent State and [Invocation storage](/docs/agents/invocation-storage#store-invocation-history) covers journals. You need both. A saved transcript does not let a model call resume after a crash.

[Schedule stores](/docs/schedule/configure#storage) keep records and run history. A KV store does not elect one Process Runtime or deduplicate across replicas. Run one scheduler per store, or add coordination in the host and make target side effects safe to repeat.

Before rollout, write realistic data, replace the process or container, and read the data again. Test backup restore separately. Set retention and deletion rules for customer data, traces, uploads, and provider session files.

## Protect every entry point

Authenticate each request at its trusted entry point, then authorize the operation and resource. [Auth](/docs/auth) does not protect every Agent by itself. Use an [authenticated invoker](/docs/agents/invokers) and [Access policy](/docs/agents/capabilities/access) where needed.

Validate HTTP bodies, webhook payloads, and stored job inputs at runtime. TypeScript types check callers in development, but not JSON from the network or records from an earlier release. Verify webhook signatures before you pass trusted caller metadata. Take tenant, user, and session identity from the authenticated request, not from a client value.

::warning
The [Console](/docs/development/console) can show stored KV values, prompts, model output, and tool activity. Turn it off when you do not need it.
::

The Console endpoint takes only [signed requests](/docs/development/console#sign-console-requests) from the ViteHub Console and the CLI. `console: { auth: false }` is for development; a production build fails with `VITE_HUB_B0022`, even with `authorize` set. You can also set `authorize`, a server file that default-exports `defineConsoleAuthorize()`. Every Console call runs it after the signature check and before it reads data.

Set `vitehub({ sameOriginWrites: true })` when browsers call your API with cookies. It refuses writes with cookies from other origins, sibling subdomains included, before any route runs. Behind a proxy that ends TLS, also set `trustProxy: true`. See [Run behind a reverse proxy](/docs/frameworks-hosts/node-self-hosted#run-behind-a-reverse-proxy).

Give model tools only the operations and scopes they need. Keep provider credentials in [Server Env](/docs/env). Before you turn on content capture, inspect logs and saved run content with realistic data. Tool output from your app can contain secrets even when provider credentials are redacted.

## Verify retries and shutdown

A Queue enqueue result means accepted, not done. A retry can repeat a side effect that the first attempt finished before it failed. For database changes, save a stable operation id and the change in one transaction with a unique constraint. A KV `get()` then `set()` cannot do that check safely.

For external effects, use the service's idempotency support. A welcome-email job can send and then fail before acknowledgement, so the retry must reuse the same idempotency key. If the service cannot deduplicate, decide how your app handles an unknown delivery result before it retries. The same rule applies to retryable Workflow steps and scheduled targets.

Set timeouts and resource limits for model calls, shells, and sandboxes. Test cancellation and shutdown while work runs. Streaming Agent routes need a real [host background lifetime](/docs/reference/runtime-context#background-work-and-cleanup). A promise started after the response is not durable work.

## Exercise the deployed application

Run your tests and production build, then deploy to a separate environment with the real provider configuration. The [verification guide](/docs/development/verification) checks generated output and provider execution.

Before rollout, check that:

- An unauthenticated caller and a caller from another tenant cannot read or change protected resources.
- Persistent data survives a restart or instance replacement.
- Duplicate jobs and retried steps do not repeat the business effect.
- Provider outages, quota limits, cancellation, and bad input give useful errors without leaking credentials.
- Operators can find failed work, inspect it, and retry or recover it safely.
- The previous version can run on the changed storage for rollback, or a tested recovery restores compatible state.

Keep the deployment version, provider configuration, and check results together. Check again after a provider, ViteHub version, or schema change.
