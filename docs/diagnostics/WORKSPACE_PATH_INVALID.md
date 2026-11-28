---
description: Learn why the Workspace rejected a reserved name or a path that is not relative to its root, and how to correct it.
---

A Workspace method rejects the path before it reads or writes the Store. `error.details.path` has the path. The `why` tells which of two problems the path has.

## Reserved name

ViteHub keeps `.git` at any depth for Git, and `.vitehub` at the root for its own data, such as `.vitehub/sources/<key>.json`. It also rejects their NTFS short names, such as `git~1` and `vitehu~1`, because Windows can open the reserved folder through them. Rename the file or folder:

```diff [server/api/settings.post.ts]
- await workspace.fs.writeFile('.git/config', config)
+ await workspace.fs.writeFile('git/config', config)
```

## Not a relative path inside the root

The path is empty or absolute, starts with a drive letter, has a NUL byte, or has a `.` or `..` part. Pass a relative path inside the Workspace, such as `docs/guide.md`.
