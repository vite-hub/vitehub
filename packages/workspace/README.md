# @vite-hub/workspace

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
</p>

`@vite-hub/workspace` gives agents and server code a file-system context they can read, diff, and, when opened in write mode, update.

## Install

```sh
pnpm add @vite-hub/workspace vite nitro h3
pnpm add -D typescript @types/node
```

Use `skipLibCheck: true` in app TypeScript configs while ViteHub depends on runtime packages with ambient provider declarations.

## Minimal API

```text
server/
  workspaces/
    docs/
      README.md
      config.ts
routes/
  docs.get.ts
nitro.config.ts
vite.config.ts
```

```ts
// server/workspaces/docs/config.ts
import { defineWorkspace, file, github } from "@vite-hub/workspace"

export default defineWorkspace({
  store: {
    provider: "local",
    root: ".vitehub/workspaces/docs",
  },
  sources: {
    readme: file({ path: "README.md", sync: true }),
    vitehubDocs: github({
      repo: "vite-hub/vitehub",
      root: "docs/content/docs",
      instructions: "Use this source for public ViteHub documentation.",
    }),
    guide: file({
      workspacePath: "guide.md",
      content: "# Guide\n",
      instructions: "Use this source for local guide notes.",
    }),
  },
})
```

```ts
// routes/docs.get.ts
import { useWorkspace } from "@vite-hub/workspace"
import { defineEventHandler } from "h3"

export default defineEventHandler(async () => {
  const workspace = useWorkspace("docs", { mode: "write" })
  const sync = await workspace.sync({ sources: "all", details: "paths" })

  return {
    sync,
    files: await workspace.fs.glob("**/*.md"),
    readme: await workspace.fs.readFile("README.md", { encoding: "utf8" }),
  }
})
```

Serve a constrained Workspace subtree without custom route plumbing:

```ts
// server/api/data/[...path].get.ts
import { defineWorkspaceFileHandler } from "@vite-hub/workspace/server"

export default defineWorkspaceFileHandler({
  workspace: "docs",
  root: "data",
  allow: ["data/**/*.json", "data/**/*.md"],
  cacheControl: "public, max-age=60",
})
```

## JSON collections

Query a generated JSON-object array without sending the complete index to the browser. The handler keeps filter, search, projection, sort, facet, and item lookup fields under server control, and every list response is capped by `maxLimit`.

```ts
// server/api/articles.get.ts
import { defineWorkspaceCollectionHandler } from "@vite-hub/workspace/server"

export default defineWorkspaceCollectionHandler({
  facets: ["category"],
  filters: ["category", "authors.name"],
  item: { key: "slug" },
  maxLimit: 100,
  path: "data/articles.json",
  searchFields: ["title", "summary"],
  select: ["slug", "title", "category"],
  sort: { field: "title", direction: "asc" },
  workspace: "content",
})
```

Nuxt auto-imports the Vue composables when this module is installed. Plain Vue apps can import them directly from `@vite-hub/workspace/collections/client`.
Default immediate requests start during browser setup so relative endpoints do not escape Nuxt's server request context. Inject `request` and call `refresh()` when an application needs SSR loading.

```ts
const articles = useWorkspaceCollection("/api/articles", {
  limit: 25,
  query: computed(() => ({
    "filter.category": selectedCategory.value || undefined,
    search: search.value || undefined,
  })),
})

const article = useWorkspaceCollectionItem("/api/articles", selectedSlug)
```

Use `empty.<field>=true` to filter for records without scalar values at an allowed field.

Collection queries parse the JSON array in the server runtime. Use this for deliberately small generated indexes; use a database when the server cannot reasonably hold and query the full source array in memory.

```ts
// nitro.config.ts
import { createWorkspaceNitroConfig } from "@vite-hub/workspace/nitro"

export default createWorkspaceNitroConfig()
```

```ts
// vite.config.ts
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubWorkspace()],
})
```

Use named Workspace Source Binding helpers such as `file()` and `github()`. The lower-level Source registry lives in `@vite-hub/source`; install and import it directly only when you use that package's registry APIs.

## Box sessions

Workspace definitions are runtime-free. To run generated code, open a [`@vite-hub/box`](../box/README.md) session and pass it to `workspace.startSession({ host: boxSession })`. Workspace materializes files into the host and still owns diff, commit, and rollback; closing without commit restores the host tree from authoritative Workspace state. Box owns execution and the host lifecycle.

Use `startSession({ attach: true, host })` only when another integration already owns the live materialized tree. Attached Sessions preserve that baseline without rematerializing the tree and roll back only their own uncommitted changes on close.

## MountX projection

Use the `@vite-hub/workspace/mountx` integration when an Agent, editor, CLI, or VM needs a real filesystem instead of Workspace methods. The adapter keeps Workspace Session diff and commit semantics in ViteHub while MountX owns the host transport.

Install MountX directly before importing its transport entry points:

```bash
pnpm add mountx@0.0.2
```

```ts
import { createWorkspaceDriver } from "@vite-hub/workspace/mountx"
import { mount } from "mountx/auto"

const session = await workspace.startSession()

try {
  const mounted = await mount(createWorkspaceDriver(session), "/tmp/vitehub-docs")

  try {
    // Programs can now use /tmp/vitehub-docs as an ordinary directory.
  }
  finally {
    await mounted.unmount()
  }

  await session.commit({ message: "accept projected changes" })
}
finally {
  await session.close()
}
```

