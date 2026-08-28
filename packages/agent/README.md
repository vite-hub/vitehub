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

Provider Drivers require a local Node.js host and don't accept `box`; Cloudflare Agents and Deno fail explicitly. Provider Workspaces additionally require a POSIX host and fail explicitly on Windows. ViteHub materializes an Agent Workspace into a temporary provider working directory, applies Workspace Scope, writes `AGENTS.md` or `CLAUDE.md`, then commits successful write-mode changes through Workspace rules. Runtime sessions resume by Agent thread while the Agent Definition process remains active; provider cursors are not durable across process restarts or workers. Normalized assistant, reasoning, tool, approval, user-input, usage, warning, error, and terminal events stay behind the ViteHub Agent Invocation contract.

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

For a self-hosted Node process, `createProcessAgentCapacity()` adjusts new admissions from host CPU and memory pressure while keeping `concurrency` as a hard maximum. When capacity reaches zero, work stays in the same FIFO queue and resumes automatically after pressure recovers. Active invocations are never preempted.

```ts
// server/agent-capacity.ts
import { createProcessAgentCapacity } from "@vite-hub/agent/runtime/process"

export const agentCapacity = createProcessAgentCapacity({
  concurrency: 6,
  queue: { maxPending: 100, timeout: 30 * 60_000 },
})
```

Import the same `agentCapacity` object into each Agent Definition that should share one process-local budget. Linux hosts use cgroup v2 memory limits, memory events, and pressure stall information when available; other hosts fall back to Node's available-memory and parallelism signals. Sampling failures or samples exceeding `sampleTimeoutMs` (one second by default) use `fallbackConcurrency`, which defaults to one. Custom samplers should pass `context.signal` to abortable I/O. Tune `memory.perInvocationBytes`, `memory.reserveBytes`, and the CPU or memory pressure thresholds when workload measurements justify different admission behavior.

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
- `papercuts()` lets an Agent report small runtime and developer-experience friction to an application-owned sink, with an optional Capability CLI command.
- `transcribe()` uses the [AI SDK transcription API](https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/transcribe); `openRouterTranscriptionModel()` provides OpenRouter transcription without consumer-owned HTTP handling.
- `createTranscription()` composes remote asynchronous submission and completion through a provider-neutral driver; `elevenLabsScribe()` is the built-in Scribe v2 adapter.
- `mcp()` connects tools from [Model Context Protocol](https://modelcontextprotocol.io/) servers through `@ai-sdk/mcp`.
- `kv()`, `blob()`, `db()`, and `email()` expose [`@vite-hub/kv`](../kv/README.md), [`@vite-hub/blob`](../blob/README.md), [`@vite-hub/database`](../database/README.md), and [`@vite-hub/email`](../email/README.md).
- `sandbox()` and `schedule()` expose [`@vite-hub/sandbox`](../sandbox/README.md) and [`@vite-hub/schedule`](../schedule/README.md).
- `usage()` requests OpenRouter usage metadata and exposes the normalized Agent Usage Record through its typed Finish Extension.
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
