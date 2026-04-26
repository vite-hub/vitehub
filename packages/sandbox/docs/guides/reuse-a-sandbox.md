---
title: Reuse a sandbox
description: Use stable sandbox IDs intentionally and understand provider-specific reuse behavior.
navigation.title: Reuse a sandbox
navigation.group: Guides
navigation.order: 32
icon: i-lucide-refresh-cw
frameworks: [vite, nitro]
---

Most calls do not need a stable sandbox identity. Let ViteHub create the provider sandbox for each execution unless reuse is part of the design.

Use reuse when you intentionally want repeated calls to target the same provider sandbox identity.

## Pass a sandbox ID per call

```ts
const result = await runSandbox('release-notes', payload, {
  sandboxId: 'release-notes-writer',
})
```

This keeps the call site explicit. It is useful when one route needs reuse but another route should stay isolated per call.

## Configure a default sandbox ID

Provider config can define a default `sandboxId`:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    sandbox: {
      provider: 'cloudflare',
      sandboxId: 'release-notes-writer',
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    sandbox: {
      provider: 'vercel',
    }
    ```
  :::
::

Per-call `sandboxId` takes precedence over the configured default where the provider supports it.

## Cloudflare reuse options

Cloudflare supports additional sandbox lifecycle options:

```ts
sandbox: {
  provider: 'cloudflare',
  sandboxId: 'release-notes-writer',
  sleepAfter: '5m',
  keepAlive: true,
  normalizeId: true,
}
```

| Option | Description |
| --- | --- |
| `sandboxId` | Stable identity used for the provider sandbox. |
| `sleepAfter` | Sleep behavior passed to Cloudflare Sandbox. |
| `keepAlive` | Keep the sandbox alive when supported. |
| `normalizeId` | Normalize sandbox IDs when supported. |

Without a `sandboxId`, ViteHub generates an ID for each Cloudflare call from the sandbox name and a random suffix.

## Vercel behavior

Vercel provider config focuses on runtime creation options such as `runtime`, `timeout`, `cpu`, `ports`, `source`, and `networkPolicy`.

Keep call sites portable by treating `sandboxId` as an optional hint. Code should still handle a normal `SandboxRunResult` whether the provider reuses an underlying runtime or creates a new one.

## Reuse checklist

Before using a stable sandbox ID, confirm:

- repeated calls are allowed to share provider runtime state
- concurrent calls with the same ID will not corrupt the work
- cleanup is handled by the provider lifecycle options
- the route still handles `result.isErr()`

## Related pages

- [Cloudflare](../providers/cloudflare)
- [Usage](../usage)
- [Runtime API](../runtime-api)
