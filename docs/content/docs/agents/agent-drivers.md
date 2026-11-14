---
title: Agent Drivers
description: Run an Agent with an AI SDK model, Codex, Claude Code, typed questions, or your own function. Each Driver decides how one Invocation runs.
seo.title: "Agent Drivers: Codex, Claude Code, AI SDK"
navigation.order: 11
navigation.group: Define and run
icon: i-lucide-cpu
navigation.kind: Guides
---

A Driver decides how one Invocation (one call to an Agent) runs. Pick the Driver that fits the work:

| Choose | Use it when |
| --- | --- |
| Model-backed | ViteHub runs a model and the tools from your Capabilities (reusable tool and policy pieces). |
| Provider-backed | Codex or Claude Code runs its own loop, tools, approvals, and session. |
| Custom run | Your code does the work. |
| Ask | A fast decision model answers a fixed set of typed questions. |

`codexDriver()` and `claudeCodeDriver()` from `vite-hub/agent` create provider-backed Drivers. Other Drivers use exactly one of `{ model }`, `{ run }`, or `{ ask }`. For a full setup with a route, credentials, and deployment, read [Run the Claude Agent SDK in production](/docs/guides/claude-agent-sdk) and [Run the Codex SDK in production](/docs/guides/codex-sdk).

## Use a model-backed Driver

Use it for support answers, classification, extraction, structured output, and limited tool use.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support requests from inspected evidence.',
    execution: {
      callSettings: { temperature: 0.2 },
      stepLimit: 8,
    },
  },
})
```

Model strings run through AI Gateway, with `AI_GATEWAY_API_KEY` from the process or the Cloudflare Server Env. To give the Agent its own key, pass `{ id, apiKey }`:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

const apiKey = process.env.SUPPORT_AI_GATEWAY_API_KEY
if (!apiKey) throw new Error('SUPPORT_AI_GATEWAY_API_KEY is required')

export default defineAgent({
  driver: {
    model: { id: 'zai/glm-5v-turbo', apiKey },
  },
})
```

`model` can also be an AI SDK model or a callback that picks the model per Invocation. Use callbacks and instrumentation for routing and call settings. Put authorization in Access or a Capability policy.

### Model options

| Option | Purpose |
| --- | --- |
| `model` | Required model id, `{ id, apiKey }`, AI SDK model, or callback. With `gateway`, a model id. |
| `gateway` | `chatgpt()` runs the model on the [ChatGPT plan](/docs/connections/chatgpt#use-a-model-backed-driver). For another gateway, set `model: languageModel(gateway, id)`. |
| `instructions` | String, string array, or callback parts. Defaults to the `instructions.md` file next to the Agent, if any. |
| `maxRetries` | Retry count for model calls. Do not also set `execution.callSettings.maxRetries`. |
| `execution.callSettings` | Provider and AI SDK call settings. |
| `execution.stepLimit` | Maximum tool-loop steps. Defaults to `20`. |
| `execution.instrumentation` | Wraps the model or overrides call settings per Invocation. |
| `execution.workspaceFallback` | Writes an answer from Workspace evidence when a run has tool results but no text. |

## Use a provider-backed Driver

To use a signed-in user's ChatGPT Plus or Pro plan, define a [ChatGPT Connection](/docs/connections/chatgpt) and set `driver: codexDriver({ gateway: chatgpt() })`, with `chatgpt` from `vite-hub/gateways`. The CLI handles sign-in. Connections handles registration and refresh. This flow never falls back to an API key. Codex needs a POSIX Node.js host. A model-backed Driver uses the same grant on every host, including Cloudflare Workers: `driver: { model: 'gpt-5.5', gateway: chatgpt() }`.

The built-in Drivers reuse T3 Code's Codex and Claude Code runtime. ViteHub owns Agents, Capabilities, Workspaces, Invocations, and lifecycle events. Install only the provider packages you use:

```sh
pnpm add @openai/codex@0.149.1
pnpm add @anthropic-ai/claude-agent-sdk@0.3.321
```

Declare the Codex credentials in Server Env:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      server: {
        codexAuthJson: env({ secret: true, source: env.source('CODEX_AUTH_JSON') }),
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        codexAuthJson: env({ secret: true, source: env.source('CODEX_AUTH_JSON') }),
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        codexAuthJson: env({ secret: true, source: env.source('CODEX_AUTH_JSON') }),
      },
    },
  })],
})
```
:::
::

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { loadServerEnv } from 'vite-hub/env'

export default defineAgent({
  driver: codexDriver({
    credentialProfile: 'review',
    credentials: async ({ abortSignal }) => (await loadServerEnv(undefined, { signal: abortSignal })).codexAuthJson,
    instructions: 'Review the exact pull request head before changing code.',
    model: 'gpt-5.5',
    permissions: 'ask',
    reasoningEffort: 'high',
    reasoningSummary: 'detailed',
  }),
  workspace: { mode: 'write' },
})
```

