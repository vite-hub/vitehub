---
title: Sandbox playground
description: Explore the existing Sandbox playground app and the files that show the end-to-end runtime flow.
navigation.title: Playground
---

The Sandbox playground is intentionally small. It shows one discovered sandbox and one API route that executes it.

## Start here

Inspect these files first:

::fw{#vite}
- `packages/sandbox/playground/vite/src/release-notes.sandbox.ts`
- `packages/sandbox/playground/vite/src/run-release-notes.ts`
::

::fw{#nitro}
- `packages/sandbox/playground/nitro/server/sandboxes/release-notes.ts`
- `packages/sandbox/playground/nitro/server/api/sandboxes/release-notes.post.ts`
::

::fw{#nuxt}
- `packages/sandbox/playground/nuxt/server/sandboxes/release-notes.ts`
- `packages/sandbox/playground/nuxt/server/api/sandboxes/release-notes.post.ts`
::

## Run the playground

```bash [Terminal]
SANDBOX_PROVIDER=cloudflare pnpm -C packages/sandbox/playground/nitro dev
```

## Trigger one sandbox run

```bash [Terminal]
curl -X POST http://localhost:3000/api/sandboxes/release-notes \
  -H 'content-type: application/json' \
  -d '{"notes":"- Added weekly digest\n- Fixed invite flow\n- Tightened signup copy"}'
```

## What to look for

- the sandbox file becomes the sandbox name `release-notes`
- the API route calls `runSandbox('release-notes', body)`
- the route checks `result.isErr()` before returning `result.value`
- changing the provider changes the runtime backend without changing the call site

## Useful follow-ups

- Use [Quickstart](./quickstart) if you want the smallest provider setup.
- Use [Run a sandbox](./guides/run-a-sandbox) if you want the normal production call pattern.
- Use [Reuse a sandbox](./guides/reuse-a-sandbox) if you want stable provider identity.
