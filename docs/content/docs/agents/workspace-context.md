---
title: Workspace context
description: Give agents source files and file-tree state without granting unrestricted filesystem access.
navigation.order: 25
icon: i-lucide-folder-search
---

Workspace context lets an Agent inspect source files, docs, generated files, or project state.

The Workspace is the file boundary. Capabilities decide which model-facing tools are exposed.

## Colocate workspace context

```ts [server/agents/docs/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { source } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer from the docs workspace. Say when the answer is not present.',
      '{{ workspace.sources }}',
    ],
  },
  workspace: {
    sources: {
      docs: source.glob({
        cwd: '.',
        include: ['README.md', 'docs/**/*.md'],
        instructions: [
          'Use this source for public product documentation.',
          'Say when these docs do not cover the answer.',
        ],
      }),
    },
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

## Source instructions

Sources can include Source Instructions. They are developer-authored guidance for how the agent should use that source; ViteHub does not infer them from provider metadata. A Source can declare them statically, or Source Resolution can return instructions for the resolved source.

When at least one visible source has instructions, ViteHub renders a `## Workspace Sources` block into the model instructions. Put `{{ workspace.sources }}` where that block belongs, or omit the slot and ViteHub appends it at the end. If the slot is present but no visible source has instructions, the slot is replaced with an empty string.

Only visible sources render. When `access()` selects a Workspace Scope, hidden or scoped-out source instructions are omitted along with the hidden files.

## Read mode first

Start with read mode. It gives the model enough visibility to inspect files without writing changes.

Use write mode only when the Agent is explicitly supposed to mutate Workspace files and the Workspace rules allow the target paths.

## Harness Workspace Sessions

Harness-backed Agent Drivers receive Workspace state through a Harness Workspace Session instead of model-facing Workspace Tools by default.

```ts [server/agents/review/config.ts]
import { createCodex } from '@ai-sdk/harness-codex'
import { defineAgent } from '@vite-hub/agent'
import { skills } from '@vite-hub/agent/capabilities'
import { source } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    harness: createCodex({
      model: 'gpt-5.5',
    }),
  },
  workspace: {
    mode: 'write',
    sources: {
      guide: source.file('AGENTS.md'),
    },
  },
  capabilities: [
    skills({ path: '.agents/skills/review' }),
  ],
})
```

Read mode materializes the selected Workspace into the harness sandbox and discards sandbox changes. Write mode syncs additions, updates, and deletions back through Workspace rules. Keep Skills behind the `skills()` Capability; ViteHub does not add root `skills`, `tools`, or `sandbox` Agent Definition fields for harness-backed Agents. Put harness guidance in Workspace files such as `AGENTS.md`; model-facing Source Instructions are not forwarded to harness-backed Agent Drivers yet.

## Access scope

Use the Access Capability when invocation identity should narrow the visible Workspace Scope.

