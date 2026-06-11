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
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { source } from '@vite-hub/workspace'

export default defineAgent({
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
  instructions: 'Answer from the docs workspace. Say when the answer is not present.',
  model,
})
```

## Source instructions

Sources can include Source Instructions. They are static developer-authored guidance for how the agent should use that source; ViteHub does not infer them from provider metadata.

When at least one visible source has instructions, ViteHub renders a `## Workspace Sources` block into the model instructions. Put `{{ workspace.sources }}` where that block belongs, or omit the slot and ViteHub appends it at the end. If the slot is present but no visible source has instructions, the slot is replaced with an empty string.

Only visible sources render. When `access()` selects a Workspace Scope, hidden or scoped-out source instructions are omitted along with the hidden files.

## Read mode first

Start with read mode. It gives the model enough visibility to inspect files without writing changes.

Use write mode only when the Agent is explicitly supposed to mutate Workspace files and the Workspace rules allow the target paths.

## Access scope

Use the Access Capability when invocation identity should narrow the visible Workspace Scope.

```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { createTeamsAdapter } from '@chat-adapter/teams'
import { defineAgent } from '@vite-hub/agent'
import { access, chat, entry, workspaceShell } from '@vite-hub/agent/capabilities'
import { source } from '@vite-hub/workspace'

const supportChat = chat({
  adapters: () => ({
    teams: createTeamsAdapter({
      apiUrl: process.env.TEAMS_API_URL,
      appId: process.env.TEAMS_APP_ID!,
      appPassword: process.env.TEAMS_APP_PASSWORD!,
      appTenantId: process.env.TEAMS_APP_TENANT_ID!,
      appType: 'SingleTenant',
    }),
  }),
})

const portalEntry = entry({
  id: 'portal',
  chat: { capability: supportChat, origin: 'portal' },
})

export default defineAgent({
  invoker: {
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
      ingestion: source.github({
        repo: 'quiverdk/ingestion',
        root: 'dbt',
        instructions: 'Use this source for customer-specific ingestion models and dbt behavior.',
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
  capabilities: [
    access({
      workspace: {
        resolve({ invoker }) {
          if (invoker.meta?.scope === 'all')
            return { all: true, role: 'admin', scope: 'support' }

          const customer = typeof invoker.meta?.customer === 'string'
            ? invoker.meta.customer
            : undefined

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
            scope: customer,
          }
        },
      },
    }),
    workspaceShell({ mode: 'read' }),
    supportChat,
    portalEntry,
  ],
  instructions: [
    'Answer from the scoped customer workspace.',
    '{{ workspace.sources }}',
  ],
  model: gateway('openai/gpt-5.1-mini'),
})
```

Agent Invoker metadata drives the access decision. In this example, a customer invoker can see the shared support guide, the forecasting engine source, and only that customer's ingestion path. A support invoker with `scope: 'all'` receives the explicit all-files Workspace Scope.

Configured Agent Invoker Profiles give DevTools and trusted app routing stable identities to select. Server-owned routes can also pass `context.invoker` after authenticating the request, and Chat Platform Adapters can provide a chat invoker from trusted platform identity. V1 trusts request-provided invoker context and profile ids, so validate requests before they reach a Chat App Route or other Agent Trigger Consumer when identity affects access.

Order matters. Access should run before Workspace-reading Capabilities so the scope is applied before tools are exposed.