### Give Codex its credentials

`credentials` accepts a Codex `auth.json` string, a sealed Server Env value, or a resolver that runs per Invocation. So a Kubernetes secret or an [Env provider](/docs/env/server-api#read-external-env-storage) can supply auth without startup files. ViteHub checks that the value is a JSON object and writes it as a `0600` file in a `0700` Codex Home, the directory where Codex keeps auth, config, sessions, and logs.

::warning
Written credentials need a POSIX host. ViteHub rejects them on Windows, where these file modes cannot guarantee owner-only access. The value never enters the provider environment or inspection output.
::

`credentialProfile` names one writable Home that Drivers in the process share, at `.vitehub/data/codex/<credentialProfile>`. Only one Codex process uses it at a time. Codex can refresh `auth.json` there. ViteHub fingerprints the last resolver value: it keeps the refreshed file while that value is unchanged, and replaces it on the next Invocation when the value rotates.

::warning
The profile is a full Codex Home. Treat its auth, config, sessions, and logs as sensitive. Only one ViteHub process may write a profile volume, so in Kubernetes give each replica its own persistent volume. ViteHub does not write refreshed credentials back to the Env provider.
::

Without `credentialProfile`, each Invocation gets a temporary Home that ViteHub removes when Codex stops.

### Host requirements

Provider Drivers need a local Node.js host whose process has the credentials.

- ViteHub finds an installed `@openai/codex` or `@anthropic-ai/claude-agent-sdk` without copy scripts.
- Self-hosted Node builds on macOS and Linux copy only the build host's native optional package, including the Linux libc variant, into `.output/server/node_modules`. Build on the host type you deploy to.
- Without the Codex package, ViteHub uses `codex` from `PATH`.
- Claude needs the Agent SDK. If its native package is missing at runtime, T3 falls back to the host `claude` command.
- ViteHub never downloads provider packages at build or startup.
- Provider Workspaces need a POSIX host.

Each Invocation gets a temporary working directory, any Workspace files, Codex instructions or a Claude prompt file, and Capability tools through a private loopback MCP server. Only successful write-mode runs commit, through the Workspace rules.

### Resume threads after a restart

Provider cursors resume a thread while the process runs. Set `sessionStorePath` to keep them in a local SQLite file across restarts.

- With `credentials`, you also need `credentialProfile`, because ViteHub removes a private Codex Home after each run.
- A relative path resolves from the process working directory.
- Use one file per provider Agent on one persistent host. The store does not stop two workers from using one thread.
- Chat cursors stay separate by origin, invoker, and Chat Session, so a new session cannot inherit an old one's context.
- If the provider cannot resume, for example after its session files were deleted, ViteHub sends the full history to a new thread and records `agent.provider.session.resume-failed`.

### Set the environment and wrap the launch

Resolve `env` per Invocation for short-lived credentials. Use `launch` to start the provider through your own wrapper, such as a remote execution CLI:

```ts [server/agents/review/agent.ts] fragment
import { codexDriver, defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: codexDriver({
    env: async ({ abortSignal }) => ({
      SANDBOX_TOKEN: await issueSandboxToken({ signal: abortSignal }),
    }),
    launch: ({ command }) => ({
      args: ['exec', '--', command],
      command: 'sandboxctl',
    }),
    permissions: 'allow-all',
  }),
})
```

ViteHub resolves `env` once, then calls `launch` with the environment, `command` (the executable to start), `providerCommand` (the original provider executable), the temporary working directory, and an abort signal. Build wrapper arguments from `command` and pick a provider runner from `providerCommand`. They are equal during Invocations. The wrapper gets its own arguments, then the provider arguments. ViteHub writes an owner-only temporary launcher outside the Workspace and removes it when the provider stops.

Launch wrappers need a POSIX host. They change only process startup. Your app owns authorization, remote isolation, and wrapper credentials. Agent inspection shows whether `env` and `launch` are static or dynamic, without resolving them.

### Check the commands the provider needs

Set `requirements` to the commands the provider's shell needs, such as `['git', 'gh', 'unzip', 'apply_patch']`. `agent.status()` checks them where the Driver runs, with `command -v`, or `where.exe` for a local Windows Driver. Missing commands make the status `unavailable` and appear in `status.missingCommands` and `status.reason`. Invocations do not repeat the check.

With `launch`, requirements need a resolver. Status inspection resolves it once with `command: 'sh'`, and each provider probe checks the commands in that shell before it starts the provider, so no extra runner starts. A probe can run the launcher more than once. If the launcher does not report the check results, readiness stays unknown.

A resolver that routes by executable must read `providerCommand`, because `command` is `sh` during the check:

```ts fragment
launch: ({ command, providerCommand }) => ({
  args: ['exec', '--', command],
  command: selectRunnerForProvider(providerCommand),
})
```

### Route model requests through a gateway

Set `gateway` to send provider model requests through an LLM proxy. An [AI gateway](/docs/gateways) preset from `vite-hub/gateways` reads its URL and key from the environment:

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { cliproxy } from 'vite-hub/gateways'

export default defineAgent({
  driver: codexDriver({
    model: 'gpt-5.5',
    // Reads CLIPROXY_URL and CLIPROXY_API_KEY.
    gateway: cliproxy(),
  }),
})
```

[AI gateways](/docs/gateways) lists the presets, their variables, and `defineAiGateway()` for other endpoints. A gateway without a base URL for the Driver fails at definition time with `AGENT_R0976`.

ViteHub maps the gateway to each provider:

- Codex gets a generated `vitehub` model provider through `-c` overrides: `base_url`, `wire_api = "responses"`, `stream_max_retries = 10`, `env_key`, and `env_http_headers`. A gateway can answer 200 and then relay an upstream error, which only Codex can retry. 10 retries back off for about 3.5 minutes, against 6 seconds for the default 5. The key and headers go in `VITEHUB_GATEWAY_API_KEY` and `VITEHUB_GATEWAY_HEADER_<n>`, and launch arguments hold only the names. These overrides come after `providerSettings.launchArgs`, so they win.
- Claude Code gets `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, and the key in `ANTHROPIC_AUTH_TOKEN` (bearer) or `ANTHROPIC_API_KEY` (x-api-key), with the other one empty.

The gateway owns these variables. Setting one in `driver.env`, or `T3CODE_CODEX_LAUNCH_ARGS` for Codex, fails with `AGENT_R0979`. A gateway replaces `credentials` and `credentialProfile`, also those from `defineAgent({ extends })`. A `launch` wrapper gets the variable names in `requiredEnvironment`, so SSH runners forward them. Inspection shows the gateway name and `executionAuthority.credentials: "provisioned"`. `agent.status()` does not cache results for an Agent with a gateway.

ViteHub does not forward host variables such as `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`, or `CLIPROXY_API_KEY`. Pass them through a gateway or `driver.env`.

A gateway changes where requests go, not the protocol. It must accept OpenAI Responses requests from Codex and Anthropic Messages requests from Claude Code, and `model` must be an ID it accepts.

::warning
The key and headers are in the provider environment, so the provider's commands can read them. Treat a gateway key as visible to the Agent. Use API keys: [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance) do not permit routing a Claude subscription sign-in through a proxy.
::

### Run in an existing directory

Each Invocation gets a new temporary working directory by default. Set `cwd` to run in a directory that your app prepares, such as a throwaway checkout that is also the Workspace's local store root:

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: codexDriver({
    cwd: '/srv/review/checkout',
    permissions: 'allow-edits',
  }),
})
```

`cwd` takes an absolute or relative path, or a per-Invocation resolver. Relative paths resolve from the process working directory. If the result is not an existing directory, the Invocation fails with `AGENT_R0939` before the provider starts. A `launch` resolver gets it as `cwd`.

The directory is the working copy. ViteHub materializes Workspace Sources (outside file sets a Workspace mounts) but starts no Workspace session: no file copy, Git baseline, diff, write-back, or removal. It restores generated instruction files when the provider stops. Skills never go into the directory. In a Git repository root, Git ignores those files during the run, so provider commits skip them. Title and progress summary runs ignore `cwd`. Your app owns the directory's contents, cleanup, and isolation between concurrent Invocations. Inspection shows whether `cwd` is static or dynamic, without resolving it.

### Temporary files

Each Invocation on this host gets its own temporary directory in `TMPDIR`, `TMP`, and `TEMP` for the provider, its commands, and a `launch` wrapper. Test fixtures, tool caches, and the Node.js compile cache stay out of the shared host directory. ViteHub removes it when the Invocation ends, even after a failure, abort, or timeout, or a later Invocation removes it once the dead owner process is confirmed. Set `TMPDIR` in `env` to use another directory, which ViteHub does not remove. A Sandbox Invocation uses the Sandbox's temporary directory.

### Give the provider its Skills

The provider reads Skills from two places. It reads the Skills of its working directory natively: `.agents/skills` and `.codex/skills` for Codex, `.claude/skills` for Claude Code. ViteHub writes every other Skill to one private folder per Invocation, outside the working directory:

- Agent-owned Skills from `server/agents/<name>/skills/`.
- Workspace Skills under a skill root that the provider does not read, such as an `.agents/skills` Skill for Claude Code.
- Skills of the outer Workspace root when the provider runs in a nested pull request checkout.
- Skills inside mounted Sources, such as `portal/.agents/skills/customer-deploy` for a Source mounted at `portal`.

Codex loads the folder as an extra skill root through `skills/extraRoots/set`. Claude Code reads its `.claude/skills` through `--add-dir`. A Skill name that the provider already reads in its working directory is not added again. The folder is next to the Invocation's temporary directory and is removed with it. A `launch` wrapper that starts the provider on another host must make the temporary directory of the ViteHub host (`os.tmpdir()`) available at the same path, as it does for the working directory. A Sandbox Invocation writes the same Skills to the provider's Home skill root instead.

Precedence by name: the working directory, then Agent-owned Skills, then the outer Workspace root, then the Sources in declaration order. An Agent-owned Skill replaces a Source Skill with the same name, with all its files.

A Source with `materialize: 'none'` still gives its Skills. ViteHub adds startup Sources named `__vitehubSourceSkills:<key>:<skill-root>` that fetch only the `.agents/skills`, `.codex/skills`, and `.claude/skills` folders of the Source and mount each at its Skill directory, so the Console file tree shows them under the Source's mount. A GitHub Source fetches only those paths. A Source whose type has no `subset()` method gives Skills only when it is materialized. Set `skills: false` on a Source binding to keep its Skills out:

```ts [server/agents/support/agent.ts] fragment
workspace: {
  materialize: 'none',
  sources: {
    portal: github({ repo: 'acme/portal' }),
    k8s: { source: github({ repo: 'acme/k8s' }), skills: false },
  },
},
```

> [!WARNING]
> Breaking change: earlier releases wrote Skills into the working directory and copied each Skill to `.agents/skills`, `.codex/skills`, and `.claude/skills`. A pull request checkout now keeps only its own files. Codex must support `skills/extraRoots/set` in `codex app-server`.

### Provision the project toolchain

Set `toolchain` when the project pins its own Node.js and package manager. It uses the same declaration as [`sandbox.toolchain`](/docs/agents/sandboxes#provision-nodejs-and-the-package-manager):

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: codexDriver({
    permissions: 'allow-all',
    toolchain: 'project',
  }),
})
```

