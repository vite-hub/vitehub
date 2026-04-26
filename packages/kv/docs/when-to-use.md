---
title: When to use KV
description: Decide when KV is the right storage primitive compared with inline memory, Blob, Queue, or a database.
navigation.title: When to use KV
navigation.order: 2
icon: i-lucide-git-compare
frameworks: [vite, nitro, nuxt]
---

Use KV when application code needs fast lookup by key and the value can be stored as one small record.

KV is not a database query engine and it is not a file store. It works best when the key is already known or when listing by a prefix is enough.

## Choose KV When

KV is a good fit when:

- the route reads or writes one value by key
- values are small JSON-serializable objects
- prefix-based grouping is enough
- the same call site should work locally and on hosted providers
- provider setup should stay out of application code

Common examples:

- feature flags
- user preferences
- small application settings
- lightweight caches
- id-to-metadata lookups

## Prefer Inline Memory When

Inline memory is better when:

- the data can disappear between requests
- values do not need to survive deploys or runtime restarts
- the state is only useful during one request

```ts
const startedAt = Date.now()

export default defineEventHandler(() => {
  return { uptimeMs: Date.now() - startedAt }
})
```

## Prefer Blob When

Use [Blob](/docs/vite/blob) when the value is a file or large object.

| Need | Primitive |
| --- | --- |
| Read a JSON settings object by key | KV |
| Store an uploaded image, PDF, or binary file | Blob |
| Store large text content where object semantics matter | Blob |
| Store small metadata for a file | KV |

## Prefer Queue When

Use [Queue](/docs/vite/queue) when the request should hand off work instead of storing state directly.

KV writes happen during the current request. Queue jobs run later through provider delivery infrastructure.

## Prefer a Database When

Use a database when you need:

- relational queries
- secondary indexes
- transactions across records
- aggregations
- complex filtering or sorting

KV can store a denormalized lookup that points to database records, but it should not replace a database when query behavior matters.

## Decision Checklist

Choose KV when all of these are true:

- The route can name the key it needs.
- The value is small enough to treat as one record.
- Prefix listing is sufficient for discovery.
- Provider-specific storage calls should stay behind config.

If any of those are false, start with Blob, Queue, or a database.

## Next Steps

- Start with [Quickstart](./quickstart) for a complete first route.
- Use [Choose a driver](./guides/choose-a-driver) for provider routing.
- Use [Usage](./usage) for key and prefix patterns.
