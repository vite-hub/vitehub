import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { expect, it } from "vitest"

import { packedWorkspacePackages } from "../packages/internal/test-utils/published-types.ts"

it("packs transitive runtime dependencies without adding optional peers or development tools", async () => {
  const root = await mkdtemp(join(import.meta.dirname, ".packed-workspace-"))
  try {
    const manifests = {
      app: { dependencies: { "@vite-hub/workspace": "workspace:*" }, devDependencies: { "@vite-hub/internal": "workspace:*" } },
      workspace: { dependencies: { "@vite-hub/blob": "workspace:*" }, peerDependencies: { "@vite-hub/shell": "workspace:*", "@vite-hub/runtime": "workspace:*" }, peerDependenciesMeta: { "@vite-hub/shell": { optional: true } } },
      blob: { optionalDependencies: { "@vite-hub/runtime": "workspace:*" } },
      runtime: { dependencies: { "@vite-hub/workspace": "workspace:*", external: "1.0.0" } },
    }
    for (const [name, manifest] of Object.entries(manifests)) {
      const directory = join(root, "packages", name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "package.json"), JSON.stringify(manifest))
    }
    expect(await packedWorkspacePackages(root, ["app"])).toEqual(["app", "workspace", "blob", "runtime"])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("includes Workspace's Blob and Database packages before they exist on npm", async () => {
  const packages = await packedWorkspacePackages(resolve(import.meta.dirname, ".."), ["workspace"])
  expect(packages).toEqual(expect.arrayContaining(["blob", "database", "runtime"]))
  expect(packages).not.toContain("shell")
})