After ViteHub prepares the pull request checkout, the Workspace, or `cwd`, it reads the pins there, installs them under `$XDG_CACHE_HOME/vitehub/toolchains`, and checks `node -v` and the package manager version. The toolchain `bin` directories come first in `PATH` for the provider, its commands, and Workspace commands. With a pull request mounted below the Workspace root, ViteHub reads that mount. A `launch` launcher gets the same `PATH`, so it must run on this host. Provider CLIs that start through `#!/usr/bin/env node`, such as the npm Codex package, also use the project's Node.js. Title and progress summary runs install no toolchain.

With `toolchain`, `status()` does not report `node`, `npm`, `npx`, `pnpm`, `pnpx`, `yarn`, or `yarnpkg` as missing, because the toolchain exists only after an Invocation prepares its checkout. With `sandbox`, use `sandbox.toolchain`. The Agent rejects `driver.toolchain` with `AGENT_R0972`.

### Provider options

Threads resume with the provider's opaque cursor. ViteHub turns provider output into Invocation events: text, reasoning, native and Capability tool activity, approvals, provider questions, usage, warnings, errors, and the final state.

| Option | Purpose |
| --- | --- |
| `credentialProfile` | Codex only. Stable Home name. Requires `credentials`. Stored under `.vitehub/data/codex/<credentialProfile>`. |
| `credentials` | Codex only. `auth.json` string, sealed Server Env value, or per-Invocation resolver. Inspection shows that it is set, without resolving it. |
| `reasoningEffort` | Codex only. A non-empty effort the model supports, such as `"low"`, `"high"`, or `"xhigh"`. Requires `model`. |
| `reasoningSummary` | Codex only. `"auto"`, `"concise"`, `"detailed"`, or `"none"`. Requires `model`. |
| `workspaceWrite` | Codex only. `{ network?, packageCaches? }`, both `false` by default. With `"allow-edits"` or `"allow-edits-unattended"`, Codex runs commands in its `workspace-write` sandbox, which has no network and can write only inside the working directory. `network: true` allows network access, for example to install packages. `packageCaches: true` also allows writes to the package manager store and caches where the provider runs, in the host Home or the Sandbox Home: `npm_config_store_dir`, `npm_config_cache_dir`, `~/.local/share/pnpm`, `~/.cache/pnpm`, `~/.cache/node/corepack`, and `~/.npm`. Other permissions ignore it. |
| `model` | Optional provider model id. |
| `env` | Values or a per-Invocation resolver, resolved once. Otherwise the provider gets only host paths, locale, and user-directory variables, not app secrets. `TMPDIR`, `TMP`, and `TEMP` point to a [temporary directory for the Invocation](#temporary-files) unless `env` sets them. |
| `execution.attachments.maxBytes` | Positive image attachment budget per Invocation. Defaults to 25 MiB, shared by inline and lazy images. |
| `instructions` | Added to the colocated instructions. |
| `launch` | Provider command wrapper or per-Invocation resolver. Gets the executable, working directory, environment, and abort signal. |
| `cwd` | Existing directory or per-Invocation resolver. No Workspace session, write-back, or removal. See [Run in an existing directory](#run-in-an-existing-directory). |
| `permissions` | `"ask"`, `"allow-edits"`, `"allow-edits-unattended"`, or `"allow-all"`. Defaults to `"ask"`. `"allow-edits-unattended"` keeps edit mode and denies native escalation without a prompt. Host-bound MCP tools keep their own authorization. Only an explicit `"allow-all"` skips approval. |
| `providerSettings` | Advanced runtime settings. They override the installed Codex executable fallback. |
| `requirements` | Commands that `status()` checks, reported in `missingCommands`. In a child Agent, a function gets the inherited list: `inherited => [...inherited, 'kubectl']`. |
| `sessionStorePath` | SQLite file for session cursors, so threads continue after a restart on the same persistent volume. |
| `toolchain` | `"project"` or `{ node, packageManager, fallbackNode }`. Installs the project's pinned Node.js and package manager. See [Provision the project toolchain](#provision-the-project-toolchain). |
| `output` | Structured output contract. |
| `capacity` | Static or adaptive concurrency and queue limits for this process. |

Provider Drivers fail explicitly with model-specific Provider Tool contributions, Cloudflare Agents, Deno, or Workspaces on Windows. Workspace-scoped Skills and Capability tools work.

## Run a provider Driver in a Sandbox

Set `sandbox` to start the provider in a [Sandbox](/docs/agents/sandboxes), an isolated command environment that supplies the working tree, private Home, environment, and boot checks per Invocation:

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'

export default defineAgent({
  sandbox: {
    runtime: 'trusted-host',
    requires: ['git'],
  },
  driver: codexDriver({ permissions: 'allow-all' }),
})
```

The runtime stays in the ViteHub process. Only the provider command runs in the Sandbox. ViteHub adds that command to the Sandbox requirements and writes instructions and Skills to the Sandbox Home. `driver.env` reaches the provider. The Driver rejects `launch`, `credentials`, and `credentialProfile`, and the Agent rejects `workspace`, so put credentials in the Sandbox. A Sandbox session lasts one Invocation, so threads do not resume.

### Cloudflare Workers

Provider Drivers start local processes, so they cannot run in a Cloudflare Worker. Deploy them to a Node.js host. Worker builds leave out the provider runtime and `@t3tools/provider-runtime` through the `workerd` and `worker` package conditions of `@vite-hub/agent`. Apps with only `{ model }`, `{ run }`, or `{ ask }` Drivers never bundle it.

Only `codexDriver()` and `claudeCodeDriver()` import the runtime, so the build finds every provider Driver, also from a variable, preset, layer, or the `title()` and `progressSummary()` Capabilities. A Worker build that contains one fails with `AGENT_B0019`. In development, a Worker Invocation that selects one fails with `AGENT_R0928`.

## Adaptive process capacity

Self-hosted Node apps can admit work by current machine load instead of a fixed limit. Share one capacity object between the Agents that use the same host:

```ts [server/agent-capacity.ts]
import { createProcessAgentCapacity } from 'vite-hub/agent/process'

export const agentCapacity = createProcessAgentCapacity({
  concurrency: 6,
  queue: { maxPending: 100, timeout: 30 * 60_000 },
})
```

`concurrency` is the hard maximum. Under CPU or memory pressure, ViteHub admits fewer new Invocations. Active ones continue, the queue stays FIFO, and admission resumes after recovery. Linux uses cgroup v2 limits, memory events, and pressure stall information when available. Other hosts use Node's available-memory and parallelism signals. A failed sample, or one slower than `sampleTimeoutMs` (default one second), uses `fallbackConcurrency` (default one). `vitehub agent info` shows the current limit, hard maximum, queue depth, and sampling reason.

## Use a custom run Driver

Use `driver.run` when your code makes the result without a model loop.

```ts [server/agents/router.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    run({ input, invoker }) {
      return { text: `Accepted ${invoker.id}: ${String(input.prompt ?? '')}` }
    },
  },
})
```

The callback receives prepared input, messages, tools, Workspace access, invocation context, and the resolved Invoker as `invoker`. A custom run callback may call a model internally, but ViteHub treats that execution and usage as application-owned behavior.

ViteHub cannot stop this callback. On cancel, `input.abortSignal` aborts and the result shows `notEnforcedBy: 'run'`. Pass the signal to your I/O or throw `input.abortSignal.reason` to stop. Model and provider Drivers stop on cancel. See [Cancel an invocation](/docs/agents/invocations#cancel-an-invocation).

Read [Instructions](/docs/agents/instructions) for model-facing behavior and [Workspace context](/docs/agents/workspace-context) for files and writeback.

## Use an ask Driver

Use `driver.ask` when the Agent only answers a few typed questions, such as a label or a score. It runs no chat model, tools, or instructions. It sends the questions to [TypeSafe Jev](https://typesafe.ai) through the `advocaat` client, in fixed-order sequential batches when one request is too large. For each question, the shared state, the question, and request overhead must fit below 30,000 bytes, or the Invocation fails. An empty question map skips Jev.

Install the client, an optional peer dependency:

```sh
pnpm add advocaat
```

It asks through the [`typesafe()` AI gateway](/docs/gateways), which reads `TYPESAFE_API_KEY`. Set `gateway` to use Vercel or Cloudflare AI Gateway:

```ts [server/agents/labeller.ts]
import { defineAgent } from 'vite-hub/agent'
import { ask } from 'vite-hub/gateways'
import { cloudflare } from 'vite-hub/gateways'

