---
title: Skip the install with a snapshot
description: Install node_modules on your machine or in CI, pack it into parts, and mount it in the WebContainer so the reader does not wait for npm install.
navigation.title: Snapshots
navigation.order: 4
icon: i-lucide-package
---

An `npm install` of a ViteHub Agent app in a WebContainer takes minutes. A snapshot is the binary form of a folder that a WebContainer mounts. Build the snapshot of `node_modules` at build time, and the container never installs.

## Build the snapshot

Run this script in Node at build time:

```ts [scripts/snapshot.ts]
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { createNodeModulesSnapshot, packSnapshot } from "@vite-hub/web-container/snapshot"

const lockfile = existsSync("app.package-lock.json") ? readFileSync("app.package-lock.json", "utf8") : undefined
// Runs `npm ci` in build/app with the lockfile, or `npm install` without one.
const { snapshot, lockfile: next } = await createNodeModulesSnapshot({ dir: "build/app", lockfile })
writeFileSync("app.package-lock.json", next) // keep it, so the next build installs the same versions
const parts = packSnapshot(snapshot) // gzip, split into parts of at most 20 MiB
const sha256 = createHash("sha256").update(Buffer.concat(parts)).digest("hex")
parts.forEach((part, index) => writeFileSync(`public/app-modules.${sha256.slice(0, 12)}.${index}.bin`, part))
```

- `dir` is a folder with the `package.json` (and `.npmrc`) of the app. The install writes `node_modules` there.
- Keep the returned `lockfile` and pass it back. The next install then runs `npm ci`, and the same lockfile gives the same snapshot bytes.
- `packSnapshot()` compresses the snapshot with gzip and splits it into parts of at most 20 MiB, for hosts that limit the size of a static file. Pass `{ partBytes }` to change the size.
- Pass `dev: true` to keep `devDependencies`.

## Mount the snapshot

In the browser, download the parts and pass them to `bootWebContainer()`:

```ts [src/playground.ts] fragment
import { bootWebContainer, fetchSnapshot } from "@vite-hub/web-container"

const container = await bootWebContainer({
  snapshot: fetchSnapshot(partUrls, { cache: "my-app-modules", sha256 }),
  files,
})
await container.run("dev")
```

- `fetchSnapshot()` downloads the parts in parallel, joins them in order, and inflates them.
- With `sha256`, it rejects parts whose hash is different.
- With `cache`, it keeps the parts in Cache Storage, so a later boot downloads nothing. A part goes into the cache only after the whole snapshot inflates and matches its hash. A damaged snapshot removes its parts from the cache, so the next boot downloads them again.
- `bootWebContainer()` boots while the snapshot loads. It mounts `files` after the snapshot, so `files` can replace files from it.

Give each snapshot version its own URLs, such as names with a content hash, and each app its own cache name. The cache deletes the parts of other URLs.

## What the install does

`createNodeModulesSnapshot()` installs as npm in a WebContainer does:

- It uses `--cpu=wasm32`, so no native binaries download.
- It swaps `esbuild`, `lightningcss`, and `@libsql/client` for their wasm builds, and adds `@rolldown/binding-wasm32-wasi`, which Rolldown otherwise downloads on first use. The wasm builds install as npm aliases in the same install, so the lockfile pins every version.
- Install scripts do not run, and source maps are left out.
- The original `package.json` is restored exactly, on success and on failure.
- The integrity of `file:` tarballs is left out of the lockfile, because a rebuilt tarball changes it.

A snapshot cannot hold symlinks or executable bits, so it lists them, and `bootWebContainer()` restores them after the mount. Link paths, executable paths, and link targets must stay inside the working directory. The builder leaves out other links, and the restore step skips other entries, because the snapshot bytes come from the network.

## Reuse a container's install

`container.export()` returns a binary snapshot of the working directory. Pass `excludes` (glob patterns) to leave files out. Mount it later with `bootWebContainer({ snapshot })`.

The vitehub.dev docs build writes its tutorial snapshots with `createNodeModulesSnapshot()`, in `docs/modules/tutorials/snapshots.ts`.
