---
title: Usage
description: Use the KV runtime to set, get, delete, clear, and list key-value pairs.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-square-terminal
---

`kv` is an unstorage-backed runtime handle for your active KV mount.

## Importing KV

Use the canonical portable import:

```ts
import { kv } from '@vitehub/kv'
```

This is the supported import path for Nitro and Nuxt runtime code that targets ViteHub KV. The Vite entrypoint registers bridge config only and does not mount storage in a plain Vite process.

## Set an item

```ts
await kv.set('vue', { year: 2014 })
await kv.set('vue:nuxt', { year: 2016 })
```

Use prefixes when you want to organize keys into groups that are easy to list or clear later.

## Get an item

```ts
const vue = await kv.get('vue')
```

## Has an item

```ts
const hasVue = await kv.has('vue')
```

## Delete an item

```ts
await kv.del('react')
```

## Clear the namespace

```ts
await kv.clear()
```

Pass a prefix when you want to clear only one subset of keys.

```ts
await kv.clear('react')
```

## List keys

```ts
const keys = await kv.keys()
```

Pass a prefix when you want to list only matching keys.

```ts
const vueKeys = await kv.keys('vue')
```

## Provider-specific options

Methods such as `kv.set(key, value, options)` pass `options` through to the underlying storage driver.

Those options are intentionally provider-specific in ViteHub today. They are not yet documented as a portable API contract, so use them only when you are targeting a specific driver and understand that driver's behavior.
