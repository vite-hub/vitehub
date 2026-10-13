---
title: Prepare a production deployment
description: Choose durable providers, protect entry points, and verify recovery before serving application traffic.
navigation.title: Production deployment
navigation.order: 48
navigation.group: Deployment hosts
icon: i-lucide-clipboard-check
---

A successful build confirms that ViteHub can generate the selected host's output. Before serving traffic, verify that the deployed application protects its data and recovers from failures with those providers.

ViteHub is under active development. Pin deployed versions and keep the application lockfile. Test upgrades against your application's contracts before rollout. Check the [security policy](https://github.com/vite-hub/vitehub/blob/main/SECURITY.md) for supported versions and private reporting.

## Choose the contract your application needs

Several primitives work together but provide different guarantees. Start with the smallest contract that meets the application's requirements.

| Application requirement | Use | Check before deployment |
| --- | --- | --- |
| Store individual objects | [Blob](/docs/blob) | Object access, retention, and provider credentials. |
| Edit a file tree with snapshots and Sources | [Workspace](/docs/workspace) | Store durability, file permissions, and concurrent writers. |
| Read external content | [Source](/docs/source) | Upstream access and refresh policy. A Source does not grant write access. |
| Deliver a job after a request returns | [Queue](/docs/queue) | Retry behavior, duplicate delivery, and failed-job handling. |
| Resume and inspect long-running work | [Workflow](/docs/workflows) | Durable provider setup and retry-safe steps. Vercel inline handlers do not survive a function restart. |
| Start work at a time or on a recurring schedule | [Schedule](/docs/schedule) | Who wakes the target, where records persist, and whether multiple runners can execute the same occurrence. |
| Execute commands | [Shell](/docs/shell) | Commands, file access, network access, and timeouts allowed by the execution provider. |
| Isolate a process from the application host | [Sandbox](/docs/sandbox) | The selected provider's isolation and resource limits. Command parsing and Workspace rules do not isolate a host process. |

Check each selected provider in the [support matrix](/docs/frameworks-hosts/support-matrix). Read the date and scope of its evidence: generated-output tests, local provider runs, and live smoke tests establish different facts. An old successful run does not verify your current deployment.

## Decide which state must survive

List the data that must survive a process restart, a replacement container, and a deployment. Configure a store for each item, including Agent State, invocation journals, transcripts, Runtime Schedules, Workflow state, uploaded objects, and Workspace files when the application uses them.

Memory stores lose their contents when the process exits. Filesystem and file-backed SQLite stores require a persistent volume on a host that supports them. Hosted SQLite stores, such as `libsql://…` and Cloudflare D1, persist through their provider and do not use a local volume. Giving two replicas the same configuration does not make their local files or memory shared. A remote store supplies only the concurrency guarantees documented by its provider and ViteHub adapter.

For Agents, [Chat History and sessions](/docs/agents/chat-history-sessions#partition-transcripts) explains Agent State selection, and [Invocations](/docs/agents/invocations#observe-the-outcome) explains journals. Configuring one does not replace the other. Retaining a transcript also does not make a running model call resumable after a crash.

[Schedule stores](/docs/schedule/configure#storage) persist records and run history. A KV store does not elect one Process Runtime or make its deduplication work across replicas. Run one scheduler for that store, or supply coordination in the host and make target side effects safe to repeat.

Before rollout, write representative data, replace the process or container, and read the data again. Test backup restoration separately. Set retention and deletion rules for customer data, traces, uploaded attachments, and provider session files.

## Protect every entry point

Authenticate requests at their trusted entry point, then authorize the specific operation and resource. Configuring [Auth](/docs/auth) does not require authentication on every Agent. Use an [authenticated invoker](/docs/agents/invokers) and [Access policy](/docs/agents/capabilities/access) where needed.

Validate HTTP bodies, webhook payloads, and stored job inputs at runtime. TypeScript types and generated Definition registries check callers during development; they cannot validate JSON received over the network or records written by an earlier release. Verify webhook signatures before supplying trusted caller metadata. Derive tenant, user, and session identity from the authenticated request rather than accepting an unrestricted client value.

The [Console](/docs/development/console) can expose stored KV values, prompts, model output, and tool activity. Keep it disabled when it is not needed. A production Console requires an explicit access contract. With `exposure: 'host-managed'`, set `authorize` to a server file that default-exports `defineConsoleAuthorize()`. Every Console data route calls it before it reads data. Without it, the build fails.

Give model tools only the operations and resource scopes they need. Keep provider credentials in [Server Env](/docs/env). Inspect logs and retained invocation content with representative data before enabling content capture; application-supplied tool output can contain secrets even when provider credentials are redacted.

## Verify retries and shutdown

A Queue enqueue result confirms acceptance, not completion. A retry can repeat an external side effect if the first attempt completed it before failing. For database changes, save a stable business operation ID and the change in one transaction with a uniqueness constraint. Basic KV `get()` followed by `set()` cannot implement that check safely.

For external effects, use the service's idempotency support. A welcome-email job can complete the send and then fail before acknowledgement; retrying it must reuse the same email-service idempotency key. If the service cannot deduplicate requests, define how the application reconciles an unknown delivery outcome before retrying. Apply the same rule to retryable Workflow steps and scheduled targets.

Set execution timeouts and resource limits for model calls, shells, and sandboxes. Test cancellation and shutdown while work is active. Streaming Agent routes need a real [host background lifetime](/docs/reference/runtime-context#background-work-and-cleanup); a promise started after the response is not durable work by itself.

## Exercise the deployed application

Run the application's tests and production build, then deploy to a separate environment with the intended provider configuration. Follow the [verification guide](/docs/development/verification) to check generated output and provider execution.

Before rollout, verify these application outcomes:

- An unauthenticated caller and a caller from another tenant cannot read or mutate protected resources.
- Data that must persist remains available after restart or instance replacement.
- Duplicate jobs and retried steps do not duplicate the business effect.
- Provider outages, quota exhaustion, cancellation, and invalid input produce useful errors without exposing credentials.
- Operators can find failed work, inspect its outcome, and retry or recover it safely.
- The previous application version can run against any storage changes needed for rollback, or a tested recovery procedure restores compatible state.

Keep the deployment version, provider configuration, and verification result together. Recheck the affected outcomes when a provider, ViteHub version, or storage schema changes.
