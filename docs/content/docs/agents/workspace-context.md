---
title: Workspace context
description: Give an Agent the files it needs, and choose if it can read or also write them.
navigation.order: 31
navigation.group: History and context
icon: i-lucide-folder-search
navigation.kind: Guides
---

A Workspace gives an Agent a named file tree and optional Sources, such as a folder or a GitHub repository. The Workspace decides which files exist. Capabilities (tools) and the Driver decide how the Agent reaches them.

Use it for project files, docs, generated state, and controlled writeback. Do not hide prompts in it: put model rules in [Instructions](/docs/agents/instructions). The [Workspace preset](/docs/agents/workspace-preset) is a ready read-only Codex Agent that cites Sources.

## Add a read-only Workspace

Turn on `agent` and `workspace`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', agent: true, workspace: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ host: 'node', agent: true, workspace: true }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ host: 'node', agent: true, workspace: true }),
  ],
})
```
:::
::

Declare a Source and give a model-backed Driver a read-only shell:

```ts [server/agents/docs/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'
import { glob } from 'vite-hub/workspace'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [
      'Answer from the docs Source.',
      'Use Workspace inspection before answering. Say when evidence is missing.',
    ],
  },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: {
    sourceRootDir: process.cwd(),
    sources: {
      docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
    },
  },
})
```

The Source puts files in the Workspace. `workspaceShell({ mode: 'read' })` lets the model read them. A Source alone gives the model no file access.

## Reuse a Workspace

Use `defineWorkspace()` when several Agents share the same files or Sources.

```ts [server/workspaces/product-docs.ts]
import { defineWorkspace, glob } from 'vite-hub/workspace'

export default defineWorkspace({
  sourceRootDir: process.cwd(),
  sources: {
    docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
  },
})
```

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: 'product-docs',
})
```

## Scope access by Invoker

Use `access()` to limit the files one invocation sees, based on the trusted caller. Put it before `workspaceShell()`, so the shell gets the scoped Workspace.

```ts [server/agents/editor.ts]
import { defineAgent } from 'vite-hub/agent'
import { access, workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    access({
      workspace: {
        defaultScope: 'support',
        scopes: {
          support: { paths: ['support'] },
        },
      },
    }),
    workspaceShell({ mode: 'read' }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
  workspace: 'product-docs',
})
```

Authenticate the request and pass an [Agent Invoker](/docs/agents/trusted-invokers) before deriving Invoker-specific access. Workspace policy enforces authorization, so base it only on trusted identity and application-owned facts. Invoker-scoped Workspace access from `access()` is read-only for model-backed and custom Drivers; provider Drivers receive a writable session limited to the selected paths. Without Invoker-scoped Access, write authority depends on the Workspace mode, its rules, and the tools exposed to the Driver.

## Use Workspace context with a provider

Provider Drivers get the rendered instructions and the selected Workspace files in a temporary local directory. A successful write-mode invocation commits through Workspace rules.

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: codexDriver({ model: 'gpt-5.5' }),
  workspace: { mode: 'write' },
})
```

## Preserve GitHub PR history

A Node process host can check out an exact PR head with Git, using `createGitHubHost()` from `vite-hub/presets/babysitter/server`. Pass `repository`, `number`, `headSha`, `headRepository`, and `headRef` to `withPullRequestCheckout()`. The host fetches the source branch directly and rejects a changed head.

Each pass uses a fresh temporary checkout. The host deletes its contents when the callback ends, also after failure, cancellation, or timeout. Cleanup is best effort: if it fails, the callback result or error is kept. It leaves an empty temporary directory, so concurrent pathname replacements stay safe.

If a provider creates its own directory, call the callback's `prepareWorkspace(cwd)` in the provider launch hook. It restores separate Git history and removes saved auth configuration. Set Workspace `commit: false` if the host pushes the provider's commits instead of Workspace writeback. If then no Workspace or Capability rule has `commit`, the run also skips the whole-tree Workspace diff.

After the provider ends, the host can call `checkout.push(cwd)`. It refreshes source credentials, checks ancestry, and rejects a source branch that changed since preparation. If pushes need host approval, do not give the provider the host's GitHub credentials. This works only for GitHub PR workspaces and needs Git, not the GitHub CLI.

## Keep context explicit

| Need | Use |
| --- | --- |
| Files or generated state | Workspace files and Sources |
| Rules for the model | Colocated or Driver Instructions |
| Read or write tools | Capabilities such as `workspaceShell` |
| Caller-specific file scope | Access plus a trusted Agent Invoker |
| Provider working directory | A write-mode Workspace |

Check the resolved Workspace, Sources, and access policy with the [CLI](/docs/development/cli) before production.

## Next steps

Use [Chat History](/docs/agents/chat-history-sessions) for earlier messages. Connect [Channels](/docs/agents/channels) for messages from a web chat or another service.
