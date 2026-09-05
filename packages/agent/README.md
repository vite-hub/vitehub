# @vite-hub/agent

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="AI SDK" src="https://img.shields.io/badge/AI%20SDK-v7-111827?style=flat-square">
</p>

`@vite-hub/agent` defines Agents from files such as `server/agents/support/agent.ts`. Each Agent selects one Driver: an AI SDK model, a built-in coding provider, or application-owned `driver.run` logic.

Keep the three pieces separate:

- **Agent Driver**: the model, coding provider, or application-owned function that runs the Agent.
- **Capabilities**: opt-in abilities such as chat, shell, search, storage, sandbox, and MCP tools.
- **Workspace**: file-system context the agent can inspect, reason from, and optionally update while doing a task.

## Install

```sh
pnpm add @vite-hub/agent @vite-hub/workspace ai
```

`ai` is required for model-backed drivers and AI SDK-powered capabilities such as model-backed `title()`, `chatSummary()`, `llmGate()`, and `transcribe()`. Agents with `driver.run` can bundle without installing `ai`.

Add the AI SDK model provider you pass to `model`.

The built-in `"codex"` and `"claude-code"` drivers use ViteHub's pinned T3 provider runtime. Install only the provider packages an Agent uses:

```sh
pnpm add @openai/codex@0.149.1
pnpm add @anthropic-ai/claude-agent-sdk@0.3.246
```

ViteHub resolves those project dependencies directly. Production self-hosted Node builds on macOS and Linux copy only the build host's native payload, including the Linux libc variant, so build on the same host type used for deployment. Without `@openai/codex`, the Codex Driver keeps using `codex` from the host `PATH`. The Claude Code Driver requires the Agent SDK; when its native package is unavailable at runtime, ViteHub leaves T3's host `claude` command fallback unchanged. Claude Code credentials and Codex credentials without an explicit `driver.credentials` resolver must be available to the host process.

Until T3 publishes the runtime on npm, pnpm consumers must set `blockExoticSubdeps: false` because the pinned runtime is an exact pkg.pr.new tarball.

## Minimal API

```ts
// server/agents/support/agent.ts
import { defineAgent } from "@vite-hub/agent"
import { workspaceShell } from "@vite-hub/agent/capabilities"
import { webChat } from "@vite-hub/agent/channels"
import { file } from "@vite-hub/workspace"

export default defineAgent({
  driver: {
    model: "openai/gpt-5.1-mini",
    instructions: [
      "Answer support questions from the workspace.",
      "Use the support Source for support policies and known answers.",
    ],
  },
  channels: {
    web: webChat(),
  },
  capabilities: [workspaceShell()],
  workspace: {
    sources: {
      support: file({
        path: "support.md",
      }),
    },
  },
});
```

## Custom Capability tools

