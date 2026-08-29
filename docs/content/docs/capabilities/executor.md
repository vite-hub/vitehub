---
title: Executor
description: Connect an Agent to an Executor tool catalog through one authenticated MCP endpoint.
navigation.icon: i-lucide-plug-zap
---

Use `executor()` when an Agent should use integrations configured in [Executor](https://executor.sh/) without owning each integration credential.
ViteHub connects to one streamable HTTP MCP endpoint. Executor keeps the Airtable, PostHog, GitHub, and other upstream credentials and policies behind that endpoint.

```ts [server/agents/support.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineAgent } from 'vite-hub/agent'
import { executor } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    executor({
      apiKey: useServerEnv().executorApiKey,
      url: 'https://executor.sh/acme/mcp',
    }),
  ],
})
```

Copy the exact endpoint from Executor's **Connect** card. ViteHub does not guess an organization path or install the Executor CLI or MCP server.
Connection setup follows Agent Invocation cancellation and times out after 30 seconds by default.

## Optional and rotating connections

Use a resolver when the endpoint or credential can change between Agent Invocations. Declare a credential that may be absent with `env({ optional: true, secret: true })`.

```ts [server/agents/support.ts]
executor(async () => {
  const env = useServerEnv()
  if (!env.executorApiKey)
    return false

  return {
    apiKey: env.executorApiKey,
    url: 'https://executor.sh/acme/mcp',
  }
})
```

The resolver runs once for every Agent Invocation. Returning `false`, `null`, or `undefined` contributes no Executor tools and creates no MCP client. A later invocation can observe a rotated credential or newly available connection.

An omitted `apiKey` deliberately connects without authentication, which is useful for a trusted local Executor endpoint. ViteHub sends a provided key only to an HTTPS endpoint. An explicitly supplied missing or empty key fails before ViteHub connects. Resolver errors and endpoint authentication, connection, discovery, integrity, and cleanup failures also remain errors.

## Tools and policy

Executor's `execute` MCP tool is exposed to the Agent as `executor`. Other catalog tools are prefixed with `executor_` after normalization.

Executor remains responsible for integration authentication, tool approval, and execution policy. ViteHub receives the Executor gateway credential and the MCP tool catalog; it does not receive upstream integration credentials or duplicate Executor's policies.

Use `integrity` to approve an exact tool-definition baseline. Added or changed tools fail before model execution, using the same fingerprint contract as [`mcp()`](/docs/capabilities/mcp).

```ts [server/agents/support.ts]
executor({
  apiKey: useServerEnv().executorApiKey,
  integrity: approvedExecutorTools,
  url: 'https://executor.sh/acme/mcp',
})
```

## Authentication boundary

Use a credential accepted by the endpoint shown in Executor's Connect card. Executor's API-key model [recognizes organization-owned keys as read-only platform credentials](https://github.com/UsefulSoftwareCo/executor/blob/main/apps/cloud/src/auth/api-keys.ts), but [Executor Cloud currently rejects them when opening an MCP session](https://github.com/UsefulSoftwareCo/executor/blob/main/apps/cloud/src/mcp/auth.ts) because they do not identify an acting user. Use a personal API key until Executor adds a subject-bound machine credential. Self-hosted and local deployments may use their own authentication policy.

ViteHub accepts a string or a sealed Server Env value for `apiKey`. It unseals the value only while resolving the Agent Invocation and redacts the authorization header from Capability and tool metadata.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string \| { unseal(): string }` | none | Executor bearer credential. Omit only for an endpoint that intentionally allows anonymous access. |
| `integrity` | `Record<string, string>` | none | Approved MCP tool fingerprints. Blocks added or changed definitions. |
| `timeout` | `number` | `30000` | Maximum time in milliseconds to connect and initialize the MCP session. |
| `url` | `string \| URL` | required | Exact HTTP or HTTPS MCP endpoint from Executor. |

The argument itself, or an async resolver, may return `false`, `null`, or `undefined` to disable the connection.

## Related

- [Executor MCP setup](https://github.com/UsefulSoftwareCo/executor#connect-an-agent-over-mcp)
- [Generic MCP servers](/docs/capabilities/mcp)
- [Server Env](/docs/server-primitives/env)