export default defineAgent({
  driver: {
    ask: { spam: ask.if('Is it spam?') },
    // Reads TYPESAFE_API_KEY, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_AI_GATEWAY_ID.
    gateway: cloudflare(),
  },
})
```

Build the questions with `ask`:

```ts [server/agents/email-labeller.ts]
import { defineAgent } from 'vite-hub/agent'
import { ask } from 'vite-hub/gateways'

export default defineAgent({
  driver: {
    ask: {
      label: ask.choice('Which Gmail label fits this email?', {
        invoice: 'Bills, receipts, and payment requests.',
        none: 'No label clearly fits.',
      }),
      urgent: ask.if('Does the email need action today?'),
    },
  },
})
```

The answers are the Invocation output, and their type comes from the questions. `runAgent()` returns a tuple, so destructure it and read `result.output`:

```ts [server/lib/label-invoice.ts]
import { runAgent } from 'vite-hub/agent'
import labeller from '../agents/email-labeller'

export async function labelInvoice() {
  const [error, result] = await runAgent(labeller, { prompt: 'Invoice 42' })
  if (error) throw error
  const answers = result.output
  if (!answers) throw new Error('Expected labeller output')
  answers.label.choice // 'invoice' | 'none'
  answers.urgent // boolean
  return answers
}
```

No output schema or parsing is necessary.

Jev reads the Invocation `data` when a caller sets it, else the prompt text, else the latest user message. Pass a function to build the questions for each Invocation. It receives the same context as `driver.run`. This one reads the labels from Server Env:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      server: {
        labeller: { labels: env({ default: 'invoice,receipt,none' }) },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        labeller: { labels: env({ default: 'invoice,receipt,none' }) },
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        labeller: { labels: env({ default: 'invoice,receipt,none' }) },
      },
    },
  })],
})
```
:::
::

