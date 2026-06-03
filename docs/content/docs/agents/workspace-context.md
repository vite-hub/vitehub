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

## Read mode first

Start with read mode. It gives the model enough visibility to inspect files without writing changes.

Use write mode only when the Agent is explicitly supposed to mutate Workspace files and the Workspace rules allow the target paths.

## Access scope

Use the Access Capability when invocation identity should narrow the visible Workspace Scope.

```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { createTeamsAdapter } from '@chat-adapter/teams'
import { defineAgent, defineInvocationProfile, type AgentInvocationProfileRunInputFromSchemas } from '@vite-hub/agent'
import { access, chat, entry, workspaceShell } from '@vite-hub/agent/capabilities'
import { source } from '@vite-hub/workspace'
import { z } from 'zod'

const portalMetadataSchema = z.object({
  quiver: z.object({
    customer: z.string().min(1),
  }),
})

const portalUserSchema = z.object({
  email: z.string().email().optional(),
})

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

const supportInput = {
  chat: {
    message: { metadata: portalMetadataSchema, runOrigin: ['portal'] },
    run: { origin: ['portal', 'teams'] },
    user: portalUserSchema,
  },
} as const

const supportProfile = defineInvocationProfile({
  id: 'support',
  input: supportInput,
  resolve({ input }) {
    const chat = input.get().context?.chat
    if (chat?.run?.origin !== 'portal')
      return { kind: 'support' as const }

    return {
      customer: chat.message?.metadata.quiver.customer,
      kind: 'portal' as const,
    }
  },
})

export default defineAgent({
  workspace: {
    sources: {
      instructions: source.file('AGENTS.md'),
      ingestion: source.github({
        repo: 'quiverdk/ingestion',
        root: 'dbt',
      }),
      forecastingEngine: source.github({
        repo: 'quiverdk/forecasting-engine',
      }),
    },
  },
  capabilities: [
    access({
      profile: supportProfile,
      workspace: {
        resolve({ profile }) {
          if (profile.kind !== 'portal')
            return { all: true, role: 'admin', scope: 'support' }

          return {
            grants: [
              { path: 'AGENTS.md' },
              { source: 'forecastingEngine' },
              { path: `ingestion/${profile.customer}` },
            ],
            scope: profile.customer,
          }
        },
      },
    }),
    workspaceShell({ mode: 'read' }),
    supportChat,
    portalEntry,
  ],
  instructions: 'Answer from the scoped customer workspace.',
  model: gateway('openai/gpt-5.1-mini'),
})
```

The Invocation Profile sees the parsed schema output. In this example, portal chat requests must include a customer in message metadata, while non-portal chat surfaces can use the explicit all-scopes Workspace Scope. The resolver returns inline Workspace Scope definitions, so the app does not need to pre-register one scope per customer.

If a helper used by the Invocation Profile needs the parsed run input, infer it from the input schema:

```ts
type SupportRunInput = AgentInvocationProfileRunInputFromSchemas<typeof supportInput>
```

After the profile value exists, `typeof supportProfile.$Infer.RunInput` and `AgentInvocationProfileRunInput<typeof supportProfile, CallOptions>` can infer from the profile directly.

The Chat App Route origin is configured in `entry({ chat })` so the access decision does not trust a browser-controlled payload. A request body may repeat the same `run.origin`, but it cannot override the configured entry origin; mismatches are rejected as bad requests so app-level proxies fail closed when their contract drifts. The Invocation Profile declares accepted `chat.run.origin` values explicitly and uses `message.runOrigin` when a message metadata schema applies to only some origins.

Order matters. Access should run before Workspace-reading Capabilities so the scope is applied before tools are exposed.
