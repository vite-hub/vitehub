# @vite-hub/agent

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="AI SDK" src="https://img.shields.io/badge/AI%20SDK-v7-111827?style=flat-square">
</p>

`@vite-hub/agent` defines Agents from files such as `server/agents/support/agent.ts`. Each Agent selects one Driver: an AI SDK model, a built-in coding provider, typed TypeSafe Jev questions, or application-owned `driver.run` logic.

Keep the three pieces separate:

- **Agent Driver**: the model, coding provider, or application-owned function that runs the Agent.
- **Capabilities**: opt-in abilities such as chat, shell, search, storage, sandbox, and MCP tools.
- **Workspace**: file-system context the agent can inspect, reason from, and optionally update while doing a task.

## Install

```sh
pnpm add @vite-hub/agent @vite-hub/workspace ai
```

`ai` is required for model-backed drivers and AI SDK-powered capabilities such as model-backed `title()`, `chatSummary()`, `llmGate()`, and `transcribe()`. Agents with `driver.run` can bundle without installing `ai`.

`driver.ask` requires the optional peer `advocaat`. ViteHub imports it only when an ask Driver or a Jev decision runs. When the application does not install it, the Agent Vite plugin keeps the import external, so other Agents still build.

Add the AI SDK model provider you pass to `model`.

Eve extensions are optional. Install the compatible pair before mounting one in a static Capability list:

```sh
pnpm add @github-tools/eve-extension@0.8.0 eve@0.72.1
```

