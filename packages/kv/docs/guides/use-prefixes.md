---
title: Use key prefixes
description: Organize KV records with predictable key prefixes for listing, clearing, and feature ownership.
navigation.title: Use key prefixes
navigation.group: Guides
navigation.order: 32
icon: i-lucide-list-tree
frameworks: [vite, nitro, nuxt]
---

Use prefixes when a feature owns more than one KV record. Prefixes make keys easier to list and safer to clear.

## Name Keys by Owner and Purpose

Use a predictable separator:

```ts
await kv.set('users:ava:preferences', { density: 'compact' })
await kv.set('users:ava:flags', { beta: true })
await kv.set('users:ben:preferences', { density: 'comfortable' })
```

The key should answer:

- who owns the value
- what kind of value it is
- whether the key is stable across deploys

## List a Prefix

```ts
const keys = await kv.keys('users:ava')
```

Example response:

```json
{
  "keys": [
    "users:ava:flags",
    "users:ava:preferences"
  ]
}
```

## Clear a Prefix

```ts
await kv.clear('users:ava')
```

This is safer than clearing the whole store when only one user, tenant, or feature namespace should be reset.

## Keep Prefixes Stable

Changing prefixes is a data migration. Prefer additive changes:

```ts
const key = `users:${userId}:preferences`
```

Avoid keys that depend on labels users can rename:

```ts
const key = `users:${displayName}:preferences`
```

## Related Pages

- [Usage](../usage)
- [Write and read values](./read-write-values)
- [Troubleshooting](../troubleshooting)
