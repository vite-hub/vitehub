---
description: "Fix KV_INVALID_KEY in ViteHub. The key is empty or has a . or .. segment. Use a key with at least one plain segment, such as users:alice."
seo.title: "KV_INVALID_KEY: the KV key is empty or has a dot segment"
---

A keyed `kv` call, such as `kv.get()` or `kv.set()`, returns `KV_INVALID_KEY`.

## Why it happens

The key is empty, such as `''` or `':'`, or has a `.` or `..` segment, such as `'a/../b'`. Both `/` and `:` separate segments. Every store rejects these keys, so KV returns this code before any provider call.

## Fix it

Use a key such as `users:alice`. To put text from a request in a key, encode it first, for example with `encodeURIComponent()`.