```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { createTeamsAdapter } from '@chat-adapter/teams'
import { defineAgent } from '@vite-hub/agent'
import { access, chat, workspaceShell } from '@vite-hub/agent/capabilities'
import { source } from '@vite-hub/workspace'

const supportChat = chat({
  platforms: () => ({
    teams: createTeamsAdapter({
      apiUrl: process.env.TEAMS_API_URL,
      appId: process.env.TEAMS_APP_ID!,
      appPassword: process.env.TEAMS_APP_PASSWORD!,
      appTenantId: process.env.TEAMS_APP_TENANT_ID!,
      appType: 'SingleTenant',
    }),
  }),
})

export default defineAgent({
  invoker: {
    resolve({ context, defaultInvoker }) {
      const rawCustomer = typeof defaultInvoker.meta?.customer === 'string'
        ? defaultInvoker.meta.customer
        : ''
      const customers = rawCustomer.split(',').map(customer => customer.trim()).filter(Boolean)
      context.set('support.customerScope', { customers }, { overwrite: true })
      return defaultInvoker
    },
    profiles: [
      {
        id: 'portal-acme',
        kind: 'customerPortal',
        label: 'Acme Portal',
        meta: { audience: 'customer', customer: 'acme' },
      },
      {
        id: 'support-technical',
        kind: 'support',
        label: 'Support Technical',
        meta: { audience: 'technical', scope: 'all' },
      },
    ],
  },
  workspace: {
    sources: {
      supportGuide: source.file({
        path: 'AGENTS.md',
        instructions: 'Use this guide for support operating rules.',
      }),
      ingestion: source.github(({ invocation }) => {
        const scope = invocation.context.get<{ customers: string[] }>('support.customerScope')
        const customer = scope?.customers[0]
        if (!customer) {
          return {
            repo: 'quiverdk/ingestion',
            root: 'dbt',
            instructions: 'Use this source for ingestion models and dbt behavior.',
          }
        }

        return {
          repo: 'quiverdk/ingestion',
          root: `dbt/${customer}`,
          mount: `ingestion/${customer}`,
          instructions: `Use this source only for ${customer} ingestion models and dbt behavior.`,
        }
      }),
      forecastingEngine: source.github({
        repo: 'quiverdk/forecasting-engine',
        instructions: [
          'Use this source for forecasting engine behavior.',
          'Do not use files outside the selected Workspace Scope.',
        ],
      }),
    },
  },
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer from the scoped customer workspace.',
      '{{ capabilities.access.workspace }}',
      '{{ workspace.sources }}',
    ],
  },
  capabilities: [
    access({
      workspace: {
        resolve({ context, invoker }) {
          if (invoker.meta?.scope === 'all')
            return { all: true, role: 'admin', scope: 'support' }

          const scope = context.get<{ customers: string[] }>('support.customerScope')
          const customer = scope?.customers[0]

          if (!customer) {
            return {
              grants: [{ path: 'AGENTS.md' }],
              scope: 'public',
            }
          }

          return {
            grants: [
              { path: 'AGENTS.md' },
              { source: 'forecastingEngine' },
              { path: `ingestion/${customer}` },
            ],
            instructions: `Answer for the ${customer} customer workspace.`,
            scope: customer,
          }
        },
      },
    }),
    workspaceShell({ mode: 'read' }),
    supportChat,
  ],
})
```

Agent Invoker metadata drives the access decision. The invoker resolver normalizes comma-separated customer metadata into a `support.customerScope` Agent Invocation Context Value before Access and Source Resolution run. In this example, a customer invoker can see the shared support guide, the forecasting engine source, and only that customer's ingestion path. A support invoker with `scope: 'all'` receives the explicit all-files Workspace Scope.

Workspace Scope Instructions are explicit prompt text for the selected scope. Static scopes and resolver results can return `instructions`, and agents opt into rendering them with `{{ capabilities.access.workspace }}`. ViteHub does not generate prompt text from the scope name, grants, role, Source metadata, or invoker metadata.

Configured Agent Invoker Profiles give DevTools and trusted Agent Trigger Consumers stable identities to select. Server-owned trigger consumers can pass an explicit app-owned `invoker` after authenticating the request, and can keep chat-only payload under chat trigger `meta`. The Chat Capability preserves `meta` under `chat.meta` and lifts it into the default chat invoker only when it derives identity from chat user data. When a request selects an Agent Invoker Profile, the selected profile keeps runtime metadata and lets profile metadata override matching keys. Chat Platform Adapters can also provide email metadata from trusted platform identity when available. V1 trusts request-provided invoker context, trigger metadata, and profile ids, so validate requests before they reach an Agent Trigger Consumer when identity affects access.

Order matters. Access should run before Workspace-reading Capabilities so the scope is applied before tools are exposed.

Source Resolution is source shaping, not authorization. It can narrow a GitHub root, Mount, and Source Instructions from trusted invocation context such as Agent Invocation Context Values or the Selected Workspace Scope, but Access remains the boundary that decides which Workspace paths are visible. Scope-affecting source options are part of the resolved source fingerprint so cached source data does not cross scopes.
