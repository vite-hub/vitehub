---
title: Source limits and errors
description: Path, symlink, secret, cache, and Collection checks for Sources in production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Production checks

- Sources are read-only. Use Workspace when content needs durable sync, path-scoped rules, diffs, snapshots, or scoped Agent visibility.
- Read secrets for private origins, such as a GitHub token, from Server Env or a trusted `auth` callback. Never from model-authored input.
- Source paths are relative to the configured root. ViteHub rejects absolute paths, parent traversal, Windows drive paths such as `C:secrets.txt`, and null bytes on every host.
- `file()` follows a symbolic link only when its resolved target stays inside the Source root. `glob()` rejects an item when its file or a parent directory is a symbolic link. Set `followSymlinks: true` to follow links whose targets stay inside the root. These checks select files. They do not isolate the process from concurrent file system changes.
- Local Workspace Stores have a stricter contract and reject symlink access.
- Give each `cachedSource()` cache a name that identifies its origin and access scope. Do not share one cache name across callers who can see different data.
- `cursor` and `limit` are reserved Collection query parameters. Invalid limits, cursor encodings, and parsed filters return HTTP `400`.
- Collection `authorize` decides access to the whole route. It does not filter rows per user.