```ts [server/agents/labeller.ts]
import { useServerEnv } from 'vite-hub/env'
import { defineAgent } from 'vite-hub/agent'
import { ask } from 'vite-hub/gateways'

export default defineAgent({
  driver: {
    ask: () => {
      const labels = useServerEnv().labeller.labels.split(',')
      return {
        label: ask.choice('Which label fits?', Object.fromEntries(labels.map(label => [label, null]))),
      }
    },
  },
})
```

| Builder | Answer |
| --- | --- |
| `ask.choice(instructions, criteria)` | `{ choice, confidence, probabilities }`. `criteria` maps labels to descriptions, or lists 2 to 255 labels. |
| `ask.switch(instructions, criteria)` | The label only. |
| `ask.score(instructions, levels)` | `{ score, ratio, confidence, legend, probabilities }` for 2 to 10 ordered levels. |
| `ask.chance(instructions, criteria?)` | `{ chance }`, the probability of yes. |
| `ask.if(instructions, { threshold? })` | `true` when the probability of yes is above `threshold`, between `0` and `1`, default `0.5`. |

State, instructions, and criteria accept JSON. Root numbers and booleans become text for the `advocaat` Entry contract. Nested ones stay native. Score legends keep the level descriptions.

`driver.ask` accepts only `ask`, `capacity`, and `gateway`. A gateway that cannot answer Jev, such as `cliproxy()`, fails at definition time with `AGENT_R1013`. The gateway retries transient failures. A missing `advocaat` or a missing or rejected key fails the Invocation with a `GATEWAYS_` code. See [AI gateway errors](/docs/gateways/limits-and-errors#errors).

The Console and `vitehub agent info` show the Driver kind as `ask`.

Each question is a trace step, so the journal and Console show what Jev was asked and answered:

| Observation | Attributes |
| --- | --- |
| `agent.tool.start` | `tool.input`: the question sent to Jev |
| `agent.tool.finish` | `tool.output`: the answer. `ask.answer`: the label, score, chance, or boolean. `ask.probabilities`, `ask.confidence`, `ask.model`, `tool.durationMs` |
| `agent.tool.error` | `tool.error`, `error.status`, `error.requestId` for each question of a failed request |
| `agent.usage.recorded` | One per Jev request: `usage.model`, `usage.inputTokens`, `usage.outputTokens`, `usage.totalTokens`, `ask.durationMs` |

Each Jev request is one call (`model`, `provider`, `usage`) in the usage record. `event.invocation.usage` in `agent:finish` and `usage.record` on `agent.invocation.finish` sum the tokens and name the model when all requests share it. The Console cost table reads it, as for Codex. To price it, add [`usage({ pricing })`](/docs/agents/capabilities/usage) to the Agent.

`agent.tool.*` observations carry `tool.id` `ask:<key>`, `ask.key`, `ask.type`, `ask.batch.index`, `ask.batch.count`, and `ask.batch.size`. The shared state is `input.data` (or the prompt) on `agent.invocation.start`, and the answers are `result.output` on `agent.invocation.finish`. A metadata-only journal keeps `tool.input`, `tool.output`, `input.data`, and `result.output` only when `metadataContent` lists them, as the Console journal does. No credentials or request headers are recorded.

### Provider exit evidence

To save the final checkout HEAD in host-owned state, return `onExit({ cwd, abortSignal })` from a `launch` resolver. ViteHub calls it once after the provider and Workspace commands stop, before it restores generated files or deletes the working directory. Title generation and other auxiliary runs skip it. It also runs after a failed or cancelled turn once shutdown completes, and a cancel can return before that. Its signal has its own teardown deadline: stop all I/O when it aborts. A throw fails cleanup, but the directory is still removed.

ViteHub skips the callback when shutdown fails or passes the cleanup deadline, and during inspection. Treat missing evidence as unknown.

::warning
The callback does not verify model claims, grant push authority, or survive a host crash. For durability, validate the checkout in host code and save the result before returning.
::