Custom Capability tools infer their handler input from inline Standard Schema validators. Schema transforms and optional outputs keep their types. A mismatched handler is a type error. Raw JSON Schema needs an explicit handler input type. Use `defineCapability<Config>()({...})` when you set the runtime config type. See the [custom Capability guide](https://vitehub.dev/docs/capabilities/custom-capabilities).

## Coding provider drivers

Use `driver: "codex"` or `driver: "claude-code"` for the defaults, including approval-required provider actions. A tagged Driver config exposes shared model, environment, instruction, permission, output, and capacity options, plus Codex credential and reasoning options.

```ts
// server/agents/codex/agent.ts
import { defineAgent } from "@vite-hub/agent";
import { file } from "@vite-hub/workspace";
import { loadServerEnv } from "#vitehub/env/server";

export default defineAgent({
  driver: {
    credentialProfile: "support",
    credentials: async ({ abortSignal }) => (await loadServerEnv(undefined, { signal: abortSignal })).codexAuthJson,
    kind: "codex",
    instructions: "Review the exact pull request head before changing code.",
    model: "gpt-5.5",
    permissions: "ask",
    reasoningEffort: "high",
    reasoningSummary: "detailed",
  },
  workspace: {
    mode: "write",
    sources: {
      guide: file("AGENTS.md"),
    },
  },
});
```

`credentials` accepts Codex `auth.json` as a string, a sealed Server Env value, or an invocation-time resolver. ViteHub never puts it in the provider environment. It writes the value to a `0600` file under a `0700` ViteHub-owned Codex Home and forces file-based Codex credential storage. Provisioned credentials require a POSIX host; ViteHub rejects them on Windows because these file modes cannot guarantee owner-only access there. A named `credentialProfile` keeps that writable Home at `.vitehub/data/codex/<credentialProfile>`, so Codex token refreshes survive process restarts when that directory uses durable storage. ViteHub serializes Codex runtime access to the profile, preserves a refreshed file while the resolver returns the same seed, and replaces it on the next invocation when the source rotates. Without `credentialProfile`, each invocation receives an isolated temporary Home that ViteHub removes after the Codex runtime stops.

The resolver remains the external source of truth, but ViteHub does not write Codex refreshes back to it. A persisted profile is a complete Codex Home, including auth, configuration, session state, and logs, so treat the whole volume as sensitive. Give each Kubernetes replica its own persistent volume; profiles do not coordinate a shared multi-writer volume across processes or pods. Agent inspection reports only that a credential source is configured and never resolves, checks, or prints it.

Provider Drivers require a local Node.js host and don't accept `box`; Cloudflare Agents and Deno fail explicitly. Provider Workspaces additionally require a POSIX host and fail explicitly on Windows. ViteHub materializes an Agent Workspace into a temporary provider working directory, applies Workspace Scope, writes `AGENTS.md` or `CLAUDE.md`, then commits successful write-mode changes through Workspace rules. Runtime sessions resume by Agent thread while the Agent Definition process remains active. Set `sessionStorePath` to keep opaque provider cursors in SQLite across restarts. Codex credentials supplied through `credentials` require a named `credentialProfile` before session persistence can be enabled because an invocation-private Codex Home is removed after each run. Dedicate each file to one provider Agent Definition on one persistent process host; it does not coordinate concurrent ownership of one thread across workers. Normalized assistant, reasoning, tool, approval, user-input, usage, warning, error, and terminal events stay behind the ViteHub Agent Invocation contract.

Process hosts can call `failInterruptedAgentInvocations(store, { recover })` at startup. `recover` must identify records owned by the stopped process host. Exclude durable Workflows and other provider-owned work because their active records may not hold a store claim while suspended. Recovery first respects an existing claim, waits up to `recoveryTimeoutMs`, and asks `recover` again before taking over the stopped host's claim. The timeout defaults to `claimLeaseMs`.

Hosts can persist external delivery evidence with `await invocations.appendObservation(invocationId, event, { id: deliveryId })`. The stable observation ID makes retries idempotent. The store assigns the sequence atomically, including for completed, failed, or cancelled Invocations, without changing lifecycle state or taking the running Agent's claim. The configured content policy still applies. Appends return the persisted record, return `undefined` when the Invocation does not exist, and throw if storage fails or the observation capacity prevents an append. Retain the same ID when retrying an ambiguous storage failure. Use one store instance per SQLite connection so its write queue serializes concurrent append calls.

`permissions` accepts `"ask"`, `"allow-edits"`, or `"allow-all"` and defaults to `"ask"`. Set `"allow-all"` explicitly when provider actions should run without approval. Approval decisions use the existing Agent message approval part, and structured provider questions accept a `data-agent-input` part with `{ requestId, answers }` through invocation input mode `"respond"`. Provider steering and follow-up are unsupported. Put Agent-owned Skills under `server/agents/<name>/skills/`; use `skills()` for Workspace-backed or external Source Skills.

## Driver capacity

Set `driver.capacity` when one Agent Definition must bound concurrent Driver work inside a process:

```ts
export default defineAgent({
  driver: {
    capacity: {
      concurrency: 2,
      queue: {
        maxPending: 20,
        timeout: 300_000,
      },
    },
    run: async context => handleAgentRun(context),
  },
})
```

Queued invocations start in FIFO order. An invocation is rejected immediately when the queue is full, rejected when its queue timeout expires, and removed from the queue when its abort signal fires. Capacity remains occupied until streamed Driver output finishes or is cancelled, so returning a stream does not allow the next invocation to start early. Agent inspection metadata and `vitehub agent info` expose the configured limits plus the process's current active and pending counts. A literal capacity config is local to one Agent Definition in one process; use provider-level or application-level coordination when capacity must span processes.

For a self-hosted Node process, `createProcessAgentCapacity()` adjusts new admissions from host CPU and memory pressure while keeping `concurrency` as a hard maximum. It does not cap I/O-heavy work to the host CPU count. When capacity reaches zero, work stays in the same FIFO queue and resumes automatically after pressure recovers. Active invocations are never preempted.

```ts
// server/agent-capacity.ts
import { createProcessAgentCapacity } from "@vite-hub/agent/runtime/process"

export const agentCapacity = createProcessAgentCapacity({
  concurrency: 6,
  queue: { maxPending: 100, timeout: 30 * 60_000 },
})
```

Import the same `agentCapacity` object into each Agent Definition that should share one process-local budget. Linux hosts use cgroup v2 memory limits, memory events, and pressure stall information when available; other hosts use Node's available-memory signal without CPU-pressure admission. Sampling failures or samples exceeding `sampleTimeoutMs` (one second by default) use `fallbackConcurrency`, which defaults to one. Custom samplers should pass `context.signal` to abortable I/O. Tune `memory.perInvocationBytes`, `memory.reserveBytes`, and the CPU or memory pressure thresholds when workload measurements justify different admission behavior.

Long-lived Node process hosts can import `createGitHubHost()` from `@vite-hub/agent/server/github` to resolve GitHub App or fallback credentials, admit GraphQL work against a shared rate-limit reserve, and run against an exact pull-request head in a temporary checkout. The process-specific entry keeps Node Git and filesystem dependencies out of the portable `@vite-hub/agent/server` entry. `withPullRequestCheckout()` clones over HTTPS, checks out the pull request's pushable branch, configures Git to use the base repository token, verifies the requested head, and removes the checkout after success, failure, cancellation, or timeout. Include `headRepository` and `headRef` to make an ordinary `git push` target the pull request's source branch. The callback keeps base repository access for reads from `origin`; use its `push()` after long-running work so the host resolves fresh source repository credentials before pushing. Pass the Agent Invocation's abort signal and use the callback signal for work inside the checkout:

```ts
await github.withPullRequestCheckout(pullRequest, async ({ env, path, push, signal }) => {
  await runAgent({ cwd: path, env, signal })
  await push()
}, { signal: invocation.abortSignal, timeout: 60_000 })
```

`access()`, `command()`, and `ensureGraphQLBudget()` accept the same `signal` and `timeout` controls. Pass them whenever the operation belongs to an Agent Invocation so credential resolution, token refresh, and GitHub CLI work stop on cancellation. Pass an upper bound for the GraphQL query's point cost as `ensureGraphQLBudget(repository, { cost })`; the host returns a reservation. Call `reservation.submit()` immediately before sending the query, then call `reservation.settle(actualCost)` with the non-negative point cost reported by GitHub after it completes. The actual cost cannot exceed the reserved cost. Call `reservation.release()` if work stops before submission. The host keeps submitted reservations deducted during concurrent budget refreshes until settlement confirms that the query completed. A later refresh reconciles GitHub's reported remaining points. The `credentials` callback receives the scoped `signal`; pass it to secret-manager or network requests. When GitHub cannot resolve an opaque token through `/user`, return a stable `rateLimitKey` with the token so rotations of the same credential share one budget while different credentials stay isolated. Shared GraphQL admission checks have an independent 60-second command limit. Set `graphQLCheckTimeout` on `createGitHubHost()` when the host needs a different limit.

The portable `@vite-hub/agent/server` entry exports `failInterruptedAgentInvocations()`, `readAgentInvocationWorkload()`, and `summarizeAgentInvocationWorkload()` for process-start recovery and health reporting. `readAgentInvocationWorkload()` combines the latest 100 invocation summaries with every active invocation. Its `total` counts that de-duplicated union, not all historical invocations. Recovery follows every store page and acquires each invocation's lease before failing it. Invocation journals renew their lease until they finish, so work owned by a live host remains active. These are host primitives. The application still owns credential storage, admission policy, scheduling, recovery timing, and deployment lifecycle.

`defineAgentInvocations({ observations, store })` configures retained observation count, content string length, encoded byte budget, and finish drain time. Defaults remain 256 observations, 65,536 UTF-16 code units of content strings, and a one-second drain, with a 16 MiB aggregate storage limit. Explicit limits support longer traces without removing bounds; records keep those limits across restarts. See [Agent Invocations](../../docs/content/docs/agents/invocations.md) for the limits and privacy policy.

`title()` accepts message input or a plain `prompt`. For a journaled run, title generation starts beside the main answer and cleanup joins it within its timeout. Metadata journals keep title text only when `metadataContent` includes `vitehub.session.title`.

For model-backed drivers, put free-form guidance for configured Sources, Capabilities, and Skills in `driver.instructions` or a deterministic imported instruction file. Tool descriptions and schemas stay with the tools as structured contracts.

```ts
// vite.config.ts
import { hubAgent } from "@vite-hub/agent/vite";
import { hubWorkspace } from "@vite-hub/workspace/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubWorkspace(), hubAgent()],
});
```

## CLI inspection

With `hubAgent()` active, start the Vite Development Server and run `vitehub agent info --agent <name>`.
The command reads the resolved Agent Definition metadata without invoking the Agent Driver, so use it to verify the selected Driver, tools, Workspace files and Sources, instructions, Agent Invoker Profiles, warnings, and metadata status before debugging model output.
Pass `--json` for the structured inspection contract.

## Capabilities

- A `webChat()` Channel exposes the Agent through the conventional `/api/_vitehub/agents/[agent]/chat` dispatcher. Use `webChat({ route: false })` when an Agent should not answer it, or `chat()` when an app-owned trigger needs Chat History and `chat.message` behavior without Channel-owned route exposure; see the [First Agent guide](https://vitehub.dev/docs/getting-started/first-agent).
- `workspaceShell()` runs scoped shell/file work through [`@vite-hub/shell`](../shell/README.md).
- `webSearch()` searches and reads the web with [Brave](https://brave.com/search/api/), [Exa](https://docs.exa.ai/), [Jina](https://jina.ai/en-US/reader/), [SearXNG](https://docs.searxng.org/dev/search_api.html), [SerpApi](https://serpapi.com/search-api), [SerpBase](https://serpbase.dev/docs), or [Tavily](https://docs.tavily.com/).
- `openapi()` turns an allowed OpenAPI `operationId` subset into bounded HTTP tools, or into a generated Capability CLI when `cli` is set.
- `transcribe()` uses the [AI SDK transcription API](https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/transcribe); `openRouterTranscriptionModel()` provides OpenRouter transcription without consumer-owned HTTP handling.
- `createTranscription()` composes remote asynchronous submission and completion through a provider-neutral driver; `elevenLabsScribe()` is the built-in Scribe v2 adapter.
- `mcp()` connects tools from [Model Context Protocol](https://modelcontextprotocol.io/) servers through `@ai-sdk/mcp`.
- `kv()`, `blob()`, `db()`, and `email()` expose [`@vite-hub/kv`](../kv/README.md), [`@vite-hub/blob`](../blob/README.md), [`@vite-hub/database`](../database/README.md), and [`@vite-hub/email`](../email/README.md).
- `sandbox()` and `schedule()` expose [`@vite-hub/sandbox`](../sandbox/README.md) and [`@vite-hub/schedule`](../schedule/README.md).
- `usage()` requests provider usage metadata, estimates missing cost from Models.dev, and exposes the normalized Agent Usage Record through its typed Finish Extension. Its `metadata.pricing` flag is false when `pricing: false` disables estimation.
- `skills()`, `access()`, `memory()`, `fetch()`, `llmRoute()`, and `llmGate()` cover prompt skills, workspace scope, durable notes, HTTP reads, and pre-run decisions.

```ts
import { openapi } from "@vite-hub/agent/capabilities";

openapi({
  spec: "https://api.example.com/openapi.json",
  cli: {
    name: "billing",
    description: "Inspect live billing API data.",
  },
  operations: ["billingListCustomers", "billingGetInvoice", "billingCreateTicket"],
  hooks: {
    request: {
      provides: {
        body: ["tenantId"],
      },
      handler({ context, request }) {
        request.body = {
          ...(request.body as Record<string, unknown> | undefined),
          tenantId: context.get<{ tenantId: string }>("billing")?.tenantId,
        };
        request.headers.set(
          "authorization",
          `Bearer ${context.get<{ token: string }>("billing")?.token}`,
        );
      },
    },
  },
  transformResponse: (response, { operation }) => ({
    operationId: operation.id,
    response,
  }),
});
```

`spec` can be a callback when the OpenAPI document comes from the current Agent Invocation context. Request servers come from OpenAPI `servers`; use `server` only as an override escape hatch when the spec has no usable server.
When `cli` is set, the operation tools are replaced by one CLI-named tool. ViteHub generates one subcommand per allowed operation, using the OpenAPI operation summary or description for command guidance.
Capability `cli` can be a static command tree or an invocation resolver that returns `undefined` when the CLI should not be available. Generated command trees stay behind adapter-owned options such as `openapi({ cli })`, whose resolver may return `false` or `undefined` for the current invocation.

## Error diagnostics

ViteHub-owned Agent configuration, build, and runtime defects use stable
Nostics codes. Application tools can also throw diagnostics created with
`defineDiagnostics()` from `nostics`. Add `nostics` as a direct dependency when
using it in your application.

AI SDK model tool results, Codex and Claude Code MCP tool responses, tool-step
reports, and CLI error output include diagnostic codes and fixes. They omit
causes and stacks. Keep diagnostic messages and metadata suitable for the model.
The AI SDK adapter preserves the original diagnostic as the cause of an Error
whose message includes the repair guidance.

Public HTTP errors keep the `ViteHubError` mapping. An unrecognized diagnostic
maps to the generic `INTERNAL` response. Approval and cancellation behavior does
not change.

See [Errors and diagnostics](https://vitehub.dev/docs/reference/errors-diagnostics)
for the code format and an application catalog example.

## Chat state

Chat History and the Concurrent Invocation Guard need an Agent State Provider when they should survive a process restart. The default `provider: "auto"` uses Cloudflare state on Cloudflare and local SQLite at `file:.vitehub/data/agent-state.sqlite` during Vite development. Production Node and serverless output require `VITEHUB_AGENT_STATE_URL` or explicit provider options because ViteHub cannot infer a durable filesystem there.

```ts
// vite.config.ts
export default defineConfig({
  agent: {
    providers: {
      state: {
        provider: "sqlite",
        url: process.env.VITEHUB_AGENT_STATE_URL,
      },
    },
  },
});
```

`provider: "sqlite"` uses the built-in libSQL-compatible state backend, so `file:` URLs work for local or explicitly persistent Node deployments and hosted libSQL URLs work remotely. Cloudflare, Vercel, and Netlify production output rejects `file:` Agent state before it can write to an ephemeral filesystem.

You can also wire the adapter manually when `chat({ state })` should own the state provider:

```ts
import { createLibsqlAgentState } from "@vite-hub/agent/state/sqlite";

chat({
  state: () =>
    createLibsqlAgentState({
      url: process.env.VITEHUB_AGENT_STATE_URL!,
    }),
});
```

This is not the Database Capability. It is Agent-owned runtime state for chat behavior.

## Built on

Vite discovers Agent files and generates runtime state for the active server host. Route-enabled Channels contribute host routes. Model execution uses [AI SDK](https://ai-sdk.dev/docs); Provider Tools stay Capability-scoped instead of becoming one global Agent config.

Learn more at [vitehub.dev](https://vitehub.dev).

## D1 invocation storage

`@vite-hub/agent/invocations/d1` exports `createD1AgentInvocationStore({ database })`. Pass a D1 binding or a resolver that returns the current request binding. Generate the required SQL with `d1AgentInvocationSchema()` and apply it through your D1 migration tool before requests use the store. The adapter does not create or migrate tables at runtime.

D1 batches and conditional writes preserve concurrent journal updates across Workers. Claims use the database clock. Terminal records use the same 30-day and 10,000-record retention defaults as the libSQL store. Pending and running records are retained. `maxAgeMs: false` and `maxRecords: false` disable each limit. An update rejects after 32 concurrent write conflicts. Keep application redaction outside the store.

D1 caps retained observations at 1,000,000 UTF-8 bytes to fit its 2 MB row limit. The adapter checks the complete row, preserves lifecycle fields and appended evidence when it removes excess ordinary observations, and rejects a row that still cannot fit. The resolved observation budget is stored with each record.

See [Agent Invocations](../../docs/content/docs/agents/invocations.md) for binding setup, schema generation, and migration limits.

## Extend an Agent

Use `extends` to make one Agent Definition the default for another:

```ts [server/agents/bot-dev/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import bot from '../bot/agent'

export default defineAgent({
  extends: bot,
  driver: { model: 'gpt-5.6-sol' },
  workspace: {
    store: { provider: 'local', root: '.vitehub/workspaces/bot-dev' },
  },
})
```

The child gets a fresh runtime from the parent's configuration. `name` is not inherited; discovery names each Agent from its own file. Configure separate persistent storage when the Agents must keep separate data. An explicitly shared store or adapter remains shared.

Child configuration overrides parent defaults. Channels, Sources, Skills, and hooks merge by key, replacing each matching definition or callback as a whole. Static Capabilities merge by `id`: the child replaces a matching Capability and appends new ones. A Capability resolver replaces the inherited list or resolver. Other arrays replace the parent array. Changing a Driver kind or store provider replaces that configuration.

`extends` accepts one definition created by `defineAgent()` in the same package instance. It does not discover files in the parent's directory. Import shared instructions with `@../bot/instructions.md` and share Skills through explicit Sources or a directory link. Relative file paths resolve from each discovered Agent's directory.


## evlog integration

`createAgentEvlog()` from `@vite-hub/agent/evlog` exports invocation lifecycle events through evlog. Add its `capability` to your Agent, connect its `drain` to the host, and await `flush()` after invocation background tasks finish. `@vite-hub/agent/evlog/posthog` adds PostHog events, Error Tracking and the official evlog log drain through optional dependencies.

`createPapercutReporter()` from `@vite-hub/agent/capabilities` journals reports in persistent Agent Invocations before delivery and replays pending reports after restart. See [evlog](../../docs/content/docs/agents/evlog.md) for delivery, privacy and shutdown contracts.
