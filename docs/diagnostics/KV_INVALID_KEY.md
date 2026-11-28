---
description: "Fix KV_INVALID_KEY in ViteHub. The key is empty or has a . or .. segment. Use a key with at least one plain segment, such as users:alice."
seo.title: "KV_INVALID_KEY: Empty keys and dot segments"
---

A keyed `kv` call, such as `kv.get()` or `kv.set()`, returns `KV_INVALID_KEY`.

## Why it happens

The key is empty, such as `''` or `':'`, or has a `.` or `..` segment, such as `'a/../b'`. Both `/` and `:` separate segments. Every store rejects these keys, so KV returns this code before any provider call.

## Fix it

Use a key such as `users:alice`. For request text, use `` `users:id-${encodeURIComponent(text)}` ``. The `id-` prefix keeps the last segment valid even when `text` is empty, `.` or `..`.

## Migrate keys before you upgrade

Older versions could write these keys through atomic operations even when ordinary reads rejected them. The new validation blocks atomic reads and deletes too.

Pause writes and back up each affected store. On the old version, use `kv.list()` on each store and check for empty keys and for `.` and `..` segments in the returned keys. For each match, rename it to an unused valid key with the provider's tools. Keep its value and expiry, then update the app code that uses the old key. If you already upgraded, you can still rename or remove these entries directly in the provider. Do not clear the store to remove individual keys.

- For `database`, change the `key` in `vitehub_kv` for the matching `namespace`. Leave `value` and `expires_at` unchanged.
- For Redis or Upstash, rename the full provider key, keeping the store's base prefix. Use `RENAMENX` so you do not overwrite an existing key.
- For Deno KV, the provider key is an array with one string. Move the entry to a new one-string key and keep its remaining lifetime. For `fs-lite`, move the value and its expiry metadata together.
