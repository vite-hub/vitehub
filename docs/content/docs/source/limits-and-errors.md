---
title: Source limits and errors
description: Path, symlink, secret, cache, and Collection checks for Source in production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Production checks

- Sources are read-only. Use Workspace for durable sync, path rules, diffs, snapshots, or scoped Agent access.
- Read secrets for private origins, such as a GitHub token, from Server Env or a trusted `auth` callback, never from model input. Without `auth`, `github()` reads `VITEHUB_GITHUB_TOKEN`, then `FORGES_GITHUB_TOKEN`.
- Paths are relative to the root. On every host, ViteHub rejects absolute paths, `..`, Windows drive paths such as `C:secrets.txt`, and null bytes.
- `file()` follows a symlink only when its target stays inside the root. `glob()` rejects an item when the file or a parent folder is a symlink, unless `followSymlinks: true` and the target stays inside the root. These checks select files; they do not guard against changes made at the same time.
- Local Workspace stores are stricter and reject symlinks.
- Name each `cachedSource()` cache after its origin and access scope. Do not share a cache name between callers who see different data.
- `cursor` and `limit` are reserved Collection query parameters. Invalid limits, cursors, and filters return HTTP `400`.
- `array()` Collections tie each cursor to the data digest and query. A cursor used after the data changed, or with another filter or search, returns HTTP `409` with `SOURCE_R0027`. Reload from the first page.
- `array()` loads the whole array on each request. Keep it small enough to filter in memory, or use `table()`.
- Collection `authorize` controls the whole route. It does not filter rows per user.
- Each routed Collection must set `authorize` or `access: 'public'`. `access: 'public'` is the only way to make a route public.
- A public Collection over `table()` must set `transform`, because `table()` selects every column.

## SOURCE_R0034

The default `useCollection()` requester received an unsuccessful HTTP status. The error keeps the status in `status` and identifies the Collection endpoint in `why`.

Check the Collection route and server logs for that status, correct the request or server error, then refresh the Collection. HTTP `401` and `403` still become `CollectionAccessError` with `SOURCE_R0026`.

## SOURCE_R0035

A Collection has a route but no `authorize` and no `access`. Such a route would serve every item to anyone, so `defineCollection()` and `defineCollectionHandler()` throw.

Set `authorize: true` to require a signed-in session, a callback to decide each request, or `access: 'public'` for a public route. Set `route: false` to keep the Collection server-only.

## SOURCE_R0036

A Collection over `table()` sets `access: 'public'` without `transform`. `table()` selects every column, so the route would serve columns such as password hashes or emails.

Add `transform` that returns only the public fields, or replace `access: 'public'` with `authorize: true` or a callback.

## SOURCE_R0037

A Collection sets `authorize: false`. `false` reads as "deny", so it does not make a route public, and `defineCollection()` and `defineCollectionHandler()` throw.

Replace `authorize: false` with `access: 'public'` to let anyone read the route. Use `authorize: true` or a callback to require sign-in.

## SOURCE_R0038

A Collection sets both `access: 'public'` and `authorize`. A public route checks nobody, so the two contradict each other.

Keep `access: 'public'` to let anyone read the route, or keep `authorize` to check each request. Remove the other.