For the accepted manifest contracts, the bridge supports one `session.started`, `turn.started`, or `step.started` handler per dynamic tool during Invocation preparation. Reading an unavailable session sequence, `stepIndex`, step model, or `modelId` throws `AGENT_R0415`. It does not provide real per-step lifecycle hooks, Eve sandbox, token, auth, or dynamic-skill adapters. Approval definitions may use `{ request }`; response authorizers are rejected. See [Eve extension capabilities](https://vitehub.dev/docs/agents/capabilities#use-an-eve-extension).

The built-in `"codex"` and `"claude-code"` drivers use ViteHub's pinned T3 provider runtime. Install only the provider packages an Agent uses:

```sh
pnpm add @openai/codex@0.149.1
pnpm add @anthropic-ai/claude-agent-sdk@0.3.246
```

ViteHub resolves those project dependencies directly. Production self-hosted Node builds on macOS and Linux copy only the build host's native payload, including the Linux libc variant, so build on the same host type used for deployment. Without `@openai/codex`, the Codex Driver keeps using `codex` from the host `PATH`. The Claude Code Driver requires the Agent SDK; when its native package is unavailable at runtime, ViteHub leaves T3's host `claude` command fallback unchanged. Claude Code credentials and Codex credentials without an explicit `driver.credentials` resolver must be available to the host process.

Until T3 publishes the runtime on npm, pnpm consumers must set `blockExoticSubdeps: false` because the pinned runtime is an exact pkg.pr.new tarball.

CLI discovery loads the application Vite config without registering the development invocation route. Middleware stages behave the same way. Normal `vite dev` keeps the development endpoint. The generated registry also handles the first SSR import cycle through Agent server internals.

The Vite integration requires Vite 8. Configure build inputs, output options, and external dependencies under `build.rolldownOptions`.

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

## Typed questions

`driver.ask` answers typed questions with TypeSafe Jev in one request. The answers are the Invocation output, and `runAgent()` infers their type from the questions:

```ts
// server/agents/labeller.ts
import { ask, defineAgent } from "@vite-hub/agent";

export default defineAgent({
  driver: {
    ask: {
      label: ask.choice("Which label fits this email?", { invoice: "Bills and receipts.", none: "No label fits." }),
      urgent: ask.if("Does it need action today?"),
    },
  },
});
```

Jev reads Invocation `data` when a caller sets it, else the prompt text, else the latest user message. `ask.choice()`, `ask.switch()`, `ask.score()`, `ask.chance()`, and `ask.if()` return plain question objects. `driver.ask` also accepts a function that returns the questions for each Invocation.

`ask.if()` accepts a finite threshold from `0` to `1`, inclusive. It defaults to `0.5`.

Credentials come from the Server Env group `typesafe`. Declare it with `typesafe: typesafeEnv()` from `@vite-hub/env`. `llmGate()` and `llmRoute()` on an ask Driver Agent use one Jev `ask.choice()` question when they have no `model` option. Their decisions include `probabilities` and no `reason`.

## Direct invocations

Use `runAgent(agent, input)` in a script to get `[null, result]` or `[Error, null]`. ViteHub creates an isolated memo cache and run ID, then drains background work before returning. Results retain their inline output or Workflow Run shape. Agents that rely on default host Workflow discovery return an error tuple. Set `runtime: false` for inline execution, configure an explicit `workflow("name")` binding, or use the three-argument form with a host context. Non-Error failures are wrapped with their original value as the cause.

`runAgent(agent, runtimeContext, input)` keeps the host context, returns the result directly, and throws failures. Use this form for request metadata, runtime configuration, and streams that require a host background lifetime. Errors during later stream or Response-body consumption are outside the two-argument tuple. See the [invocation guide](https://vitehub.dev/docs/agents/invocations).

## Structured data and interception

Set `defineAgent({ data })` to a Standard Schema to validate `input.data` before Capabilities, hooks, and the Driver run. Invalid data fails the Invocation. Call sites use the schema input type; hooks and `intercept` receive the schema output type. Model and provider Drivers do not read `data`, so pass model text in `prompt` or `messages`.

Set `defineAgent({ intercept })` to finish an Invocation before the Driver runs. Return `undefined` to continue, or a value to use as the Invocation output. `runAgent()` types its output as the union of the `intercept` return type and the `driver.output` schema output. `agent:finish` hooks receive the intercepted value, and the finish trace event records `agent.intercepted: true`. See [Agent Definitions](https://vitehub.dev/docs/agents/agent-definitions#finish-before-the-driver).

## Custom Capability tools

Custom Capability tools infer their handler input from inline Standard Schema validators. Schema transforms and optional outputs keep their types. A mismatched handler is a type error. Raw JSON Schema needs an explicit handler input type. Use `defineCapability<Config>()({...})` when you set the runtime config type. See the [custom Capability guide](https://vitehub.dev/docs/agents/capabilities/custom).

Tools can declare `title`, a short past-tense label such as `Searched meals`, and `icon`, an Iconify name such as `i-lucide-utensils`. Tool events use `title` when the driver gives none. `inspectAgentTools()` records them as `label` and `icon`, and metadata-only journals keep both. The model does not receive them. Built-in `db`, `kv`, and `blob` tools and Workspace `materialize_sources` declare both.

## Coding provider drivers

Use `driver: "codex"` or `driver: "claude-code"` for the defaults, including approval-required provider actions. A tagged Driver config exposes shared model, environment, instruction, permission, output, and capacity options, plus Codex credential and reasoning options.

Set `driver.gateway` to route Codex or Claude Code model requests through an LLM proxy or gateway. Presets in `@vite-hub/agent/gateways` cover CLIProxyAPI, LiteLLM, Ollama, OpenRouter, Vercel AI Gateway, OpenAI, and Anthropic; `defineGateway()` covers other endpoints. Each preset reads its URL and key from optional Server Env, such as `CLIPROXY_URL` and `CLIPROXY_API_KEY`, and `cloudflareAccess()` reads Cloudflare Access service-token headers. ViteHub writes the Codex model provider configuration or the Claude Code `ANTHROPIC_*` variables, and passes the key and headers in the provider environment. Ambient variables such as `CLIPROXY_API_KEY` or `OPENAI_API_KEY` are not forwarded. See [Agent Drivers](../../docs/content/docs/agents/agent-drivers.md#route-model-requests-through-a-gateway).

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

Provider Drivers require a local Node.js host; Cloudflare Agents and Deno fail explicitly. Set `box` on the Agent Definition to start the provider command inside an [`@vite-hub/box`](../box/README.md) session. Each invocation opens a new Box with its checkout, environment, Home files, and requirements resolved for that invocation. ViteHub adds the provider command to the requirements and writes Driver instructions and Skills to the Box Home. The Box runtime must forward process input, and Capability tools need a runtime that shares the ViteHub network. `box` rejects model and custom `run` Drivers, `driver.launch`, `driver.credentials`, `driver.credentialProfile`, and `workspace` when the Agent is defined. Box invocations do not resume provider sessions, fail explicitly on Windows hosts, and fail when the Box session cannot close. Set `driver.cwd` to an existing directory, or a resolver that returns one, to run the provider in an application-owned checkout. ViteHub then materializes Workspace Sources but starts no Workspace session: it does not copy files, create a Git baseline, write changes back, or remove the directory. Title and progress summary runs ignore `cwd`. Cloudflare Worker builds exclude the provider Driver runtime through the `workerd` and `worker` package conditions and fail with `AGENT_B0019` when a server module selects a provider Driver. Provider Workspaces additionally require a POSIX host and fail explicitly on Windows. ViteHub materializes an Agent Workspace into a temporary provider working directory, applies Workspace Scope, writes `AGENTS.md` for Codex or a literal prompt file for Claude Code, then commits successful write-mode changes through Workspace rules. Runtime sessions resume by Agent thread while the Agent Definition process remains active. Set `sessionStorePath` to keep opaque provider cursors in SQLite across restarts. Codex credentials supplied through `credentials` require a named `credentialProfile` before session persistence can be enabled because an invocation-private Codex Home is removed after each run. Dedicate each file to one provider Agent Definition on one persistent process host; it does not coordinate concurrent ownership of one thread across workers. Normalized assistant, reasoning, tool, approval, user-input, usage, warning, error, and terminal events stay behind the ViteHub Agent Invocation contract.

When all selected Workspace Sources materialize successfully before the provider session starts, ViteHub appends source evidence for each ready GitHub Source with an immutable commit revision. Direct, inferred shorthand, and resolved GitHub Sources are supported. If session startup must retry materialization, ViteHub omits source evidence because the mounted revision may change. The evidence gives the canonical repository URL, commit revision, configured source root, and Workspace mount so the provider can cite the mounted files without rediscovering their origin. ViteHub omits mutable or unavailable revisions, custom Sources, invalid repository metadata, and Source credentials.

Process hosts can call `failInterruptedAgentInvocations(store, { recover })` at startup. `recover` must identify records owned by the stopped process host. Exclude durable Workflows and other provider-owned work because their active records may not hold a store claim while suspended. Recovery first respects an existing claim, waits up to `recoveryTimeoutMs`, and asks `recover` again before taking over the stopped host's claim. The timeout defaults to `claimLeaseMs`.

Journaled Invocations require a successful cancellation-state read before execution starts. A missing record, failed read, or timed-out read rejects the Invocation. A custom `run` Driver also requires durable dispatch-state metadata before it starts. Observation and terminal-write failures do not replace the Driver result.

Hosts can persist external delivery evidence with `await invocations.appendObservation(invocationId, event, { id: deliveryId })`. The stable observation ID makes retries idempotent. The store assigns the sequence atomically, including for completed, failed, or cancelled Invocations, without changing lifecycle state or taking the running Agent's claim. The configured content policy still applies. Appends return the persisted record, return `undefined` when the Invocation does not exist, and throw if storage fails or the observation capacity prevents an append. Retain the same ID when retrying an ambiguous storage failure. Use one store instance per SQLite connection so its write queue serializes concurrent append calls.

`permissions` accepts `"ask"`, `"allow-edits"`, `"allow-edits-unattended"`, or `"allow-all"` and defaults to `"ask"`. `"allow-edits-unattended"` keeps the provider edit mode and denies native permission escalation without prompting. Host-bound MCP tools keep their separate authorization. Set `"allow-all"` explicitly when provider actions should run without approval. Approval decisions use the existing Agent message approval part, and structured provider questions accept a `data-agent-input` part with `{ requestId, answers }` through invocation input mode `"respond"`. Provider-backed invocations accept live input through invocation input mode `"steer"` when the provider adds the input to its active turn. Put Agent-owned Skills under `server/agents/<name>/skills/`; use `skills()` for Workspace-backed or external Source Skills.

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

Import the same `agentCapacity` object into each Agent Definition that should share one process-local budget. Linux hosts use cgroup v2 memory limits and events, host `MemAvailable`, and the greater of host and cgroup CPU or memory pressure when available; other hosts use Node's available-memory signal without CPU-pressure admission. Sampling failures or samples exceeding `sampleTimeoutMs` (one second by default) use `fallbackConcurrency`, which defaults to one. Custom samplers should pass `context.signal` to abortable I/O. The sampler reserves `memory.perInvocationBytes` of additional growth for each active invocation before admitting new work. This is conservative because current usage is already deducted from available memory. Admission does not enforce worker limits or stop active work. Tune `memory.perInvocationBytes`, `memory.reserveBytes` for the host, `memory.serviceReserveBytes` for the process or cgroup (1 GiB by default), and the CPU or memory pressure thresholds when workload measurements justify different admission behavior.

Long-lived Node process hosts can import `createGitHubHost()` from `@vite-hub/agent/server/github` to resolve GitHub App or fallback credentials, admit GraphQL work against a shared rate-limit reserve, and run against an exact pull-request head in a temporary checkout. The process-specific entry keeps Node Git and filesystem dependencies out of the portable `@vite-hub/agent/server` entry. `withPullRequestCheckout()` uses Git over HTTPS, fetches the source branch directly, verifies the requested head, and removes the checkout contents after success, failure, cancellation, or timeout. Cleanup is best effort and preserves the callback result or error if filesystem discovery or deletion fails. Cleanup retains an empty temporary directory because removing its pathname could delete a concurrent replacement. Checkout and push operations need Git but do not need the GitHub CLI. Generic `command()` operations still use the GitHub CLI. Include `headRepository` and `headRef` to make an ordinary `git push` target the pull request's source branch. The callback keeps base repository access for reads from `origin`; use its `push()` after long-running work so the host resolves fresh source repository credentials before pushing. Push checks that the repair descends from the last verified head and uses a lease to reject a changed source branch. It returns the pushed SHA and advances the lease for later pushes in the same callback. Pass the Agent Invocation's abort signal and use the callback signal for work inside the checkout:

```ts
await github.withPullRequestCheckout(pullRequest, async ({ env, path, push, signal }) => {
  await runAgent({ cwd: path, env, signal })
  await push()
}, { signal: invocation.abortSignal, timeout: 60_000 })
```

For a provider that materializes a separate working directory, call `checkout.prepareWorkspace(cwd)` from the provider launch hook, then `checkout.push(cwd)` from the host after reviewing the result. The host imports the exact commit without credentials and pushes it from the original trusted clone, so provider Git configuration cannot control the authenticated push. Preparation copies the independent PR clone's Git history and push destination, removes old target metadata and saved credential/header configuration, and leaves the original clone unchanged. The standalone `prepareGitHubPullRequestWorkspace(checkoutPath, cwd, { signal })` export performs the same preparation. These helpers apply only to prepared GitHub PR checkouts; other workspace types do not receive Git metadata. Keep host credentials out of the provider environment when push authority belongs to the host.

`access()`, `command()`, and `ensureGraphQLBudget()` accept the same `signal` and `timeout` controls. Pass them whenever the operation belongs to an Agent Invocation so credential resolution, token refresh, and GitHub CLI work stop on cancellation. Pass an upper bound for the GraphQL query's point cost as `ensureGraphQLBudget(repository, { cost })`; the host returns a reservation. Call `reservation.submit()` immediately before sending the query, then call `reservation.settle(actualCost)` with the non-negative point cost reported by GitHub after it completes. The actual cost cannot exceed the reserved cost. Call `reservation.release()` if work stops before submission. The host keeps submitted reservations deducted during concurrent budget refreshes until settlement confirms that the query completed. A later refresh reconciles GitHub's reported remaining points. The `credentials` callback receives the target `repository` and scoped `signal`. Select that repository's App installation in the callback and pass the signal to secret-manager or network requests. Installation tokens and GraphQL budgets remain separate across installations, including concurrent checkout work. `host.channel()` also resolves credentials for each activity or delivery target repository. Unscoped `access()` calls omit `repository`, so the callback should supply its default credentials. When GitHub cannot resolve an opaque token through `/user`, return a stable `rateLimitKey` with the token so rotations of the same credential share one budget while different credentials stay isolated. Shared GraphQL admission checks have an independent 60-second command limit. Set `graphQLCheckTimeout` on `createGitHubHost()` when the host needs a different limit.

The portable `@vite-hub/agent/server` entry exports `failInterruptedAgentInvocations()`, `readAgentInvocationWorkload()`, and `summarizeAgentInvocationWorkload()` for process-start recovery and health reporting. `readAgentInvocationWorkload()` combines the latest 100 invocation summaries with every active invocation. Its `total` counts that de-duplicated union, not all historical invocations. Recovery follows every store page and acquires each invocation's lease before failing it. Invocation journals renew their lease until they finish, so work owned by a live host remains active. These are host primitives. The application still owns credential storage, admission policy, scheduling, recovery timing, and deployment lifecycle.

The same entry exports `drainInlineChatInvocations()` and `webhookQueueShutdown()` for graceful shutdown on process hosts. Call both on `SIGTERM`, then exit. `drainInlineChatInvocations({ timeoutMs, settleMs })` waits up to `timeoutMs` for inline Chat invocations to finish. It then aborts the rest with a `HOST_RESTARTED` error, which replaces the thinking placeholder with a restart notice. Each inline Chat invocation stores its inbound message in Chat state under `vitehub:interrupted-chat` until it finishes. When the webhook route resumes with `recoverInterruptedBefore`, it posts the notice for each stored message that did not complete and runs the message once more with a note that asks the Agent to check for work that the first attempt already did. Recovery requires State with atomic lease-fenced cache mutations (`mutateWithLock`). It durably reserves the single retry before dispatch, so an expired lease cannot cause a second dispatch. If the host stops after reservation but before dispatch is confirmed, the next startup treats that attempt as exhausted. A message that was already retried is not retried again; the thread gets "Please send your message again." `webhookQueueShutdown()` resolves when every stopping webhook queue has settled. A stopping queue waits up to `VITEHUB_SHUTDOWN_DRAIN_MS` for active deliveries before it aborts them, and the persisted queue replays aborted deliveries after the restart. Workflow-backed Agents do not need this path, because their runs continue across restarts.

`defineAgentInvocations({ observations, store })` configures retained observation count, content string length, encoded byte budget, and finish drain time. Defaults retain up to 32,768 observations, 65,536 UTF-16 code units of content strings, and a one-second drain, with a 16 MiB aggregate storage limit. Explicit limits support longer traces without removing bounds; records keep those limits across restarts. See [Agent Invocations](../../docs/content/docs/agents/invocations.md) for the limits and privacy policy.

`redact(observation)` rewrites or drops (`undefined`) each observation before storage, including late and appended evidence. `redactError(error)` rewrites the error of a failed record. `agent:finish` and `agent:error` events expose the record's `traceId` as `event.invocation.traceId` after journal creation confirms its identity. The field is omitted while creation is unresolved.

Capability setup and close callbacks emit `agent.capability.<phase>` timing events through the invocation trace. They include capability ID, measured duration, outcome, and available correlation IDs, without callback payloads or thrown messages. See [Agent Invocations](../../docs/content/docs/agents/invocations.md#observe-the-outcome) for the event contract.

`title()` accepts message input or a plain `prompt`. Its default prompt follows T3 Code’s subject-and-outcome rules, requests `{ "title": "..." }`, and caps the title at 39 characters. An explicit title Driver uses the configured fallback on failure or timeout. For a journaled run, title generation starts beside the main answer and cleanup joins it within its timeout. Metadata journals keep title text only when `metadataContent` includes `vitehub.session.title`.

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
- `defineChannel(kind, { message })` declares the methods that `agent:finish` and `agent:error` hooks call through `event.message`, typed from the Agent's `channels`. Set `dryRun: true` in the Invocation input to record write methods in the trace instead of calling the provider; see [Act on the Channel message in hooks](https://vitehub.dev/docs/agents/channels#act-on-the-channel-message-in-hooks).
- Built-in GitHub `webhook` and `dev` Triggers supply `{ repository, pullRequest, run, trigger }` as Channel message data. Custom `message.data` schemas must accept this pull request context.
- `workspaceShell()` runs scoped shell/file work through [`@vite-hub/shell`](../shell/README.md).
- `webSearch()` searches and reads the web with [Brave](https://brave.com/search/api/), [Exa](https://docs.exa.ai/), [Jina](https://jina.ai/en-US/reader/), [SearXNG](https://docs.searxng.org/dev/search_api.html), [SerpApi](https://serpapi.com/search-api), [SerpBase](https://serpbase.dev/docs), or [Tavily](https://docs.tavily.com/).
- `openapi()` turns an allowed OpenAPI `operationId` subset into bounded HTTP tools, or into a generated Capability CLI when `cli` is set.
- `transcribe()` uses the [AI SDK transcription API](https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/transcribe); `openRouterTranscriptionModel()` provides OpenRouter transcription without consumer-owned HTTP handling.
- `createTranscription()` composes remote asynchronous submission and completion through a provider-neutral driver; `elevenLabsScribe()` is the built-in Scribe v2 adapter.
- `mcp()` connects tools from [Model Context Protocol](https://modelcontextprotocol.io/) servers through `@ai-sdk/mcp`. Transient transport failures skip the affected server and record `vitehub.mcp.warnings` in the Invocation input context. Read them with `getMcpWarnings(input)`. Set `unavailableNotice: true` to append a notice to the final chat reply. Authentication, configuration, cancellation, protocol, and integrity failures remain fatal. Executor failures remain fatal. Outside an Invocation, `callMcpTool(server, name, args)` from `@vite-hub/agent/mcp` calls one tool on the same server entry and returns `[error, value]`.
- `kv()`, `blob()`, `db()`, and `email()` expose [`@vite-hub/kv`](../kv/README.md), [`@vite-hub/blob`](../blob/README.md), [`@vite-hub/database`](../database/README.md), and [`@vite-hub/email`](../email/README.md).
- `channelDelivery({ channel, options })` adds one `send_message` tool that sends through a Channel client from `useChannel()` to an application-selected recipient. Its name must be unique among Capability tools. It limits calls with `maxCalls` (default `1`) and can fail the Invocation with `required: true` when the Agent never sends.
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

## Channel Env

Built-in Channels read credentials from `env.server.<channel>.<field>`. They read the host variable names only when Server Env does not declare the field. `discoverAgentChannelEnv({ rootDir, serverDirs })` from `@vite-hub/agent/vite` finds built-in Channel factory calls in Agent files and returns the fields to declare, with their host names, `secret` flag, and `required` flag. `vitehub({ agent })` passes the result to Server Env before `hubEnv()` builds the registry; application declarations win field by field. Explicit Channel options always win over Env.

To give a built-in Channel Env, add its factory name and fields to `builtInChannelEnv` in `src/channel-env.ts`, then read each field with `channelEnvValue(channel, field, context)` when the option is omitted. Set `requiredUnless` to the option keys that make a field unnecessary; other fields stay optional. See the [Channel Env guide](https://vitehub.dev/docs/agents/channels#channel-env) for the current names.

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

## Chat replies

`teams()` requests descriptive Markdown source links. Chat SDK reply delivery replaces unresolved native web citations with `[source link unavailable]`, including in streams. Codex app-server does not expose a citation-ID-to-URL map; ViteHub preserves explicit source links and does not guess URLs for native IDs.

Set `messages.replyToSubscribedThreads: true` on an Agent or a built-in Channel to answer human replies without an @mention in subscribed threads. The default is `false`. Mentions subscribe the conversation. Programmatically created bot threads must be subscribed through the same Agent chat state before replies can be admitted. Unmentioned messages in other threads and messages from other bots remain ignored. `messages.filter` receives `deliveryKind: "subscribed"` for these replies. Provider permissions must still allow the bot to receive channel messages.

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

Built-in persistent `file:` connections use SQLite WAL so queue commits can complete while another connection retains a read snapshot. WAL requires a local filesystem with shared-memory support. For NFS, EFS, or another network-backed volume, set `agent.providers.state.journalMode: "delete"` to use rollback journaling. The low-level `createLibsqlAgentState()` accepts the same `journalMode` option. Keep the database and its journal files on the same persistent volume. Supplied clients and remote connections keep their own connection policy. Agent State operations on the same local file share an in-process queue across adapters, including equivalent encoded or relative file URLs. Adapters with one supplied client share a queue by client identity. Owned in-memory clients serialize their own operations without blocking independent memory databases. Owned clients using `file::memory:?cache=shared` share one database queue, including equivalent encoded and mixed-case scheme URLs. This coordination does not replace SQLite locks across processes or coordinate SQL issued directly outside Agent State.

Queued webhook deliveries in this state survive a restart. A persistent Nitro server resumes them when it starts, without an inbound request. Before the queue resumes, the server fails each Agent's pending or running invocations that started before this process. An invocation that a persisted queued delivery runs again under the same run ID stays active and continues with that delivery. Agents with a durable Workflow runtime are skipped. Vercel and Netlify output resumes the queue on the first webhook request and does not recover invocations.

A queued delivery gets three execution attempts. When the queue stops retrying it, after the last failed attempt or after the delivery used all its execution leases, ViteHub dispatches the Trigger's `failed` callback at most once with `{ attempts, deliveryId, error, publicError, input?, invocation?, run? }`. An error from `failed` is logged and does not change the delivery outcome. Pending notifications survive restart with built-in state providers; a process exit after the durable notification claim leaves an uncertain outcome that is not replayed automatically. See [Report a failed webhook delivery](../../docs/content/docs/agents/triggers.md#report-a-failed-webhook-delivery).

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

## Invocation summaries

`defineAgentInvocations()` returns `getSummary(id)` for metadata reads without observations. Every store must implement this method. Use `get(id)` for the full record or `get(id, { observationNames: ["agent.invocation.finish"] })` to read only observations with those exact names. An empty list returns no observations. The built-in SQL stores filter observation payloads inside the database. Custom stores can apply the same option to avoid loading unrelated payloads; the Invocations wrapper also filters their returned records. Both methods return `undefined` when the Invocation does not exist.

## Invocation cancel

`invocations.cancel(id)` records `cancelRequestedAt` on a pending or running Invocation and returns an `AgentInvocationCancelResult`. A run in the same process aborts its Invocation abort signal at once. The `requested` outcome confirms a recorded or locally sent request, not that execution stopped. If the journal record is missing but a local run received the request, the result still reports `requested` with `delivery: "local"` and any Driver warning. Before setup, active runs check the flag; a rejected or missing read, or a check that exceeds one second, fails startup with `AGENT_R0973`. After startup, active runs read the flag every 10 seconds, including after a lost lease stops claim renewal. Orphaned records remain pending or running until an execution owner recovers and observes the request. Cancellation does not take over expired leases or recover orphaned work. Read the final journal status to confirm cancellation. Model-backed and provider-backed Drivers stop on cancel. Cancellation before Driver dispatch stops startup without a warning. `cancelWarningPending` and its `cancelWarningOwnerId` are persisted when a custom Driver record is created and identifies dispatch that is not yet verified; warning writes retry after dispatch. A remote caller waits up to five seconds to verify a pending state, then throws `AGENT_R0974` if verification fails, while keeping the recorded request. A custom `run` Driver that has started receives the aborted signal but ViteHub cannot stop it, so the result reports `notEnforcedBy: "run"` and the record stays `running`. A terminal journal does not prove every stale local Driver stopped; cancelling it still signals local runs and returns durable or local `notEnforcedBy` warnings without changing the terminal record. Durable warnings describe Driver enforcement and do not prove work is still active. Custom stores keep the new fields through `applyAgentInvocationStoreUpdate()`. `vitehub agent invocations cancel <id>` sends the same request into the Nitro runtime of a Vite + Nitro Development Server, so it reaches the application's own journal and abort handles. Nuxt and plain Vite return `501`. With `--url https://app.example.com`, the command sends the request to the deployed Console instead, with the credentials in `VITEHUB_CONSOLE_AUTHORIZATION`, `VITEHUB_CONSOLE_COOKIE`, or `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. See [Agent Invocations](../../docs/content/docs/agents/invocations.md#cancel-an-invocation).

## GitHub pull request Workspaces

GitHub pull request Channels use `pullRequest.workspace.mount` for a custom repository mount. Omitting `workspace` mounts at `portal`. Both `workspace: true` and `workspace: {}` use the Workspace root. Set `workspace: false` to disable the contribution.

Provider Drivers get the mount as a real Git checkout of the exact head SHA, with `origin`, the fetched base branch, and a local head branch that tracks the pull request branch. A declared GitHub Source of the same repository and scope at the same mount is replaced for the Invocation; a different repository or scope fails with an error that names the Source. Checkout setup rejects a head branch without an explicit head repository, including pull requests from deleted forks.

Set `defineAgent({ github })` to a GitHub identity such as `createGitHubHost()`. Provider Drivers receive its `access().env` (`GH_TOKEN`, `GITHUB_TOKEN`, a Git credential helper, and the commit identity) before `driver.env`, and the pull request checkout and `git()` use the same credentials. `github({ app: host })` uses the identity for Channel API calls and also sets `defineAgent({ github })` when it is omitted.

Channels with `history: { collection, key, thread?, invocationItem? }` export Collection items through `vitehub channels history`. Use repeatable `--query key=value`, optional `--thread`, and `--invocations` for retained runs and unformatted deliveries. Live and replayed triggers annotate the item key and thread. `channelDelivery` records dry-run writes without sending. Declared `webhooks.path` values receive the same authenticated requests as built-in webhook routes. See the [Channel history guide](../../docs/content/docs/agents/channels.md#replay-channel-history).

For GitHub Channels, `activity: true` links pull request webhook activity to its ViteHub Console invocation when `vitehub({ publicUrl })` is set. `activity: { publicUrl }` overrides the origin for one Channel. Without a public URL, the application supplies its own links. See the [GitHub Channel guide](../../docs/content/docs/agents/channels.md#publish-agent-activity-without-opening-a-chat).

`pullRequest.reconcile.concurrencyLimit` sets the maximum concurrent reconciled webhook deliveries per repository and pull request. It defaults to `1`; set a positive integer such as `4` to run up to four deliveries for one PR together. Other PRs have separate limits. See the [GitHub Channel guide](../../docs/content/docs/agents/channels.md#reconcile-github-pull-requests).

## D1 invocation storage

`@vite-hub/agent/invocations/d1` exports `createD1AgentInvocationStore({ database })`. Pass a D1 binding or a resolver that returns the current request binding. The store creates its table with idempotent `d1AgentInvocationSchema()` statements on first use of each binding in an isolate. Set `migrate: false` to apply those statements through your own D1 migration tool instead.

D1 batches and conditional writes preserve concurrent journal updates across Workers. Claims use the database clock. Terminal records use the same 30-day and 10,000-record retention defaults as the libSQL store. Both adapters apply the record count on about 1 in `ceil(maxRecords / 100)` creates and terminal transitions, because that limit reads about `maxRecords` rows. The count can exceed the limit by about 1% between runs. Pending and running records are retained. `maxAgeMs: false` and `maxRecords: false` disable each limit. `invocations.delete(id)` and `invocations.prune({ olderThanMs, dryRun })` remove terminal records on demand in both adapters; `vitehub agent invocations delete|prune` does the same for a SQLite or libSQL journal. An update rejects after 32 concurrent write conflicts. Use the journal's `redact` hook to remove sensitive values before any store receives them.

`agentInvocationRerunInput(record)` returns the recorded prompt and Invoker Profile ID of a terminal record when the journal kept the complete prompt and selected profile ID. Pending and running records return `available: false` with the reason `invocation-not-terminal`. Otherwise it returns `available: false` with the reason: `input-not-captured`, `replay-metadata-unavailable`, `input-has-invoker`, `input-has-data`, `input-has-options`, `input-has-context`, `input-has-run-metadata`, `input-has-timeout`, `input-has-abort-signal`, `input-has-dry-run`, `input-prompt-changed`, `input-has-messages`, `input-redacted`, or `input-truncated`. Records without the current replay schema and invocations with a direct invoker or actor identity cannot be replayed. A resolver-derived Invoker without a selected Invoker Profile also returns `input-has-invoker`. A selected profile is resolved again when the new Invocation starts. Structured input, call options, extra context, runtime run metadata, timeouts, cancellation signals, dry-run mode, singular message inputs, and prompts changed by input preparation are not replayed. Redaction of the prompt, input-presence flags, or selected Invoker Profile disables replay. The Console uses it for its rerun action. `invocations.supportsDelete` reports whether the configured store implements deletion.

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

Child configuration overrides parent defaults. Channels, Sources, Skills, and hooks merge by key, replacing each matching definition or callback as a whole. Static Capabilities merge by `id`: the child replaces a matching Capability and appends new ones. A Capability resolver replaces the inherited list or resolver. Other arrays replace the parent array. A child `driver.launch` replaces the entire inherited launch command or resolver, including `onExit`. If the child omits `launch`, it inherits the parent launch. Changing a Driver kind or store provider replaces that configuration.

`extends` accepts one definition created by `defineAgent()` in the same package instance. It does not discover files in the parent's directory. Compose shared instruction strings in TypeScript, or import Markdown with `?raw` and assign the composed string to `driver.instructions`. References such as `@../bot/instructions.md` remain literal text. Share Skills through explicit Sources or a directory link.

A definition that is not discovered, such as one created in a Schedule, uses the colocated Skills of the discovered Agent it extends. It reads them when it runs, so module import order does not matter. Use `agentWithSkills()` to add Skills to such a definition without an Agent folder:

```ts [server/schedules/changelog.ts]
import { agentWithSkills, defineAgent } from 'vite-hub/agent'
import botDev from '../agents/bot-dev/agent'
import changelogSkill from './changelog-skill.md?raw'

const changelogAgent = agentWithSkills(
  defineAgent({ extends: botDev, name: 'changelog' }),
  { 'changelog-writing': changelogSkill },
)
```

Each key is a Skill name, and each value is its `SKILL.md` content. The result keeps the inherited Skills. A Skill with the same name replaces the inherited one.

### Named presets

Export ordinary `defineAgent()` definitions from a preset package. Consumers import them and select a local name:

```ts
import { defineAgent } from "@vite-hub/agent"
import { notetaker } from "@example/agents"

export default defineAgent({
  preset: "notetaker",
  presets: { notetaker },
  name: "meeting-notes",
  driver: { model: "gpt-5.6-sol" },
})
```

`preset` must name an own entry in `presets`. Selection uses the same composition as `extends`, including child overrides and a fresh runtime. Specify one parent with either `preset` or `extends`. The map belongs to this definition; it does not register global names or load packages. Neither the map nor its selected name becomes model instructions.

Preset packages must declare `@vite-hub/agent` as a peer dependency so their definitions share the application's package instance. Package authors must include instruction content and required assets explicitly; selecting a preset does not discover its package directory.

A preset can expose typed options with the same `defineAgent()` function:

```ts
export const notetaker = defineAgent({
  options: { format: "concise" as "concise" | "detailed", labels: ["notes"] },
  configure: ({ format }) => defineAgent({
    driver: { kind: "codex", instructions: `Write ${format} notes.` },
  }),
})
```

Consumers select the definition and override only the options they need:

```ts
const notes = defineAgent({
  preset: "notetaker",
  presets: { notetaker },
  options: { format: "detailed", labels: [] },
  driver: { model: "gpt-5.4" },
})

notes.options.format // "concise" | "detailed"
```

`options` must be a plain record and uses nested defaults. Built-in instance roots are rejected by the types. Custom class roots are rejected at runtime because TypeScript cannot distinguish their structure from plain records with callbacks. Child values replace parent values, including `false`, empty arrays, and callbacks. Arrays never concatenate. Nested values with required methods, including class instances, require complete replacements. Omitted or `undefined` values retain their defaults. Annotate optional fields and literal unions in the defaults to describe the accepted configuration. TypeScript checks options against the selected preset. If options come from untyped input, validate them in `configure`.

`configure` runs synchronously when defining or extending the Agent. Return a normal Agent Definition and keep this callback free of network calls and other side effects. The callback receives its own option copy. Copies of standard built-ins preserve their own property descriptors and nested values. Custom class instances and values such as `WeakMap`, `WeakSet`, and `Error` retain their identity across option copies. Detached buffers and their views retain identity. Resizable or growable buffers and their views also retain identity, preserving resize behavior and fixed-length or length-tracking views. Ordinary Agent overrides apply after the callback and remain in effect through further extensions. An inherited Agent name is cleared on each extension. For discovered Agents, a Workspace reference object must use a statically known string `name`; `name: undefined` owns a Workspace. Opaque names require an explicit Workspace ownership marker on the configured definition. A configured Agent exposes its resolved `options` for host setup and inspection; these values do not become model instructions automatically.

For folder Agents discovered from `agent.ts`, define `configure` in that file and return a discoverable `defineAgent()` call. Workspace discovery does not execute imported callbacks or opaque helper calls returned by `configure`, including computed calls such as `builders["workspace"]()` and asserted calls such as `build!()` or `(build as Factory)()`. Return `defineAgent()` directly, or declare `workspace: {}` for owned storage or a named Workspace reference on the configured Agent. It rejects an imported `configure` callback because it cannot determine the required Workspace setup. Discovery also rejects unresolved computed settings keys, quoted keys with unsupported escapes, compound `void` expressions, dynamic Workspace values such as `options.workspaceName`, opaque settings spreads such as `...importedSettings`, imported Capability options and preset registries (including object spreads), option-derived Capability lists such as `options.caps`, returned Agent members such as `agents.storage`, imported Agent parents, imported Channel maps, Channels imported from packages, local Channel factories and opaque calls such as `makeChannel()`, first-party Channel helper calls with opaque options such as `github(options.github)` or `github({ pullRequest: options.pullRequest })`, Channel options defined by accessors such as `get pullRequest()`, dynamic preset selections, logical Capability expressions such as `false || [storage]`, constructed Capability lists such as `Array.of(storage)` or `[plain].concat(storage)`, imported Capability values, destructured Capability bindings, and local Capability member access or calls such as `values.storage` and `values.storage()`. If these contribute an owned Workspace, add `workspace: {}` to the Agent definition. Otherwise, define the settings, parents, Channels, and Capabilities locally with direct bindings so discovery can inspect them.

Discovery reads first-party Channel helper calls, such as `github({ pullRequest: false })`, without running them. It also follows a Channel imported from a relative module, such as `import portal from '../portal.github.ts'`, and inspects that module's export with the same rules. It follows re-exports from relative modules, such as `export { default } from './inner.ts'` and `export * from './channels.ts'`, and rejects re-exports from packages. `github()` owns a Workspace only when `pullRequest` is enabled and `pullRequest.workspace` is not `false`. `discord()`, `gitlab()`, `forgejo()`, `http()`, `slack()`, `teams()`, `telegram()`, and `webChat()` own a Workspace only through their `capabilities`. An Agent whose Channels own no Workspace stays a stateless Agent; do not add `workspace: {}` to it.

Discovery rejects Channel option bindings that are mutated or passed to opaque calls, including local callbacks and built-in mutators such as `Object.assign`. It does not execute those calls to inspect their effects. Use unmodified local options, or add `workspace: {}` when the Channel owns a Workspace.

Configured presets use the existing layer rules for capabilities, channels, and hooks. A child replaces a capability with the same ID or a channel or hook with the same key. Distinct hooks remain present; same-key hooks do not automatically compose. Option callbacks are values and are also replaced, never invoked by merging.

Publish the exported definition on npm and import it into `presets`. There is no second preset factory or global package loader.



## evlog integration

Import `observability()` and `createAgentEvlog()` from `@vite-hub/agent/evlog`, not `@vite-hub/agent/capabilities`. This keeps unrelated Capabilities usable without the optional `evlog` peer. Applications can use `vite-hub/agent/evlog`. Install `evlog` when using this integration.

`createAgentEvlog()` from `@vite-hub/agent/evlog` exports invocation lifecycle events through evlog. Add its `capability` to your Agent, connect its `drain` to the host, and await `flush()` after invocation background tasks finish. `@vite-hub/agent/evlog/posthog` adds PostHog events, Error Tracking and the official evlog log drain through optional dependencies.

`createPapercutReporter()` from `@vite-hub/agent/capabilities` journals reports in persistent Agent Invocations before delivery and replays pending reports after restart. See [observability](../../docs/content/docs/agents/observability.md) for delivery, privacy and shutdown contracts.

GitHub Channels with `activity: true` keep one managed comment per pull request. A single table lists current and recent session links, status, relative start times, and completed durations. Task checkboxes and the newest available session's final answer appear below; all session answers are collapsed in newest-first order with one link and one paragraph per answer. Full transcripts stay in the linked sessions.

### Process-owned agents

For a single Node process that discovers background work, `createProcessAgentHost`
from `@vite-hub/agent/runtime/process` combines capacity, invocation storage and
recovery, provider-session storage, and a draining reconciler. Its data directory
must belong exclusively to this host. It is not a distributed lease.

```ts
export default await createProcessAgentHost({
  name: 'reviewer',
  dataDir: '.vitehub',
  providerCommand: 'codex',
  capacity: { concurrency: 4 },
  async run(reason, { track }, accepting) {
    const jobs = await discoverWork()
    if (accepting()) track(runJobs(jobs))
  },
})
```

Use the host's `capacity`, `invocations`, and `providerSessionStorePath` in the
Agent Definition. `host.health()` reports provider availability and stale records.
`host.wake()` requests discovery after work completes. `host.start()` is idempotent;
`host.close()` stops admission and waits for tracked work.

The host can also live beside an Agent Definition as a named export. Keep the
Agent Definition as the module's default export and select the host in Vite:

```ts
processAgentHost({ entry: './server/agents/babysitter/agent.ts', exportName: 'host' })
```

`exportName` defaults to `default`. Both startup/shutdown and the drain route use
the selected export; no separate host entry file is required.

For Nitro, add `processAgentHost({ entry: './server/host.ts' })` from
`@vite-hub/agent/vite` to the Vite plugins. The entry exports the host as default.
The plugin starts it and closes it with Nitro, and serves drain status at
`/api/drain`, configurable with `drainRoute`. SIGUSR2 starts a drain.
Use the runtime drain CLI before replacing the process.

`@vite-hub/agent/server/github-inbox` provides a SQLite PR inbox for Node hosts.
Construct `PullRequestInbox({ storage, repositories, filter })` with
`agentState.extension("babysitter")` from `@vite-hub/agent/state/sqlite` to keep
the inbox tables in the Agent State database, or with `path` for a private
`node:sqlite` file. `scope` separates inboxes that share one storage. Every
method is asynchronous. Seed discovered PRs and ingest verified webhook
deliveries with `ingest(deliveryId, event, payload)`.
`filter` uses `GitHubPullRequestFilter` from the GitHub Channel. PR properties apply
to discovery and claims. Actor and action rules gate new webhook admissions only;
existing PRs still receive lifecycle evidence that can cancel their active work.

`claim(limit)` grants exclusive two-hour leases. `hydrateSnapshot()` fills gaps
through a caller-supplied paginated REST reader and optional thread reader.
`finish()` parks completed work or schedules a retry; feedback and terminal CI
results wake it by default. Pending CI updates persist without starting another pass.
CI for a source push can arrive before the PR synchronize event. The inbox retains
it for the active claim or a durable pushed-head wait. A rollback to the original
claimed head revokes repair custody, even while synchronize still reports that head.
For explicit durable waits, pass `wait: { reason, evidenceKey }` to `finish()`.
The inbox binds the wait to the current head and excludes it from claims until
`wake(observedSnapshot, evidenceKey)` sees changed evidence. See the
[host reconciliation contract](../../docs/content/docs/reference/github-inbox-waits.md).
`recoverLeases()` releases expired leases only, including after a process restart.
Claims, recovery, head matching and `summary()` read indexed columns, so they do
not parse every stored snapshot. `detectChangedPullRequests()` reads every open PR of a repository with one
GraphQL query per 50 PRs, at most once a minute. It seeds PRs that no delivery
reported and marks PRs whose state fingerprint changed, or that closed.
`probeChangedSnapshots()` then reads only those PRs over REST and ingests them,
so lost webhook deliveries are recovered without probing unchanged PRs. Row
order and an unknown mergeability do not count as changes. `pruneDeliveries()` drops delivery payloads after
7 days and delivery IDs after 30 days. `importLegacyFile(path)` copies an older
`node:sqlite` inbox file once, clears its leases, and leaves the file unchanged.
`createClaimStopCheck()` checks lease, PR state, and head changes, and accepts a
repair push only when the provider Git HEAD proves the new head. Call `close()`
when the host stops. `snapshotPrompt()` serializes the retained feedback with
explicit thread resolution and current-head checks; it does not truncate bodies.

`createGitHubPullRequests(host)` from `@vite-hub/agent/server/github` reads PR
snapshots with paginated feedback, required checks, and host budget admission.
An explicit `activityAuthors` list excludes only those authors' managed activity
comments from feedback fingerprints. `feedback.hasDiscussion` is conservative;
consumers must still check failures and conflicts before deciding to wait.
`publishAgentActivity()` updates a channel without starting an invocation.

`createGitHubPullRequestOperations(host, { repository, number, expectedHeadOid,
autoMerge, eligible, push })` binds repair operations to one PR. Expose its
comment, metadata, thread resolution, failure log, and push methods as selected
Capabilities. Keep `host`, its credentials, and Git credential configuration out
of the worker. `eligible` receives current PR fields and all labels, so the host
can recheck the channel filter before each operation. The host-owned `push`
callback returns the verified commit SHA; subsequent operations follow that head
and reject external changes.

`requestAutoMerge()` is disabled by default. When enabled, it checks repository
settings, required checks or workflows in active branch rules or required checks in classic protection, and
outstanding human change requests, then requests GitHub native auto-merge with
an atomic expected-head check. It returns `enabled`, `already-enabled`, `merged`,
or `blocked` with a reason. GitHub remains responsible for required checks and
reviews. The operation never approves, merges directly, or deletes a branch.
If automatic repository branch deletion could affect open child PRs, it blocks.
API failures propagate without a direct-merge fallback.

`host.channel({ activity: true })` is `github({ activity: true, app: host })`. It shares the host's credentials and identity.
A provider `env` resolver can call `host.environment()` inside
`withPullRequestCheckout()`. The environment binds to that callback's checkout,
including concurrent callbacks. Await the entire agent run before returning.
Use `defineAgent({ extends: agent, name, workspace })` to bind the workspace
without rebuilding driver configuration.

### Host inspection routes

Keep host inspection configuration beside an Agent Definition. `agentHostRoutes`
from `vite-hub/agent/vite` generates GET/HEAD routes from named function exports:

```ts
agentHostRoutes({
  entry: './server/agents/support/agent.ts',
  health: 'health',
  workspace: 'workspace',
})
```

The defaults are `/api/health` and
`/api/_vitehub/console/invocations/:id/workspace`. Each option also accepts
`{ exportName, route }`. Omit an option to omit its route. Workspace exports accept
`(invocationId, path?)` and return a Response; for GitHub checkouts, use
`createGitHubInvocationWorkspaceHandler({ host: github, invocations })`.
The default Workspace route also serves Console RPC inspection, so retained GitHub
snapshots remain available after disposable checkouts are removed. A custom route
keeps its own URL and does not replace the default Console inspector.

These are opt-in host routes: the application owns access control, including any
middleware protecting Workspace content. They do not grant Console authorization.

Export `health = createAgentHealth({ name: 'Support', agent: () => agent })` from
`vite-hub/agent/server` for model, admission, invocation workload, and provider
status. Provider inspection uses the definition's credentials and launch target
(including SSH), sends no prompt, and shares Console's cached inspection logic.
Optional `process`, `github`, and `console` inputs add process recovery, GitHub
access/budget, and Console delivery diagnostics. `diagnostics(signal)` and
`workload()` add application-specific information. An informational warning can
set `affectsHealth: false`, so an expected budget wait does not degrade health.

Reports are cached for five seconds and concurrent reads share one sample.
`maxAgeMs` and `timeoutMs` configure caching and the default 15-second deadline.
A timeout returns a degraded report and prevents overlapping samples until the
original dependency settles. Dependency errors are not copied into public reports.
Health is an operational report and returns HTTP 200 even when degraded; keep
startup readiness and Kubernetes restart policy on their existing probes.

## Host lifecycle and transcript retention

For a Nitro host, set `agent.preparation` in `vitehub()` to start Workspace preparation with the server and stop it on shutdown:

```ts
agent: {
  preparation: {
    workspace: "support",
    requireNonEmpty: true,
    retryDelayMs: 10_000,
  },
}
```

The generated `/api/_vitehub/ready` route supports GET and HEAD, returning 503 until preparation succeeds. `requireNonEmpty` rejects an empty prepared Workspace; it is opt-in. Set `route` to change the readiness path.

`agentEvlogPlugin(telemetry, reporters)` from `@vite-hub/agent/evlog` owns Nitro request IDs, drain and error hooks, reporter lifecycle, and shutdown flush. See the [observability guide](https://vitehub.dev/docs/agents/observability) for host drain reuse and background delivery.

Set `transcripts: { retention: "forever" }` in `createLibsqlAgentState()` to preserve Chat transcript rows before startup expiry cleanup and ignore future transcript TTLs. Other state still expires normally. This cannot recover rows already deleted.


Webhook `secretToken` accepts a string, `false`, `undefined`, a callback, or an object with its own `resolve` method. Resolver objects must define `resolve` directly, for example `{ resolve: () => "secret" }`. A class can use a `resolve` field. Inherited methods, including class prototype methods, are rejected. Resolvers must return a string, `false` to disable verification, or `undefined`. Other resolved values fail webhook verification.

For an existing external webhook URL, Nitro hosts can route an alias directly to an Agent Channel:

```ts
hubAgent({
  routes: {
    aliases: {
      "/api/github/webhook": { agent: "support", webhook: "github" },
    },
  },
})
```

Aliases use the native webhook handler, retaining the request body and signature headers. The target Channel must be configured on that Agent. Static route collisions fail at build time. Deno and standalone Netlify output do not currently support aliases.

## Code Host capability

`codeHost()` from `@vite-hub/agent/capabilities` gives an Agent repository tools for GitHub, GitLab and Forgejo. Read mode is the default. Write mode adds comments, labels, reviews and checks. Credentials come from Server Env. Repository access is bounded by `repositories` or the triggering pull request context. See [Code Host](../../docs/content/docs/agents/capabilities/code-host.md) for tools, approval and limits.

## Capability inspection

Capability definitions can declare `inspection: { label, view? }`. Lifecycle hooks publish serializable state with `await context.inspection.set(state)`. The state replaces the previous snapshot for that Capability and Invocation. Views use the typed, read-only JSON Render catalog in `AgentCapabilityInspectionView`; runtime code has no Vue dependency.

MCP records server discovery and tool provenance. Title records generation settings, progress, and its result. The Console's Capabilities tab reads these snapshots without invoking either capability. Other capabilities use the default tools/configuration view. Set the Invocation journal's `configuration` to `"content"` to retain inspection state and views independently of other trace content. Metadata-only capture keeps labels. Existing redaction and observation bounds apply.

See [custom capability inspection](https://vitehub.dev/docs/agents/capabilities/custom#contribute-an-inspection-view) for the catalog and a complete example.


### Instruction templates

An Agent can reserve one place for extending instructions. Define a template in
`driver.instructions` with exactly one `{{{ instructions }}}` marker outside code:

```ts
const base = defineAgent({
  driver: {
    kind: "codex",
    instructions: {
      template: "Inspect the request.\n\n{{{ instructions }}}\n\nExplain the result.",
      content: "Use concise language.",
    },
  },
})

const agent = defineAgent({
  extends: base,
  driver: { instructions: "Check migration safety." },
})
```

The extension replaces the slot content. It does not append instructions or add
headings. Omitted content uses the inherited default. Strings, arrays, and async
instruction resolvers work in both `template` and `content`. Markdown files can
be loaded through the existing instruction resolver or Markdown import path.

To discard the inherited template, use
`instructions: { mode: "replace", value: "A complete instruction document." }`.
A new `{ template, content }` object also replaces the inherited template.
Without a template, extending instructions replaces the inherited document.

### Babysitter preset

Import `babysitter` from `@vite-hub/agent/presets/babysitter`, or
`vite-hub/agent/presets/babysitter` in an application. It repairs selected pull
requests, addresses human and bot review feedback, and parks while checks run.
Its workflow options are the GitHub Channel `filter`, the provider `driver`, and
the `merge` policy:

```ts
import { defineAgent } from "@vite-hub/agent"
import { babysitter } from "@vite-hub/agent/presets/babysitter"

export default defineAgent({
  preset: "babysitter",
  presets: { babysitter },
  options: {
    filter: {
      repository: { allow: ["acme/app"] },
      labels: { allow: ["repair"], deny: ["do-not-touch"] },
    },
    driver: "codex",
    merge: false,
    concurrency: 2,
  },
  driver: { model: "your-codex-model" },
})
```

`driver` selects the provider Driver that repairs each checkout: `"codex"` (the
default) or `"claude-code"`. Set its model and other provider settings with the
ordinary `driver` field. Model and custom run Drivers cannot repair a checkout.

`install` defaults to `true`. This mode requires Git and Corepack in the trusted
host PATH. Install Corepack separately on Node 25 and newer. The package Node
engine does not install these host tools. The host installs dependencies from the
frozen pnpm, npm, or Yarn lockfile before starting the provider. Installers run one
at a time per host process to bound dependency setup memory. Lifecycle scripts and
repository package-manager hooks, plugins, and binary delegation stay disabled.
The package manager must name an official version, rather than a URL. Corepack
uses the trusted npm registry and ignores checkout environment files. npm must
be version 7 or newer. A manifest without a package-manager version uses a pinned
default rather than an ambient executable. Installation failures are recorded in
`.git/vitehub-install.json`. Invalid installation inputs park the PR until new head
or comment evidence wakes it. Host and package-manager failures retry after five
minutes. Set `install: false` for a checkout with no Node dependencies.
Dependency manifests and lockfiles are checked for local sources that escape the checkout, including encoded paths and symlinks. Project `.npmrc` and pnpm workspace configuration accept dependency declarations, peer and hoisting settings, and build allowlists. Other settings, including filesystem locations and package-manager extensions, are rejected before host installation. Supported configuration is fingerprinted so changes require a dependency refresh. npm accepts either `package-lock.json` or `npm-shrinkwrap.json`, and the boolean lockfile-shaping settings `legacy-peer-deps` and `install-links`.
Validation follows configured workspace patterns and referenced local packages; unrelated nested projects are excluded. pnpm workspaces without a root manifest use the pinned pnpm default. Executable fetch protocols such as Yarn `exec:`, Git dependencies that prepare remote projects, and unsupported source protocols are rejected before Corepack runs. Use registry packages or HTTPS archives instead, or set `install: false` when dependencies must be prepared in the provider sandbox.
Local package source files, archives, and patch files contribute their contents and executable mode to the dependency fingerprint. Local package source trees require regular files and directories; installed modules and Git metadata are excluded. Host installation reads a validated snapshot inside protected Git metadata, so provider writes cannot alter package-manager configuration or dependency sources after validation. The package-manager cache has its own CommonJS scope even in an ESM checkout. The host reconciles generated dependency outputs and rejects a refresh if the live dependency inputs changed. Workspace links continue to point to the live checkout.
Validation refreshes generated linked commands in reused input snapshots. A changed or deleted command requires a dependency refresh; tracked commands retain their commit snapshot.
Refresh reconciles all managed outputs. Switching to Yarn PnP removes obsolete root and workspace `node_modules`; switching away removes generated `.pnp.*` and Yarn cache state while preserving Yarn source configuration. Provider quota cooldowns pause model dispatch until their recorded deadline. Host merges and stack retargets continue during that cooldown.
Yarn `~/` patch selectors resolve from the project root after decoding. Other local patch selectors are rejected because Yarn can resolve them inside a parent package filesystem. Each grouped lockfile
descriptor is checked. Workspace glob matches must stay inside the checkout after
symlink resolution. Trusted GitHub release archives use the HTTPS archive path.
Workers call `commitRepair` with a message and explicit repair paths, then
`pushRepair`. The host commits because the provider sandbox protects Git metadata. For a
conflicting PR, the host first prepares a merge against the exact base commit.
Installation runs after merge preparation. The worker resolves dependency conflicts and calls `refreshDependencies` before validation, then commits through the same tool. Changing dependency inputs requires another refresh and validation before committing.
Unattended Codex runs preauthorize only the assigned host tools. Capability checks
still run on the host, and the native shell keeps its edit sandbox.

Direct merges use GitHub's asynchronous API, including native stacks. The inbox
records the request UUID and waits for GitHub to confirm a merge. Finished owners
release their queue lease while preserving any unresolved merge attempt. Expired
GitHub request results re-enter the current head's normal merge gates. An enqueued request retains its fence until the PR closes, merges, or changes head: queue absence and removal timeline commits do not identify the accepted request safely.

`merge` defaults to `false`:

| Value | Behavior |
| --- | --- |
| `false` | The Babysitter never merges. |
| `"auto"` | The worker may call `requestAutoMerge`, which requests GitHub native auto-merge. |
| `"direct"` | Before a model pass, the host squash-merges a PR that is ready. |
| `{ strategy: "direct", method, ready }` | Direct merge with `"squash"`, `"merge"`, or `"rebase"`, and an optional `ready` hook. |

A direct merge needs passing required checks, completed and successful
current-head checks and statuses, loaded and resolved review threads, a
non-draft PR, and GitHub's live `mergeable_state: "clean"` on the default
branch. The merge request pins the head SHA, so a concurrent push makes GitHub
reject it. `ready({ repository, number, head, snapshot, requiredChecks })` can
add a policy, such as a required approval check; return `true` or a reason. Any
other result runs a normal repair pass. `autoMerge: true` is a deprecated alias
for `merge: "auto"`.

After a repair push, the pass may continue for 3 minutes, then ends. The PR
waits on the pushed head. Later events on a waiting PR start a pass only when
they need one: new human or bot feedback, a new failing check, a merge conflict,
or an unresolved review thread. Pending checks, the pushed head's synchronize
event, and repeated results for failures the pass already saw keep it waiting.
With `merge: "direct"`, passing required checks also wake it, so the host can
merge. `reviewChecks` lists check names, such as a review bot's check, that keep
a PR waiting while they run. A comment-only review with an empty body does not
wake a waiting PR; its inline comments do. `noFindingsReviews` lists body
prefixes, such as `"> ✅ No new issues found."`, of comment-only reviews that
report no findings; these do not wake it either. `ignoreFeedbackAuthors` lists
logins, such as deployment preview bots, whose comments and reviews never need an
assessment. Feedback that a pass assessed or answered with a repair push stays
assessed on later heads, so a direct merge needs a model pass only for new
feedback. Bot issue comments count by identity, not body. Without required
checks on the base branch, the newest run of every current-head check must
finish before a merge.

`deferWhilePending` (default `true`) holds a pass while required checks or
review checks run, unless a failure or conflict already needs repair; the PR
wakes once the gates stop. `noProgressBudget` (default `3`, `false` disables it)
stops a head after that many passes without a push or a recorded wait, until the
head changes or a person comments. `install` (default `true`) installs
dependencies on the host before the model starts: it detects pnpm, npm or
Yarn from the lockfile and installs frozen, or runs `{ command, args }`. The
install gets a scrubbed environment and records its result and timing in
`.git/vitehub-install.json`. On Linux, a detected pnpm install reuses the
`node_modules` trees through independent copies (copy-on-write where supported).
The cache is scoped by repository identity, lockfile, workspace configuration,
package manifests, `.npmrc` files, patches and Node version. Restored trees are
verified offline, with one install per cache key at a time. Detected installs
disable lifecycle and build scripts; custom commands are trusted host configuration.
`install: { cache: { directory, entries } }` configures the cache, and
`cache: false` disables it. At startup, the built-in host removes pass
workspaces from an earlier process when its temporary directory is inside the
service directory. Stack parents are claimed first, and a restart
releases the claims of the previous process. A stacked PR whose parent merged into the default
branch is retargeted to the default branch. A provider rate limit is retried
three times; after that, model dispatch waits for an hour. Each owner rechecks
the durable deadline before dispatch, including after workspace setup. Host
merges and stack retargets continue during the cooldown.
While the built-in resource guard pauses model passes for a spent token budget, low temporary space or exhausted proxy accounts, host work continues. A token budget of `0` stops every claim.

Colocated `instructions.md` fills the preset's instruction slot without adding
headings. Explicit `driver.instructions` replaces that slot. Use
`{ mode: "replace", value: "..." }` to replace the complete instruction document.

A discovered Agent that imports the preset runs without more wiring on the Node
server preset. ViteHub generates a Nitro plugin that starts a process host for
it: a SQLite PR inbox in Agent State, bounded GitHub discovery of
`filter.repository.allow`, claims, repair passes, and wake handling. Signed
GitHub deliveries to `/api/_vitehub/agents/<name>/webhooks/github` feed the
inbox; they never start the Agent directly. `GET /api/_vitehub/host/drain`
reports drain status, and `GET /api/_vitehub/host/health` reports each host's
health and queue. SIGUSR2 starts a drain. The build fails with `AGENT_B0022` on
hosts that cannot keep a process running, and with `AGENT_B0023` without SQL
Agent State. Hosts start in production builds, or in development only with
`VITEHUB_AGENT_PROCESS_HOSTS=1`, so a development server does not repair real
PRs by accident.

The host reads the GitHub App from `env.server.github` or `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY_PATH`), and
`GITHUB_WEBHOOK_SECRET`. It resolves the App installation of each repository and
commits as the App's bot. `GITHUB_APP_INSTALLATION_ID` pins the installation for
`GITHUB_APP_OWNER`. `GITHUB_APP_INSTALLATIONS` accepts a JSON object mapping owner
names to installation IDs. Other owners resolve their own installation. The host
ignores an environment installation ID without an owner.
A delivery without a configured webhook secret is rejected. Only the commit
author and committer identity pass to the worker; credentials do not. On its
first start, the host imports `.vitehub/pull-request-inbox.sqlite` from an
earlier hand-wired Babysitter once.

Pass results and their GitHub status deliveries commit in one inbox transaction.
The host publishes the saved result through its verified GitHub identity, retries
failed delivery after restart, and compares delivery versions before clearing an
entry. Delivery claims are atomic across hosts and expire after five minutes if
a host stops. Active writers renew their leases until publication settles, even
when the twenty-second deadline requests cancellation. Up to five publications
run outside queue reconciliation and remain tracked during process drain.
Deferred repair heads yield the bounded batch to other PRs. Saved results use
separate activity run IDs so completed invocations can publish their wait reason.
Older acknowledgements are backfilled with the corrected activity identity.
New same-head feedback discards obsolete saved results. Confirmed repair-head and
closure transitions retain their result. If a writer settles after another host
replaces its expired lease, the latest settled result is requeued with a fresh
activity identity. A late saved-status write during an active worker queues a
running projection bound to that worker's claim. Its correction can publish
before the pass finishes, while an obsolete claim cannot authorize it.
GitHub comment writes cannot be fenced: a lease cannot
revoke an HTTP write already accepted by GitHub. A crashed writer's marker
expires fifteen minutes after its last delivery lease. Corrective replay stops
at that deadline. If an expired writer later settles in a live process, the host
queues the latest status again. An unobserved remote write after the deadline
can still overwrite the comment. Channels serialize activity publication by PR target before resolving credentials.
Separate token callbacks and token rotation cannot split that queue. Credential
resolution and read stages have thirty-second bounds. Caller cancellation can
shorten them, and a stalled credential or lookup callback releases the local queue
even when it ignores cancellation. An already-started write requests cancellation
at the deadline but retains target ordering and its durable delivery lease until
the actual transport settles. A custom transport that never settles after
cancellation can hold that target queue. Waiting comments
include the blocker reason. A confirmed repair result waits for its head webhook
if that webhook arrives after the pass finishes.

Known worker setup failures receive one recovery attempt per Agent `version` and
PR head. Bump an explicit version with each deployed Agent release. An Agent without
a version uses the installed package build identity, which changes with package
source and dependency updates even when preview builds reuse a manifest version.
Hosts that run package sources compute the same fingerprint at startup. The wake and release marker
commit together, so restarting the same release cannot repeat the wake. Timed
retries, check dependencies, and maintainer credential blockers keep their existing
wake conditions. Health can reuse admission accounting for at most two minutes
and reports its observation time; dispatch shares a fresh accounting read.

Invalid dependency installation inputs park the PR without a timer retry. Correct
the inputs, then push a new head or comment on the PR to resume. Installer capacity,
filesystem, and package-manager failures retain a five-minute retry.

Each pass uses a disposable provider workspace with unattended edit permission.
Native permission escalation is denied without prompting; the provider does not run
in full-access mode. GitHub tokens
stay on the host. Tools provide PR-bound log reads, repair pushes, comments,
metadata updates and thread resolution. Unless `merge` is `"auto"`, the worker
has no merge tool and the host rejects auto-merge operations. With `"auto"`, it
requests GitHub native auto-merge subject to current PR admission and repository
checks and reviews. Workers never merge directly or delete branches.

Before a repair push, the host durably associates the exact candidate commit with
its active claim. Check and status webhooks for that commit are retained even when
they arrive before the source-push and synchronize webhooks. This association does
not count as a successful push and expires with the claim. A wait after several
repair pushes retains every verified push receipt, including when host admission
closes during a provider retry.
When a candidate becomes the PR head, earlier unpublished candidates stop accepting
CI evidence. Later pending candidates and separately verified push receipts remain valid.

A pass can resolve several addressed review threads without cancelling itself
when its own resolution webhooks arrive. New comments and external thread reopens
still revoke further repair operations.

### Bound repeated PR work

The Node inbox accepts `budgets: { providerRetries: 3, noProgress: 3 }`.
Call `reserveProviderAttempt(accountScope)` immediately before each provider dispatch,
then `finishProviderAttempt(token, outcome)` exactly once. The initial dispatch plus
three retries allow four consecutive classified provider failures. Successful
provider access clears older failures; unrelated errors release their reservation
without imposing a quota stop. Reservations also bound concurrent dispatches to
four until they settle. Both pending reservations and failures survive restart.
A crashed reservation requires inspection and `resetProviderBudget(scope, reason)`;
there is no automatic cooldown or timer reset. Token generations reject results
from before a reset. `providerBudget(scope)` exposes pending and failed attempts.

Supply `finish(claim, { text, progress: { kind: 'no-progress' } })` when a host check
proves no progress, including a completed invocation that merely repeats a wait.
Three such completions block new claims for that head even after a webhook.
Use `{ kind: 'verified', evidence: 'thread:123:resolved' }` for a newly verified change;
credited evidence IDs persist for that head, so replay does not reset the count. A new head has a fresh budget.
`resetProgressBudget(repository, number, expectedHead, reason)` permits an explicit
operator retry and rejects active claims or stale heads. `summary()` exposes the
persisted head, limit, count and exhaustion state. The first progress outcome saves
the configured limit for that head. Configuration changes and restarts retain it;
an explicit reset or a new head adopts the current limit. The host verifies evidence and classifies
errors; Agent text, result status, and elapsed time do not choose this policy.

See [durable retry budgets](https://vitehub.dev/docs/agents/invocations#durable-retry-budgets)
for a worker example. Budgets are opt-in and do not change existing inbox callers.

### Provider exit evidence

A `launch` resolver can return `onExit({ cwd, abortSignal })` with its command. ViteHub calls this host callback once after the provider and Workspace commands stop, before it restores generated files or deletes the working directory. Auxiliary runs, such as title generation, do not call it. Use it to read the final checkout HEAD and persist evidence in host-owned state. The callback also runs after a failed or cancelled turn when shutdown completes. Cancellation can return before this deferred cleanup finishes. Its signal has a separate teardown deadline; stop all I/O when it aborts. Callback errors fail cleanup without preventing directory removal.

The callback is skipped when provider shutdown fails or exceeds the cleanup deadline, and during provider inspection. Missing evidence must remain unknown. This callback does not verify model claims, grant push authority, or make closure state durable across host crashes. Validate the checkout in host code and persist the result before returning when durability is required.

### Required GitHub checks

Import `createGitHubRequiredCheckPolicyReader` and `evaluateGitHubRequiredChecks`
from `@vite-hub/agent/server/github` to inspect required checks for scheduling.
Supply an authenticated REST reader `(path) => Promise<{ status, data, nextPage? }>`; paths
are relative to the GitHub API root. The reader combines active branch rules with
classic branch protection and preserves required GitHub App identities. It requests
the first rules page with a page size of 100, then follows explicit continuation
targets. For every successful rules response, the callback must normalize the
Link header's `rel="next"` URL to an API-relative `nextPage` path without a leading
slash, relative to the complete configured API base URL, including its pathname.
For GitHub Enterprise Server, `https://host/api/v3/repositories/123/rules/branches/main?page=2`
becomes `repositories/123/rules/branches/main?page=2`, without repeating `api/v3`.
The adapter must reject URLs with a different origin or outside the API base path,
and preserve query parameters. For example, normalize a parsed next URL with:

```ts
function normalizeNextPage(nextUrl: string, apiBase: string): string {
  const base = new URL(apiBase);
  const prefix = base.pathname.replace(/\/$/, "") + "/";
  const next = new URL(nextUrl);
  if (next.origin !== base.origin || !next.pathname.startsWith(prefix)) {
    throw new Error("Pagination URL is outside the GitHub API base");
  }
  return next.pathname.slice(prefix.length) + next.search;
}
```

GitHub can change the route to `repositories/{id}/...`; the reader follows these
paths without requiring the original route prefix.
Set `nextPage: null` only when the header has no next relation
(or after fetching all pages). Missing metadata, invalid or repeated targets,
failed pages, and the 1,000-page limit return unknown policy. Page length does
not establish completion. Other endpoint responses do not need `nextPage`.

```ts
const policies = createGitHubRequiredCheckPolicyReader(readGitHubRest)
const policy = await policies.read('acme/app', 'main')
const result = evaluateGitHubRequiredChecks(policy, {
  repository: 'acme/app', branch: 'main', headSha,
  checkRuns, statuses,
})
policies.invalidate('acme/app', 'main') // after a protection or ruleset event
```

Pass complete REST check-run records and commit statuses fetched for the exact
head. Add the requested SHA as `sha` on each status because GitHub omits it from
individual status records. The evaluator selects the
latest matching records on the exact head. A successful same-context commit status
for an App-bound requirement returns `unknown` because REST statuses do not identify
the source App, unless a matching check run already proves failure. Failing and
pending statuses retain their blocking states. Missing requirements return `pending`
and appear in `missing`; malformed or unavailable policy returns `unknown`, never
an empty passing policy. Required workflow rules return `unknown` because they
cannot be represented as check contexts. Policy reads use a five-minute cache,
with a two-minute cache for unknown results. Set `ttlMs`, `failureTtlMs`, and
`clock` in the reader options to change this behavior. Invalidation also prevents
older in-flight reads from restoring stale cache entries.

These results describe scheduling evidence. They do not grant merge authority or
replace fresh GitHub merge checks. Repository selection, approvals, merge methods,
and review-provider policy remain application decisions.
