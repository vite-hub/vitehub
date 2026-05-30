---
title: Sandbox
description: Run isolated commands and code behind an explicit execution boundary.
navigation.order: 11
icon: i-lucide-terminal-square
---

Sandbox is the primitive for isolated execution. Use it when code should run away from the request process or when execution needs a host-managed boundary.

Sandbox is not a generic shell. Every public path should make command authority explicit.

## Define sandbox work

```ts [server/sandboxes/release-notes.ts]
import { defineSandbox } from '@vite-hub/sandbox'

export default defineSandbox(async (payload: { notes?: string } = {}) => {
  return {
    text: payload.notes?.toUpperCase() || 'No notes',
  }
})
```

## Run it

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async (event) => {
  return runSandbox('release-notes', await readBody(event))
})
```

## Workspace sessions

Pair Sandbox with Workspace when the execution should operate on a file tree.

```ts
const session = await useWorkspace('docs', { mode: 'write' }).startSession()
await session.exec('pnpm', ['test'])
const diff = await session.diff()
```

Sandbox owns command execution. Workspace owns files, rules, snapshots, and commit behavior.

## Cloudflare sandbox binding

Cloudflare sandbox setup depends on the configured sandbox binding and deployment output.

## Vercel Sandbox credentials

Vercel sandbox setup depends on project and team credentials. Keep those values in server env, not in sandbox payloads.

## Sandbox and agents

An agent can execute commands only through an attached Sandbox Capability or Workspace Shell Capability. Do not attach execution capabilities casually. Limit commands, inspect outputs, and prefer read-only workspace access until writes are required.