The same driver works with MountX's 9P and NFSv4.1 servers for Linux guests, or its S3 gateway for S3-compatible clients. Use `{ readOnly: true }` when the consumer only needs inspection. The adapter uses MountX's unstorage driver, so it does not project or persist empty directories, and filenames cannot contain `:`, `?`, or end in `$`. MountX is still alpha and unaudited, so keep network transports loopback-only unless the surrounding sandbox or network is the explicit security boundary.

Harness-backed Agents use the Workspace Package to prepare Harness Workspace Sessions for `defineAgent({ driver: { harness }, workspace })`. The Agent Package keeps the harness inside the Agent Driver boundary, Capabilities keep tools and Skills opt-in, and Workspace owns materializing the selected Workspace Scope plus write-mode sync back through Workspace rules.

## Vite Integration

Use `hubWorkspace()` in Vite to discover workspace definitions, emit the workspace manifest for local development, and make the runtime store available to server code.

## Publishing current state

`workspace.snapshot()` creates a durable Store snapshot, then runs every configured Workspace publisher. Use `workspace.publish()` when the current Store contents should be published without advancing the Store's snapshot history:

```ts
const workspace = useWorkspace("docs", { mode: "write" })

await workspace.publish({ name: "chore: publish docs" })
```

Publishers receive a transient snapshot-shaped view of the current Store entries. `PublishContext.durable` is `false` for this direct lifecycle and `true` for snapshot-driven publication. Repeated publication remains a no-op when a publisher, such as the GitHub publisher, already has the same content.

A GitHub publisher cannot publish directly to the repository and branch backing the active GitHub Store because that would move the Store branch behind its loaded baseline. Use `workspace.snapshot()` for that branch, or configure the publisher with a different repository or branch.

## Hosted Cloudflare runtime

Nuxt apps can install the Workspace Nuxt module so hosted Workspace runtime setup is generated by the Vite Integration and merged into Nuxt's top-level Nitro config:

```ts
export default defineNuxtConfig({
  modules: ["@vite-hub/workspace/nuxt"],
  vite: {
    workspace: {
      store: {
        provider: "github",
        repository: "owner/repo",
        branch: "main",
        root: ".vitehub/workspaces/docs",
      },
    },
  },
})
```

Cloudflare-hosted apps outside Nuxt can install the public runtime setup instead of importing internal runtime state or store adapters:

```ts
import { configureCloudflareWorkspaceRuntime } from "@vite-hub/workspace/cloudflare"

configureCloudflareWorkspaceRuntime()
```

`useWorkspace()` will then resolve `cloudflare-artifacts` Workspace Stores from the configured runtime store or the Workspace Definition's `store` option.

Select Cloudflare Artifacts explicitly when a Cloudflare Worker needs durable, versioned Workspace state:

```ts
// vite.config.ts
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubWorkspace()],
  workspace: {
    store: {
      provider: "cloudflare-artifacts",
      binding: "WORKSPACE_ARTIFACTS",
      namespace: "vitehub",
    },
  },
})
```

The Vite Integration writes matching module-level and discovered definition-level Artifacts bindings into generated Cloudflare Provider Output. Each named Workspace uses its own repository by default, and a successful `workspace.snapshot()` pushes a Git commit whose SHA is the snapshot id. The Worker adapter keeps its checkout in isolate memory, so use it for deliberately small Workspaces. Cloudflare Artifacts is currently a closed beta and is not available on Workers Free; Cloudflare hosting therefore continues to default to the `memory` Store.

Artifacts repositories are private Git storage, not public attachment hosting. Use `@vite-hub/blob` with R2 or another Blob provider when an Agent needs a stable public delivery URL.

## GitHub-backed persistence

Use the GitHub Workspace Store when a hosted runtime needs durable Workspace file-tree state without a provider-specific artifact store:

```ts
export default defineWorkspace({
  store: {
    provider: "github",
    repository: "owner/repo",
    branch: "main",
    root: ".vitehub/workspaces/<workspace>",
  },
})
```

Set `WORKSPACE_GITHUB_TOKEN`, `VITEHUB_WORKSPACE_GITHUB_TOKEN`, `GITHUB_TOKEN`, or a `GITHUB_TOKEN` runtime binding with permission to read and write the repository contents. Reads and snapshots call the GitHub API, so this Store trades provider independence for GitHub API latency and rate limits. `workspace.snapshot()` writes changed Workspace Store files as a GitHub commit. If the target branch moves after the Workspace Store loaded local changes, snapshot fails with a conflict so the caller can retry from a fresh Workspace Store.

Publish a Workspace snapshot into an existing GitHub repository with the GitHub publisher:

```ts
import { github } from "@vite-hub/workspace/publish"

export default defineWorkspace({
  publish: [github({
    repository: "owner/repo",
    branch: "main",
    root: "generated/docs",
    deleteUntracked: false,
  })],
})
```

By default, the publisher treats `root` as an exact mirror and deletes remote paths that are absent from the Workspace snapshot. Set `deleteUntracked: false` when the publisher owns only part of `root`; Workspace files are still created and updated, while every remote-only path remains on GitHub, including files from earlier snapshots.

Built on [`@vite-hub/source`](../source/README.md) and [isomorphic-git](https://isomorphic-git.org/). Shell-backed Workspace tools load `@vite-hub/shell` only when the shell tool executes.

Learn more at [vitehub.dev](https://vitehub.dev).
