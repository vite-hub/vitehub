---
title: Choose a driver
description: Route KV to local fs-lite, Cloudflare KV bindings, or Upstash-backed Vercel deployments.
navigation.title: Choose a driver
navigation.group: Guides
navigation.order: 31
icon: i-lucide-route
frameworks: [vite, nitro, nuxt]
---

Choose the driver in config when you need predictable behavior. Let hosting inference handle the common deployed path when the defaults match your app.

## Local Development

Use `fs-lite` for the smallest local setup:

```ts
kv: {
  driver: 'fs-lite',
  base: '.data/kv',
}
```

This stores data on the local filesystem. It is useful for quickstarts, local testing, and examples.

## Cloudflare

Use `cloudflare-kv-binding` when the app runs with Cloudflare KV bindings:

```ts
kv: {
  driver: 'cloudflare-kv-binding',
  binding: 'KV',
  namespaceId: '<kv-namespace-id>',
}
```

If Cloudflare hosting is detected and no explicit driver is configured, ViteHub selects this driver automatically.

## Vercel

Use `upstash` for Vercel:

```ts
kv: {
  driver: 'upstash',
}
```

Then set runtime credentials:

```bash
KV_REST_API_URL=https://example.upstash.io
KV_REST_API_TOKEN=<upstash-rest-token>
```

If Vercel hosting is detected and no explicit driver is configured, ViteHub selects `upstash` automatically.

## Auto-Resolution Order

| Priority | Signal | Driver |
| --- | --- | --- |
| 1 | Explicit `kv.driver` | Configured driver |
| 2 | Upstash REST env vars | `upstash` |
| 3 | Vercel hosting | `upstash` |
| 4 | Cloudflare hosting | `cloudflare-kv-binding` |
| 5 | No signal | `fs-lite` |

## Choosing Checklist

Use `fs-lite` when:

- you are developing locally
- data can live in `.data/kv`
- no hosted provider should be required

Use `cloudflare-kv-binding` when:

- the app deploys to Cloudflare Workers or Pages
- a Cloudflare KV namespace is bound to the runtime
- you know the binding name and namespace ID

Use `upstash` when:

- the app deploys to Vercel
- Upstash REST credentials are available at runtime
- you want the same path outside Vercel by configuring env vars explicitly

## Related Pages

- [Cloudflare](../providers/cloudflare)
- [Vercel](../providers/vercel)
- [Runtime API](../runtime-api)
