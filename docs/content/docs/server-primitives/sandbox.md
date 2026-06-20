---
title: Sandbox
description: Run named isolated work through an explicit Sandbox Provider boundary.
navigation.order: 12
icon: i-lucide-terminal-square
---

Sandbox owns isolated execution. Use it when named work should run away from the request process or when execution needs a provider-managed boundary.

Sandbox is not Shell. Sandbox owns isolated Sandbox Runs; Shell owns controlled Unix-like command sessions and Shell Observations.

## Define sandbox work

Create a Sandbox Definition for work that can run through a Sandbox Provider.

```ts [server/sandboxes/release-notes.ts]
import { defineSandbox } from '@vite-hub/sandbox'

export default defineSandbox(async (payload: { notes?: string } = {}) => {
  return {
    text: payload.notes?.toUpperCase() || 'No notes',
  }
})
```

## Run it at runtime

Use `runSandbox()` from server code.

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async (event) => {
  return runSandbox('release-notes', await readBody(event), {
    id: 'release-notes-preview',
  })
})
```

The payload is Sandbox Payload. Provider reuse hints such as Sandbox Identity belong to Invocation Options, not to the portable Sandbox Definition identity.

## Pair it with Workspace

Use Workspace when isolated execution should operate on a file tree.

```ts [server/tasks/test-workspace.ts]
import { useWorkspace } from '@vite-hub/workspace'

export async function testWorkspace() {
  const session = await useWorkspace('docs', { mode: 'write' }).startSession()

  await session.exec('pnpm', ['test'])
  const diff = await session.diff()
  await session.close()

  return diff
}
```

Workspace owns files, rules, snapshots, diffs, and commit behavior. Sandbox owns the isolated provider execution boundary.

## Provider output

The Sandbox Package discovers Sandbox Definitions, selects a Sandbox Provider, and generates runtime wiring for the host. Provider selection belongs in Integration Options when it changes generated output or bindings.

Cloudflare and Vercel sandbox providers have different deployment and credential requirements. Keep those details in configuration and Server Env.

## Connect it to Agents

An Agent can execute isolated work only through an attached Sandbox Capability or through app-owned server behavior that you explicitly expose. Do not attach execution Capabilities casually.

Limit commands, inspect outputs, and prefer read-only Workspace access until the Agent has a real need to mutate files.

## Production boundaries

Sandbox execution can create cost, persistence, credential, and isolation concerns. Treat provider credentials as Server Env secrets and keep payloads free of raw secret material.

Use Shell when the app needs a controlled command session over a declared filesystem boundary. Use Sandbox when isolation and provider-managed execution are the main requirement.

## Next steps

- Use [Shell](/docs/server-primitives/shell) for controlled command sessions.
- Use [Workspace](/docs/server-primitives/workspace) for file-tree state.
- Expose execution to agents through [Official capabilities](/docs/capabilities/official-capabilities).
